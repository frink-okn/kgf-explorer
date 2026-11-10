// The operations. One list, two surfaces: the page renders each as a form and a button, and
// the chat hands the same list to the model as its tools. A model's call and a person's
// click go through one function, land as one kind of table, and write one kind of log record.

import { RECEIPT_SCHEMA, chunks, formatTerm, lookupLabels, query, readJson, runDirect, runFetch, runSparql, wireTerm } from './kgf.js';
import { RDF_OBJECT, RDF_PREDICATE, RDF_SUBJECT, RDF_TYPE, cliqueOf, getJson, histogramOf, labelOf, link, presenceOf, rowsOf, skolem, valuesOf } from './links.js';
import { TEMPLATES, iri, limit } from './templates.js';
import { termsFromSql } from './terms.js';

const GRAPHS = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  maxItems: 4,
  description: 'Graph ids from list_graphs. Two or more graphs are queried together: each pattern is matched in every graph, which is how a join crosses graphs that share IRIs. terms and count say which graphs share them.',
};
// For operations that ask every graph at once: one cheap request each, so no cap of four.
const ANY_GRAPHS = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Graph ids from list_graphs. Default: every graph.' };
const GRAPH = { type: 'string', description: 'A graph id from list_graphs.' };
const LIMIT = { type: 'integer', minimum: 1, description: 'Maximum rows (default 200; at most the endpoint\'s max_output_rows).' };
const TERM = (position, example) => ({ type: 'string', examples: [ example ], description: `The ${position}: ?name for a variable (it becomes a column), an IRI, or a quoted literal such as "20695" or "asthma"@en. Omit for an unnamed variable.` });
const GRADES = [ 'asserted', 'external', 'sparql', 'bundle' ];
// Client budgets for where and connections, named as budgets: identifiers counted across
// graphs, graphs connections reads, predicates each way whose far ends it samples, and that sample's size.
const WHERE_IRIS = 40;
const LINK_GRAPHS = 8;
const LINK_ENDS = 12;
const END_SAMPLE = 100;
const IRI = description => ({ type: 'string', description: `${description} An absolute IRI, as it appears in an earlier result.` });
const DIRECTION = { type: 'string', enum: [ 'out', 'in' ], description: '"out" follows the predicate from the known node to the new one; "in" follows it backwards.' };
const COUNT_TERM = (position, example) => ({ type: 'string', examples: [ example ], description: `The ${position}: an IRI, a quoted literal such as "20695" or "asthma"@en, or ?name to take the values bind gives it. Omit to match any ${position}.` });
const BIND = {
  type: 'object',
  properties: { table: { type: 'string' }, columns: { type: 'object', additionalProperties: { type: 'string' } } },
  required: [ 'table', 'columns' ],
};

function schema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function sparqlTool(name, title, description, properties, required) {
  return {
    name,
    title,
    description,
    input_schema: schema({ graphs: GRAPHS, ...properties, limit: LIMIT }, [ 'graphs', ...required ]),
    run: async(input, ctx) => {
      const template = TEMPLATES[name];
      const graphs = checkGraphs(input.graphs, ctx.endpoint);
      const query = template.build(input, maxOutputRows(ctx.endpoint));
      return runSparql({ endpoint: ctx.endpoint, operation: name, input, query, variables: template.variables, graphs, budget: ctx.budget, stop: ctx.stop });
    },
  };
}

function maxOutputRows(endpoint) {
  return endpoint.descriptor.budgets?.max_output_rows ?? 100_000;
}

/** One position of a fetch pattern, in KGF request syntax. */
export function position(value, pos) {
  if (value === undefined || value === null || value === '') {
    return { variable: pos, text: `?${pos}` };
  }
  if (typeof value !== 'string') {
    throw new Error(`${pos} must be a string`);
  }
  const v = value.trim();
  const variable = /^\?([A-Za-z_][A-Za-z0-9_]*)$/u.exec(v);
  if (variable) {
    return { variable: variable[1], text: v };
  }
  if (/^<.*>$/su.test(v) || /^https?:\/\//u.test(v)) {
    return { text: iri(v, pos) };
  }
  if (/^"(?:[^"\\]|\\.)*"(?:@[A-Za-z]+(?:-[A-Za-z0-9]+)*|\^\^<[^<>\s]+>)?$/u.test(v)) {
    return { text: v };
  }
  throw new Error(`${pos} must be ?variable, an IRI, or a quoted literal such as "20695"; got ${JSON.stringify(value)}`);
}

/** The distinct tuples of an earlier table's columns, as bindings for the pattern's variables. */
function resolveBind(bind, pattern, workspace) {
  if (bind === undefined || bind === null) {
    return null;
  }
  if (typeof bind !== 'object' || typeof bind.table !== 'string' || !bind.columns || typeof bind.columns !== 'object') {
    throw new Error('bind must look like {"table": "t4", "columns": {"z": "s"}}: pattern variable → column of that table');
  }
  const table = workspace.table(bind.table);
  if (!table) {
    throw new Error(`no table ${JSON.stringify(bind.table)}`);
  }
  const used = new Set(Object.values(pattern).filter(t => t.variable).map(t => t.variable));
  const variables = Object.keys(bind.columns);
  if (variables.length === 0) {
    throw new Error('bind.columns must name at least one pattern variable');
  }
  for (const v of variables) {
    if (!used.has(v)) {
      throw new Error(`bind names ?${v}, which the pattern does not use`);
    }
    if (!table.variables.includes(bind.columns[v])) {
      throw new Error(`table ${bind.table} has no column ${JSON.stringify(bind.columns[v])}; its columns are ${table.variables.join(', ') || 'none'}`);
    }
  }
  const seen = new Set();
  const tuples = [];
  const values = [];
  for (const row of table.rows) {
    const terms = variables.map(v => row[bind.columns[v]]);
    if (terms.some(t => !t)) {
      continue;
    }
    const formatted = terms.map(formatTerm);
    const key = formatted.join('\u0000');
    if (!seen.has(key)) {
      seen.add(key);
      tuples.push(formatted);
      values.push(terms);
    }
  }
  // tuples in request syntax, values as the terms themselves, index for index.
  return { table: bind.table, columns: bind.columns, variables, tuples, values };
}

/** The graphs an every-graph operation asks: those named, or every graph that offers `link`. */
function graphsOrAll(graphs, endpoint, link) {
  if (graphs === undefined || graphs === null || (Array.isArray(graphs) && graphs.length === 0)) {
    return [ ...endpoint.graphs.values() ].filter(d => d.links?.[link]).map(d => d.id);
  }
  if (!Array.isArray(graphs)) {
    throw new Error('graphs must be a list of graph ids');
  }
  for (const g of graphs) {
    endpoint.link(g, link);
  }
  return [ ...new Set(graphs) ];
}

/**
 * Runs `work` on each item a few at a time, past any that fail: a graph that does not answer
 * is named, not fatal. Once a run is over budget or stopped every later request fails at
 * once, so the rest settle quickly.
 */
