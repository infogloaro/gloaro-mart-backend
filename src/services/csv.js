/**
 * A small RFC 4180 CSV reader/writer.
 *
 * Written rather than depended on because the alternative is a parse library in
 * the dependency tree for two functions, and the format we accept is narrow: a
 * header row, then rows exported by this same module or edited in a spreadsheet.
 *
 * It does handle the three things a spreadsheet actually produces and a naive
 * `split(',')` gets wrong: quoted fields containing commas, escaped quotes
 * (`""`), and newlines inside quoted fields.
 */

/**
 * Splits CSV text into rows of raw string cells.
 *
 * Character-by-character rather than line-by-line, because a quoted field may
 * contain a newline and splitting on newlines first would tear it in half.
 */
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // A leading BOM is invisible in Excel but would otherwise become part of the
  // first header name, so the first column silently stops matching.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // Swallow; the \n that follows ends the row.
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // A file not ending in a newline still has a final row.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parses CSV into objects keyed by header name.
 *
 * Each object carries a non-enumerable `__line` so an error can name the row
 * number the operator sees in their spreadsheet (1 = header, so data starts
 * at 2) rather than a zero-based index they would have to translate.
 */
function parseCsv(text) {
  const rows = parseRows(String(text ?? '').trim());
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim());
  const records = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // A trailing blank line is not a record, and a spreadsheet leaves plenty.
    if (cells.every((c) => c.trim() === '')) continue;

    const record = {};
    headers.forEach((header, c) => {
      record[header] = (cells[c] ?? '').trim();
    });
    Object.defineProperty(record, '__line', { value: r + 1, enumerable: false });
    records.push(record);
  }

  return { headers, records };
}

/** Quotes a cell only when it would otherwise change meaning. */
function escapeCell(value) {
  if (value == null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Serialises rows to CSV.
 *
 * CRLF line endings: Excel on Windows treats a bare \n as one long line in some
 * import paths, and CRLF is what RFC 4180 specifies anyway.
 */
function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return lines.join('\r\n');
}

module.exports = { parseCsv, toCsv };
