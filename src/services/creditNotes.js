const pool = require('../config/db');
const { financialYear } = require('./invoices');

/**
 * Raising and cancelling credit notes (schema CREDIT NOTES, PHASE 41).
 * Used by Admin → Credit Notes and by an approved return.
 */

const REASONS = ['return', 'cancellation', 'price_adjustment', 'deficiency', 'other'];

class CreditNoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** What is still creditable on each line of an invoice: invoiced less issued credit notes. */
async function remainingByLine(client, invoiceId) {
  const { rows } = await client.query(
    `SELECT l.*,
            l.quantity - COALESCE(c.qty, 0) AS remaining_qty,
            l.taxable_cents - COALESCE(c.taxable, 0) AS remaining_taxable,
            l.cgst_cents - COALESCE(c.cgst, 0) AS remaining_cgst,
            l.sgst_cents - COALESCE(c.sgst, 0) AS remaining_sgst,
            l.igst_cents - COALESCE(c.igst, 0) AS remaining_igst,
            l.discount_cents - COALESCE(c.discount, 0) AS remaining_discount
     FROM invoice_lines l
     LEFT JOIN LATERAL (
       SELECT SUM(cl.quantity)::int AS qty, SUM(cl.taxable_cents)::int AS taxable, SUM(cl.cgst_cents)::int AS cgst,
              SUM(cl.sgst_cents)::int AS sgst, SUM(cl.igst_cents)::int AS igst, SUM(cl.discount_cents)::int AS discount
       FROM credit_note_lines cl JOIN credit_notes cn ON cn.id = cl.credit_note_id
       WHERE cl.invoice_line_id = l.id AND cn.status = 'issued'
     ) c ON TRUE
     WHERE l.invoice_id = $1 ORDER BY l.id`,
    [invoiceId]
  );
  return rows;
}

/** A share of `amount` for `qty` of `of` units; the last units take whatever is left. */
const share = (remainingAmount, originalAmount, qty, originalQty, remainingQty) =>
  qty === remainingQty ? remainingAmount : Math.round((originalAmount * qty) / originalQty);

/**
 * The online payment's refund for this credit note: an existing refund on the
 * order not yet tied to a credit note is reused (an approved return already
 * raised one); otherwise a new pending refund, capped at what's refundable.
 * COD and unpaid orders get none — they are settled off-platform.
 */
