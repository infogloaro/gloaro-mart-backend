const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const { CreditNoteError, raiseCreditNote, cancelCreditNote } = require('../services/creditNotes');

/** Admin → Credit Notes, and the customer's copies. The rules are in services/creditNotes.js. */

const PAGE_SIZE = 25;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const IN_MONTH = `to_char(c.credit_note_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $1`;

const SELECT = `
  SELECT c.*, i.invoice_number, i.order_id, i.vendor_id, i.vendor_name, i.buyer_name, i.buyer_gstin, i.supply_type,
         COALESCE(cg.reference, '#' || i.order_id) AS group_reference,
         u.full_name AS created_by_name, r.status AS refund_status
  FROM credit_notes c
  JOIN invoices i ON i.id = c.invoice_id
  JOIN orders o ON o.id = i.order_id
  LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
  LEFT JOIN users u ON u.id = c.created_by
  LEFT JOIN refunds r ON r.id = c.refund_id`;

function toJson(c) {
  return {
    id: c.id,
    creditNoteNumber: c.credit_note_number,
    creditNoteDate: c.credit_note_date,
    invoiceId: c.invoice_id,
    invoiceNumber: c.invoice_number,
    orderId: c.order_id,
    orderReference: `${c.group_reference} · #${c.order_id}`,
    vendorId: c.vendor_id,
    vendorName: c.vendor_name,
    buyerName: c.buyer_name,
    buyerGstin: c.buyer_gstin,
    supplyType: c.supply_type,
    reason: c.reason,
    reasonNote: c.reason_note,
    taxableCents: c.taxable_cents,
    cgstCents: c.cgst_cents,
    sgstCents: c.sgst_cents,
    igstCents: c.igst_cents,
    discountCents: c.discount_cents,
    totalCents: c.total_cents,
    status: c.status,
    refundId: c.refund_id,
    refundStatus: c.refund_status,
    returnId: c.return_id,
    pdfUrl: c.pdf_url,
    createdByName: c.created_by_name,
    createdAt: c.created_at,
  };
}

async function loadDetail(id) {
  const { rows } = await pool.query(`${SELECT} WHERE c.id = $1`, [Number(id)]);
  if (!rows[0]) return null;
  const { rows: lines } = await pool.query('SELECT * FROM credit_note_lines WHERE credit_note_id = $1 ORDER BY id', [rows[0].id]);
  return {
    ...toJson(rows[0]),
    lines: lines.map((l) => ({
      id: l.id,
      invoiceLineId: l.invoice_line_id,
      description: l.description,
      hsnCode: l.hsn_code,
      quantity: l.quantity,
      taxableCents: l.taxable_cents,
      gstRatePercent: Number(l.gst_rate_percent),
      cgstCents: l.cgst_cents,
      sgstCents: l.sgst_cents,
      igstCents: l.igst_cents,
      discountCents: l.discount_cents,
      totalCents: l.total_cents,
    })),
  };
}

function monthOf(req, res) {
  if (!MONTH.test(req.query.month ?? '')) {
    res.status(400).json({ message: 'month must look like 2026-10' });
    return null;
  }
  return req.query.month;
}

async function listCreditNotes(req, res) {
  const month = monthOf(req, res);
  if (!month) return;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [month];
  const conditions = [IN_MONTH];
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(c.credit_note_number ILIKE ${p} OR i.invoice_number ILIKE ${p} OR i.buyer_name ILIKE ${p} OR i.buyer_gstin ILIKE ${p}
        OR i.vendor_name ILIKE ${p} OR cg.reference ILIKE ${p})`
    );
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY c.credit_note_date DESC, c.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id JOIN orders o ON o.id = i.order_id
       LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id ${where}`,
      params
    ),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

/**
 * The month's credit notes, issued ones only. "Awaiting refund" counts those
 * whose refund hasn't completed, or that were paid online and have none yet;
 * COD credits are settled off-platform and aren't waiting on anything here.
 */
async function creditNoteSummary(req, res) {
  const month = monthOf(req, res);
  if (!month) return;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(c.taxable_cents), 0)::bigint AS taxable,
            COALESCE(SUM(c.cgst_cents + c.sgst_cents + c.igst_cents), 0)::bigint AS tax,
            COALESCE(SUM(c.total_cents), 0)::bigint AS total,
            COUNT(*) FILTER (WHERE (c.refund_id IS NOT NULL AND r.status <> 'completed')
              OR (c.refund_id IS NULL AND EXISTS (
                SELECT 1 FROM payments p JOIN orders o ON o.checkout_group_id = p.checkout_group_id
                WHERE o.id = i.order_id AND p.method <> 'cod' AND p.amount_captured_cents > 0)))::int AS awaiting
     FROM credit_notes c JOIN invoices i ON i.id = c.invoice_id LEFT JOIN refunds r ON r.id = c.refund_id
     WHERE ${IN_MONTH} AND c.status = 'issued'`,
    [month]
  );
  const s = rows[0];
  res.json({ count: s.count, taxableCents: Number(s.taxable), taxCents: Number(s.tax), totalCents: Number(s.total), awaitingRefund: s.awaiting });
}

async function getCreditNote(req, res) {
  const detail = await loadDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'Credit note not found' });
  res.json(detail);
}

const fail = (res, err) => {
  if (err instanceof CreditNoteError) return res.status(err.status).json({ message: err.message });
  throw err;
};

async function createCreditNote(req, res) {
  const b = req.body || {};
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) || null : null;
  try {
    const cn = await raiseCreditNote({ invoiceId: Number(b.invoiceId), reason: b.reason, note, lines: b.lines, userId: req.user.id });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'credit_note.raised',
      module: 'payments',
      entityType: 'credit_note',
      entityId: cn.id,
      newValue: { invoiceId: cn.invoice_id, number: cn.credit_note_number, totalCents: cn.total_cents, reason: cn.reason },
    });
    res.status(201).json(await loadDetail(cn.id));
  } catch (err) {
    fail(res, err);
  }
}

async function cancel(req, res) {
  try {
    const cn = await cancelCreditNote({ id: Number(req.params.id), userId: req.user.id });
    await recordAudit({ actorUserId: req.user.id, action: 'credit_note.cancelled', module: 'payments', entityType: 'credit_note', entityId: cn.id });
    res.json(await loadDetail(cn.id));
  } catch (err) {
    fail(res, err);
  }
}

/** The customer's credit notes on one of their orders. */
async function listForOrder(req, res) {
  const { rows } = await pool.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Order not found' });
  const { rows: notes } = await pool.query(`${SELECT} WHERE i.order_id = $1 AND c.status = 'issued' ORDER BY c.id`, [rows[0].id]);
  res.json({ creditNotes: await Promise.all(notes.map((n) => loadDetail(n.id))) });
}

module.exports = { listCreditNotes, creditNoteSummary, getCreditNote, createCreditNote, cancel, listForOrder };
