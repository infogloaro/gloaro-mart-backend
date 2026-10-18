const pool = require('../config/db');
const { settleStockForOrder } = require('./inventory');
const { bumpMetrics, metricsForTransition } = require('./matching');
const { onOrderStatusChanged } = require('./shipments');

/**
 * Cancelling an order, by anyone, under the per-stage rules (schema
 * CANCELLATIONS, PHASE 35). Customer, vendor and admin paths all come through
 * here, so the fee, the refund and the stock decision are made one way.
 *
 * Who cancels decides the money: only a cancellation the customer asked for
 * carries the stage's fee, and only out of what was actually paid (COD that
 * was never collected has nothing to refund or retain).
 */

const RULE_STAGES = ['pending', 'confirmed', 'packed', 'out_for_delivery'];

const REASONS = {
  changed_mind: 'Changed my mind',
  ordered_by_mistake: 'Ordered by mistake',
  found_better_price: 'Found a better price',
  delivery_too_late: 'Delivery is too late',
  wrong_address: 'Wrong address or details',
  out_of_stock: 'Out of stock',
  cannot_deliver: "Can't deliver to this address",
  shop_closed: 'Shop is closed',
  customer_unreachable: 'Customer unreachable',
  other: 'Other',
};
const REASONS_FOR = {
  customer: ['changed_mind', 'ordered_by_mistake', 'found_better_price', 'delivery_too_late', 'wrong_address', 'other'],
  vendor: ['out_of_stock', 'cannot_deliver', 'shop_closed', 'customer_unreachable', 'other'],
  admin: Object.keys(REASONS),
};

class CancellationError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const reasonLabel = (code) => REASONS[code] ?? code;

/** A reason code the party may use; old app builds send only free text, which becomes 'other'. */
function readReason(by, body) {
  const code = body?.reasonCode ?? 'other';
  if (!REASONS_FOR[by].includes(code)) {
    throw new CancellationError(400, `reasonCode must be one of ${REASONS_FOR[by].join(', ')}`);
  }
  const note = typeof (body?.note ?? body?.reason) === 'string' ? (body.note ?? body.reason).trim().slice(0, 500) : '';
  return { code, note: note || null };
}

async function loadRules(db = pool) {
  const { rows } = await db.query('SELECT * FROM cancellation_rules');
  return RULE_STAGES.map((s) => rows.find((r) => r.order_status === s)).filter(Boolean);
}

async function ruleFor(db, stage) {
  const { rows } = await db.query('SELECT * FROM cancellation_rules WHERE order_status = $1', [stage]);
  return rows[0] ?? null;
}

/**
 * What the customer paid for this shop's order that can still come back:
 * captured online money, less refunds already sent or still open on the
 * purchase (other shops in the same checkout may have claimed part of it).
 */
async function refundableFor(db, order) {
  if (!order.checkout_group_id) return { cents: 0, payment: null };
  const { rows } = await db.query(
    `SELECT p.*,
            (SELECT COALESCE(SUM(amount_cents), 0)::int FROM refunds r
             WHERE r.payment_id = p.id AND r.status IN ('pending', 'processing')) AS open_refunds_cents
     FROM payments p WHERE p.checkout_group_id = $1 AND p.method <> 'cod'`,
    [order.checkout_group_id]
  );
  const payment = rows[0];
  if (!payment || payment.amount_captured_cents <= 0) return { cents: 0, payment: payment ?? null };
  const remaining = payment.amount_captured_cents - payment.amount_refunded_cents - payment.open_refunds_cents;
  return { cents: Math.max(0, Math.min(order.total_cents, remaining)), payment };
}

/** The fee is a share of the order value, but never more than was paid. */
function quote(order, feePercent, paidCents) {
  const fee = Math.min(Math.round((order.total_cents * Number(feePercent)) / 100), paidCents);
  return { feeCents: fee, refundCents: paidCents - fee };
}

async function nextReference(client) {
  const { rows } = await client.query("SELECT nextval('order_cancellation_ref_seq') AS n");
  return `CXL-${new Date().getFullYear()}-${String(rows[0].n).padStart(5, '0')}`;
}