async function settleEach(items, work, width = 8) {
  const failures = [];
  let next = 0;
  const worker = async() => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await work(item);
      } catch (error) {
        failures.push({ graph: item.graph ?? item, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return failures;
}

/** The first few failures verbatim, by graph; undefined when every graph answered. */
function failureText(failures) {
  if (!failures.length) {
    return undefined;
  }
  const graphs = [ ...new Set(failures.map(f => f.graph)) ];
  const named = graphs.length > 10 ? `${graphs.slice(0, 10).join(', ')}, and ${graphs.length - 10} more` : graphs.join(', ');
  // One line per distinct error: a budget stops every graph with the same one.
  const distinct = [ ...new Map(failures.map(f => [ f.error, f ])).values() ];
  const shown = distinct.slice(0, 3).map(f => `${f.graph}: ${f.error.length > 1000 ? `${f.error.slice(0, 1000)}…` : f.error}`);
  return `${graphs.length} graph${graphs.length === 1 ? '' : 's'} did not answer in full (${named}).\n${shown.join('\n')}` +
    (distinct.length > shown.length ? `\n…and ${distinct.length - shown.length} more distinct errors` : '');
}

/** "N graphs", or "N graphs answered" when some did not: a denominator counts only answers. */
function answeredOf(answered, asked) {
  return answered === asked ? `${asked} graphs` : `${answered} graphs answered (of ${asked} asked)`;
}

/** Keeps a row under the visitor's row budget, or ends the run there. */
function keepRow(account) {
  if (!account.countRow()) {
    account.abort('max_rows', `${account.rows} rows kept`);
    throw account.signal.reason;
  }
}

/** "a 3, b 2, …": the first ten of a graph → number list, largest first. */
function perGraph(entries) {
  const sorted = [ ...entries ].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 10).map(([ g, n ]) => `${g} ${n.toLocaleString('en-US')}`).join(', ');
  return sorted.length > 10 ? `${shown}, and ${sorted.length - 10} more` : shown;
}

/** kgfq D17: a derived table's grade is the lowest grade among the tables it read. */
function lowestGrade(inputs) {
  if (inputs.length === 0) {
    return 'asserted';
  }
  return inputs.map(i => i.grade).reduce((a, b) => (GRADES.indexOf(a) <= GRADES.indexOf(b) ? a : b));
}

async function runSql(input, ctx) {
  const started = new Date();
  let result = { variables: [], rows: [], reads: [] };
  let outcome;
  try {
    const raw = await ctx.sql.select(input.query, ctx.budget.maxRows ?? maxOutputRows(ctx.endpoint));
    const read = raw.reads.map(name => ctx.workspace.table(name.toLowerCase())).filter(Boolean);
    result = { ...raw, ...termsFromSql(raw.names, raw.rows, read) };
    outcome = result.truncated ?
      { contract: 'aborted', rows: result.rows.length, budget: 'max_rows' } :
      { contract: 'complete', rows: result.rows.length };
    const plain = Object.entries(result.plain ?? {});
    if (plain.length) {
      // Stated, never guessed (kgfq C6): the page never reads an IRI off a value's shape, so it says
      // which columns are text and how to make them IRIs.
      const [ first ] = plain[0];
      outcome.note = `Plain text, not IRIs: ${plain.map(([ c, n ]) => `${c} (${n.toLocaleString('en-US')} of ${result.rows.length.toLocaleString('en-US')} rows)`).join(', ')}. ` +
        `These values had no ${first}_kind beside them and are not in the tables read with one kind. If they are IRIs, select 'iri' AS ${first}_kind with ${first}.`;
    }
  } catch (error) {
    outcome = { contract: 'error', rows: 0, error: error instanceof Error ? error.message : String(error) };
  }
  // The parser also names CTEs; only the session's own tables are inputs.
  const inputs = [ ...new Set(result.reads.map(name => name.toLowerCase())) ]
    .filter(id => ctx.workspace.table(id))
    .map(id => ({ table: id, grade: ctx.workspace.table(id).receipt.grade ?? 'asserted' }));
  // A derived table's IRIs come from the graphs its inputs came from; that is where to label them.
  const graphs = [ ...new Set(inputs.flatMap(i => ctx.workspace.table(i.table).graphs)) ];
  const finished = new Date();
  return {
    variables: result.variables,
    rows: result.rows,
    graphs,
    receipt: {
      schema: RECEIPT_SCHEMA,
      operation: 'sql',
      input,
      grade: lowestGrade(inputs),
      query: input.query,
      inputs,
      sources: [],
      outcome,
      requests: [],
      totals: { requests: 0, bindings_requests: 0, bytes: 0, elapsed_ms: finished.getTime() - started.getTime() },
      engine: { duckdb: ctx.sql.version ?? null, runtime: 'browser' },
      started: started.toISOString(),
      finished: finished.toISOString(),
    },
  };
}

function checkGraphs(graphs, endpoint) {
  if (!Array.isArray(graphs) || graphs.length === 0 || graphs.length > 4) {
    throw new Error('graphs must list one to four graph ids');
  }
  for (const g of graphs) {
    endpoint.graph(g);
  }
  return graphs;
}

export const TOOLS = [
  {
    name: 'list_graphs',
    title: 'List graphs',
    description: 'Every graph this endpoint serves: id, title, size in triples, and the release pinned for this session. Start here to choose graphs.',
    input_schema: schema({}, []),
    run: async(input, ctx) => runDirect({
      operation: 'list_graphs', input, budget: ctx.budget, stop: ctx.stop,
      call: async() => ({
        variables: [ 'graph', 'title', 'triples', 'release', 'description' ],
        rows: [ ...ctx.endpoint.graphs.values() ].map(d => ({
          graph: lit(d.id), title: lit(d.title), triples: lit(String(d.triples)), release: lit(d.current), description: lit(d.description ?? ''),
        })),
      }),
    }),
  },
  {
    name: 'graph_summary',
    title: 'Graph summary',
    description: 'The graph\'s summary card, written by the server from its statistics: description, counts, the largest classes and predicates with their counts, the leading class→predicate→class relations, and every namespace the graph declares with its IRIs by position. It lists only the largest classes; schema lists everything. Read it before choosing predicates or classes for a query.',
    input_schema: schema({ graph: GRAPH }, [ 'graph' ]),
    run: async(input, ctx) => runDirect({
      operation: 'graph_summary', input, budget: ctx.budget, stop: ctx.stop,
      call: async fetch => {
        const url = new URL(ctx.endpoint.link(input.graph, 'summary'));
        url.searchParams.set('format', 'md');
        const response = await fetch(url.href, { headers: { accept: 'text/markdown' } });
        let text = await response.text();
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText} from ${url.href}\n${text}`);
        }
        // The Markdown card leaves out the namespace inventory its JSON form carries.
        if (!/^## Namespaces/mu.test(text)) {
          const json = await readJson(await fetch(ctx.endpoint.link(input.graph, 'summary'), { headers: { accept: 'application/json' } }));
          if (json.namespaces?.namespaces) {
            text = `${text.trimEnd()}\n\n${namespaceSection(json.namespaces)}\n`;
          }
        }
        return { variables: [], rows: [], text };
      },
    }),
  },
  {
    name: 'search',
    title: 'Search',
    description: 'Full-text search over one graph\'s literals (labels first). Returns matching subjects with their label and the literal that matched. Use it to turn a name into an IRI.',
    input_schema: schema({ graph: GRAPH, text: { type: 'string', description: 'Words to find.' }, limit: { ...LIMIT, description: 'Maximum hits (default 20).' } }, [ 'graph', 'text' ]),
    run: async(input, ctx) => runDirect({
      operation: 'search', input, budget: ctx.budget, stop: ctx.stop,
      call: async fetch => {
        if (typeof input.text !== 'string' || !input.text.trim()) {
          throw new Error('text must be a non-empty string');
        }
        const url = new URL(ctx.endpoint.link(input.graph, 'search'));
        url.searchParams.set('q', input.text.trim());
        url.searchParams.set('limit', String(input.limit ?? 20));
        const body = await readJson(await fetch(url.href, { headers: { accept: 'application/json' } }));
        return {
          variables: [ 'subject', 'label', 'predicate', 'matched', 'score' ],
          rows: body.results.map(r => ({
            subject: wireTerm(r.subject),
            label: r.label === null || r.label === undefined ? null : lit(r.label),
            predicate: r.match?.predicate ? { type: 'iri', value: r.match.predicate } : null,
            matched: r.match?.literal === undefined ? null : lit(r.match.literal),
            score: lit(String(r.score)),
          })),
        };
      },
    }),
  },
  {
    name: 'where',
    title: 'Where an entity is',
    mapOnly: true,
    description: 'Every graph that holds an entity, under each identifier for it: the IRI given; the identifiers Babel lists as the same thing (its clique); and IRIs labeled with the same words in any graph, which share a name and are not checked to be the same thing. Each row is one identifier in one graph, with the triples it is subject and object of there. Call it first on the thing a question is about: a graph may hold it only under another identifier (spoke-okn holds asthma as DOID:2841, other graphs as MONDO:0004979, digcfdekg as its own trait nodes).',
    input_schema: schema({ iri: IRI('The entity.') }, [ 'iri' ]),
    run: async(input, ctx) => {
      const target = iri(input.iri, 'iri').slice(1, -1);
      return runDirect({
        operation: 'where', input, budget: ctx.budget, stop: ctx.stop,
        call: (fetch, account) => whereRows({ endpoint: ctx.endpoint, target }, fetch, account),
      });
    },
  },
  {
    name: 'connections',
    title: 'Connections of an entity',
    mapOnly: true,
    description: `Everything that links one entity, in each graph that holds it, exactly: every predicate it has as subject (out) and as object (in), with its triple count, from each graph's own index. For the ${LINK_ENDS} largest each way, what is at the other end: the classes of a sample, or for statements reached by rdf:subject or rdf:object, their rdf:predicate. Use it to see how a thing connects before choosing a path; describe and incoming show only their first rows, which a large predicate can fill. Default graphs: those that hold the IRI, most triples first, up to ${LINK_GRAPHS}.`,
    input_schema: schema({ iri: IRI('The entity.'), graphs: ANY_GRAPHS }, [ 'iri' ]),
    run: async(input, ctx) => {
      const target = iri(input.iri, 'iri').slice(1, -1);
      const graphs = input.graphs?.length ? graphsOrAll(input.graphs, ctx.endpoint, 'count') : null;
      return runDirect({
        operation: 'connections', input, budget: ctx.budget, stop: ctx.stop,
        call: (fetch, account) => linksRows({ endpoint: ctx.endpoint, target, graphs }, fetch, account),
      });
    },
  },
  {
    name: 'count',
    title: 'Count a pattern',
    description: 'The exact number of triples matching one pattern, from each graph\'s index, one request per graph. Any of subject, predicate, object may be left out. Without graphs every graph is asked, and only graphs with matches are kept: that says which graphs use a predicate or hold an IRI. With bind, a ?variable takes the distinct values of an earlier table\'s column, as in fetch, and each value gets its own count in each graph: subject "?x" bound to a column of IRIs says where each one is described, object "?x" where each one is pointed at. The result says how many values matched in no graph. Every value is answered by every graph asked, so for a large column narrow the graphs with terms first. Count before fetching anything that could be large.',
    input_schema: schema({
      graphs: ANY_GRAPHS,
      subject: COUNT_TERM('subject', '?x'),
      predicate: COUNT_TERM('predicate', '<https://w3id.org/secure-chain/dependsOn>'),
      object: COUNT_TERM('object', '"asthma"@en'),
      bind: { ...BIND, description: 'Optional. {"table": "t1", "columns": {"x": "source"}} binds the pattern\'s ?x to the values of t1\'s column source.' },
    }, []),
    run: async(input, ctx) => {
      const graphs = graphsOrAll(input.graphs, ctx.endpoint, 'count');
      const pattern = { s: position(input.subject, 's'), p: position(input.predicate, 'p'), o: position(input.object, 'o') };
      const bind = resolveBind(input.bind, pattern, ctx.workspace);
      for (const v of bind?.variables ?? []) {
        if ([ 'graph', 'count', 'exact' ].includes(v)) {
          throw new Error(`?${v} names a column count adds; bind another name`);
        }
      }
      return runDirect({
        operation: 'count', input, budget: ctx.budget, stop: ctx.stop,
        call: (fetch, account) => (bind ?
          countBound({ endpoint: ctx.endpoint, graphs, pattern, bind }, fetch, account) :
          countPlain({ endpoint: ctx.endpoint, graphs, pattern }, fetch)),
      });
    },
  },
  {
    name: 'terms',
    title: 'Namespaces in graphs',
    description: 'Which graphs use a namespace, from each graph\'s term dictionary: the exact number of distinct IRIs under each prefix, as subject, predicate and object, one request per graph per prefix. A prefix is the start of an IRI, matched byte for byte: a namespace (http://purl.obolibrary.org/obo/MONDO_), a site (https://climatepub4kg.github.io/), or a whole IRI, which also matches longer IRIs that begin with it. Graphs that hold the same IRIs join directly; this is how to find them, and which graphs use an identifier scheme at all. Another graph\'s namespace as subjects means this graph describes its entities; as objects, that it points at them. Vocabularies such as rdf, rdfs, owl and schema.org are in many graphs and say nothing about overlap. A graph\'s own namespaces are in its graph_summary; overlap checks them for two to four graphs, both ways. With list, the terms themselves from each graph that uses the prefix.',
    input_schema: schema({
      prefixes: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, examples: [ [ 'https://climatepub4kg.github.io/' ] ], description: 'One to eight prefixes: the start of IRIs, written bare (no angle brackets).' },
      graphs: ANY_GRAPHS,
      list: { type: 'integer', minimum: 1, description: 'Optional. Also list up to this many terms under each prefix in each graph that uses it, in dictionary order, with their positions (at most the endpoint\'s max_limit). Without it, counts only.' },
      role: { type: 'string', enum: [ 'any', 'subject', 'predicate', 'object' ], description: 'With list: only terms in this position. Default any.' },
    }, [ 'prefixes' ]),
    run: async(input, ctx) => {
      const prefixes = prefixList(input.prefixes);
      const graphs = graphsOrAll(input.graphs, ctx.endpoint, 'terms');
      const maxList = ctx.endpoint.descriptor.caps?.max_limit ?? 10_000;
      if (input.list !== undefined && input.list !== null && (!Number.isInteger(input.list) || input.list < 1 || input.list > maxList)) {
        throw new Error(`list must be an integer from 1 to ${maxList}, this endpoint's max_limit`);
      }
      const role = input.role ?? 'any';
      if (![ 'any', 'subject', 'predicate', 'object' ].includes(role)) {
        throw new Error('role must be any, subject, predicate or object');
      }
      return runDirect({
        operation: 'terms', input, budget: ctx.budget, stop: ctx.stop,
        call: (fetch, account) => termCounts({ endpoint: ctx.endpoint, graphs, prefixes, list: input.list ?? 0, role }, fetch, account),
      });
    },
  },
  {
    name: 'overlap',
    title: 'Where graphs overlap',
    description: 'Whether two to four graphs hold the same IRIs, checked both ways: each graph\'s own namespaces (those its summary lists with subjects) are counted in each of the others, from their term dictionaries. A row is one graph\'s namespace that another graph holds as subjects or objects, with the counts and one example IRI; terms with list gives the rest, and fetch, count with bind, or a template over both graphs follows them. Shared vocabularies (W3C, Dublin Core, FOAF, VANN, schema.org) are skipped, and a namespace another graph uses only for predicates is counted in the note, not shown. IRIs a graph holds under no namespace it declares are not checked. No rows means no shared identifiers under these namespaces; the graphs may still share values, which sql joins.',
    input_schema: schema({ graphs: { ...GRAPHS, minItems: 2, description: 'Two to four graph ids from list_graphs.' } }, [ 'graphs' ]),
    run: async(input, ctx) => {
      const graphs = [ ...new Set(checkGraphs(input.graphs, ctx.endpoint)) ];
      if (graphs.length < 2) {
        throw new Error('overlap needs two to four different graphs');
      }
      for (const g of graphs) {
        ctx.endpoint.link(g, 'summary');
        ctx.endpoint.link(g, 'terms');
      }
      return runDirect({
        operation: 'overlap', input, budget: ctx.budget, stop: ctx.stop,
        call: (fetch, account) => overlapOf({ endpoint: ctx.endpoint, graphs }, fetch, account),
      });
    },
  },
  {
    name: 'schema',
    title: 'Schema',
    description: 'A graph\'s schema, computed by the server from the data. With only graph: every class, with its entity count. With a class: the predicates its entities use, with triple counts. With a class and one of its predicates: the classes and datatypes of its objects, with counts. graph_summary shows only the largest classes; this lists all of them.',
    input_schema: schema({ graph: GRAPH, class: IRI('A class, to list the predicates its entities use.'), predicate: IRI('A predicate, to list what its objects are.') }, [ 'graph' ]),
    run: async(input, ctx) => runDirect({
      operation: 'schema', input, budget: ctx.budget, stop: ctx.stop,
      call: async fetch => {
        const cls = input.class ? { class: iri(input.class, 'class') } : {};
        if (input.predicate) {
          const selector = { ...cls, predicate: iri(input.predicate, 'predicate') };
          const classes = await schemaItems(fetch, ctx.endpoint, input.graph, { ...selector, children: 'object-classes' });
          const datatypes = await schemaItems(fetch, ctx.endpoint, input.graph, { ...selector, children: 'datatypes' });
          const c = classes.node?.counts ?? {};
          return {
            variables: [ 'object_kind', 'object', 'triples' ],
            rows: [
              ...classes.items.sort(byTriples).map(i => ({ object_kind: lit('class'), object: i.term, triples: count(i.counts?.triples) })),
              ...datatypes.items.sort(byTriples).map(i => ({ object_kind: lit('datatype'), object: i.term, triples: count(i.counts?.triples) })),
            ],
            note: `${input.predicate}${input.class ? ` on ${input.class}` : ''}: ${c.triples ?? '?'} triples` +
              (c.distinct_subjects === undefined ? '' : `, ${c.distinct_subjects} distinct subjects`) +
              (c.distinct_objects === undefined ? '' : `, ${c.distinct_objects} distinct objects`) +
              (classes.items.length || datatypes.items.length ? '' : input.class ?
                '. No object classes or datatypes: the objects are IRIs with no rdf:type in this graph.' :
                '. This server lists object classes and datatypes only beneath a class: give the class too.'),
          };
        }
        if (input.class) {
          const { node, items } = await schemaItems(fetch, ctx.endpoint, input.graph, { ...cls, children: 'properties' });
          return {
            variables: [ 'predicate', 'triples' ],
            rows: items.sort(byTriples).map(i => ({ predicate: i.term, triples: count(i.counts?.triples) })),
            note: `${input.class}: ${node?.counts?.entities ?? '?'} entities`,
          };
        }
        const { items } = await schemaItems(fetch, ctx.endpoint, input.graph, { children: 'classes' });
        return {
          variables: [ 'class', 'entities', 'triples' ],
          rows: items
            .sort((a, b) => Number(b.counts?.entities ?? 0) - Number(a.counts?.entities ?? 0))
            .map(i => ({ class: i.term, entities: count(i.counts?.entities), triples: count(i.counts?.triples) })),
        };
      },
    }),
  },
  sparqlTool('describe', 'Describe an entity',
    'Every triple with this IRI as subject: its properties and values.',
    { iri: IRI('The entity.') }, [ 'iri' ]),
  sparqlTool('incoming', 'Incoming links',
    'Every triple with this IRI as object: who points at it, and by which predicate.',
    { iri: IRI('The entity.') }, [ 'iri' ]),
  sparqlTool('instances', 'Instances of a class',
    'Members of a class (rdf:type).',
    { class: IRI('The class.') }, [ 'class' ]),
  sparqlTool('neighbors', 'Follow a predicate',
    'The nodes one predicate reaches from an entity.',
    { iri: IRI('The starting entity.'), predicate: IRI('The predicate to follow.'), direction: DIRECTION }, [ 'iri', 'predicate' ]),
  sparqlTool('two_hop', 'Two-hop path',
    'Follow predicate1 from start to ?mid, then predicate2 from ?mid to ?end. With two graphs, each hop can come from a different graph: that is a cross-graph join on ?mid\'s IRI.',
    { start: IRI('The starting entity.'), predicate1: IRI('First predicate.'), direction1: DIRECTION, predicate2: IRI('Second predicate.'), direction2: DIRECTION },
    [ 'start', 'predicate1', 'predicate2' ]),
  {
    name: 'fetch',
    title: 'Fetch a pattern',
    description: 'Every triple matching one pattern in one graph, as a table whose columns are the pattern\'s ?variables. Pages to the end. With bind, a variable is bound to the distinct values of a column of an earlier table, sent to the server in batches: this is how a result carries forward into the next step (ZIP areas → their districts). The result says how many bound values matched nothing, with a sample of them. Fetch a pattern whole when count says it is small; bind a column when the pattern is large and the column is small.',
    input_schema: schema({
      graph: GRAPH,
      subject: TERM('subject', '?prov'),
      predicate: TERM('predicate', '<https://schema.org/postalCode>'),
      object: TERM('object', '?zip'),
      bind: { ...BIND, description: 'Optional. {"table": "t4", "columns": {"z": "s"}} binds the pattern\'s ?z to the values of t4\'s column s.' },
    }, [ 'graph' ]),
    run: async(input, ctx) => {
      const pattern = { s: position(input.subject, 's'), p: position(input.predicate, 'p'), o: position(input.object, 'o') };
      const bind = resolveBind(input.bind, pattern, ctx.workspace);
      return runFetch({ endpoint: ctx.endpoint, input, pattern, bind, budget: ctx.budget, stop: ctx.stop });
    },
  },
  {
    name: 'sql',
    title: 'SQL over tables',
    description: 'One DuckDB SELECT over this session\'s tables, which are SQL tables named t1, t2, …. Each term column x holds the value as text (CAST for arithmetic) beside x_kind (iri, literal or bnode), x_lang and x_datatype. A result column keeps its kind when you select x_kind with it, or when its values appear in the tables read with one kind each; other text comes back as a plain literal, and the result says which columns did; to make IRIs from text, select \'iri\' AS x_kind beside x. Numbers come back as typed literals. Use it to join tables, filter, group and count. The result is a new table. Nothing outside the session\'s tables can be read.',
    input_schema: schema({ query: { type: 'string', description: 'A single SELECT; WITH … SELECT is fine.' } }, [ 'query' ]),
    run: runSql,
  },
  {
    name: 'labels',
    title: 'Labels for a column',
    description: 'One label per IRI in a column of an earlier table, as a new table (iri, label) to join in sql: for when names must be part of the data, such as a final answer. Each graph picks the label by its own declared label predicates; an IRI a graph does not hold gets none from it. Results already come with labels for reading; this is for tables.',
    input_schema: schema({
      table: { type: 'string', description: 'An earlier table, t1, t2, ….' },
      column: { type: 'string', description: 'Its column of IRIs.' },
      graphs: { ...GRAPHS, description: 'Graphs to ask, in order; the first label found wins. Default: the graphs the table came from.' },
    }, [ 'table', 'column' ]),
    run: async(input, ctx) => {
      const source = ctx.workspace.table(input.table);
      if (!source) {
        throw new Error(`no table ${JSON.stringify(input.table)}`);
      }
      if (!source.variables.includes(input.column)) {
        throw new Error(`table ${input.table} has no column ${JSON.stringify(input.column)}; its columns are ${source.variables.join(', ') || 'none'}`);
      }
      const graphs = input.graphs ? checkGraphs(input.graphs, ctx.endpoint) : source.graphs;
      if (!graphs.length) {
        throw new Error(`table ${input.table} came from no graph; name the graphs to ask`);
      }
      const iris = [ ...new Set(source.rows.map(r => r[input.column]).filter(t => t?.type === 'iri').map(t => t.value)) ];
      const result = await runDirect({
        operation: 'labels', input, budget: ctx.budget, stop: ctx.stop,
        call: async fetch => {
          const found = new Map();
          let remaining = iris;
          for (const graph of graphs) {
            if (!remaining.length) {
              break;
            }
            const answer = await lookupLabels(ctx.endpoint, graph, remaining, fetch);
            for (const [ iri, label ] of answer.labels) {
              if (label !== null) {
                found.set(iri, label);
              }
            }
            remaining = remaining.filter(i => !found.has(i));
          }
          return {
            variables: [ 'iri', 'label' ],
            rows: iris.map(i => ({ iri: { type: 'iri', value: i }, label: found.has(i) ? lit(found.get(i)) : null })),
            note: `${found.size} of ${iris.length} IRIs labeled, asking ${graphs.join(', then ')}`,
          };
        },
      });
      return { ...result, graphs };
    },
  },
  {
    name: 'read_table',
    title: 'Read a table',
    description: 'Rows of a table already in this session, by id (t1, t2, …). Tool results show only a preview; use this to read further rows.',
    llmOnly: true,
    input_schema: schema({ table: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, [ 'table' ]),
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map(t => [ t.name, t ]));

/** Full mode's tools, which the gate's manifest signs: map mode's own operations are not among them (D19). */
export const FULL_TOOLS = TOOLS.filter(t => !t.mapOnly);

function lit(value) {
  return { type: 'literal', value: String(value) };
}

function count(value) {
  return value === undefined || value === null ? null : { type: 'literal', value: String(value), datatype: 'http://www.w3.org/2001/XMLSchema#integer' };
}

/** One `/schema` selector, every page of its items, in the design view the summary card uses. */
async function schemaItems(fetch, endpoint, graph, params) {
  const items = [];
  let node = null;
  let cursor = null;
  do {
    const url = new URL(endpoint.link(graph, 'schema'));
    for (const [ key, value ] of Object.entries({ ...params, view: 'design', limit: String(endpoint.descriptor.caps?.max_schema_items ?? 1000) })) {
      url.searchParams.set(key, value);
    }
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }
    const page = await readJson(await fetch(url.href, { headers: { accept: 'application/json' } }));
    node ??= page.node ?? null;
    items.push(...page.items ?? []);
    cursor = page.complete ? null : page.next;
  } while (cursor);
  return { node, items };
}

const byTriples = (a, b) => Number(b.counts?.triples ?? 0) - Number(a.counts?.triples ?? 0);

/** One `/count` per graph; a graph's row is kept when it matched, or when it was the only one asked. */
async function countPlain({ endpoint, graphs, pattern }, fetch) {
  const answers = new Map();
  const failures = await settleEach(graphs, async graph => {
    const url = new URL(endpoint.link(graph, 'count'));
    for (const [ pos, t ] of Object.entries(pattern)) {
      if (!t.variable) {
        url.searchParams.set(pos, t.text);
      }
    }
    answers.set(graph, await readJson(await fetch(url.href, { headers: { accept: 'application/json' } })));
  });
  const n = graph => Number(answers.get(graph).count.value);
  const kept = graphs.filter(g => answers.has(g) && (graphs.length === 1 || n(g) > 0)).sort((a, b) => n(b) - n(a));
  return {
    variables: [ 'graph', 'subject', 'predicate', 'object', 'count', 'exact' ],
    rows: kept.map(g => {
      const body = answers.get(g);
      return {
        graph: lit(g), subject: patternTerm(body.pattern.s), predicate: patternTerm(body.pattern.p), object: patternTerm(body.pattern.o),
        count: count(body.count.value), exact: lit(String(body.count.exact)),
      };
    }),
    graphs: kept,
    note: graphs.length === 1 ? undefined : `${kept.length} of ${answeredOf(answers.size, graphs.length)} have matching triples${kept.length ? `: ${perGraph(kept.map(g => [ g, n(g) ]))}` : ''}`,
    error: failureText(failures),
  };
}

/**
 * Bound counts (kgf-navigator N5): one `QUERY /count` per graph per batch of bindings, one
 * count per bound value. Every graph answers for every value, zeros included, so the bytes
 * grow with values × graphs; only values that matched become rows.
 */
async function countBound({ endpoint, graphs, pattern, bind }, fetch, account) {
  const caps = endpoint.descriptor.caps ?? {};
  const vars = bind.variables.map(v => `?${v}`);
  const template = { pattern: Object.fromEntries(Object.entries(pattern).map(([ pos, t ]) => [ pos, t.variable ? `?${t.variable}` : t.text ])) };
  const batches = [ ...chunks(bind.tuples, vars, template, caps.max_bindings ?? 200, endpoint.descriptor.budgets?.max_request_bytes ?? 2 ** 20) ];
  const offsets = batches.map((_, b) => batches.slice(0, b).reduce((n, rows) => n + rows.length, 0));
  const found = new Map(graphs.map(g => [ g, new Map() ]));
  const answered = batches.map(() => 0);
  const work = graphs.flatMap(graph => batches.map((_, b) => ({ graph, b })));
  const failures = await settleEach(work, async ({ graph, b }) => {
    const body = await readJson(await query(endpoint, fetch, endpoint.link(graph, 'count'), { ...template, bindings: { vars, rows: batches[b] } }));
    for (const c of body.counts ?? []) {
      if (Number(c.count?.value ?? 0) > 0) {
        keepRow(account);
        found.get(graph).set(offsets[b] + c.binding, c.count);
      }
    }
    answered[b]++;
  });
  // Only batches every graph answered can say a value matched nowhere.
  let checked = 0;
  const unmatched = [];
  const matchedAnywhere = new Set([ ...found.values() ].flatMap(m => [ ...m.keys() ]));
  batches.forEach((rows, b) => {
    if (answered[b] === graphs.length) {
      checked += rows.length;
      for (let i = offsets[b]; i < offsets[b] + rows.length; i++) {
        if (!matchedAnywhere.has(i)) {
          unmatched.push(i);
        }
      }
    }
  });
  const holding = graphs.filter(g => found.get(g).size).sort((a, b) => found.get(b).size - found.get(a).size);
  const rows = holding.flatMap(g => [ ...found.get(g) ].sort((a, b) => a[0] - b[0]).map(([ i, c ]) => ({
    ...Object.fromEntries(bind.variables.map((v, k) => [ v, bind.values[i][k] ])),
    graph: lit(g), count: count(c.value), exact: lit(String(c.exact)),
  })));
  return {
    variables: [ ...bind.variables, 'graph', 'count', 'exact' ],
    rows,
    graphs: holding,
    note: `${matchedAnywhere.size} of ${bind.tuples.length} bound values matched, in ${holding.length} of ${answeredOf(graphs.length - new Set(failures.map(f => f.graph)).size, graphs.length)}` +
      (holding.length ? `; values matched per graph: ${perGraph(holding.map(g => [ g, found.get(g).size ]))}` : ''),
    extra: {
      bindings: {
        table: bind.table, columns: bind.columns, tuples: bind.tuples.length, chunks: batches.length, graphs: graphs.length,
        checked, matched: checked - unmatched.length, unmatched: unmatched.length,
        unmatched_sample: unmatched.slice(0, 8).map(i => bind.tuples[i].join(' ')),
      },
    },
    error: failureText(failures),
  };
}

/** Prefixes as given, or space-separated from the page's form; brackets dropped. */
function prefixList(value) {
  const list = typeof value === 'string' ? value.split(/\s+/u) : value;
  if (!Array.isArray(list)) {
    throw new Error('prefixes must be a list of IRI prefixes');
  }
  const out = [ ...new Set(list.map(p => (typeof p === 'string' ? p.trim().replace(/^<|>$/gu, '') : p)).filter(p => p !== '')) ];
  if (out.length === 0 || out.length > 8) {
    throw new Error('prefixes must list one to eight IRI prefixes');
  }
  for (const p of out) {
    if (typeof p !== 'string' || /\s/u.test(p)) {
      throw new Error(`a prefix is the start of an IRI with no spaces; got ${JSON.stringify(p)}`);
    }
  }
  return out;
}

/**
 * `/terms` (doc 03 §3.4.8): with `count=true`, the exact number of distinct terms under a
 * prefix by role, from two binary searches over the graph's dictionary. With `list`, each
 * graph that uses a prefix then lists its first terms.
 */
function termsUrl(endpoint, graph, params) {
  const u = new URL(endpoint.link(graph, 'terms'));
  for (const [ k, v ] of Object.entries(params)) {
    u.searchParams.set(k, String(v));
  }
  return u.href;
}

async function termCounts({ endpoint, graphs, prefixes, list, role }, fetch, account) {
  const url = (graph, params) => termsUrl(endpoint, graph, params);
  const counts = new Map();
  const answered = new Map(prefixes.map(p => [ p, 0 ]));
  const key = (prefix, graph) => `${prefix}\n${graph}`;
  const failures = await settleEach(prefixes.flatMap(prefix => graphs.map(graph => ({ prefix, graph }))), async ({ prefix, graph }) => {
    const body = await readJson(await fetch(url(graph, { prefix, role: 'any', count: 'true' }), { headers: { accept: 'application/json' } }));
    answered.set(prefix, answered.get(prefix) + 1);
    const c = body.counts ?? { any: Number(body.count?.value ?? 0) };
    if (Number(c.any) > 0) {
      counts.set(key(prefix, graph), { prefix, graph, ...c });
    }
  });
  const used = prefixes.flatMap(prefix => graphs.map(graph => counts.get(key(prefix, graph))).filter(Boolean).sort((a, b) => b.any - a.any));
  const holding = [ ...new Set(used.map(u => u.graph)) ];
  const lines = prefixes.map(prefix => {
    const here = used.filter(u => u.prefix === prefix);
    return `${prefix}: ${here.length} of ${answeredOf(answered.get(prefix), graphs.length)}${here.length ? ` (${perGraph(here.map(u => [ u.graph, Number(u.any) ]))} terms)` : ''}`;
  });
  if (!list) {
    return {
      variables: [ 'prefix', 'graph', 'terms', 'subjects', 'predicates', 'objects' ],
      rows: used.map(u => ({ prefix: lit(u.prefix), graph: lit(u.graph), terms: count(u.any), subjects: count(u.subject), predicates: count(u.predicate), objects: count(u.object) })),
      graphs: holding,
      note: `Distinct IRIs under each prefix; a term in several positions counts once in terms. ${lines.join('; ')}`,
      error: failureText(failures),
    };
  }
  const listed = new Map();
  failures.push(...await settleEach(used, async u => {
    const body = await readJson(await fetch(url(u.graph, { prefix: u.prefix, role, limit: list }), { headers: { accept: 'application/json' } }));
    const rows = [];
    for (const t of body.terms ?? []) {
      keepRow(account);
      rows.push({ prefix: lit(u.prefix), graph: lit(u.graph), term: wireTerm(t.term), roles: lit((t.roles ?? []).join(' ')) });
    }
    listed.set(key(u.prefix, u.graph), { rows, total: Number(body.cardinality?.value ?? rows.length) });
  }));
  const shown = used.filter(u => listed.has(key(u.prefix, u.graph)));
  return {
    variables: [ 'prefix', 'graph', 'term', 'roles' ],
    rows: shown.flatMap(u => listed.get(key(u.prefix, u.graph)).rows),
    graphs: holding,
    note: `${lines.join('; ')}. Listed${role === 'any' ? '' : ` as ${role}`}: ` +
      shown.map(u => { const l = listed.get(key(u.prefix, u.graph)); return `${u.graph} ${l.rows.length} of ${l.total}`; }).join(', '),
    error: failureText(failures),
  };
}

// Namespaces of vocabularies that many graphs share: holding their IRIs says nothing about
// whether two graphs describe the same things. Measured 2026-11-05: climatemodelskg against
// every graph, both ways, gave 72 rows, 70 of them these.
const VOCABULARIES = [ 'http://www.w3.org/', 'https://www.w3.org/', 'http://purl.org/dc/', 'http://xmlns.com/foaf/', 'http://purl.org/vocab/vann/', 'http://schema.org/', 'https://schema.org/' ];

/**
 * Each graph's own namespaces — those its summary's inventory lists with subjects, less the
 * shared vocabularies — counted in each other graph by `/terms?count=true`, then one example
 * IRI for each namespace a graph holds as subjects or objects.
 */
async function overlapOf({ endpoint, graphs }, fetch, account) {
  const json = { headers: { accept: 'application/json' } };
  const own = new Map();
  const skipped = new Set();
  const failures = await settleEach(graphs, async graph => {
    const body = await readJson(await fetch(endpoint.link(graph, 'summary'), json));
    const list = body.namespaces?.namespaces;
    if (!list) {
      throw new Error('its summary has no namespace inventory');
    }
    const subjects = list.filter(n => n.subject > 0);
    own.set(graph, subjects.filter(n => !VOCABULARIES.some(v => n.namespace.startsWith(v))).map(n => n.namespace));
    for (const n of subjects.filter(n => VOCABULARIES.some(v => n.namespace.startsWith(v)))) {
      skipped.add(n.prefix || n.namespace);
    }
  });
  const work = graphs.flatMap(owner => (own.get(owner) ?? []).flatMap(namespace => graphs.filter(g => g !== owner).map(graph => ({ owner, namespace, graph }))));
  const found = [];
  const predicateOnly = [];
  failures.push(...await settleEach(work, async w => {
    const c = (await readJson(await fetch(termsUrl(endpoint, w.graph, { prefix: w.namespace, role: 'any', count: 'true' }), json))).counts ?? {};
    if (c.subject > 0 || c.object > 0) {
      keepRow(account);
      found.push({ ...w, ...c });
    } else if (c.predicate > 0) {
      predicateOnly.push(w);
    }
  }));
  // One example a row: a subject when there are any, else an object.
  failures.push(...await settleEach(found, async f => {
    const body = await readJson(await fetch(termsUrl(endpoint, f.graph, { prefix: f.namespace, role: f.subject > 0 ? 'subject' : 'object', limit: 1 }), json));
    f.example = body.terms?.[0]?.term ? wireTerm(body.terms[0].term) : null;
  }));
  const order = g => graphs.indexOf(g);
  found.sort((a, b) => order(a.owner) - order(b.owner) || order(a.graph) - order(b.graph) || (b.subject + b.object) - (a.subject + a.object));
  const pairs = graphs.flatMap(owner => graphs.filter(g => g !== owner).map(graph => {
    const n = own.get(owner)?.length;
    if (n === undefined) {
      return `${owner}'s namespaces in ${graph}: not checked`;
    }
    const held = found.filter(f => f.owner === owner && f.graph === graph);
    return `${owner}'s ${n} namespace${n === 1 ? '' : 's'} in ${graph}: ` +
      (held.length ? held.map(f => `${f.namespace} ${f.subject} as subject, ${f.object} as object`).join('; ') : 'none held');
  }));
  return {
    variables: [ 'owner', 'namespace', 'graph', 'subjects', 'objects', 'predicates', 'terms', 'example' ],
    rows: found.map(f => ({
      owner: lit(f.owner), namespace: lit(f.namespace), graph: lit(f.graph),
      subjects: count(f.subject), objects: count(f.object), predicates: count(f.predicate), terms: count(f.any), example: f.example ?? null,
    })),
    graphs,
    note: `${pairs.join('. ')}.` +
      (predicateOnly.length ? ` Used only as predicates, not shown: ${predicateOnly.map(w => `${w.namespace} in ${w.graph}`).join(', ')}.` : '') +
      (skipped.size ? ` Skipped as shared vocabularies: ${[ ...skipped ].join(', ')}.` : ''),
    error: failureText(failures),
  };
}

/**
 * `where`: the IRI, Babel's clique for it, and IRIs whose label equals its label in any graph,
 * each counted as subject and object in every graph by bound `/count`s (navigator N5, N6).
 */
async function whereRows({ endpoint, target }, fetch, account) {
  const how = new Map([ [ target, 'given' ] ]);
  const failures = [];
  if (endpoint.graphs.has('babel')) {
    try {
      for (const m of await cliqueOf(endpoint, fetch, target, WHERE_IRIS)) {
        if (!how.has(m)) {
          how.set(m, 'babel');
        }
      }
    } catch (error) {
      failures.push({ graph: 'babel', error: error instanceof Error ? error.message : String(error) });
    }
  }
  const counted = graphsOrAll(null, endpoint, 'count');
  const presence = new Map();
  const count = async iris => {
    failures.push(...await settleEach(counted, async graph => {
      for (const [ i, entry ] of await presenceOf(endpoint, fetch, graph, iris)) {
        presence.set(i, new Map([ ...presence.get(i) ?? [], [ graph, entry ] ]));
      }
    }));
  };
  await count([ ...how.keys() ].slice(0, WHERE_IRIS));
  const holding = [ ...presence.get(target) ?? [] ].sort((a, b) => b[1].subject + b[1].object - (a[1].subject + a[1].object)).map(([ g ]) => g);
  const label = holding.length ? await labelOf(endpoint, fetch, holding.slice(0, 3), target) : null;
  if (label && how.size < WHERE_IRIS) {
    const words = label.trim().toLowerCase();
    const searched = graphsOrAll(null, endpoint, 'search');
    const added = [];
    failures.push(...await settleEach(searched, async graph => {
      const search = async role => {
        try {
          return await getJson(fetch, link(endpoint, graph, 'search', { q: label, limit: 10, ...(role ? { role } : {}) }));
        } catch (error) {
          if (role && /not declared/u.test(error?.message ?? '')) {
            return search(null);
          }
          throw error;
        }
      };
      for (const r of (await search('label')).results ?? []) {
        const same = [ r.label, r.match?.literal ].some(x => typeof x === 'string' && x.trim().toLowerCase() === words);
        if (same && r.subject?.type === 'iri' && !skolem(r.subject.value) && !how.has(r.subject.value) && how.size < WHERE_IRIS) {
          how.set(r.subject.value, 'same label');
          added.push(r.subject.value);
        }
      }
    }));
    if (added.length) {
      await count(added);
    }
  }
  const rows = [];
  for (const [ i, why ] of how) {
    for (const [ graph, c ] of [ ...presence.get(i) ?? [] ].sort((a, b) => b[1].subject + b[1].object - (a[1].subject + a[1].object))) {
      keepRow(account);
      rows.push({ iri: { type: 'iri', value: i }, how: lit(why), graph: lit(graph), subjects: count0(c.subject), objects: count0(c.object) });
    }
  }
  const graphs = [ ...new Set(rows.map(r => r.graph.value)) ];
  const ids = [ ...new Set(rows.map(r => r.iri.value)) ];
  const kinds = [ 'babel', 'same label' ].map(k => [ k, ids.filter(i => how.get(i) === k).length ]).filter(([ , n ]) => n);
  return {
    variables: [ 'iri', 'how', 'graph', 'subjects', 'objects' ],
    rows,
    graphs,
    note: `${ids.length} identifier${ids.length === 1 ? '' : 's'} in ${graphs.length} graph${graphs.length === 1 ? '' : 's'}` +
      (kinds.length ? ` (${kinds.map(([ k, n ]) => `${n} by ${k}`).join(', ')})` : '') +
      (label ? `; label "${label}"` : '') +
      (presence.has(target) ? '' : '; the IRI given is in no graph') +
      (how.size > ids.length ? `; ${how.size - ids.length} identifiers found are in no graph` : ''),
    error: failureText(failures),
  };
}

/** "87 <iri>; 7 <iri>": a tally, largest first. */
function tally(counts) {
  return [ ...counts ].sort((a, b) => b[1] - a[1]).map(([ k, n ]) => `${n} ${k}`).join('; ');
}

/**
 * `connections`: per graph, the entity's exact predicate histogram each way (navigator N7), and for
 * the largest predicates the classes of a sample of what is at the other end.
 */
async function linksRows({ endpoint, target, graphs }, fetch, account) {
  const failures = [];
  let asked = graphs;
  let others = [];
  if (!asked) {
    const totals = new Map();
    failures.push(...await settleEach(graphsOrAll(null, endpoint, 'count'), async graph => {
      for (const [ , c ] of await presenceOf(endpoint, fetch, graph, [ target ])) {
        totals.set(graph, c.subject + c.object);
      }
    }));
    const sorted = [ ...totals ].sort((a, b) => b[1] - a[1]).map(([ g ]) => g);
    asked = sorted.slice(0, LINK_GRAPHS);
    others = sorted.slice(LINK_GRAPHS);
  }
  const byGraph = new Map();
  failures.push(...await settleEach(asked, async graph => {
    const h = await histogramOf(endpoint, fetch, graph, target);
    const rows = [];
    for (const dir of [ 'out', 'in' ]) {
      const entries = h.entries.filter(e => e.dir === dir).sort((a, b) => b.count - a.count);
      for (const [ k, e ] of entries.entries()) {
        let ends = null;
        let example = null;
        if (k < LINK_ENDS) {
          const pattern = dir === 'out' ? { s: `<${target}>`, p: `<${e.predicate}>` } : { p: `<${e.predicate}>`, o: `<${target}>` };
          const far = (await rowsOf(endpoint, fetch, graph, pattern, END_SAMPLE)).rows.map(r => (dir === 'out' ? r.o : r.s)).filter(Boolean);
          example = far[0] ? wireTerm(far[0]) : null;
          const iris = [ ...new Set(far.filter(t => t.type === 'iri' && !skolem(t.value)).map(t => t.value)) ];
          const literals = far.filter(t => t.type === 'literal');
          const counts = new Map();
          const statements = dir === 'in' && (e.predicate === RDF_SUBJECT || e.predicate === RDF_OBJECT);
          if (iris.length) {
            const values = await valuesOf(endpoint, fetch, graph, iris, statements ? RDF_PREDICATE : RDF_TYPE);
            for (const i of iris) {
              for (const v of new Set((values.get(i) ?? []).filter(t => t.type === 'iri' && !skolem(t.value)).map(t => t.value))) {
                counts.set(`<${v}>`, (counts.get(`<${v}>`) ?? 0) + 1);
              }
            }
            const bare = iris.filter(i => !(values.get(i) ?? []).length).length;
            if (bare) {
              counts.set(statements ? 'with no rdf:predicate' : 'with no class', bare);
            }
          }
          for (const t of literals) {
            const kind = `literals${t.datatype ? ` ^^<${t.datatype}>` : t.lang ? ` @${t.lang}` : ''}`;
            counts.set(kind, (counts.get(kind) ?? 0) + 1);
          }
          const sampled = iris.length + literals.length;
          ends = `${sampled < e.count ? `${sampled} sampled of ${e.count.toLocaleString('en-US')}` : `all ${e.count.toLocaleString('en-US')}`}` +
            `${statements ? ', statements by rdf:predicate' : ''}: ${tally(counts) || 'nothing'}`;
        }
        keepRow(account);
        rows.push({
          graph: lit(graph), direction: lit(dir), predicate: { type: 'iri', value: e.predicate }, triples: count(e.count),
          ends: ends === null ? null : lit(ends), example,
        });
      }
    }
    byGraph.set(graph, { rows, h });
  }));
  const kept = asked.filter(g => byGraph.has(g));
  return {
    variables: [ 'graph', 'direction', 'predicate', 'triples', 'ends', 'example' ],
    rows: kept.flatMap(g => byGraph.get(g).rows),
    graphs: kept,
    note: kept.map(g => {
      const { h } = byGraph.get(g);
      const n = dir => h.entries.filter(e => e.dir === dir).length;
      return `${g}: ${n('out')} predicates out (${h.totals.out.toLocaleString('en-US')} triples), ${n('in')} in (${h.totals.in.toLocaleString('en-US')})${h.partial ? ', some predicates past the first 2,000 triples may be missing' : ''}`;
    }).join('; ') + (others.length ? `. Also in, not read: ${others.join(', ')}` : '') + (kept.length ? '' : `. No graph holds ${target}`),
    error: failureText(failures),
  };
}

function count0(n) {
  return count(n ?? 0);
}

/** The summary's namespace inventory, as a section for the Markdown card. */
function namespaceSection(ns) {
  const lines = [
    '## Namespaces',
    '',
    'Distinct IRIs under each prefix this graph declares, by position. IRIs under a namespace the graph does not declare, such as another graph\'s, are counted only below; terms counts any prefix in every graph.',
    '',
    '| prefix | namespace | IRIs | subjects | predicates | objects |',
    '|---|---|---:|---:|---:|---:|',
    ...ns.namespaces.map(n => `| ${n.prefix ?? ''} | \`${n.namespace}\` | ${n.distinct_iris} | ${n.subject} | ${n.predicate} | ${n.object} |`),
  ];
  const residual = [ 'subject', 'predicate', 'object' ].filter(r => ns.roles?.[r]).map(r => `${ns.roles[r].residual} of ${ns.roles[r].distinct_iris} ${r} IRIs`);
  if (residual.length) {
    lines.push('', `Under no declared prefix: ${residual.join('; ')}.`);
  }
  return lines.join('\n');
}

function patternTerm(text) {
  if (text === null || text === undefined) {
    return null;
  }
  const m = /^<(.*)>$/su.exec(text);
  return m ? { type: 'iri', value: m[1] } : lit(text);
}

export { limit };
