// SQL over the session's tables: DuckDB-Wasm in a worker. kgfq D6 carried into the tab —
// no files, no URLs, no extensions, the settings locked before any SQL a model wrote can run,
// and only a single SELECT is accepted. Table names are the workspace's own (t1, t2, …);
// nothing a model or a graph supplies becomes an identifier.

import * as duckdb from '@duckdb/duckdb-wasm';
import { DataType, tableFromArrays, util } from 'apache-arrow';
import { COMPANIONS, termColumns } from './terms.js';

function asset(name) {
  return new URL(`duckdb/${name}`, document.baseURI).href;
}

export class Sql {
  constructor() {
    this.ready = this.open();
  }

  async open() {
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: asset('duckdb-mvp.wasm'), mainWorker: asset('duckdb-browser-mvp.worker.js') },
      eh: { mainModule: asset('duckdb-eh.wasm'), mainWorker: asset('duckdb-browser-eh.worker.js') },
    });
    const worker = new Worker(bundle.mainWorker);
    this.db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    this.conn = await this.db.connect();
    for (const statement of [
      'SET enable_external_access = false',
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      'SET lock_configuration = true',
    ]) {
      await this.conn.query(statement);
    }
    this.version = (await this.conn.query('SELECT version() AS v')).toArray()[0].v;
    return this;
  }

  /** A workspace table as a SQL table: per term column x, the text columns x, x_kind, x_lang, x_datatype. */
  async register(id, variables, rows) {
    await this.ready;
    const arrays = {};
    for (const v of variables) {
      const encoded = rows.map(r => termColumns(r[v]));
      arrays[v] = encoded.map(e => e[0]);
      COMPANIONS.forEach((c, i) => {
        arrays[`${v}_${c}`] = encoded.map(e => e[i + 1]);
      });
    }
    await this.conn.insertArrowTable(tableFromArrays(arrays), { name: id, create: true });
  }

  /**
   * Runs one SELECT and returns at most `maxRows` rows of plain values (a DECIMAL as
   * `{decimal}`), the column names, and the tables it read. Terms are the caller's to make.
   * Two guards, both DuckDB's own: the text is wrapped as a subquery, where only a query
   * parses, and it is prepared, which refuses more than one statement.
   */
  async select(query, maxRows) {
    await this.ready;
    const text = String(query ?? '').trim().replace(/;\s*$/u, '');
    if (!text) {
      throw new Error('query must be a SELECT statement');
    }
    let statement;
    try {
      statement = await this.conn.prepare(`SELECT * FROM (\n${text}\n) AS q LIMIT ${maxRows + 1}`);
    } catch (error) {
      // Preparing also binds; only a parse failure means the text was not a single query.
      const text = duckdbMessage(error);
      throw new Error(/Parser Error/u.test(text) ? `Only a single SELECT is run here. DuckDB says: ${text}` : text);
    }
    const reads = [ ...new Set(await this.conn.getTableNames(text)) ].sort();
    let result;
    try {
      result = await statement.query();
    } catch (error) {
      throw new Error(duckdbMessage(error));
    } finally {
      await statement.close();
    }
    const fields = result.schema.fields.map(f => ({ name: f.name, scale: DataType.isDecimal(f.type) ? f.type.scale : null }));
    const names = fields.map(f => f.name);
    const rows = result.toArray().map(row => Object.fromEntries(fields.map(f =>
      [ f.name, f.scale === null ? plain(row[f.name]) : decimal(row[f.name], f.scale) ])));
    const truncated = rows.length > maxRows;
    return { names, rows: truncated ? rows.slice(0, maxRows) : rows, truncated, reads };
  }
}

/** DuckDB-Wasm reports some errors as a JSON object; give them DuckDB's usual "Kind Error: …" form. */
function duckdbMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(text);
    if (parsed.exception_message) {
      return `${parsed.exception_type ?? 'DuckDB'} Error: ${parsed.exception_message}`;
    }
  } catch {
    // Not JSON: already DuckDB's own text.
  }
  return text;
}

/** Arrow carries a DECIMAL as its unscaled integer; the scale comes from the schema. */
function decimal(value, scale) {
  if (value === null || value === undefined) {
    return null;
  }
  const n = util.bigNumToBigInt(value);
  const digits = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return { decimal: `${n < 0n ? '-' : ''}${text}` };
}

/** Arrow values as plain JavaScript; nested values as JSON text. */
function plain(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'object' && !(value instanceof Date) && typeof value.toJSON === 'function') {
    return JSON.stringify(value.toJSON());
  }
  return value;
}
