// The KGF side: direct API calls and code-authored SPARQL through kgf-sparql's engine,
// every request through kgf-sparql's own counting fetch (RunAccount), so a browser run gets
// the same budget and the same request accounting the CLI does. Nothing here plans a query:
// Comunica and the KGF actors do, from the statistics the server publishes.

import { KeysHttp } from '@comunica/context-entries';
import { RunAccount } from 'kgf-sparql/lib/cli/Budget.js';
import { describeKgfSource } from 'kgf-sparql/lib/cli/Sources.js';
import { QueryEngine } from 'kgf-sparql/lib/QueryEngine.js';

export const RECEIPT_SCHEMA = 'kgf-explorer.receipt/0';
const ENGINE = { kgf_sparql: KGF_SPARQL_VERSION, comunica: COMUNICA_VERSION, runtime: 'browser' };
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/**
 * One endpoint, its catalogue read once and pinned for the session: every later call names
 * the release the catalogue listed as current, so a session never drifts across a release.
 */
export class Endpoint {
  constructor(origin) {
    this.origin = origin.replace(/\/$/u, '');
    this.graphs = new Map();
    this.descriptor = null;
  }

  async load() {
    const response = await fetch(`${this.origin}/`, { headers: { accept: 'application/json' } });
    const body = await readJson(response);
    this.descriptor = body;
    for (const d of body.datasets) {
      this.graphs.set(d.id, d);
    }
    return this;
  }

  graph(id) {
    const d = this.graphs.get(id);
    if (!d) {
      throw new Error(`unknown graph ${JSON.stringify(id)}; call list_graphs for the ids this endpoint serves`);
    }
    return d;
  }

  link(id, name) {
    const d = this.graph(id);
    const href = d.links?.[name];
    if (!href) {
      throw new Error(`graph ${id} release ${d.current} offers no ${name} link`);
    }
    return new URL(href, `${this.origin}/`).href;
  }

  /** The pinned release's fragment URL, the form kgf-sparql's `kgf@` sources take. */
  fragmentUrl(id) {
    return this.link(id, 'fragment');
  }
}

