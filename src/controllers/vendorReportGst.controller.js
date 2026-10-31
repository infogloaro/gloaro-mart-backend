const pool = require('../config/db');

/**
 * VD18: the shop's GST for a month, ready for its accountant (GSTR-1 style).
 *
 * GET /api/vendor/reports/gst?month=YYYY-MM
 *
 * Outward supplies = tax invoices issued in the month (India time); credit
 * notes issued in the month reduce them, whichever month their invoice was
 * in — that's how GST returns treat them. Cancelled documents don't count.
 * HSN summary and rate-wise totals are net of credit notes; B2B lists each
 * invoice to a GST-registered buyer.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const IN_MONTH = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $2`;

const money = (r) => ({
  taxableCents: Number(r.taxable ?? 0),
  cgstCents: Number(r.cgst ?? 0),
  sgstCents: Number(r.sgst ?? 0),
  igstCents: Number(r.igst ?? 0),
  totalCents: Number(r.total ?? 0),
});

async function gstReport(req, res) {
  const month = req.query.month;
  if (!MONTH.test(month ?? '')) return res.status(400).json({ message: 'month looks like 2026-10' });
  const args = [req.vendorId, month];
  const SUMS = `COUNT(*)::int AS n, COALESCE(SUM(taxable_cents), 0)::bigint AS taxable, COALESCE(SUM(cgst_cents), 0)::bigint AS cgst,
                COALESCE(SUM(sgst_cents), 0)::bigint AS sgst, COALESCE(SUM(igst_cents), 0)::bigint AS igst, COALESCE(SUM(total_cents), 0)::bigint AS total`;

  const [inv, cn, hsn, rates, b2b] = await Promise.all([
    pool.query(`SELECT ${SUMS}, COUNT(*) FILTER (WHERE buyer_gstin IS NOT NULL)::int AS b2b FROM invoices WHERE vendor_id = $1 AND status = 'issued' AND ${IN_MONTH('invoice_date')}`, args),
    pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(c.taxable_cents), 0)::bigint AS taxable, COALESCE(SUM(c.cgst_cents), 0)::bigint AS cgst,
              COALESCE(SUM(c.sgst_cents), 0)::bigint AS sgst, COALESCE(SUM(c.igst_cents), 0)::bigint AS igst, COALESCE(SUM(c.total_cents), 0)::bigint AS total
       FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id
       WHERE i.vendor_id = $1 AND c.status = 'issued' AND ${IN_MONTH('c.credit_note_date')}`,
      args
    ),
    // HSN summary: invoice lines in the month minus credit-note lines in the month.
    pool.query(
      `WITH lines AS (
         SELECT COALESCE(NULLIF(trim(l.hsn_code), ''), '—') AS hsn, l.description, l.gst_rate_percent AS rate, l.quantity AS qty,
                l.taxable_cents, l.cgst_cents, l.sgst_cents, l.igst_cents, l.total_cents
         FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE i.vendor_id = $1 AND i.status = 'issued' AND ${IN_MONTH('i.invoice_date')}
         UNION ALL
         SELECT COALESCE(NULLIF(trim(cl.hsn_code), ''), '—'), cl.description, cl.gst_rate_percent, -cl.quantity,
                -cl.taxable_cents, -cl.cgst_cents, -cl.sgst_cents, -cl.igst_cents, -cl.total_cents
         FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id JOIN invoices i ON i.id = c.invoice_id
         WHERE i.vendor_id = $1 AND c.status = 'issued' AND ${IN_MONTH('c.credit_note_date')}
       )
       SELECT hsn, MIN(description) AS description, rate, SUM(qty)::int AS qty,
              SUM(taxable_cents)::bigint AS taxable, SUM(cgst_cents)::bigint AS cgst, SUM(sgst_cents)::bigint AS sgst,
              SUM(igst_cents)::bigint AS igst, SUM(total_cents)::bigint AS total
       FROM lines GROUP BY hsn, rate ORDER BY SUM(taxable_cents) DESC, hsn`,
      args
    ),
    pool.query(
      `WITH lines AS (
         SELECT l.gst_rate_percent AS rate, l.taxable_cents, l.cgst_cents, l.sgst_cents, l.igst_cents, l.total_cents
         FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE i.vendor_id = $1 AND i.status = 'issued' AND ${IN_MONTH('i.invoice_date')}
         UNION ALL
         SELECT cl.gst_rate_percent, -cl.taxable_cents, -cl.cgst_cents, -cl.sgst_cents, -cl.igst_cents, -cl.total_cents
         FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id JOIN invoices i ON i.id = c.invoice_id
         WHERE i.vendor_id = $1 AND c.status = 'issued' AND ${IN_MONTH('c.credit_note_date')}
       )
       SELECT rate, SUM(taxable_cents)::bigint AS taxable, SUM(cgst_cents)::bigint AS cgst, SUM(sgst_cents)::bigint AS sgst,
              SUM(igst_cents)::bigint AS igst, SUM(total_cents)::bigint AS total
       FROM lines GROUP BY rate ORDER BY rate`,
      args
    ),
    pool.query(
      `SELECT invoice_number, invoice_date, buyer_name, buyer_gstin, place_of_supply, taxable_cents AS taxable, cgst_cents AS cgst,
              sgst_cents AS sgst, igst_cents AS igst, total_cents AS total
       FROM invoices WHERE vendor_id = $1 AND status = 'issued' AND buyer_gstin IS NOT NULL AND ${IN_MONTH('invoice_date')}
       ORDER BY invoice_date, invoice_number`,
      args
    ),
  ]);

  const i = inv.rows[0];
  const c = cn.rows[0];
  const net = {
    taxableCents: Number(i.taxable) - Number(c.taxable),
    cgstCents: Number(i.cgst) - Number(c.cgst),
    sgstCents: Number(i.sgst) - Number(c.sgst),
    igstCents: Number(i.igst) - Number(c.igst),
    totalCents: Number(i.total) - Number(c.total),
  };
  res.json({
    month,
    invoices: { count: i.n, b2bCount: i.b2b, ...money(i) },
    creditNotes: { count: c.n, ...money(c) },
    net: { ...net, taxCents: net.cgstCents + net.sgstCents + net.igstCents },
    byRate: rates.rows.map((r) => ({ ratePercent: Number(r.rate), ...money(r) })),
    hsn: hsn.rows.map((r) => ({ hsn: r.hsn, description: r.description, ratePercent: Number(r.rate), quantity: r.qty, ...money(r) })),
    b2b: b2b.rows.map((r) => ({
      invoiceNumber: r.invoice_number,
      invoiceDate: r.invoice_date,
      buyerName: r.buyer_name,
      buyerGstin: r.buyer_gstin,
      placeOfSupply: r.place_of_supply,
      ...money(r),
    })),
  });
}

module.exports = { gstReport };
