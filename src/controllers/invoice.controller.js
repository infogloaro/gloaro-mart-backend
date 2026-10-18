const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const { toCsv } = require('../services/csv');
const { issueForOrder } = require('../services/invoices');

/**
 * Admin → Invoices & GST, and the customer's copy of their invoice. Invoices
 * are issued on delivery by services/invoices.js; here they are read, filed
 * and, when wrong, cancelled. Nothing here edits an issued invoice.
 */

const PAGE_SIZE = 25;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// Months are India's: an invoice issued at 00:30 IST on the 1st belongs to that month.
const IN_MONTH = `to_char(i.invoice_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $1`;

const SELECT = `
  SELECT i.*, COALESCE(cg.reference, '#' || i.order_id) AS group_reference
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id`;

function toJson(i) {
  return {
    id: i.id,
    invoiceNumber: i.invoice_number,
    invoiceDate: i.invoice_date,
    orderId: i.order_id,
    orderReference: `${i.group_reference} · #${i.order_id}`,
    vendorId: i.vendor_id,
    vendorName: i.vendor_name,
    vendorGstin: i.vendor_gstin,
    buyerName: i.buyer_name,
    buyerGstin: i.buyer_gstin,
    placeOfSupply: i.place_of_supply,
    supplyType: i.supply_type,
    taxableCents: i.taxable_cents,
    cgstCents: i.cgst_cents,
    sgstCents: i.sgst_cents,
    igstCents: i.igst_cents,
    cessCents: i.cess_cents,
    discountCents: i.discount_cents,
    roundOffCents: i.round_off_cents,
    totalCents: i.total_cents,
    status: i.status,
    cancelledAt: i.cancelled_at,
    cancelReason: i.cancel_reason,
    creditNoteNumber: i.credit_note_number,
    pdfUrl: i.pdf_url,
    createdAt: i.created_at,
  };
}

const lineJson = (l) => ({
  id: l.id,
  description: l.description,
  hsnCode: l.hsn_code,
  quantity: l.quantity,
  unitPriceCents: l.unit_price_cents,
  discountCents: l.discount_cents,
  taxableCents: l.taxable_cents,
  gstRatePercent: Number(l.gst_rate_percent),
  cgstCents: l.cgst_cents,
  sgstCents: l.sgst_cents,
  igstCents: l.igst_cents,
  cessCents: l.cess_cents,
  totalCents: l.total_cents,
});

async function loadDetail(where, params) {
  const { rows } = await pool.query(`${SELECT} WHERE ${where}`, params);
  if (!rows[0]) return null;
  const { rows: lines } = await pool.query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY id', [rows[0].id]);
  return {
    ...toJson(rows[0]),
    billingAddress: rows[0].billing_address,
    shippingAddress: rows[0].shipping_address,
    vendorAddress: rows[0].vendor_address,
    lines: lines.map(lineJson),
  };
}

function monthOf(req, res) {
  const month = req.query.month;
  if (!MONTH.test(month ?? '')) {
    res.status(400).json({ message: 'month must look like 2026-10' });
    return null;
  }
  return month;
}

const TYPE_FILTERS = {
  b2b: "i.buyer_gstin IS NOT NULL AND i.status = 'issued'",
  b2c: "i.buyer_gstin IS NULL AND i.status = 'issued'",
  cancelled: "i.status = 'cancelled'",
};

