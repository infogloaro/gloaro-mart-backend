/**
 * RP3 — Tax (GST) reports, from issued tax invoices and credit notes — the
 * same source and rules as the shop's own GST report (vendorReportGst, VD18):
 * a credit note counts in the period it was issued, whichever period its
 * invoice was in, and cancelled documents don't count.
 */
const { F } = require('./sales');

const RATE = {
  key: 'rate',
  label: 'GST rate',
  type: 'select',
  options: ['0', '5', '12', '18', '28'].map((r) => ({ value: r, label: `${r}%` })),
};
const SUPPLY = {
  key: 'supply',
  label: 'Supply',
  type: 'select',
  options: [
    { value: 'intra_state', label: 'Within the state (CGST + SGST)' },
    { value: 'inter_state', label: 'Other state (IGST)' },
  ],
};
const MONTH = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`;

/**
 * Invoice lines issued in the range, minus credit-note lines issued in the
 * range, with the document's shop, month and supply type.
 */
function gstLines({ f, p, inRange }) {
  const w = [];
  if (f.shop != null) w.push(`i.vendor_id = ${p(f.shop)}`);
  if (f.supply) w.push(`i.supply_type = ${p(f.supply)}`);
  const lineRate = (col) => (f.rate ? `AND ${col} = ${p(f.rate)}::numeric` : '');
  const and = w.length ? `AND ${w.join(' AND ')}` : '';
  return `
    SELECT i.vendor_id, ${MONTH('i.invoice_date')} AS month, COALESCE(NULLIF(TRIM(l.hsn_code), ''), '—') AS hsn,
           l.description, l.gst_rate_percent AS rate, l.quantity AS qty, l.taxable_cents AS taxable,
           l.cgst_cents AS cgst, l.sgst_cents AS sgst, l.igst_cents AS igst, l.total_cents AS total
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
    WHERE i.status = 'issued' AND ${inRange('i.invoice_date')} ${and} ${lineRate('l.gst_rate_percent')}
    UNION ALL
    SELECT i.vendor_id, ${MONTH('c.credit_note_date')}, COALESCE(NULLIF(TRIM(cl.hsn_code), ''), '—'),
           cl.description, cl.gst_rate_percent, -cl.quantity, -cl.taxable_cents,
           -cl.cgst_cents, -cl.sgst_cents, -cl.igst_cents, -cl.total_cents
    FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id JOIN invoices i ON i.id = c.invoice_id
    WHERE c.status = 'issued' AND ${inRange('c.credit_note_date')} ${and} ${lineRate('cl.gst_rate_percent')}`;
}

const TAX_COLUMNS = [
  { key: 'taxable', label: 'Taxable value', type: 'money' },
  { key: 'cgst', label: 'CGST', type: 'money' },
  { key: 'sgst', label: 'SGST', type: 'money' },
  { key: 'igst', label: 'IGST', type: 'money' },
  { key: 'tax', label: 'Total tax', type: 'money' },
  { key: 'total', label: 'Invoice value', type: 'money' },
];
const TAX_SUMS = `SUM(taxable) AS taxable, SUM(cgst) AS cgst, SUM(sgst) AS sgst, SUM(igst) AS igst,
                  SUM(cgst + sgst + igst) AS tax, SUM(total) AS total`;
const TAX_SUMMARY = [
  { key: 'taxable', label: 'Taxable value', type: 'money', sql: 'COALESCE(SUM(r.taxable), 0)' },
  { key: 'cgst', label: 'CGST', type: 'money', sql: 'COALESCE(SUM(r.cgst), 0)' },
  { key: 'sgst', label: 'SGST', type: 'money', sql: 'COALESCE(SUM(r.sgst), 0)' },
  { key: 'igst', label: 'IGST', type: 'money', sql: 'COALESCE(SUM(r.igst), 0)' },
  { key: 'tax', label: 'Total tax', type: 'money', sql: 'COALESCE(SUM(r.tax), 0)' },
];
const NET_NOTE = 'Issued tax invoices minus credit notes issued in the range (a credit note counts when it is issued). Cancelled documents are left out.';

const gstHsn = {
  key: 'gst-hsn',
  group: 'tax',
  title: 'GST by HSN',
  description: 'HSN-wise summary (as in GSTR-1 table 12): quantity, taxable value and CGST / SGST / IGST, net of credit notes.',
  keywords: ['gst', 'hsn', 'gstr-1', 'gstr1', 'tax', 'cgst', 'sgst', 'igst', 'monthly gst'],
  filters: [
    {
      key: 'groupBy',
      label: 'Show',
      type: 'select',
      default: 'hsn',
      options: [
        { value: 'hsn', label: 'Whole range' },
        { value: 'month', label: 'Month by month' },
      ],
    },
    F.shop,
    RATE,
    SUPPLY,
  ],
  columns: [
    { key: 'month', label: 'Month', type: 'text', search: true },
    { key: 'hsn', label: 'HSN', type: 'text', search: true },
    { key: 'description', label: 'Description', type: 'text', search: true },
    { key: 'rate', label: 'Rate', type: 'percent' },
    { key: 'qty', label: 'Qty', type: 'int' },
    ...TAX_COLUMNS,
  ],
  defaultSort: { key: 'taxable', dir: 'desc' },
  summary: [{ key: 'codes', label: 'HSN codes', type: 'int', sql: 'COUNT(DISTINCT r.hsn)' }, ...TAX_SUMMARY],
  notes: `${NET_NOTE} "—" means the product has no HSN code yet.`,
  sql: (ctx) => {
    const month = ctx.f.groupBy === 'month' ? 'month' : `'All'`;
    return `
      WITH g AS (${gstLines(ctx)})
      SELECT ${month} AS month, hsn, MIN(description) AS description, rate, SUM(qty) AS qty, ${TAX_SUMS}
      FROM g GROUP BY 1, hsn, rate`;
  },
};

const gstByRate = {
  key: 'gst-by-rate',
  group: 'tax',
  title: 'GST by rate',
  description: 'Taxable value and tax for each GST rate, for the range or month by month.',
  keywords: ['gst rate', 'tax slab', '5%', '12%', '18%', '28%', 'rate wise'],
  filters: [
    {
      key: 'groupBy',
      label: 'Show',
      type: 'select',
      default: 'all',
      options: [
        { value: 'all', label: 'Whole range' },
        { value: 'month', label: 'Month by month' },
      ],
    },
    F.shop,
    SUPPLY,
  ],
  columns: [
    { key: 'month', label: 'Month', type: 'text' },
    { key: 'rate', label: 'Rate', type: 'percent' },
    { key: 'qty', label: 'Qty', type: 'int' },
    ...TAX_COLUMNS,
  ],
  defaultSort: { key: 'rate', dir: 'asc' },
  summary: TAX_SUMMARY,
  notes: NET_NOTE,
  sql: (ctx) => `
    WITH g AS (${gstLines(ctx)})
    SELECT ${ctx.f.groupBy === 'month' ? 'month' : `'All'`} AS month, rate, SUM(qty) AS qty, ${TAX_SUMS}
    FROM g GROUP BY 1, rate`,
};

const gstByShop = {
  key: 'gst-by-shop',
  group: 'tax',
  title: 'Tax collected per shop',
  description: 'Each shop’s GSTIN, invoices, credit notes, taxable value and tax, net of credit notes.',
  keywords: ['gstin', 'vendor gst', 'shop tax', 'tax collected', 'seller gst'],
  filters: [
    F.shop,
    { key: 'shopCity', label: 'Shop city', type: 'city' },
    {
      key: 'gstin',
      label: 'GSTIN',
      type: 'select',
      options: [
        { value: 'yes', label: 'Has a GSTIN' },
        { value: 'no', label: 'No GSTIN' },
      ],
    },
    SUPPLY,
  ],
  columns: [
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'gstin', label: 'GSTIN', type: 'text', search: true },
    { key: 'state', label: 'State', type: 'text', search: true },
    { key: 'invoices', label: 'Invoices', type: 'int' },
    { key: 'credit_notes', label: 'Credit notes', type: 'int' },
    ...TAX_COLUMNS,
  ],
  defaultSort: { key: 'tax', dir: 'desc' },
  summary: [
    { key: 'shops', label: 'Shops', type: 'int', sql: 'COUNT(*)' },
    { key: 'invoices', label: 'Invoices', type: 'int', sql: 'COALESCE(SUM(r.invoices), 0)' },
    ...TAX_SUMMARY,
  ],
  notes: `${NET_NOTE} Only shops with an invoice or credit note in the range are listed.`,
  sql: (ctx) => {
    const { f, p, inRange } = ctx;
    const w = [];
    if (f.shopCity) w.push(`LOWER(v.city) = LOWER(${p(f.shopCity)})`);
    if (f.gstin === 'yes') w.push(`NULLIF(TRIM(v.gst_number), '') IS NOT NULL`);
    if (f.gstin === 'no') w.push(`NULLIF(TRIM(v.gst_number), '') IS NULL`);
    const docs = (alias, dateCol, from) => {
      const dw = [`${alias}.status = 'issued'`, inRange(dateCol)];
      if (f.shop != null) dw.push(`i.vendor_id = ${p(f.shop)}`);
      if (f.supply) dw.push(`i.supply_type = ${p(f.supply)}`);
      return `SELECT i.vendor_id, COUNT(*) AS n FROM ${from} WHERE ${dw.join(' AND ')} GROUP BY i.vendor_id`;
    };
    return `
      WITH g AS (${gstLines({ ...ctx, f: { ...f, rate: null } })}),
      t AS (SELECT vendor_id, ${TAX_SUMS} FROM g GROUP BY vendor_id),
      inv AS (${docs('i', 'i.invoice_date', 'invoices i')}),
      cn AS (${docs('c', 'c.credit_note_date', 'credit_notes c JOIN invoices i ON i.id = c.invoice_id')})
      SELECT v.business_name AS shop, v.gst_number AS gstin, v.state,
             COALESCE(inv.n, 0) AS invoices, COALESCE(cn.n, 0) AS credit_notes,
             COALESCE(t.taxable, 0) AS taxable, COALESCE(t.cgst, 0) AS cgst, COALESCE(t.sgst, 0) AS sgst,
             COALESCE(t.igst, 0) AS igst, COALESCE(t.tax, 0) AS tax, COALESCE(t.total, 0) AS total
      FROM vendor_profiles v
      LEFT JOIN t ON t.vendor_id = v.id
      LEFT JOIN inv ON inv.vendor_id = v.id
      LEFT JOIN cn ON cn.vendor_id = v.id
      WHERE (inv.n IS NOT NULL OR cn.n IS NOT NULL) ${w.length ? `AND ${w.join(' AND ')}` : ''}`;
  },
};

const gstRegister = {
  key: 'gst-register',
  group: 'tax',
  title: 'GST invoice & credit note register',
  description: 'Every tax invoice and credit note: number, date, shop, buyer, buyer GSTIN (B2B), place of supply and tax.',
  keywords: ['invoice register', 'b2b', 'b2c', 'credit note', 'sales register', 'gstr-1', 'invoice list'],
  filters: [
    {
      key: 'doc',
      label: 'Document',
      type: 'select',
      options: [
        { value: 'invoice', label: 'Tax invoices' },
        { value: 'credit_note', label: 'Credit notes' },
      ],
    },
    F.shop,
    {
      key: 'buyer',
      label: 'Buyer',
      type: 'select',
      options: [
        { value: 'b2b', label: 'B2B (has GSTIN)' },
        { value: 'b2c', label: 'B2C (consumer)' },
      ],
      outer: 'buyer_type',
    },
    SUPPLY,
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      default: 'issued',
      options: [
        { value: 'issued', label: 'Issued' },
        { value: 'cancelled', label: 'Cancelled' },
      ],
    },
    { key: 'place', label: 'Place of supply', type: 'text', outer: 'place_of_supply', op: 'ilike' },
  ],
  columns: [
    { key: 'doc_type', label: 'Document', type: 'text' },
    { key: 'number', label: 'Number', type: 'text', search: true },
    { key: 'doc_date', label: 'Date', type: 'datetime' },
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'buyer', label: 'Buyer', type: 'text', search: true },
    { key: 'buyer_gstin', label: 'Buyer GSTIN', type: 'text', search: true },
    { key: 'buyer_type', label: 'B2B / B2C', type: 'status' },
    { key: 'place_of_supply', label: 'Place of supply', type: 'text' },
    { key: 'taxable', label: 'Taxable value', type: 'money' },
    { key: 'cgst', label: 'CGST', type: 'money' },
    { key: 'sgst', label: 'SGST', type: 'money' },
    { key: 'igst', label: 'IGST', type: 'money' },
    { key: 'total', label: 'Value', type: 'money' },
  ],
  defaultSort: { key: 'doc_date', dir: 'desc' },
  summary: [
    { key: 'invoices', label: 'Invoices', type: 'int', sql: `COUNT(*) FILTER (WHERE r.doc_type = 'Tax invoice')` },
    { key: 'credit_notes', label: 'Credit notes', type: 'int', sql: `COUNT(*) FILTER (WHERE r.doc_type = 'Credit note')` },
    { key: 'b2b', label: 'B2B documents', type: 'int', sql: `COUNT(*) FILTER (WHERE r.buyer_type = 'b2b')` },
    { key: 'taxable', label: 'Net taxable', type: 'money', sql: 'COALESCE(SUM(r.taxable), 0)' },
    { key: 'tax', label: 'Net tax', type: 'money', sql: 'COALESCE(SUM(r.cgst + r.sgst + r.igst), 0)' },
  ],
  notes: 'Credit notes show as negative values, so the totals are net. Cancelled documents only show when Status is Cancelled.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`i.vendor_id = ${p(f.shop)}`);
    if (f.supply) w.push(`i.supply_type = ${p(f.supply)}`);
    const and = w.length ? `AND ${w.join(' AND ')}` : '';
    const status = p(f.status);
    const inv = `
      SELECT 'Tax invoice' AS doc_type, i.invoice_number AS number, i.invoice_date AS doc_date, i.order_id,
             COALESCE(v.business_name, i.vendor_name) AS shop, i.buyer_name AS buyer, i.buyer_gstin,
             CASE WHEN NULLIF(TRIM(i.buyer_gstin), '') IS NOT NULL THEN 'b2b' ELSE 'b2c' END AS buyer_type,
             i.place_of_supply, i.taxable_cents AS taxable, i.cgst_cents AS cgst, i.sgst_cents AS sgst,
             i.igst_cents AS igst, i.total_cents AS total
      FROM invoices i LEFT JOIN vendor_profiles v ON v.id = i.vendor_id
      WHERE i.status = ${status} AND ${inRange('i.invoice_date')} ${and}`;
    const cn = `
      SELECT 'Credit note' AS doc_type, c.credit_note_number AS number, c.credit_note_date AS doc_date, i.order_id,
             COALESCE(v.business_name, i.vendor_name) AS shop, i.buyer_name AS buyer, i.buyer_gstin,
             CASE WHEN NULLIF(TRIM(i.buyer_gstin), '') IS NOT NULL THEN 'b2b' ELSE 'b2c' END AS buyer_type,
             i.place_of_supply, -c.taxable_cents AS taxable, -c.cgst_cents AS cgst, -c.sgst_cents AS sgst,
             -c.igst_cents AS igst, -c.total_cents AS total
      FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id LEFT JOIN vendor_profiles v ON v.id = i.vendor_id
      WHERE c.status = ${status} AND ${inRange('c.credit_note_date')} ${and}`;
    if (f.doc === 'invoice') return inv;
    if (f.doc === 'credit_note') return cn;
    return `${inv} UNION ALL ${cn}`;
  },
};

module.exports = { reports: [gstHsn, gstByRate, gstByShop, gstRegister] };
