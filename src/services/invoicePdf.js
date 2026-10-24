const pool = require('../config/db');
const simplePdf = require('./simplePdf');

/**
 * A shop order's tax invoice as a PDF (for WhatsApp), from the invoice as
 * issued (schema INVOICES & GST, PHASE 40). Null when it doesn't exist or was
 * cancelled. The table is in Courier so its columns line up.
 */

const rs = (cents) => (Number(cents) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const cut = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}~` : String(s ?? ''));
const col = (s, n, right = false) => (right ? cut(s, n).padStart(n) : cut(s, n).padEnd(n));
// Courier 8 pt: 4.8 pt a character, 515 pt of line → 107; the table uses 105.
const WIDTH = 105;

async function buildInvoicePdf(invoiceId, db = pool) {
  const { rows: [inv] } = await db.query(
    `SELECT i.*, COALESCE(cg.reference, 'GLM-ORDER-' || o.id) AS order_ref
     FROM invoices i JOIN orders o ON o.id = i.order_id LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
     WHERE i.id = $1 AND i.status = 'issued'`,
    [Number(invoiceId)]
  );
  if (!inv) return null;
  const { rows: items } = await db.query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY id', [inv.id]);

  const lines = [];
  const text = (t, o = {}) => lines.push({ text: t, ...o });
  const block = (title, body) => {
    text(title, { font: 'bold', size: 8.5 });
    for (const l of String(body ?? '-').split('\n')) text(l, { size: 8.5, gap: 11 });
  };

  text('TAX INVOICE', { font: 'bold', size: 15, gap: 18 });
  text(inv.vendor_name, { font: 'bold', size: 11 });
  for (const l of String(inv.vendor_address ?? '').split('\n').filter(Boolean)) text(l, { size: 8.5, gap: 11 });
  if (inv.vendor_gstin) text(`GSTIN: ${inv.vendor_gstin}`, { size: 8.5, gap: 11 });
  lines.push({ rule: true, gap: 10 });
  text(`Invoice no: ${inv.invoice_number}     Date: ${day(inv.invoice_date)}     Order: ${inv.order_ref}`, { font: 'bold', size: 9 });
  text(`Place of supply: ${inv.place_of_supply} (${inv.supply_type === 'inter_state' ? 'inter-state, IGST' : 'intra-state, CGST + SGST'})`, { size: 8.5 });
  lines.push({ rule: true, gap: 10 });
  block('Bill to', [inv.buyer_name, inv.billing_address, inv.buyer_gstin ? `GSTIN: ${inv.buyer_gstin}` : null].filter(Boolean).join('\n'));
  if (inv.shipping_address && inv.shipping_address !== inv.billing_address) block('Ship to', inv.shipping_address);
  lines.push({ rule: true, gap: 10 });

  const header = [col('#', 3), col('Item', 30), col('HSN', 8), col('Qty', 5, true), col('Rate', 11, true), col('Taxable', 12, true),
    col('GST%', 6, true), col('Tax', 10, true), col('Total', 12, true)].join(' ');
  text(header.slice(0, WIDTH), { font: 'monoBold', size: 8 });
  items.forEach((l, i) => {
    const tax = l.cgst_cents + l.sgst_cents + l.igst_cents + l.cess_cents;
    const row = [col(i + 1, 3), col(l.description, 30), col(l.hsn_code ?? '', 8), col(l.quantity, 5, true), col(rs(l.unit_price_cents), 11, true),
      col(rs(l.taxable_cents), 12, true), col(Number(l.gst_rate_percent), 6, true), col(rs(tax), 10, true), col(rs(l.total_cents), 12, true)].join(' ');
    text(row.slice(0, WIDTH), { font: 'mono', size: 8, gap: 11 });
  });
  lines.push({ rule: true, gap: 10 });

  const sum = (label, cents, bold = false) => text(`${label.padStart(WIDTH - 15)} ${rs(cents).padStart(12)}`, { font: bold ? 'monoBold' : 'mono', size: 8, gap: 11 });
  sum('Taxable value', inv.taxable_cents);
  if (inv.cgst_cents) sum('CGST', inv.cgst_cents);
  if (inv.sgst_cents) sum('SGST', inv.sgst_cents);
  if (inv.igst_cents) sum('IGST', inv.igst_cents);
  if (inv.cess_cents) sum('Cess', inv.cess_cents);
  if (inv.discount_cents) sum('Discount', -inv.discount_cents);
  if (inv.round_off_cents) sum('Round off', inv.round_off_cents);
  sum('Invoice total (Rs.)', inv.total_cents, true);
  lines.push({ rule: true, gap: 14 });
  text('This is a computer-generated invoice and needs no signature. Sold through Gloaro Mart.', { size: 7.5 });

  return {
    buffer: simplePdf.render(lines),
    filename: `Invoice-${inv.invoice_number.replace(/[^\w.-]+/g, '-')}.pdf`,
    invoiceNumber: inv.invoice_number,
  };
}

module.exports = { buildInvoicePdf };