async function listInvoices(req, res) {
  // Without a month it searches every month — the credit-note picker looks invoices up that way.
  let month = null;
  if (req.query.month) {
    month = monthOf(req, res);
    if (!month) return;
  }
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = month ? [month] : [];
  const conditions = month ? [IN_MONTH] : ['TRUE'];
  if (req.query.type && req.query.type !== 'all') {
    if (!TYPE_FILTERS[req.query.type]) return res.status(400).json({ message: 'Unknown type' });
    conditions.push(TYPE_FILTERS[req.query.type]);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(i.invoice_number ILIKE ${p} OR i.buyer_gstin ILIKE ${p} OR i.vendor_gstin ILIKE ${p} OR i.buyer_name ILIKE ${p}
        OR i.vendor_name ILIKE ${p} OR cg.reference ILIKE ${p} OR ('#' || i.order_id) ILIKE ${p})`
    );
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY i.invoice_date DESC, i.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM invoices i JOIN orders o ON o.id = i.order_id
       LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id ${where}`,
      params
    ),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

/** The month's totals. Cancelled and credit-noted invoices are counted but kept out of the money. */
async function invoiceSummary(req, res) {
  const month = monthOf(req, res);
  if (!month) return;
  const LIVE = "i.status = 'issued' AND i.credit_note_number IS NULL";
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${LIVE})::int AS count,
            COUNT(*) FILTER (WHERE ${LIVE} AND i.buyer_gstin IS NOT NULL)::int AS b2b,
            COUNT(*) FILTER (WHERE i.status = 'cancelled')::int AS cancelled,
            COUNT(*) FILTER (WHERE i.status = 'issued' AND i.credit_note_number IS NOT NULL)::int AS credit_noted,
            COALESCE(SUM(i.taxable_cents) FILTER (WHERE ${LIVE}), 0)::bigint AS taxable,
            COALESCE(SUM(i.cgst_cents) FILTER (WHERE ${LIVE}), 0)::bigint AS cgst,
            COALESCE(SUM(i.sgst_cents) FILTER (WHERE ${LIVE}), 0)::bigint AS sgst,
            COALESCE(SUM(i.igst_cents) FILTER (WHERE ${LIVE}), 0)::bigint AS igst,
            COALESCE(SUM(i.total_cents) FILTER (WHERE ${LIVE}), 0)::bigint AS total
     FROM invoices i WHERE ${IN_MONTH}`,
    [month]
  );
  const s = rows[0];
  res.json({
    count: s.count,
    b2bCount: s.b2b,
    cancelledCount: s.cancelled,
    creditNotedCount: s.credit_noted,
    taxableCents: Number(s.taxable),
    cgstCents: Number(s.cgst),
    sgstCents: Number(s.sgst),
    igstCents: Number(s.igst),
    totalCents: Number(s.total),
  });
}

async function getInvoice(req, res) {
  const detail = await loadDetail('i.id = $1', [Number(req.params.id)]);
  if (!detail) return res.status(404).json({ message: 'Invoice not found' });
  res.json(detail);
}

const rupees = (cents) => (cents / 100).toFixed(2);

/**
 * The month for filing: one row per invoice per tax rate, the shape GSTR-1's
 * B2B and B2C tables are built from. Cancelled invoices are listed (marked)
 * because the return still has to account for the number.
 */
async function exportInvoices(req, res) {
  const month = monthOf(req, res);
  if (!month) return;
  const { rows } = await pool.query(
    `SELECT i.*, l.gst_rate_percent AS rate,
            SUM(l.taxable_cents)::bigint AS l_taxable, SUM(l.igst_cents)::bigint AS l_igst,
            SUM(l.cgst_cents)::bigint AS l_cgst, SUM(l.sgst_cents)::bigint AS l_sgst, SUM(l.cess_cents)::bigint AS l_cess
     FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
     WHERE ${IN_MONTH}
     GROUP BY i.id, l.gst_rate_percent
     ORDER BY i.invoice_date, i.invoice_number, l.gst_rate_percent`,
    [month]
  );
  const headers = ['Invoice Number', 'Invoice Date', 'Status', 'Type', 'Buyer GSTIN', 'Buyer Name', 'Supplier GSTIN', 'Supplier',
    'Place of Supply', 'Supply Type', 'Rate %', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess', 'Invoice Value', 'Credit Note'];
  const csv = toCsv(
    headers,
    rows.map((r) => ({
      'Invoice Number': r.invoice_number,
      'Invoice Date': new Date(r.invoice_date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
      Status: r.status,
      Type: r.buyer_gstin ? 'B2B' : 'B2C',
      'Buyer GSTIN': r.buyer_gstin ?? '',
      'Buyer Name': r.buyer_name,
      'Supplier GSTIN': r.vendor_gstin ?? '',
      Supplier: r.vendor_name,
      'Place of Supply': r.place_of_supply,
      'Supply Type': r.supply_type === 'inter_state' ? 'Inter-state' : 'Intra-state',
      'Rate %': Number(r.rate),
      'Taxable Value': rupees(Number(r.l_taxable)),
      IGST: rupees(Number(r.l_igst)),
      CGST: rupees(Number(r.l_cgst)),
      SGST: rupees(Number(r.l_sgst)),
      Cess: rupees(Number(r.l_cess)),
      'Invoice Value': rupees(r.total_cents),
      'Credit Note': r.credit_note_number ?? '',
    }))
  );
  await recordAudit({ actorUserId: req.user.id, action: 'invoices.exported', module: 'payments', entityType: 'invoice', newValue: { month, rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gloaro-gst-${month}.csv"`);
  res.send(`﻿${csv}`);
}

/** Cancels an issued invoice. Its number is never reused; the order can be invoiced again. */
async function cancelInvoice(req, res) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) return res.status(400).json({ message: 'Give a reason (up to 500 characters).' });
  const { rows } = await pool.query(
    `UPDATE invoices SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3
     WHERE id = $1 AND status = 'issued' AND credit_note_number IS NULL RETURNING id, invoice_number, order_id`,
    [Number(req.params.id), reason, req.user.id]
  );
  if (!rows[0]) return res.status(409).json({ message: 'Only an issued invoice without a credit note can be cancelled.' });
  await recordAudit({ actorUserId: req.user.id, action: 'invoice.cancelled', module: 'payments', entityType: 'invoice', entityId: rows[0].id, newValue: { reason } });
  res.json(await loadDetail('i.id = $1', [rows[0].id]));
}

/** Issues (or re-issues after a cancellation) the invoice for a delivered order. */
async function issueInvoice(req, res) {
  const orderId = Number(req.body?.orderId);
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'orderId is required' });
  try {
    const { invoice, created } = await issueForOrder(orderId);
    if (created) {
      await recordAudit({ actorUserId: req.user.id, action: 'invoice.issued', module: 'payments', entityType: 'invoice', entityId: invoice.id, newValue: { orderId } });
    }
    res.status(created ? 201 : 200).json(await loadDetail('i.id = $1', [invoice.id]));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
}

/** The customer's own invoice for one of their orders (null until it's delivered). */
async function getForOrder(req, res) {
  const { rows } = await pool.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Order not found' });
  const detail = await loadDetail("i.order_id = $1 AND i.status = 'issued'", [rows[0].id]);
  res.json(detail);
}

module.exports = { listInvoices, invoiceSummary, getInvoice, exportInvoices, cancelInvoice, issueInvoice, getForOrder };
