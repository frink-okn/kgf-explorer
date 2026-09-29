// The session: every operation, whoever asked for it, appends one log record and leaves one
// table with its receipt. The log exports as JSON Lines — the page's analogue of kgfq's
// session log, though not yet in kgfq's schema. Every table's shown IRIs are labeled through
// the graphs' /labels, beside the table and never in it (kgfq C7): labels are for reading.

import { RECEIPT_SCHEMA, labelIris } from './kgf.js';
import { TEMPLATES } from './templates.js';
import { TOOL_BY_NAME } from './tools.js';

const PREVIEW_ROWS = 20;
const SCHEMA_ROWS = 200;
// The rows the page shows; their IRIs are labeled when a table lands, the rest on demand.
export const LABELED_ROWS = 500;
const TEXT_LIMIT = 12_000;

export class Workspace extends EventTarget {
  constructor(endpoint, sql) {
    super();
    this.endpoint = endpoint;
    this.sql = sql;
    this.tables = [];
    this.log = [];
  }

  changed(detail) {
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }

  table(id) {
    return this.tables.find(t => t.id === id);
  }

  /** Runs one operation for `actor` ("user" or "assistant") and returns its table. */
  async run(name, input, { actor, budget, stop }) {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      throw new Error(`no operation named ${JSON.stringify(name)}`);
    }
    const record = { seq: this.log.length + 1, at: new Date().toISOString(), actor, operation: name, input, status: 'running' };
    this.log.push(record);
    this.changed({ record });
    if (name === 'read_table') {
      const result = await this.readTable(input, { budget, stop });
      record.status = result.error ? 'error' : 'complete';
      record.reads = input.table;
      this.changed({ record });
      return { read: result };
    }
    let result;
    try {
      result = await tool.run(input, { endpoint: this.endpoint, budget, stop, workspace: this, sql: this.sql });
    } catch (error) {
      // Refused before any request: the input did not validate.
      result = { rows: [], variables: [], receipt: refused(name, input, error) };
    }
    const table = {
      id: `t${this.tables.length + 1}`,
      operation: name,
      title: tool.title,
      input,
      actor,
      graphs: input.graphs ?? (input.graph ? [ input.graph ] : []),
      ...result,
    };
    this.tables.push(table);
    if (table.variables.length) {
      // Every table is also a SQL table of the same name, so a later `sql` step can read it.
      try {
        await this.sql.register(table.id, table.variables, table.rows);
      } catch (error) {
        table.sqlError = error instanceof Error ? error.message : String(error);
      }
    }
    if (table.operation === 'labels') {
      table.labels = { labels: new Map(table.rows.map(r => [ r.iri.value, r.label?.value ?? null ])), graphs: table.graphs, requests: 0 };
    } else {
      await this.label(table, table.rows.slice(0, LABELED_ROWS), { budget, stop });
    }
    record.table = table.id;
    record.status = table.receipt.outcome.contract;
    record.receipt = table.receipt;
    this.changed({ record, table });
    return { table };
  }

  /** Labels the IRIs in `rows` that the table has no label answer for yet, from the table's graphs. */
  async label(table, rows, { budget, stop }) {
    if (!table.graphs.length) {
      return;
    }
    const known = table.labels?.labels ?? new Map();
    const iris = irisIn(rows, table.variables).filter(i => !known.has(i));
    if (!iris.length) {
      return;
    }
    const answer = await labelIris({ endpoint: this.endpoint, graphs: table.graphs, iris, budget, stop });
    table.labels = {
      ...answer,
      labels: new Map([ ...known, ...answer.labels ]),
      requests: (table.labels?.requests ?? 0) + answer.requests,
    };
  }

  async readTable({ table: id, offset = 0, limit = 50 }, context) {
    const table = this.table(id);
    if (!table) {
      return { error: `no table ${JSON.stringify(id)}; tables so far: ${this.tables.map(t => t.id).join(', ') || 'none'}` };
    }
    const slice = table.rows.slice(offset, offset + limit);
    await this.label(table, slice, context);
    const out = { table: id, columns: table.variables, total_rows: table.rows.length, offset, rows: slice.map(compactRow) };
    const labels = labelsFor(table, slice);
    if (Object.keys(labels).length) {
      out.labels = labels;
    }
    return out;
  }

  exportLog() {
    return this.log.map(r => JSON.stringify(r)).join('\n') + '\n';
  }
}

