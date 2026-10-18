const pool = require('../config/db');
const { RfqError } = require('./rfqs');

/**
 * Purchase orders after they are raised (schema PHASE 46/47): the vendor
 * acknowledging, delivering and confirming payment; the admin or buyer
 * resending, cancelling and closing. Used by Admin → Purchase Orders, the
 * vendor portal and the buyer in the app.
 *
 * Money: each delivery is invoiced at its value (the delivered quantities at
 * the PO's unit prices, plus their tax). The delivery that completes the PO
 * carries the remainder of the total, so rounding and the delivery charge land
 * there and a fully delivered PO is invoiced at exactly its total.
 */

const OPEN = ['issued', 'acknowledged', 'in_progress', 'partially_delivered'];
const RESEND_GAP_MINUTES = 15;
const METHODS = ['bank_transfer', 'upi', 'cheque', 'cash', 'other'];

async function inTxn(fn) {
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

/** The PO, locked, with what's been invoiced and paid so far. `vendorId` scopes it to one shop. */
async function lockPo(client, id, { vendorId } = {}) {
  const { rows } = await client.query(
    `SELECT po.*, vp.user_id AS vendor_user_id, vp.business_name AS vendor_name,
            COALESCE(a.trade_name, a.legal_name) AS business_name
     FROM purchase_orders po JOIN vendor_profiles vp ON vp.id = po.vendor_id JOIN business_accounts a ON a.id = po.business_account_id
     WHERE po.id = $1 FOR UPDATE OF po`,
    [Number(id)]
  );
  const po = rows[0];
  if (!po || (vendorId != null && po.vendor_id !== vendorId)) throw new RfqError(404, 'Purchase order not found');
  const { rows: money } = await client.query(
    `SELECT (SELECT COALESCE(SUM(value_cents), 0) FROM purchase_order_deliveries WHERE purchase_order_id = $1)::bigint AS invoiced,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM purchase_order_payments WHERE purchase_order_id = $1)::bigint AS paid`,
    [po.id]
  );
  po.invoiced = Number(money[0].invoiced);
  po.paid = Number(money[0].paid);
  return po;
}

const vendorLink = (po) => `/vendor/purchase-orders/${po.id}`;
const buyerLink = (po) => `/business/purchase-orders/${po.id}`;

async function notifyVendor(client, po, type, title, body) {
  if (!po.vendor_user_id) return;
  await client.query('INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, $2, $3, $4, $5)', [
    po.vendor_user_id, type, title, body, vendorLink(po),
  ]);
}

/** The buyer who raised it and the business's owners, once each. */
async function notifyBuyer(client, po, type, title, body) {
  await client.query(
    `INSERT INTO notifications (user_id, type, title, body, deep_link)
     SELECT DISTINCT u, $3, $4, $5, $6 FROM (
       SELECT $2::int AS u WHERE $2::int IS NOT NULL
       UNION SELECT user_id FROM business_members WHERE account_id = $1 AND role = 'owner'
     ) t`,
    [po.business_account_id, po.buyer_user_id, type, title, body, buyerLink(po)]
  );
}

const rupees = (cents) => `₹${(cents / 100).toFixed(2)}`;

function assertOpen(po, what) {
  if (!OPEN.includes(po.status)) throw new RfqError(409, `This purchase order is ${po.status.replace('_', ' ')} — it can't be ${what}.`);
}

// ------------------------------------------------------------------ vendor

const acknowledge = ({ id, vendorId }) =>
  inTxn(async (client) => {
    const po = await lockPo(client, id, { vendorId });
    if (po.status !== 'issued') throw new RfqError(409, `This purchase order is already ${po.status.replace('_', ' ')}.`);
    await client.query("UPDATE purchase_orders SET status = 'acknowledged', acknowledged_at = now(), updated_at = now() WHERE id = $1", [po.id]);
    await notifyBuyer(client, po, 'purchase_order', 'Purchase order acknowledged', `${po.vendor_name} confirmed ${po.po_number}.`);
    return po;
  });

/** Work has begun (packing, procurement). Only from acknowledged; deliveries move it on from there. */
const start = ({ id, vendorId }) =>
  inTxn(async (client) => {
    const po = await lockPo(client, id, { vendorId });
    if (po.status !== 'acknowledged') throw new RfqError(409, po.status === 'issued' ? 'Acknowledge the purchase order first.' : `This purchase order is ${po.status.replace('_', ' ')}.`);
    await client.query("UPDATE purchase_orders SET status = 'in_progress', updated_at = now() WHERE id = $1", [po.id]);
    return po;
  });

/**
 * A delivery of some of the outstanding quantities. Delivering an
 * unacknowledged PO acknowledges it — the goods prove it was read.
 */
const recordDelivery = ({ id, vendorId, userId, lines, trackingNumber, note, deliveredAt }) =>
  inTxn(async (client) => {
    const po = await lockPo(client, id, { vendorId });
    assertOpen(po, 'delivered against');
    if (!Array.isArray(lines) || lines.length === 0) throw new RfqError(400, 'Say which lines were delivered and how many.');
    const { rows: poLines } = await client.query('SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY id FOR UPDATE', [po.id]);
    const byId = new Map(poLines.map((l) => [l.id, l]));
    const seen = new Set();
    let value = 0;
    for (const l of lines) {
      const line = byId.get(Number(l?.lineId));
      if (!line) throw new RfqError(400, `Line ${l?.lineId} is not on this purchase order.`);
      if (seen.has(line.id)) throw new RfqError(400, 'Each line once per delivery.');
      seen.add(line.id);
      const qty = Number(l.quantity);
      if (!Number.isInteger(qty) || qty <= 0) throw new RfqError(400, 'Delivered quantities are whole numbers above zero.');
      const remaining = line.quantity - line.delivered_quantity;
      if (qty > remaining) throw new RfqError(409, `${line.description}: only ${remaining} ${line.unit} left to deliver.`);
      line.delivered_quantity += qty;
      l.qty = qty;
      value += Math.round(qty * line.unit_price_cents * (1 + Number(line.tax_percent) / 100));
    }
    const complete = poLines.every((l) => l.delivered_quantity >= l.quantity);
    // The last delivery squares the invoice with the PO total.
    if (complete) value = Math.max(0, po.total_cents - po.invoiced);

    let at = null;
    if (deliveredAt != null) {
      at = new Date(deliveredAt);
      if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60000) throw new RfqError(400, 'The delivery date is not valid or is in the future.');
      if (at < new Date(po.issued_at)) throw new RfqError(400, 'The delivery date is before the purchase order was issued.');
    }
    const tracking = typeof trackingNumber === 'string' ? trackingNumber.trim().slice(0, 80) || null : null;
    const text = typeof note === 'string' ? note.trim().slice(0, 500) || null : null;
    const { rows: d } = await client.query(
      `INSERT INTO purchase_order_deliveries (purchase_order_id, delivered_at, value_cents, tracking_number, note, recorded_by)
       VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6) RETURNING *`,
      [po.id, at, value, tracking, text, userId]
    );
    for (const l of lines) {
      const lineId = Number(l.lineId);
      await client.query('INSERT INTO purchase_order_delivery_lines (delivery_id, purchase_order_line_id, quantity) VALUES ($1, $2, $3)', [d[0].id, lineId, l.qty]);
      await client.query('UPDATE purchase_order_lines SET delivered_quantity = delivered_quantity + $2 WHERE id = $1', [lineId, l.qty]);
    }
    await client.query(
      `UPDATE purchase_orders SET status = $2, acknowledged_at = COALESCE(acknowledged_at, now()),
         delivered_at = CASE WHEN $3 THEN now() ELSE delivered_at END, updated_at = now() WHERE id = $1`,
      [po.id, complete ? 'delivered' : 'partially_delivered', complete]
    );
    await notifyBuyer(client, po, 'purchase_order', complete ? 'Purchase order delivered in full' : 'Part of a purchase order delivered',
      `${po.po_number}: ${rupees(value)} delivered${tracking ? ` (${tracking})` : ''}. Payment due in ${po.payment_terms_days} days.`);
    return { po, delivery: d[0], complete };
  });