/** A server error is its problem document, verbatim — never paraphrased. */
async function readJson(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${response.url}\n${text}`);
  }
  return JSON.parse(text);
}

function receipt({ operation, input, query = null, sources = [], outcome, account, budget, started, extra = {} }) {
  const finished = new Date();
  return {
    schema: RECEIPT_SCHEMA,
    operation,
    input,
    // Every table here comes from a published bundle release; kgfq D17's top grade.
    grade: 'bundle',
    query,
    ...extra,
    sources,
    outcome,
    requests: account.requests,
    totals: {
      requests: account.requests.length,
      bindings_requests: account.requests.filter(r => r.bindings).length,
      bytes: account.bytes,
      elapsed_ms: finished.getTime() - started.getTime(),
    },
    budget: {
      max_requests: budget.maxRequests ?? null,
      max_bytes: budget.maxBytes ?? null,
      max_rows: budget.maxRows ?? null,
      timeout_s: budget.timeoutSeconds ?? null,
    },
    engine: ENGINE,
    started: started.toISOString(),
    finished: finished.toISOString(),
  };
}

function newAccount(budget) {
  // window.fetch must be called unbound from RunAccount's own `this`.
  return new RunAccount(budget, (input, init) => fetch(input, init));
}

/**
 * A direct KGF call (catalogue, summary, search, count) under the same accounting as a query,
 * so its receipt carries the request, the bytes and the server's request id.
 */
export async function runDirect({ operation, input, budget, stop, call }) {
  const account = newAccount(budget);
  const started = new Date();
  const onStop = () => account.fail(new Error('stopped by the user'));
  stop?.addEventListener('abort', onStop, { once: true });
  account.startClock();
  try {
    const result = await call(account.fetch);
    const outcome = { contract: 'complete', rows: result.rows.length };
    if (result.note) {
      outcome.note = result.note;
    }
    return { ...result, receipt: receipt({ operation, input, outcome, account, budget, started }) };
  } catch (error) {
    const outcome = account.exceeded ?
      { contract: 'aborted', rows: 0, budget: account.exceeded, error: message(error) } :
      { contract: 'error', rows: 0, error: message(error) };
    return { rows: [], variables: [], receipt: receipt({ operation, input, outcome, account, budget, started }) };
  } finally {
    account.stopClock();
    stop?.removeEventListener('abort', onStop);
  }
}

/**
 * A code-authored SELECT through kgf-sparql's engine. Rows arrive as a stream; every one
 * passes the row budget first, and whatever arrived before a budget or an error ends the
 * run is kept and labelled as such — never as complete.
 */
export async function runSparql({ endpoint, operation, input, query, variables, graphs, budget, stop }) {
  const account = newAccount(budget);
  const started = new Date();
  const rows = [];
  const onStop = () => account.fail(new Error('stopped by the user'));
  stop?.addEventListener('abort', onStop, { once: true });
  let sources = graphs.map(g => ({ kind: 'kgf', url: endpoint.fragmentUrl(g) }));
  let outcome;
  account.startClock();
  try {
    sources = [];
    for (const g of graphs) {
      sources.push(await describeKgfSource(endpoint.fragmentUrl(g), account.fetch));
    }
    // A fresh engine per run: a shared one may cache a source built with an earlier run's
    // fetch, and then this run's requests would escape this run's receipt.
    const engine = new QueryEngine();
    const stream = await engine.queryBindings(query, {
      sources: sources.map(s => ({ type: 'kgf', value: s.url })),
      [KeysHttp.fetch.name]: account.fetch,
    });
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        stream.destroy();
        reject(account.signal.reason);
      };
      account.signal.addEventListener('abort', onAbort, { once: true });
      stream.on('data', bindings => {
        if (!account.countRow()) {
          account.signal.removeEventListener('abort', onAbort);
          stream.destroy();
          account.abort('max_rows', `${account.rows} rows kept`);
          resolve();
          return;
        }
        rows.push(toRow(bindings, variables));
      });
      stream.on('end', () => {
        account.signal.removeEventListener('abort', onAbort);
        resolve();
      });
      stream.on('error', reject);
    });
    outcome = account.exceeded ?
      { contract: 'aborted', rows: rows.length, budget: account.exceeded } :
      { contract: 'complete', rows: rows.length };
  } catch (error) {
    outcome = account.exceeded ?
      { contract: 'aborted', rows: rows.length, budget: account.exceeded, error: message(error) } :
      { contract: 'error', rows: rows.length, error: message(error) };
  } finally {
    account.stopClock();
    stop?.removeEventListener('abort', onStop);
  }
  return { rows, variables, receipt: receipt({ operation, input, query, sources, outcome, account, budget, started }) };
}

/**
 * One triple pattern against one graph, straight to the KGF API: `GET /fragment` for a pattern
 * of constants and variables, `QUERY /fragment` with bindings when variables are bound to rows
 * of an earlier table. Page size and bindings batch come from the endpoint's descriptor; every
 * cursor is followed, so a table is complete unless a budget or an error stopped it.
 */
export async function runFetch({ endpoint, input, pattern, bind, budget, stop }) {
  const account = newAccount(budget);
  const started = new Date();
  const rows = [];
  const onStop = () => account.fail(new Error('stopped by the user'));
  stop?.addEventListener('abort', onStop, { once: true });
  const graph = endpoint.graph(input.graph);
  const url = endpoint.link(input.graph, 'fragment');
  const caps = endpoint.descriptor.caps ?? {};
  const pageSize = caps.max_limit ?? 10_000;
  const names = Object.fromEntries(Object.entries(pattern).filter(([ , t ]) => t.variable).map(([ pos, t ]) => [ pos, t.variable ]));
  const variables = [ ...new Set(Object.values(names)) ];
  const sources = [ { kind: 'kgf', url, dataset: graph.id, version: graph.current } ];
  const extra = { pattern: Object.fromEntries(Object.entries(pattern).map(([ pos, t ]) => [ pos, t.text ])) };
  let outcome;
  let full = false;
  // Which bound values found anything: KGF tags each row with the index of the binding it
  // answers, relative to its batch. A value that matched nothing is a silent loss unless
  // it is counted here.
  const matched = new Set();
  let checked = 0;
  const keep = (page, offset) => {
    for (const raw of page.rows ?? []) {
      const row = {};
      let consistent = true;
      for (const [ pos, name ] of Object.entries(names)) {
        const t = wireTerm(raw[pos]);
        if (name in row && !sameTerm(row[name], t)) {
          consistent = false;
        }
        row[name] = t;
      }
      if (!consistent) {
        continue;
      }
      if (!account.countRow()) {
        full = true;
        return;
      }
      rows.push(row);
      if (offset !== undefined && Number.isInteger(raw.binding)) {
        matched.add(offset + raw.binding);
      }
    }
  };
  account.startClock();
  try {
    if (!bind) {
      const params = new URLSearchParams();
      for (const [ pos, t ] of Object.entries(pattern)) {
        if (!t.variable) {
          params.set(pos, t.text);
        }
      }
      params.set('limit', String(pageSize));
      let cursor = null;
      do {
        if (cursor) {
          params.set('cursor', cursor);
        }
        const page = await readJson(await account.fetch(`${url}?${params}`, { headers: { accept: 'application/json' } }));
        keep(page);
        cursor = page.complete ? null : page.next;
      } while (cursor && !full);
    } else {
      const body = { pattern: Object.fromEntries(Object.entries(pattern).map(([ pos, t ]) => [ pos, t.variable ? `?${t.variable}` : t.text ])), limit: pageSize };
      const vars = bind.variables.map(v => `?${v}`);
      extra.bindings = { table: bind.table, columns: bind.columns, tuples: bind.tuples.length, chunks: 0 };
      let offset = 0;
      for (const chunk of chunks(bind.tuples, vars, body, caps.max_bindings ?? 200, endpoint.descriptor.budgets?.max_request_bytes ?? 2 ** 20)) {
        extra.bindings.chunks++;
        let cursor = null;
        do {
          const request = { ...body, bindings: { vars, rows: chunk }, ...(cursor ? { cursor } : {}) };
          const page = await readJson(await query(endpoint, account.fetch, url, request));
          keep(page, offset);
          cursor = page.complete ? null : page.next;
        } while (cursor && !full);
        if (full) {
          break;
        }
        offset += chunk.length;
        checked = offset;
      }
    }
    if (full) {
      account.abort('max_rows', `${rows.length} rows kept`);
    }
    outcome = account.exceeded ?
      { contract: 'aborted', rows: rows.length, budget: account.exceeded } :
      { contract: 'complete', rows: rows.length };
  } catch (error) {
    outcome = account.exceeded ?
      { contract: 'aborted', rows: rows.length, budget: account.exceeded, error: message(error) } :
      { contract: 'error', rows: rows.length, error: message(error) };
  } finally {
    account.stopClock();
    stop?.removeEventListener('abort', onStop);
  }
  if (extra.bindings) {
    // Only batches that ran to the end can say a value matched nothing.
    const unmatched = [];
    for (let i = 0; i < checked; i++) {
      if (!matched.has(i)) {
        unmatched.push(i);
      }
    }
    Object.assign(extra.bindings, {
      checked,
      matched: checked - unmatched.length,
      unmatched: unmatched.length,
      unmatched_sample: unmatched.slice(0, 8).map(i => bind.tuples[i].join(' ')),
    });
  }
  return { rows, variables, receipt: receipt({ operation: 'fetch', input, sources, outcome, account, budget, started, extra }) };
}

/**
 * One label per IRI from one graph's `/labels` (doc 03 §3.4.12): the graph's declared label
 * predicates in order, one deterministic label, `null` when it has none — which includes
 * every IRI the graph does not hold. Batched by the descriptor's `max_label_iris` and
 * `max_request_bytes`.
 */
export async function lookupLabels(endpoint, graph, iris, fetch) {
  const labels = new Map();
  let complete = true;
  const url = endpoint.link(graph, 'labels');
  const maxCount = endpoint.descriptor.caps?.max_label_iris ?? 1000;
  const maxBytes = endpoint.descriptor.budgets?.max_request_bytes ?? 2 ** 20;
  let start = 0;
  while (start < iris.length) {
    let size = Math.min(maxCount, iris.length - start);
    let body;
    for (;;) {
      body = { iris: iris.slice(start, start + size).map(i => `<${i}>`) };
      if (new TextEncoder().encode(JSON.stringify(body)).length <= maxBytes || size === 1) {
        break;
      }
      size = Math.max(1, Math.floor(size / 2));
    }
    const page = await readJson(await query(endpoint, fetch, url, body));
    for (const entry of page.labels ?? []) {
      labels.set(entry.iri.value, entry.label ?? null);
    }
    complete &&= page.complete !== false;
    start += size;
  }
  return { labels, complete };
}

/**
 * Labels for IRIs a table shows, asking its graphs in order: the first label wins, and an IRI
 * no graph labels gets `null` only when every graph answered. Accounted like any run, but
 * kept apart from the table's own receipt: labels are for reading, not part of the data.
 */
export async function labelIris({ endpoint, graphs, iris, budget, stop }) {
  const account = newAccount(budget);
  const onStop = () => account.fail(new Error('stopped by the user'));
  stop?.addEventListener('abort', onStop, { once: true });
  const labels = new Map();
  let remaining = [ ...new Set(iris) ];
  let complete = true;
  let error;
  try {
    for (const graph of graphs) {
      if (remaining.length === 0) {
        break;
      }
      const answer = await lookupLabels(endpoint, graph, remaining, account.fetch);
      for (const [ iri, label ] of answer.labels) {
        if (label !== null) {
          labels.set(iri, label);
        }
      }
      complete &&= answer.complete;
      remaining = remaining.filter(i => !labels.has(i));
    }
    if (complete) {
      for (const iri of remaining) {
        labels.set(iri, null);
      }
    }
  } catch (e) {
    error = message(e);
  } finally {
    stop?.removeEventListener('abort', onStop);
  }
  return { labels, graphs, requests: account.requests.length, bytes: account.bytes, complete: complete && !error, error };
}

/** `QUERY` first; a server that refuses the method gets the same body by `POST`, remembered per endpoint. */
export async function query(endpoint, fetch, url, body) {
  const init = method => ({ method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (endpoint.queryMethod !== 'POST') {
    const response = await fetch(url, init('QUERY'));
    if (response.status !== 405 && response.status !== 501) {
      endpoint.queryMethod = 'QUERY';
      return response;
    }
    await response.body?.cancel();
    endpoint.queryMethod = 'POST';
  }
  return fetch(url, init('POST'));
}

/** Bindings in batches no larger than the server's `max_bindings` rows or `max_request_bytes`. */
export function* chunks(tuples, vars, template, maxRows, maxBytes) {
  let start = 0;
  while (start < tuples.length) {
    let size = Math.min(maxRows, tuples.length - start);
    for (;;) {
      const chunk = tuples.slice(start, start + size);
      const bytes = new TextEncoder().encode(JSON.stringify({ ...template, bindings: { vars, rows: chunk } })).length;
      if (bytes <= maxBytes || size === 1) {
        yield chunk;
        break;
      }
      size = Math.max(1, Math.floor(size / 2));
    }
    start += size;
  }
}

function sameTerm(a, b) {
  return a?.type === b?.type && a?.value === b?.value && a?.lang === b?.lang && a?.datatype === b?.datatype;
}

/** KGF request syntax for a term: IRIs bracketed, literals quoted and escaped. */
export function formatTerm(t) {
  if (t.type === 'iri') {
    return `<${t.value}>`;
  }
  if (t.type === 'bnode') {
    return `_:${t.value}`;
  }
  const body = `"${t.value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`;
  if (t.lang) {
    return `${body}@${t.lang}`;
  }
  return t.datatype && t.datatype !== XSD_STRING ? `${body}^^<${t.datatype}>` : body;
}

function toRow(bindings, variables) {
  const byName = new Map();
  for (const [ variable, value ] of bindings) {
    byName.set(variable.value, value);
  }
  return Object.fromEntries(variables.map(v => [ v, term(byName.get(v)) ]));
}

function term(t) {
  if (!t) {
    return null;
  }
  switch (t.termType) {
    case 'NamedNode':
      return { type: 'iri', value: t.value };
    case 'BlankNode':
      return { type: 'bnode', value: t.value };
    case 'Literal': {
      const out = { type: 'literal', value: t.value };
      if (t.language) {
        out.lang = t.language;
      } else if (t.datatype && t.datatype.value !== XSD_STRING) {
        out.datatype = t.datatype.value;
      }
      return out;
    }
    default:
      return { type: t.termType, value: t.value };
  }
}

/** KGF's JSON term (`{type, value, lang?, datatype?}`) is already this shape. */
export function wireTerm(t) {
  if (!t) {
    return null;
  }
  const out = { type: t.type, value: t.value };
  if (t.lang) {
    out.lang = t.lang;
  }
  if (t.datatype && t.datatype !== XSD_STRING) {
    out.datatype = t.datatype;
  }
  return out;
}

function message(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

export { readJson };
