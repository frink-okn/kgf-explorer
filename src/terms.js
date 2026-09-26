// Terms in table columns, as kgfq stores them (kgfq plan C6, changed 2026-09-24): every term
// column x has companions x_kind (iri | literal | bnode), x_lang and x_datatype. The kind is
// stated, never guessed; a plain literal stores no datatype; a blank node keeps its `_:`.

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_STRING = `${XSD}string`;
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
export const COMPANIONS = [ 'kind', 'lang', 'datatype' ];

/** A term as its four stored values: [value, kind, lang, datatype]. */
export function termColumns(t) {
  if (!t) {
    return [ null, null, null, null ];
  }
  if (t.type === 'iri') {
    return [ t.value, 'iri', null, null ];
  }
  if (t.type === 'bnode') {
    return [ `_:${t.value}`, 'bnode', null, null ];
  }
  const datatype = t.lang || t.datatype === XSD_STRING || t.datatype === RDF_LANG_STRING ? null : t.datatype ?? null;
  return [ t.value, 'literal', t.lang ?? null, datatype ];
}

/** The inverse of termColumns. */
export function fromColumns(value, kind, lang, datatype) {
  if (value === null || value === undefined) {
    return null;
  }
  if (kind === 'iri') {
    return { type: 'iri', value };
  }
  if (kind === 'bnode') {
    return { type: 'bnode', value: value.replace(/^_:/u, '') };
  }
  const t = { type: 'literal', value };
  if (lang) {
    t.lang = lang;
  } else if (datatype && datatype !== XSD_STRING) {
    t.datatype = datatype;
  }
  return t;
}

/** A value SQL computed (not read from a term column), as a literal of its type. */
export function typedLiteral(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return { type: 'literal', value: value.toString(), datatype: `${XSD}integer` };
  }
  if (typeof value === 'number') {
    return { type: 'literal', value: String(value), datatype: Number.isInteger(value) ? `${XSD}integer` : `${XSD}double` };
  }
  if (typeof value === 'boolean') {
    return { type: 'literal', value: String(value), datatype: `${XSD}boolean` };
  }
  if (value instanceof Date) {
    return { type: 'literal', value: value.toISOString(), datatype: `${XSD}dateTime` };
  }
  if (value && typeof value === 'object' && value.decimal !== undefined) {
    return { type: 'literal', value: value.decimal, datatype: `${XSD}decimal` };
  }
  return { type: 'literal', value: typeof value === 'string' ? value : JSON.stringify(value) };
}

/**
 * SQL output back as terms. A column x that arrives with x_kind is reassembled from its
 * companions. A text column without them takes the kind its values have in the tables the
 * query read, when every value there has exactly one encoding; otherwise it is plain text.
 */
export function termsFromSql(names, rows, inputs) {
  const present = new Set(names);
  const companion = new Set();
  const explicit = new Set();
  for (const name of names) {
    if (present.has(`${name}_kind`)) {
      explicit.add(name);
      for (const c of COMPANIONS) {
        companion.add(`${name}_${c}`);
      }
    }
  }
  const variables = names.filter(n => !companion.has(n));
  let index;
  const encodingOf = value => {
    index ??= valueIndex(inputs);
    const seen = index.get(value);
    return seen && seen.size === 1 ? [ ...seen ][0] : null;
  };
  const out = rows.map(row => Object.fromEntries(variables.map(v => {
    const value = row[v];
    if (explicit.has(v)) {
      return [ v, fromColumns(value === null ? null : String(value), row[`${v}_kind`], row[`${v}_lang`] ?? null, row[`${v}_datatype`] ?? null) ];
    }
    if (typeof value === 'string') {
      const encoding = encodingOf(value);
      return [ v, encoding ? fromColumns(value, ...JSON.parse(encoding)) : typedLiteral(value) ];
    }
    return [ v, typedLiteral(value) ];
  })));
  return { variables, rows: out };
}

/** Stored value → the distinct encodings ([kind, lang, datatype]) it has in these tables. */
function valueIndex(tables) {
  const index = new Map();
  for (const table of tables) {
    for (const row of table.rows) {
      for (const v of table.variables) {
        const [ value, kind, lang, datatype ] = termColumns(row[v]);
        if (value === null) {
          continue;
        }
        let seen = index.get(value);
        if (!seen) {
          seen = new Set();
          index.set(value, seen);
        }
        seen.add(JSON.stringify([ kind, lang, datatype ]));
      }
    }
  }
  return index;
}