const setInvoiceNumber = ({ id, vendorId, invoiceNumber }) =>
  inTxn(async (client) => {
    const po = await lockPo(client, id, { vendorId });
    const text = typeof invoiceNumber === 'string' ? invoiceNumber.trim() : '';
    if (!text || text.length > 40) throw new RfqError(400, 'Give the invoice number (up to 40 characters).');
    if (po.status === 'closed') throw new RfqError(409, 'This purchase order is closed.');
    await client.query('UPDATE purchase_orders SET invoice_number = $2, updated_at = now() WHERE id = $1', [po.id, text]);
    return po;
  });

/** The vendor confirming money received. Never more than what's invoiced and unpaid. */
const recordPayment = ({ id, vendorId, userId, amountCents, method = 'bank_transfer', reference, paidAt }) =>
  inTxn(async (client) => {
    const po = await lockPo(client, id, { vendorId });
    if (po.status === 'closed') throw new RfqError(409, 'This purchase order is closed.');
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) throw new RfqError(400, 'The amount is a whole number of paise above zero.');
    const outstanding = po.invoiced - po.paid;
    if (outstanding <= 0) throw new RfqError(409, 'Nothing is outstanding on this purchase order.');
    if (amount > outstanding) throw new RfqError(409, `Only ${rupees(outstanding)} is outstanding.`);
    if (!METHODS.includes(method)) throw new RfqError(400, `Method is one of ${METHODS.join(', ')}.`);
    let at = null;
    if (paidAt != null) {
      at = new Date(paidAt);
      if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60000) throw new RfqError(400, 'The payment date is not valid or is in the future.');
    }
    const ref = typeof reference === 'string' ? reference.trim().slice(0, 80) || null : null;
    const { rows } = await client.query(
      `INSERT INTO purchase_order_payments (purchase_order_id, amount_cents, method, reference, paid_at, recorded_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6) RETURNING *`,
      [po.id, amount, method, ref, at, userId]
    );
    await client.query('UPDATE purchase_orders SET updated_at = now() WHERE id = $1', [po.id]);
    const left = outstanding - amount;
    await notifyBuyer(client, po, 'purchase_order', 'Payment received',
      `${po.vendor_name} confirmed ${rupees(amount)} on ${po.po_number}.${left > 0 ? ` ${rupees(left)} still due.` : ' Nothing is due.'}`);
    return { po, payment: rows[0] };
  });

