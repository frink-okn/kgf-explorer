// What one entity is, everywhere: kgf-navigator's presence, equivalents and fact histogram
// (its N5–N7), as helpers for the `where` and `connections` operations and for maps (plan D19). Each
// takes a run's accounting fetch, so every request lands in that run's receipt.

import { lookupLabels, query, readJson } from './kgf.js';

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const RDF_SUBJECT = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#subject';
export const RDF_OBJECT = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#object';
export const RDF_PREDICATE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate';
const SKOS_EXACT = 'http://www.w3.org/2004/02/skos/core#exactMatch';

/** A blank node the server named with a skolem IRI: an OWL axiom or annotation, not a thing. */
export const skolem = iri => /^urn:.*:bnode:/u.test(iri) || iri.includes('/.well-known/genid/');

export async function getJson(fetch, href) {
  return readJson(await fetch(href, { headers: { accept: 'application/json' } }));
}

export function link(endpoint, graph, which, params = {}) {
  const u = new URL(endpoint.link(graph, which));
  for (const [ k, v ] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      u.searchParams.set(k, String(v));
    }
  }
  return u.href;
}

/** Up to `max` rows of one pattern (constants in KGF syntax), cursor after cursor. */
export async function rowsOf(endpoint, fetch, graph, pattern, max) {
  const rows = [];
  const page = Math.min(max, endpoint.descriptor.caps?.max_limit ?? 10_000);
  let cursor = null;
  do {
    const body = await getJson(fetch, link(endpoint, graph, 'fragment', { ...pattern, limit: page, cursor }));
    rows.push(...body.rows ?? []);
    cursor = body.complete ? null : body.next;
  } while (cursor && rows.length < max);
  return { rows: rows.slice(0, max), more: Boolean(cursor) || rows.length > max };
}

/** Bindings rows in batches the endpoint accepts. */
function batches(rows, max) {
  const out = [];
  for (let i = 0; i < rows.length; i += max) {
    out.push(rows.slice(i, i + max));
  }
  return out;
}

/** The values of one predicate for each IRI, in one graph, by bound requests: IRI → [term]. */
export async function valuesOf(endpoint, fetch, graph, iris, predicate) {
  const out = new Map();
  const url = endpoint.link(graph, 'fragment');
  const limit = endpoint.descriptor.caps?.max_limit ?? 10_000;
  for (const batch of batches(iris.map(i => [ `<${i}>` ]), endpoint.descriptor.caps?.max_bindings ?? 200)) {
    let cursor = null;
    do {
      const body = await readJson(await query(endpoint, fetch, url, {
        pattern: { s: '?x', p: `<${predicate}>`, o: '?o' }, bindings: { vars: [ '?x' ], rows: batch }, limit, ...(cursor ? { cursor } : {}),
      }));
      for (const r of body.rows ?? []) {
        if (r.s?.type === 'iri' && r.o) {
          out.set(r.s.value, [ ...out.get(r.s.value) ?? [], r.o ]);
        }
      }
      cursor = body.complete ? null : body.next;
    } while (cursor);
  }
  return out;
}

/** Triples per graph with each IRI as subject and as object: IRI → graph → { subject, object }. */
export async function presenceOf(endpoint, fetch, graph, iris) {
  const out = new Map();
  const url = endpoint.link(graph, 'count');
  for (const [ pos, key ] of [ [ 's', 'subject' ], [ 'o', 'object' ] ]) {
    for (const batch of batches(iris, endpoint.descriptor.caps?.max_bindings ?? 200)) {
      const body = await readJson(await query(endpoint, fetch, url, {
        pattern: pos === 's' ? { s: '?x', p: '?p', o: '?o' } : { s: '?s', p: '?p', o: '?x' }, bindings: { vars: [ '?x' ], rows: batch.map(i => [ `<${i}>` ]) },
      }));
      for (const c of body.counts ?? []) {
        const n = Number(c.count?.value ?? 0);
        if (n > 0) {
          const iri = batch[c.binding];
          const entry = out.get(iri) ?? { subject: 0, object: 0 };
          entry[key] = n;
          out.set(iri, entry);
        }
      }
    }
  }
  return out;
}