function refused(operation, input, error) {
  const now = new Date().toISOString();
  return {
    schema: RECEIPT_SCHEMA,
    operation,
    input,
    query: null,
    sources: [],
    outcome: { contract: 'error', rows: 0, error: error instanceof Error ? error.message : String(error) },
    requests: [],
    totals: { requests: 0, bindings_requests: 0, bytes: 0, elapsed_ms: 0 },
    started: now,
    finished: now,
  };
}

/** What the model sees of a result: counts, the receipt's verdict, and a preview — never the whole table. */
export function summarizeForModel(result) {
  if (result.read) {
    return result.read;
  }
  const { table } = result;
  const r = table.receipt;
  const out = { table: table.id, contract: r.outcome.contract, rows: table.rows.length };
  if (r.outcome.budget) {
    out.aborted_at_budget = r.outcome.budget;
  }
  if (r.outcome.error) {
    out.error = r.outcome.error;
  }
  if (r.outcome.note) {
    out.about = r.outcome.note;
  }
  if (r.bindings) {
    const b = r.bindings;
    out.bound_values = { from: `${b.table} (${Object.entries(b.columns).map(([ v, c ]) => `?${v} ← ${c}`).join(', ')})`, sent: b.tuples, matched: b.matched, unmatched: b.unmatched };
    if (b.checked < b.tuples) {
      out.bound_values.not_checked = b.tuples - b.checked;
    }
    if (b.unmatched) {
      out.bound_values.unmatched_sample = b.unmatched_sample;
      out.bound_values.note = 'These values found nothing in this graph. Look at their form before concluding they are absent.';
    }
  }
  if (table.text !== undefined) {
    out.text = table.text.length > TEXT_LIMIT ? `${table.text.slice(0, TEXT_LIMIT)}\n…(truncated)` : table.text;
  } else {
    out.columns = table.variables;
    // A schema listing is shown whole: its point is the small entries a size ranking hides.
    // So is the graph list: a preview of it hid spoke-okn, the 41st of 45.
    const shown = table.operation === 'schema' || table.operation === 'list_graphs' ? SCHEMA_ROWS : PREVIEW_ROWS;
    out.preview = table.rows.slice(0, shown).map(compactRow);
    const labels = labelsFor(table, table.rows.slice(0, shown));
    if (Object.keys(labels).length) {
      // Beside the rows, never in them: a label is for reading, the IRI is what later steps take.
      out.labels = labels;
    }
    if (table.rows.length > shown) {
      out.note = `preview shows ${shown} of ${table.rows.length} rows; call read_table for more`;
    }
    const limit = table.input.limit ?? (table.operation === 'search' ? 20 : 200);
    if ((table.operation in TEMPLATES || table.operation === 'search') && table.rows.length === limit) {
      out.limit_reached = true;
    }
    if (table.sqlError) {
      out.sql_error = `not available to sql: ${table.sqlError}`;
    }
  }
  out.requests = r.totals.requests;
  out.elapsed_ms = r.totals.elapsed_ms;
  return out;
}

function irisIn(rows, variables) {
  const iris = new Set();
  for (const row of rows) {
    for (const v of variables) {
      if (row[v]?.type === 'iri') {
        iris.add(row[v].value);
      }
    }
  }
  return [ ...iris ];
}

/** IRI → label for the IRIs in these rows that have one; an IRI absent here has none (or was not asked). */
function labelsFor(table, rows) {
  const known = table.labels?.labels;
  if (!known || table.operation === 'labels') {
    return {};
  }
  const out = {};
  for (const iri of irisIn(rows, table.variables)) {
    const label = known.get(iri);
    if (label) {
      out[iri] = label;
    }
  }
  return out;
}

export function compactRow(row) {
  return Object.fromEntries(Object.entries(row).map(([ k, t ]) => [ k, compactTerm(t) ]));
}

function compactTerm(t) {
  if (!t) {
    return null;
  }
  if (t.type === 'iri') {
    return t.value;
  }
  if (t.type === 'literal') {
    if (t.lang) {
      return `"${t.value}"@${t.lang}`;
    }
    const numeric = /#(integer|decimal|double|float|int|long)$/u.test(t.datatype ?? '');
    if (numeric && Number.isFinite(Number(t.value)) && Math.abs(Number(t.value)) <= Number.MAX_SAFE_INTEGER) {
      return Number(t.value);
    }
    if (t.datatype) {
      return `"${t.value}"^^${t.datatype.replace('http://www.w3.org/2001/XMLSchema#', 'xsd:')}`;
    }
    return t.value;
  }
  return `_:${t.value}`;
}
