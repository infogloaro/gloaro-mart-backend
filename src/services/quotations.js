const pool = require('../config/db');
const { RfqError, notify } = require('./rfqs');

/**
 * Deciding on quotations (schema PHASE 45/46): asking for a revision,
 * rejecting, and awarding — which closes the RFQ and raises the purchase order.
 * Used by Admin → Quotations and by the buyer in the app.
 */

const OPEN = ['submitted', 'revision_requested'];

/** Quotes past their "valid until" that nobody decided on are no longer good. */
async function expireDue(db = pool) {
  await db.query(
    `UPDATE quotations SET status = 'expired', decided_at = now(), decision_note = 'Past its validity'
     WHERE status IN ('submitted', 'revision_requested') AND valid_until < (now() AT TIME ZONE 'Asia/Kolkata')::date`
  );
}

async function lockQuote(client, id) {
  const { rows } = await client.query(
    `SELECT q.*, r.reference AS rfq_reference, r.status AS rfq_status, r.created_by AS buyer_id, r.business_account_id,
            r.delivery_address, vp.user_id AS vendor_user_id, vp.business_name
     FROM quotations q JOIN rfqs r ON r.id = q.rfq_id JOIN vendor_profiles vp ON vp.id = q.vendor_id
     WHERE q.id = $1 FOR UPDATE OF q, r`,
    [Number(id)]
  );
  if (!rows[0]) throw new RfqError(404, 'Quotation not found');
  return rows[0];
}

async function addMessage(db, quotationId, { role, userId, body }) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text || text.length > 2000) throw new RfqError(400, 'Write a message of up to 2000 characters.');
  await db.query('INSERT INTO quotation_messages (quotation_id, author_role, author_user_id, body) VALUES ($1, $2, $3, $4)', [quotationId, role, userId, text]);
  return text;
}

/** Messages carry across revisions: the thread is the shop's, not one revision's. */
async function threadFor(db, quote) {
  const { rows } = await db.query(
    `SELECT m.*, COALESCE(u.full_name, u.email) AS author_name FROM quotation_messages m
     JOIN quotations q ON q.id = m.quotation_id LEFT JOIN users u ON u.id = m.author_user_id
     WHERE q.rfq_id = $1 AND q.vendor_id = $2 ORDER BY m.created_at, m.id`,
    [quote.rfq_id, quote.vendor_id]
  );
  return rows;
}

async function inTxn(fn) {
  // Expiry first and on its own: a decision refused for being past validity
  // must not roll the "expired" mark back with it.
  await expireDue();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const requestRevision = ({ id, role, userId, message }) =>
  inTxn(async (client) => {
    const q = await lockQuote(client, id);
    if (q.status !== 'submitted') throw new RfqError(409, `This quote is ${q.status.replace('_', ' ')}.`);
    if (!['open', 'closed'].includes(q.rfq_status)) throw new RfqError(409, `The RFQ is ${q.rfq_status}.`);
    const text = await addMessage(client, q.id, { role, userId, body: message });
    await client.query("UPDATE quotations SET status = 'revision_requested' WHERE id = $1", [q.id]);
    await notify(client, q.vendor_user_id, 'quotation_revision', 'A better price is asked for', `${q.rfq_reference}: ${text}`, `/vendor/rfqs/${q.rfq_id}`);
    return q;
  });

const reject = ({ id, role, userId, reason }) =>
  inTxn(async (client) => {
    const q = await lockQuote(client, id);
    if (!OPEN.includes(q.status)) throw new RfqError(409, `This quote is ${q.status.replace('_', ' ')}.`);
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text || text.length > 500) throw new RfqError(400, 'Give the vendor a reason (up to 500 characters).');
    await client.query(
      "UPDATE quotations SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1",
      [q.id, userId, text]
    );
    await addMessage(client, q.id, { role, userId, body: `Rejected: ${text}` });
    await notify(client, q.vendor_user_id, 'quotation_rejected', 'Quotation not accepted', `${q.rfq_reference}: ${text}`, `/vendor/rfqs/${q.rfq_id}`);
    return q;
  });

/**
 * Awards a quote: it's accepted, every other open quote on the RFQ is
 * rejected, the RFQ is awarded, and the purchase order is raised from its
 * priced lines. Past its validity, or on an RFQ already decided, it's refused.
 */