/** Babel's clique for an IRI: its leader by skos:exactMatch, then the leader's incoming exactMatch. */
export async function cliqueOf(endpoint, fetch, iri, max) {
  const up = await rowsOf(endpoint, fetch, 'babel', { s: `<${iri}>`, p: `<${SKOS_EXACT}>` }, 10);
  const leader = up.rows.map(r => r.o).find(t => t?.type === 'iri')?.value;
  if (!leader) {
    return [];
  }
  const down = await rowsOf(endpoint, fetch, 'babel', { p: `<${SKOS_EXACT}>`, o: `<${leader}>` }, max);
  return [ ...new Set([ leader, ...down.rows.map(r => r.s).filter(t => t?.type === 'iri').map(t => t.value) ]) ];
}

/** One label for an IRI from the first of these graphs that has one. */
export async function labelOf(endpoint, fetch, graphs, iri) {
  for (const graph of graphs) {
    const answer = await lookupLabels(endpoint, graph, [ iri ], fetch);
    const label = answer.labels.get(iri);
    if (label) {
      return label;
    }
  }
  return null;
}

/** A graph's predicates, from /schema; kept on the endpoint for the session (releases are pinned). */
async function predicatesOf(endpoint, fetch, graph) {
  endpoint.predicateLists ??= new Map();
  if (!endpoint.predicateLists.has(graph)) {
    const items = [];
    let cursor = null;
    do {
      const body = await getJson(fetch, link(endpoint, graph, 'schema', {
        children: 'properties', view: 'design', limit: endpoint.descriptor.caps?.max_schema_items ?? 1000, cursor,
      }));
      items.push(...body.items ?? []);
      cursor = body.complete ? null : body.next;
    } while (cursor);
    endpoint.predicateLists.set(graph, items.filter(i => i.term?.type === 'iri').map(i => i.term.value));
  }
  return endpoint.predicateLists.get(graph);
}

/**
 * How many triples an entity has per predicate in one graph, each way, exactly (navigator N7):
 * the graph's predicates go out as bindings of a `QUERY /count` per direction. When they fall
 * short of the entity's own triples (a predicate the schema does not list), its first 2,000
 * triples each way name the rest.
 */
export async function histogramOf(endpoint, fetch, graph, iri) {
  const listed = await predicatesOf(endpoint, fetch, graph);
  const url = endpoint.link(graph, 'count');
  const max = endpoint.descriptor.caps?.max_bindings ?? 200;
  const count = async(predicates, dir) => {
    const found = [];
    for (const batch of batches(predicates, max)) {
      const pattern = dir === 'out' ? { s: `<${iri}>`, p: '?p', o: '?o' } : { s: '?s', p: '?p', o: `<${iri}>` };
      const body = await readJson(await query(endpoint, fetch, url, { pattern, bindings: { vars: [ '?p' ], rows: batch.map(p => [ `<${p}>` ]) } }));
      for (const c of body.counts ?? []) {
        const n = Number(c.count?.value ?? 0);
        if (n > 0) {
          found.push({ dir, predicate: batch[c.binding], count: n });
        }
      }
    }
    return found;
  };
  const total = async pos => Number((await getJson(fetch, link(endpoint, graph, 'count', { [pos]: `<${iri}>` }))).count?.value ?? 0);
  const [ out, inc, outTotal, inTotal ] = await Promise.all([ count(listed, 'out'), count(listed, 'in'), total('s'), total('o') ]);
  let entries = [ ...out, ...inc ];
  let partial = false;
  const sum = dir => entries.filter(e => e.dir === dir).reduce((n, e) => n + e.count, 0);
  for (const [ dir, expected, pos ] of [ [ 'out', outTotal, 's' ], [ 'in', inTotal, 'o' ] ]) {
    if (sum(dir) < expected) {
      const { rows, more } = await rowsOf(endpoint, fetch, graph, { [pos]: `<${iri}>` }, 2000);
      const known = new Set(entries.filter(e => e.dir === dir).map(e => e.predicate));
      const extra = [ ...new Set(rows.map(r => r.p?.value).filter(Boolean)) ].filter(p => !known.has(p));
      entries = entries.concat(await count(extra, dir));
      partial ||= more;
    }
  }
  return { entries, totals: { out: outTotal, in: inTotal }, partial };
}
