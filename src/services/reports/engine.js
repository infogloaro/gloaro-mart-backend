/**
 * Admin → Reports (RP): one engine for every report.
 *
 * A report is a definition — title, filters, columns, summary — plus a
 * `sql(ctx)` that returns the report's rows for the date range and its own
 * filters. The engine wraps that SQL as a subquery and does the parts every
 * report shares: the From → To range (India days), search, sort, server-side
 * pagination, totals over the whole filtered set, and an "all rows" read for
 * PDF / CSV export.
 *
 * Nothing user-typed ever reaches the SQL text: values go in as $n params,
 * sort keys and select options are checked against the definition.
 */

const MAX_RANGE_DAYS = 1100; // about three years
const PAGE_SIZES = [10, 25, 50, 100];
const EXPORT_LIMIT = 5000;

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A real calendar day: 2026-13-01 and 2026-02-30 are refused, not thrown on.
const isDay = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** ?from&to as India days. Missing means today; a "to" past today stops at today. */
function reportRange(query) {
  // India is UTC+5:30 all year; no database round trip for "today".
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const from = query.from || today;
  let to = query.to || today;
  if (!isDay(from) || !isDay(to)) throw new ReportError(400, 'From and To are dates like 2026-10-31.');
  if (from > to) throw new ReportError(400, 'From is after To.');
  if (from > today) throw new ReportError(400, 'From is in the future.');
  if (to > today) to = today;
  const days = daysBetween(from, to) + 1;
  if (days > MAX_RANGE_DAYS) throw new ReportError(400, `Pick at most ${MAX_RANGE_DAYS} days.`);
  return { from, to, days, today };
}

/**
 * Reads the report's own filters from the query string. Unknown or empty
 * values are dropped (= "all"); a select value must be one of its options.
 */
function parseFilters(def, query) {
  const values = {};
  for (const f of def.filters || []) {
    const raw = query[f.key];
    if (raw == null || raw === '') {
      if (f.default != null) values[f.key] = f.default;
      continue;
    }
    const v = String(raw).trim();
    if (f.type === 'select') {
      if (!f.options.some((o) => o.value === v)) throw new ReportError(400, `${f.label}: unknown value.`);
      values[f.key] = v;
    } else if (f.type === 'shop' || f.type === 'brand') {
      if (!/^\d+$/.test(v)) throw new ReportError(400, `${f.label}: pick from the list.`);
      values[f.key] = Number(v);
    } else if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new ReportError(400, `${f.label}: a number of 0 or more.`);
      // Money filters are typed in rupees and compared in paise.
      values[f.key] = f.money ? Math.round(n * 100) : n;
    } else {
      // text, category, city
      if (v.length > 100) throw new ReportError(400, `${f.label}: at most 100 characters.`);
      values[f.key] = v;
    }
  }
  return values;
}

const quote = (key) => `"${String(key).replace(/"/g, '')}"`;
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Runs a report. `opts.all` reads up to EXPORT_LIMIT rows from the first one,
 * for the PDF and CSV exports.
 */
async function runReport(db, def, query, opts = {}) {
  const range = def.noDates ? null : reportRange(query);
  const f = parseFilters(def, query);

  const params = [];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  // [start, end) of the range in IST, as SQL over a timestamptz column.
  let win = null;
  const inRange = (col) => {
    if (!range) return 'TRUE';
    if (!win) win = { s: p(range.from), e: p(range.to) };
    return `${col} >= (${win.s}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND ${col} < ((${win.e}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
  };
  const base = def.sql({ range, f, p, inRange });

  // Filters on a computed column are applied outside the report's SQL.
  const outer = [];
  for (const flt of def.filters || []) {
    if (!flt.outer || f[flt.key] == null) continue;
    const col = `r.${quote(flt.outer)}`;
    if (flt.op === 'gte') outer.push(`${col} >= ${p(f[flt.key])}`);
    else if (flt.op === 'lte') outer.push(`${col} <= ${p(f[flt.key])}`);
    else if (flt.op === 'ilike') outer.push(`${col}::text ILIKE ${p(`%${likeEscape(f[flt.key])}%`)}`);
    else outer.push(`${col} = ${p(f[flt.key])}`);
  }

  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const searchable = def.columns.filter((c) => c.search);
  if (q && searchable.length) {
    const like = p(`%${likeEscape(q)}%`);
    outer.push(`(${searchable.map((c) => `r.${quote(c.key)}::text ILIKE ${like}`).join(' OR ')})`);
  }
  const where = outer.length ? `WHERE ${outer.join(' AND ')}` : '';

  const sortCol = def.columns.find((c) => c.key === query.sort && c.sortable !== false) ? query.sort : def.defaultSort.key;
  const dir = query.dir === 'asc' || query.dir === 'desc' ? query.dir : def.defaultSort.dir;
  const tiebreak = def.columns[0].key === sortCol ? '' : `, r.${quote(def.columns[0].key)}`;
  const orderBy = `ORDER BY r.${quote(sortCol)} ${dir.toUpperCase()} NULLS LAST${tiebreak}`;

  let page = 1;
  let pageSize = EXPORT_LIMIT;
  if (!opts.all) {
    pageSize = PAGE_SIZES.includes(Number(query.pageSize)) ? Number(query.pageSize) : 25;
    page = Math.max(1, Math.floor(Number(query.page)) || 1);
  }
  const offset = (page - 1) * pageSize;

  // Totals and the page together (the pool runs them on two connections).
  const summarySql = (def.summary || []).map((s) => `${s.sql} AS ${quote(s.key)}`);
  const [head, rows] = await Promise.all([
    db.query(`SELECT ${['COUNT(*)::int AS __total', ...summarySql].join(', ')} FROM (${base}) r ${where}`, params),
    db.query(
      `SELECT * FROM (${base}) r ${where} ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    ),
  ]);
  const total = head.rows[0].__total;

  return {
    report: def.key,
    range,
    filters: f,
    q,
    sort: { key: sortCol, dir },
    page,
    pageSize,
    total,
    truncated: !!opts.all && total > EXPORT_LIMIT,
    summary: (def.summary || []).map((s) => ({
      key: s.key,
      label: s.label,
      type: s.type,
      value: head.rows[0][s.key] == null || s.type === 'text' ? head.rows[0][s.key] ?? null : Number(head.rows[0][s.key]),
    })),
    rows: rows.rows.map((r) => {
      const out = {};
      for (const c of def.columns) {
        const v = r[c.key];
        out[c.key] = v != null && ['int', 'money', 'percent', 'number'].includes(c.type) ? Number(v) : v;
      }
      return out;
    }),
  };
}

/** What the Reports page needs to draw a report: everything but the SQL. */
function describe(def) {
  return {
    key: def.key,
    group: def.group,
    title: def.title,
    description: def.description,
    keywords: def.keywords || [],
    noDates: !!def.noDates,
    filters: (def.filters || []).map(({ key, label, type, options, default: d, money }) => ({
      key, label, type, options, default: d, money: !!money,
    })),
    columns: def.columns.map(({ key, label, type, sortable, search }) => ({
      key, label, type, sortable: sortable !== false, search: !!search,
    })),
    defaultSort: def.defaultSort,
    summary: (def.summary || []).map(({ key, label, type }) => ({ key, label, type })),
    notes: def.notes || null,
  };
}

module.exports = { ReportError, runReport, describe, reportRange, PAGE_SIZES, EXPORT_LIMIT, MAX_RANGE_DAYS };
