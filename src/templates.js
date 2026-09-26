// SPARQL templates. The SPARQL is code's: a caller (a button or a model) picks a template
// and supplies IRIs and a limit; nothing it supplies is ever spliced in unchecked. This is
// kgfq D16's rule carried into the browser — a model never writes a query. No template joins
// a label: every result's IRIs are labeled afterwards through /labels, which follows each
// graph's declared label predicates and returns one label per IRI.

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** An absolute http(s) IRI with nothing that could close the `<…>` it is written into. */
export function iri(value, name) {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be an IRI string`);
  }
  const bare = value.trim().replace(/^<(.*)>$/su, '$1');
  if (!/^https?:\/\/[^\s<>"{}|\\^`]+$/u.test(bare)) {
    throw new Error(`${name} must be an absolute http(s) IRI, got ${JSON.stringify(value)}`);
  }
  return `<${bare}>`;
}

/** A row limit, bounded by the endpoint's own `max_output_rows`, never by a number of ours. */
export function limit(value, max) {
  const n = value === undefined || value === null || value === '' ? 200 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`limit must be an integer from 1 to ${max} (this endpoint's max_output_rows)`);
  }
  return n;
}

function direction(value, name) {
  const d = value ?? 'out';
  if (d !== 'out' && d !== 'in') {
    throw new Error(`${name} must be "out" or "in"`);
  }
  return d;
}

/** One hop from `from` to `to` over `predicate`, written in the direction asked. */
function hop(from, predicate, to, dir) {
  return dir === 'out' ? `${from} ${predicate} ${to} .` : `${to} ${predicate} ${from} .`;
}

export const TEMPLATES = {
  describe: {
    variables: [ 'p', 'o' ],
    build: (input, max) => `SELECT ?p ?o WHERE {\n  ${iri(input.iri, 'iri')} ?p ?o .\n} LIMIT ${limit(input.limit, max)}`,
  },
  incoming: {
    variables: [ 's', 'p' ],
    build: (input, max) => `SELECT ?s ?p WHERE {\n  ?s ?p ${iri(input.iri, 'iri')} .\n} LIMIT ${limit(input.limit, max)}`,
  },
  instances: {
    variables: [ 's' ],
    build: (input, max) => `SELECT ?s WHERE {\n  ?s <${RDF_TYPE}> ${iri(input.class, 'class')} .\n} LIMIT ${limit(input.limit, max)}`,
  },
  neighbors: {
    variables: [ 'node' ],
    build: (input, max) => `SELECT ?node WHERE {\n` +
      `  ${hop(iri(input.iri, 'iri'), iri(input.predicate, 'predicate'), '?node', direction(input.direction, 'direction'))}\n` +
      `} LIMIT ${limit(input.limit, max)}`,
  },
  two_hop: {
    variables: [ 'mid', 'end' ],
    build: (input, max) => `SELECT ?mid ?end WHERE {\n` +
      `  ${hop(iri(input.start, 'start'), iri(input.predicate1, 'predicate1'), '?mid', direction(input.direction1, 'direction1'))}\n` +
      `  ${hop('?mid', iri(input.predicate2, 'predicate2'), '?end', direction(input.direction2, 'direction2'))}\n` +
      `} LIMIT ${limit(input.limit, max)}`,
  },
};
