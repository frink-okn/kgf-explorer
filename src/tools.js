// The operations. One list, two surfaces: the page renders each as a form and a button, and
// the chat hands the same list to the model as its tools. A model's call and a person's
// click go through one function, land as one kind of table, and write one kind of log record.

import { RECEIPT_SCHEMA, formatTerm, lookupLabels, readJson, runDirect, runFetch, runSparql, wireTerm } from './kgf.js';
import { TEMPLATES, iri, limit } from './templates.js';
import { termsFromSql } from './terms.js';

const GRAPHS = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  maxItems: 4,
  description: 'Graph ids from list_graphs. Two or more graphs are queried together: each pattern is matched in every graph, which is how a join crosses graphs that share IRIs.',
};
const GRAPH = { type: 'string', description: 'A graph id from list_graphs.' };
const LIMIT = { type: 'integer', minimum: 1, description: 'Maximum rows (default 200; at most the endpoint\'s max_output_rows).' };
const TERM = (position, example) => ({ type: 'string', examples: [ example ], description: `The ${position}: ?name for a variable (it becomes a column), an IRI, or a quoted literal such as "20695" or "asthma"@en. Omit for an unnamed variable.` });
const GRADES = [ 'asserted', 'external', 'sparql', 'bundle' ];
const IRI = description => ({ type: 'string', description: `${description} An absolute IRI, as it appears in an earlier result.` });
const DIRECTION = { type: 'string', enum: [ 'out', 'in' ], description: '"out" follows the predicate from the known node to the new one; "in" follows it backwards.' };

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
function position(value, pos) {
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
    }
  }
  return { table: bind.table, columns: bind.columns, variables, tuples };
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
    description: 'The graph\'s summary card, written by the server from its statistics: description, counts, the largest classes and predicates with their counts, and the leading class→predicate→class relations. It lists only the largest; schema lists everything. Read it before choosing predicates or classes for a query.',
    input_schema: schema({ graph: GRAPH }, [ 'graph' ]),
    run: async(input, ctx) => runDirect({
      operation: 'graph_summary', input, budget: ctx.budget, stop: ctx.stop,
      call: async fetch => {
        const url = new URL(ctx.endpoint.link(input.graph, 'summary'));
        url.searchParams.set('format', 'md');
        const response = await fetch(url.href, { headers: { accept: 'text/markdown' } });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText} from ${url.href}\n${text}`);
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
    name: 'count',
    title: 'Count a pattern',
    description: 'The exact number of triples matching a pattern in one graph, from the server\'s index, in one request. Any of subject, predicate, object may be left out. Count before fetching anything that could be large.',
    input_schema: schema({ graph: GRAPH, subject: IRI('Subject.'), predicate: IRI('Predicate.'), object: IRI('Object.') }, [ 'graph' ]),
    run: async(input, ctx) => runDirect({
      operation: 'count', input, budget: ctx.budget, stop: ctx.stop,
      call: async fetch => {
        const url = new URL(ctx.endpoint.link(input.graph, 'count'));
        for (const [ key, param ] of [ [ 'subject', 's' ], [ 'predicate', 'p' ], [ 'object', 'o' ] ]) {
          if (input[key]) {
            url.searchParams.set(param, iri(input[key], key));
          }
        }
        const body = await readJson(await fetch(url.href, { headers: { accept: 'application/json' } }));
        return {
          variables: [ 'subject', 'predicate', 'object', 'count', 'exact' ],
          rows: [ {
            subject: patternTerm(body.pattern.s), predicate: patternTerm(body.pattern.p), object: patternTerm(body.pattern.o),
            count: lit(String(body.count.value)), exact: lit(String(body.count.exact)),
          } ],
        };
      },
    }),
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
      bind: {
        type: 'object',
        description: 'Optional. {"table": "t4", "columns": {"z": "s"}} binds the pattern\'s ?z to the values of t4\'s column s.',
        properties: { table: { type: 'string' }, columns: { type: 'object', additionalProperties: { type: 'string' } } },
        required: [ 'table', 'columns' ],
      },
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
    description: 'One DuckDB SELECT over this session\'s tables, which are SQL tables named t1, t2, …. Each term column x holds the value as text (CAST for arithmetic) beside x_kind (iri, literal or bnode), x_lang and x_datatype. A result column keeps its kind when you select x_kind with it, or when its values appear in the tables read with one kind each; other text comes back as a plain literal, numbers as typed literals. Use it to join tables, filter, group and count. The result is a new table. Nothing outside the session\'s tables can be read.',
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

function patternTerm(text) {
  if (text === null || text === undefined) {
    return null;
  }
  const m = /^<(.*)>$/su.exec(text);
  return m ? { type: 'iri', value: m[1] } : lit(text);
}

export { limit };