const award = ({ id, userId, role }) =>
  inTxn(async (client) => {
    const q = await lockQuote(client, id);
    if (q.status === 'expired') throw new RfqError(409, 'This quote is past its validity — ask the vendor for a fresh revision.');
    if (q.status !== 'submitted') throw new RfqError(409, `This quote is ${q.status.replace('_', ' ')} and cannot be awarded.`);
    if (!['open', 'closed'].includes(q.rfq_status)) throw new RfqError(409, `The RFQ is ${q.rfq_status}.`);

    await client.query("UPDATE quotations SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1", [q.id, userId]);
    const { rows: losers } = await client.query(
      `UPDATE quotations SET status = 'rejected', decided_by = $3, decided_at = now(), decision_note = 'Another quote was awarded'
       WHERE rfq_id = $1 AND id <> $2 AND status IN ('submitted', 'revision_requested')
       RETURNING vendor_id`,
      [q.rfq_id, q.id, userId]
    );
    await client.query(
      "UPDATE rfqs SET status = 'awarded', awarded_quotation_id = $2, awarded_at = now(), closed_at = COALESCE(closed_at, now()), updated_at = now() WHERE id = $1",
      [q.rfq_id, q.id]
    );

    // The PO: priced lines only, at the quoted prices, delivery and terms as quoted.
    const { rows: lines } = await client.query(
      `SELECT l.*, i.product_name, i.specification, i.quantity, i.unit, p.hsn_code
       FROM quotation_lines l JOIN rfq_items i ON i.id = l.rfq_item_id LEFT JOIN products p ON p.id = i.product_id
       WHERE l.quotation_id = $1 AND NOT l.unavailable ORDER BY l.id`,
      [q.id]
    );
    const { rows: seq } = await client.query("SELECT nextval('purchase_order_seq') AS n");
    const { rows: po } = await client.query(
      `INSERT INTO purchase_orders (po_number, quotation_id, rfq_id, business_account_id, vendor_id, buyer_user_id, subtotal_cents,
         tax_cents, delivery_cents, total_cents, payment_terms_days, expected_delivery_at, delivery_address, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [`PO-${new Date().getFullYear()}-${String(seq[0].n).padStart(5, '0')}`, q.id, q.rfq_id, q.business_account_id, q.vendor_id,
        q.buyer_id, q.subtotal_cents, q.tax_cents, q.delivery_cents, q.total_cents, q.payment_terms_days ?? 0,
        q.delivery_days == null ? null : new Date(Date.now() + q.delivery_days * 86400000), q.delivery_address, userId]
    );
    for (const l of lines) {
      await client.query(
        `INSERT INTO purchase_order_lines (purchase_order_id, quotation_line_id, description, hsn_code, quantity, unit,
           unit_price_cents, tax_percent, line_total_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [po[0].id, l.id, l.specification ? `${l.product_name} — ${l.specification}` : l.product_name, l.hsn_code, l.quantity, l.unit,
          l.unit_price_cents, l.tax_percent, l.line_total_cents]
      );
    }
    await notify(client, q.vendor_user_id, 'quotation_awarded', 'You won the order',
      `${q.rfq_reference}: purchase order ${po[0].po_number} for ₹${(q.total_cents / 100).toFixed(2)}. Please acknowledge it.`, `/vendor/purchase-orders/${po[0].id}`);
    for (const l of losers) {
      const { rows: shop } = await client.query('SELECT user_id FROM vendor_profiles WHERE id = $1', [l.vendor_id]);
      await notify(client, shop[0]?.user_id, 'quotation_rejected', 'Quotation not accepted', `${q.rfq_reference} was awarded to another shop.`, `/vendor/rfqs/${q.rfq_id}`);
    }
    if (role !== 'buyer') {
      await notify(client, q.buyer_id, 'rfq_awarded', 'Your RFQ was awarded', `${q.rfq_reference} → ${q.business_name}, PO ${po[0].po_number}.`, `/business/rfqs/${q.rfq_id}`);
    }
    return { quotation: q, purchaseOrder: po[0] };
  });

/** The vendor taking back a quote nobody has decided on. */
const withdraw = ({ id, vendorId }) =>
  inTxn(async (client) => {
    const q = await lockQuote(client, id);
    if (q.vendor_id !== vendorId) throw new RfqError(404, 'Quotation not found');
    if (!OPEN.includes(q.status)) throw new RfqError(409, `This quote is ${q.status.replace('_', ' ')}.`);
    await client.query("UPDATE quotations SET status = 'withdrawn', decided_at = now(), decision_note = 'Withdrawn by the vendor' WHERE id = $1", [q.id]);
    await notify(client, q.buyer_id, 'rfq_quote', 'A quotation was withdrawn', `${q.business_name} withdrew its quote on ${q.rfq_reference}.`, `/business/rfqs/${q.rfq_id}`);
    return q;
  });

module.exports = { OPEN, expireDue, lockQuote, addMessage, threadFor, requestRevision, reject, award, withdraw };