/**
 * Cancels the (locked) order inside the caller's transaction and settles the
 * request's money. Stock, COD and the refund row happen after the commit, in
 * finish(), matching how every other cancellation path already behaved.
 */
async function cancelInTxn(client, { order, cancellation, actorRole, userId, feeCents = null, note }) {
  const { rows } = await client.query(
    "UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *",
    [order.id]
  );
  await client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, actor_role, note)
     VALUES ($1, $2, 'cancelled', $3, $4, $5)`,
    [order.id, order.status, userId, actorRole, note]
  );
  // A shop is ranked on the cancellations it caused, not on customers changing their minds.
  if (cancellation.requested_by === 'customer') {
    await bumpMetrics(client, order.vendor_id, { openOrders: -1 });
  } else {
    const deltas = metricsForTransition(order.status, 'cancelled', (Date.now() - new Date(order.created_at).getTime()) / 60000);
    if (deltas) await bumpMetrics(client, order.vendor_id, deltas);
  }

  await onOrderStatusChanged(client, rows[0], 'cancelled', { actorRole, userId });

  const paid = await refundableFor(client, order);
  const money =
    feeCents == null
      ? quote(order, cancellation.fee_percent, paid.cents)
      : { feeCents: Math.min(feeCents, paid.cents), refundCents: paid.cents - Math.min(feeCents, paid.cents) };
  await client.query('UPDATE order_cancellations SET fee_cents = $2, refund_cents = $3, updated_at = now() WHERE id = $1', [
    cancellation.id,
    money.feeCents,
    money.refundCents,
  ]);
  // Any other open request on this order is moot now.
  await client.query(
    `UPDATE order_cancellations SET status = 'withdrawn', decision_note = 'The order was cancelled another way', updated_at = now()
     WHERE order_id = $1 AND status = 'requested' AND id <> $2`,
    [order.id, cancellation.id]
  );
  return { order: rows[0], ...money, payment: paid.payment };
}

/** After the commit: stock, the COD payment, the refund request and telling the customer. */
async function finish({ order, cancellation, refundCents, payment, actorRole, userId, tellCustomer = actorRole !== 'customer' }) {
  const { settleCodForOrder } = require('../controllers/payment.controller');
  const by = { customer: 'the customer', vendor: 'the shop', admin: 'an admin', system: 'the system' }[actorRole];
  // Restock puts held or sold units back; without it they count as sold (sent, lost or spoiled).
  await settleStockForOrder(order.id, cancellation.restock ? 'release' : 'confirm', {
    userId,
    note: `Order cancelled by ${by}${cancellation.restock ? '' : ' (not restocked)'}`,
  });
  await settleCodForOrder(order.id);

  let refund = null;
  if (refundCents > 0 && payment) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reason = `Order cancelled (${cancellation.reference})`;
      const { rows } = await client.query(
        `INSERT INTO refunds (payment_id, order_id, amount_cents, reason, requested_by_user_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [payment.id, order.id, refundCents, reason, userId]
      );
      refund = rows[0];
      await client.query(
        `INSERT INTO refund_transactions (refund_id, event, amount_cents, actor_role, changed_by_user_id, note)
         VALUES ($1, 'requested', $2, $3, $4, $5)`,
        [refund.id, refundCents, actorRole, userId, reason]
      );
      await client.query('UPDATE order_cancellations SET refund_id = $2 WHERE id = $1', [cancellation.id, refund.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (tellCustomer) {
    await notify(
      order.user_id,
      'order_cancelled',
      'Your order was cancelled',
      `${by === 'the shop' ? 'The shop' : 'We'} cancelled order #${order.id}: ${reasonLabel(cancellation.reason_code)}.` +
        (refundCents > 0 ? ` A refund of ₹${(refundCents / 100).toFixed(2)} is on its way.` : ''),
      order.id
    );
  }
  return refund;
}

/** `orderId` becomes the deep link the app opens (/orders/<id>). */
async function notify(userId, type, title, body, orderId = null) {
  if (!userId) return;
  await pool.query('INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, $2, $3, $4, $5)', [
    userId,
    type,
    title,
    body,
    orderId ? `/orders/${orderId}` : null,
  ]);
}

/** Runs fn(client) in a transaction with the order locked; refuses orders already over. */
async function withLockedOrder(orderId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = rows[0];
    if (!order) throw new CancellationError(404, 'Order not found');
    const result = await fn(client, order);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function assertCancellable(order) {
  if (order.status === 'cancelled') throw new CancellationError(409, 'This order is already cancelled.');
  if (order.status === 'delivered') {
    throw new CancellationError(409, 'This order has been delivered — raise a return instead of a cancellation.');
  }
}

/**
 * A customer or vendor asking to cancel. Goes through at once when the rule
 * for the order's stage allows it (see the schema notes); otherwise it becomes
 * a request for an admin, marked ineligible if the rules say no.
 */
async function requestCancellation({ orderId, by, userId, body, owns }) {
  const reason = readReason(by, body);
  let outcome;
  const result = await withLockedOrder(orderId, async (client, order) => {
    if (!owns(order)) throw new CancellationError(404, 'Order not found');
    assertCancellable(order);
    const { rows: open } = await client.query(
      "SELECT reference FROM order_cancellations WHERE order_id = $1 AND status = 'requested'",
      [order.id]
    );

    const rule = await ruleFor(client, order.status);
    const allowed = by === 'customer' ? rule.customer_allowed : rule.vendor_allowed;
    const immediate = allowed && (by === 'vendor' || rule.auto_approve);
    // One request waits at a time. A cancellation that goes through at once
    // still may — the shop cancelling settles the customer's request too.
    if (open[0] && !immediate) {
      throw new CancellationError(409, `A cancellation request (${open[0].reference}) is already waiting for this order.`);
    }
    const { rows } = await client.query(
      `INSERT INTO order_cancellations
         (reference, order_id, requested_by, requested_by_user_id, order_status_at_request, reason_code, reason_note,
          status, eligible, fee_percent, restock, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        await nextReference(client),
        order.id,
        by,
        userId,
        order.status,
        reason.code,
        reason.note,
        immediate ? 'auto_approved' : 'requested',
        allowed,
        by === 'customer' ? rule.fee_percent : 0,
        rule.restock,
        immediate ? new Date() : null,
      ]
    );
    const cancellation = rows[0];
    if (!immediate) return { immediate: false, cancellation, order };

    outcome = await cancelInTxn(client, {
      order,
      cancellation,
      actorRole: by,
      userId,
      note: reason.note || `Cancelled by the ${by}: ${reasonLabel(reason.code)}`,
    });
    return { immediate: true, cancellation, order: outcome.order };
  });

  if (!result.immediate) return result;
  const refund = await finish({ ...outcome, cancellation: result.cancellation, actorRole: by, userId });
  return { ...result, refund, feeCents: outcome.feeCents, refundCents: outcome.refundCents };
}

/** An admin cancelling outright from the Orders page: recorded, full refund, stock back. */
async function adminCancel({ orderId, userId, body }) {
  const reason = readReason('admin', body);
  let outcome;
  const result = await withLockedOrder(orderId, async (client, order) => {
    assertCancellable(order);
    const { rows } = await client.query(
      `INSERT INTO order_cancellations
         (reference, order_id, requested_by, requested_by_user_id, order_status_at_request, reason_code, reason_note,
          status, eligible, fee_percent, restock, decided_by, decided_at)
       VALUES ($1, $2, 'admin', $3, $4, $5, $6, 'approved', TRUE, 0, TRUE, $3, now()) RETURNING *`,
      [await nextReference(client), order.id, userId, order.status, reason.code, reason.note]
    );
    outcome = await cancelInTxn(client, {
      order,
      cancellation: rows[0],
      actorRole: 'admin',
      userId,
      note: reason.note || 'Order cancelled by an admin',
    });
    return { cancellation: rows[0], order: outcome.order };
  });
  const refund = await finish({ ...outcome, cancellation: result.cancellation, actorRole: 'admin', userId });
  return { ...result, refund };
}

/** Locks one open request and its order. */
async function withOpenRequest(id, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM order_cancellations WHERE id = $1 FOR UPDATE', [id]);
    const cancellation = rows[0];
    if (!cancellation) throw new CancellationError(404, 'Cancellation request not found');
    if (cancellation.status !== 'requested') {
      throw new CancellationError(409, `This request is already ${cancellation.status.replace('_', ' ')}.`);
    }
    const { rows: orderRows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [cancellation.order_id]);
    const result = await fn(client, cancellation, orderRows[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function approve({ id, userId, feeCents, note }) {
  let outcome;
  let cancellation;
  await withOpenRequest(id, async (client, c, order) => {
    assertCancellable(order);
    if (feeCents != null && (!Number.isInteger(feeCents) || feeCents < 0 || feeCents > order.total_cents)) {
      throw new CancellationError(400, 'feeCents must be a whole number between zero and the order value.');
    }
    const { rows } = await client.query(
      `UPDATE order_cancellations SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [c.id, userId, note || null]
    );
    cancellation = rows[0];
    outcome = await cancelInTxn(client, {
      order,
      cancellation,
      actorRole: 'admin',
      userId,
      // A vendor's request carries no fee whatever the admin types.
      feeCents: c.requested_by === 'customer' ? feeCents : 0,
      note: `Cancellation ${c.reference} approved${note ? `: ${note}` : ''}`,
    });
  });
  // A customer hears about their own request below rather than as "we cancelled your order".
  const refund = await finish({
    ...outcome,
    cancellation,
    actorRole: 'admin',
    userId,
    tellCustomer: cancellation.requested_by !== 'customer',
  });
  if (cancellation.requested_by === 'customer') {
    await notify(
      outcome.order.user_id,
      'cancellation_approved',
      'Your cancellation was approved',
      `Order #${outcome.order.id} is cancelled.` + (outcome.refundCents > 0 ? ` A refund of ₹${(outcome.refundCents / 100).toFixed(2)} is on its way.` : ''),
      outcome.order.id
    );
  } else {
    await notify(cancellation.requested_by_user_id, 'cancellation_approved', 'Cancellation approved', `Order #${outcome.order.id} is cancelled.`, outcome.order.id);
  }
  return { cancellation, order: outcome.order, refund, feeCents: outcome.feeCents, refundCents: outcome.refundCents };
}

async function reject({ id, userId, reason }) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text || text.length > 500) throw new CancellationError(400, 'Give a reason (up to 500 characters) the requester can read.');
  const cancellation = await withOpenRequest(id, async (client, c) => {
    const { rows } = await client.query(
      `UPDATE order_cancellations SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [c.id, userId, text]
    );
    return rows[0];
  });
  await notify(
    cancellation.requested_by_user_id,
    'cancellation_rejected',
    'Cancellation request declined',
    `Order #${cancellation.order_id} will go ahead: ${text}`,
    cancellation.order_id
  );
  return cancellation;
}

/** The requester taking back their own open request. */
async function withdraw({ orderId, userId }) {
  const { rows } = await pool.query(
    `UPDATE order_cancellations SET status = 'withdrawn', decided_at = now(), updated_at = now()
     WHERE order_id = $1 AND requested_by_user_id = $2 AND status = 'requested' RETURNING *`,
    [orderId, userId]
  );
  if (!rows[0]) throw new CancellationError(404, 'No open cancellation request on this order.');
  return rows[0];
}

/**
 * What the customer may do about cancelling right now, for the order screen:
 * whether a request is possible, whether it would go through at once, and the fee.
 */
async function customerPolicy(order) {
  if (['cancelled', 'delivered'].includes(order.status)) return { canRequest: false, instant: false, feePercent: 0, openRequest: null };
  const [rule, { rows: open }] = await Promise.all([
    ruleFor(pool, order.status),
    pool.query("SELECT id, reference, status, created_at FROM order_cancellations WHERE order_id = $1 AND status = 'requested'", [order.id]),
  ]);
  return {
    canRequest: !open[0],
    allowed: rule.customer_allowed,
    instant: !open[0] && rule.customer_allowed && rule.auto_approve,
    feePercent: Number(rule.fee_percent),
    openRequest: open[0] ?? null,
    reasons: REASONS_FOR.customer.map((code) => ({ code, label: REASONS[code] })),
  };
}

module.exports = {
  RULE_STAGES,
  REASONS,
  REASONS_FOR,
  CancellationError,
  reasonLabel,
  loadRules,
  refundableFor,
  quote,
  requestCancellation,
  adminCancel,
  approve,
  reject,
  withdraw,
  customerPolicy,
};