// --------------------------------------------------------- admin and buyer

/** Tells the vendor again about a PO it hasn't acknowledged — not more than every 15 minutes. */
const resend = ({ id }) =>
  inTxn(async (client) => {
    const po = await lockPo(client, id);
    if (po.status !== 'issued') throw new RfqError(409, 'The vendor has already acknowledged this purchase order.');
    const last = po.last_sent_at ?? po.issued_at;
    const minutes = (Date.now() - new Date(last).getTime()) / 60000;
    if (minutes < RESEND_GAP_MINUTES) {
      throw new RfqError(409, `It was sent ${Math.max(1, Math.floor(minutes))} minute(s) ago — give the vendor ${RESEND_GAP_MINUTES} minutes before sending again.`);
    }
    await client.query('UPDATE purchase_orders SET last_sent_at = now(), resend_count = resend_count + 1, updated_at = now() WHERE id = $1', [po.id]);
    await notifyVendor(client, po, 'purchase_order', 'Reminder: please acknowledge this purchase order',
      `${po.po_number} from ${po.business_name} for ${rupees(po.total_cents)} is waiting for you.`);
    return po;
  });

/** Stops a PO. What was already delivered stays invoiced and payable. */
const cancel = ({ id, userId, reason, by }) =>
  inTxn(async (client) => {
    const po = await lockPo(client, id);
    assertOpen(po, 'cancelled');
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text || text.length > 500) throw new RfqError(400, 'Say why (up to 500 characters) — the vendor and the buyer are both told.');
    await client.query(
      "UPDATE purchase_orders SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3, closed_at = now(), updated_at = now() WHERE id = $1",
      [po.id, text, userId]
    );
    const owed = po.invoiced - po.paid;
    const tail = owed > 0 ? ` ${rupees(owed)} already delivered is still payable.` : '';
    await notifyVendor(client, po, 'purchase_order', 'Purchase order cancelled', `${po.po_number}: ${text}.${tail}`);
    if (by !== 'buyer') await notifyBuyer(client, po, 'purchase_order', 'Purchase order cancelled', `${po.po_number}: ${text}.${tail}`);
    return po;
  });

/** Finished: everything arrived and everything invoiced is paid. */
const close = ({ id, userId }) =>
  inTxn(async (client) => {
    const po = await lockPo(client, id);
    if (po.status !== 'delivered') {
      if (OPEN.includes(po.status)) throw new RfqError(409, 'Not everything has been delivered yet.');
      throw new RfqError(409, `This purchase order is ${po.status.replace('_', ' ')}.`);
    }
    if (po.paid < po.invoiced) throw new RfqError(409, `${rupees(po.invoiced - po.paid)} is still unpaid.`);
    await client.query("UPDATE purchase_orders SET status = 'closed', closed_at = now(), closed_by = $2, updated_at = now() WHERE id = $1", [po.id, userId]);
    await notifyVendor(client, po, 'purchase_order', 'Purchase order closed', `${po.po_number} is delivered, paid and closed.`);
    return po;
  });

module.exports = { OPEN, METHODS, lockPo, acknowledge, start, recordDelivery, setInvoiceNumber, recordPayment, resend, cancel, close };