async function linkRefund(client, { invoice, totalCents, userId, refundId }) {
  if (refundId) return refundId;
  const { rows: existing } = await client.query(
    `SELECT r.id FROM refunds r
     WHERE r.order_id = $1 AND r.status <> 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM credit_notes cn WHERE cn.refund_id = r.id AND cn.status = 'issued')
     ORDER BY r.created_at DESC LIMIT 1`,
    [invoice.order_id]
  );
  if (existing[0]) return existing[0].id;

  const { rows: payments } = await client.query(
    `SELECT p.*, (SELECT COALESCE(SUM(amount_cents), 0)::int FROM refunds r
                  WHERE r.payment_id = p.id AND r.status IN ('pending', 'processing')) AS open_cents
     FROM payments p JOIN orders o ON o.checkout_group_id = p.checkout_group_id
     WHERE o.id = $1 AND p.method <> 'cod' FOR UPDATE OF p`,
    [invoice.order_id]
  );
  const payment = payments[0];
  if (!payment) return null;
  const refundable = payment.amount_captured_cents - payment.amount_refunded_cents - payment.open_cents;
  const amount = Math.min(totalCents, refundable);
  if (amount <= 0) return null;
  const { rows } = await client.query(
    `INSERT INTO refunds (payment_id, order_id, amount_cents, reason, requested_by_user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [payment.id, invoice.order_id, amount, 'Credit note raised', userId]
  );
  await client.query(
    `INSERT INTO refund_transactions (refund_id, event, amount_cents, actor_role, changed_by_user_id, note)
     VALUES ($1, 'requested', $2, 'admin', $3, 'Raised with a credit note')`,
    [rows[0].id, amount, userId]
  );
  return rows[0].id;
}

/**
 * Raises a credit note. `lines` is [{ invoiceLineId, quantity }], or 'all' for
 * everything still creditable. Returns the credit note row.
 */
async function raiseCreditNote({ invoiceId, reason, note = null, lines, userId, refundId = null, returnId = null }) {
  if (!REASONS.includes(reason)) throw new CreditNoteError(400, `reason must be one of ${REASONS.join(', ')}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: invRows } = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    const invoice = invRows[0];
    if (!invoice) throw new CreditNoteError(404, 'Invoice not found');
    if (invoice.status !== 'issued') throw new CreditNoteError(409, 'A cancelled invoice cannot be credited.');

    const remaining = await remainingByLine(client, invoice.id);
    const wanted =
      lines === 'all'
        ? remaining.filter((l) => l.remaining_qty > 0).map((l) => ({ invoiceLineId: l.id, quantity: l.remaining_qty }))
        : lines;
    if (!Array.isArray(wanted) || wanted.length === 0) throw new CreditNoteError(400, 'Credit at least one line.');
    const seen = new Set();
    const built = wanted.map((w) => {
      const line = remaining.find((l) => l.id === w?.invoiceLineId);
      if (!line) throw new CreditNoteError(400, 'A line does not belong to this invoice.');
      if (seen.has(line.id)) throw new CreditNoteError(400, `${line.description} is listed twice.`);
      seen.add(line.id);
      if (!Number.isInteger(w.quantity) || w.quantity <= 0) throw new CreditNoteError(400, 'Each quantity must be a whole number above zero.');
      if (w.quantity > line.remaining_qty) {
        throw new CreditNoteError(409, `Only ${line.remaining_qty} of ${line.description} is left to credit.`);
      }
      const part = (key) => share(line[`remaining_${key}`], line[`${key}_cents`], w.quantity, line.quantity, line.remaining_qty);
      const taxable = part('taxable');
      const cgst = part('cgst');
      const sgst = part('sgst');
      const igst = part('igst');
      const discount = part('discount');
      return { line, quantity: w.quantity, taxable, cgst, sgst, igst, discount, total: taxable + cgst + sgst + igst - discount };
    });
    if (lines === 'all' && built.length === 0) throw new CreditNoteError(409, 'Everything on this invoice has already been credited.');

    const sum = (key) => built.reduce((s, b) => s + b[key], 0);
    const totalCents = sum('total');
    const date = new Date();
    const fy = financialYear(date);
    const { rows: counter } = await client.query(
      `INSERT INTO invoice_series (financial_year, last_number) VALUES ($1, 1)
       ON CONFLICT (financial_year) DO UPDATE SET last_number = invoice_series.last_number + 1
       RETURNING last_number`,
      [`CN:${fy}`]
    );
    const { rows: settings } = await client.query('SELECT invoice_prefix FROM platform_settings WHERE id = 1');
    const number = `${settings[0]?.invoice_prefix || 'GLM'}-CN/${fy}/${String(counter[0].last_number).padStart(6, '0')}`;

    const linkedRefund = await linkRefund(client, { invoice, totalCents, userId, refundId });
    const { rows: cn } = await client.query(
      `INSERT INTO credit_notes (credit_note_number, credit_note_date, financial_year, invoice_id, reason, reason_note,
         taxable_cents, cgst_cents, sgst_cents, igst_cents, discount_cents, total_cents, refund_id, return_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [number, date, fy, invoice.id, reason, note, sum('taxable'), sum('cgst'), sum('sgst'), sum('igst'), sum('discount'),
        totalCents, linkedRefund, returnId, userId]
    );
    for (const b of built) {
      await client.query(
        `INSERT INTO credit_note_lines (credit_note_id, invoice_line_id, description, hsn_code, quantity, taxable_cents,
           gst_rate_percent, cgst_cents, sgst_cents, igst_cents, discount_cents, total_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [cn[0].id, b.line.id, b.line.description, b.line.hsn_code, b.quantity, b.taxable, b.line.gst_rate_percent,
          b.cgst, b.sgst, b.igst, b.discount, b.total]
      );
    }
    await client.query('UPDATE invoices SET credit_note_number = $2 WHERE id = $1', [invoice.id, number]);
    await client.query('COMMIT');
    return cn[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancels a credit note, putting the invoice back. Refused once its refund has
 * been paid out; a refund still waiting is cancelled with it.
 */
async function cancelCreditNote({ id, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM credit_notes WHERE id = $1 FOR UPDATE', [id]);
    const cn = rows[0];
    if (!cn) throw new CreditNoteError(404, 'Credit note not found');
    if (cn.status !== 'issued') throw new CreditNoteError(409, 'This credit note is already cancelled.');
    if (cn.refund_id) {
      const { rows: refund } = await client.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [cn.refund_id]);
      const r = refund[0];
      if (r && ['processing', 'completed'].includes(r.status)) {
        throw new CreditNoteError(409, `Its refund is ${r.status} — the money is already on its way back, so it can't be cancelled.`);
      }
      // A refund raised by a return belongs to the return; only one raised for this note goes with it.
      if (r && r.status === 'pending' && !cn.return_id) {
        await client.query("UPDATE refunds SET status = 'cancelled', updated_at = now() WHERE id = $1", [r.id]);
        await client.query(
          `INSERT INTO refund_transactions (refund_id, event, amount_cents, actor_role, changed_by_user_id, note)
           VALUES ($1, 'cancelled', 0, 'admin', $2, 'Its credit note was cancelled')`,
          [r.id, userId]
        );
      }
    }
    const { rows: updated } = await client.query(
      `UPDATE credit_notes SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE id = $1 RETURNING *`,
      [cn.id, userId]
    );
    // The invoice shows its latest live credit note, or none.
    await client.query(
      `UPDATE invoices SET credit_note_number = (
         SELECT credit_note_number FROM credit_notes WHERE invoice_id = $1 AND status = 'issued' ORDER BY id DESC LIMIT 1)
       WHERE id = $1`,
      [cn.invoice_id]
    );
    await client.query('COMMIT');
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { REASONS, CreditNoteError, raiseCreditNote, cancelCreditNote };
