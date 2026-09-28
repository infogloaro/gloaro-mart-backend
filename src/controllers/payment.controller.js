const pool = require('../config/db');
const { getProvider, providerForMethod } = require('../services/payments');
const { applyTopupEvent } = require('./customerWallet.controller');
const { confirmReservations, releaseReservations } = require('../services/inventory');

/**
 * Payments, refunds and the ledger behind them.
 * Contracts per documents/SPRINT_3_PAYMENTS_SPEC.md.
 */

const TERMINAL = new Set(['successful', 'failed', 'cancelled', 'refunded', 'partially_refunded']);
const METHODS = ['cod', 'upi', 'card', 'netbanking', 'wallet'];

/** Appends to the payment ledger. Takes a client: the row belongs in the same
 *  transaction as the change it describes, or the two can disagree. */
async function recordPaymentEvent(client, {
  paymentId,
  attemptId = null,
  event,
  amountCents = 0,
  providerEventId = null,
  actorRole = 'system',
  userId = null,
  note = null,
  payload = null,
}) {
  await client.query(
    `INSERT INTO payment_transactions
       (payment_id, attempt_id, event, amount_cents, provider_event_id, actor_role, changed_by_user_id, note, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [paymentId, attemptId, event, amountCents, providerEventId, actorRole, userId, note, payload]
  );
}

/**
 * The payment a checkout group owes. Created inside the checkout transaction so
 * a purchase can never exist without one.
 */
async function createPaymentForGroup(client, { groupId, userId, amountCents, method = 'cod' }) {
  const provider = providerForMethod(method);
  const { rows } = await client.query(
    `INSERT INTO payments (checkout_group_id, user_id, method, provider, status, amount_cents)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    // COD is owed rather than merely created: nothing more is needed from the
    // customer until the courier arrives.
    [groupId, userId, method, provider.name, method === 'cod' ? 'pending' : 'created', amountCents]
  );
  const payment = rows[0];
  await recordPaymentEvent(client, {
    paymentId: payment.id,
    event: 'created',
    amountCents,
    actorRole: 'customer',
    userId,
    note: `Payment opened for ${method.toUpperCase()}`,
  });
  return payment;
}

/**
 * COD capture. Called after an order's status changes: once every non-cancelled
 * order in the purchase has been delivered, the cash is in and the payment
 * settles for the delivered orders only — a cancelled shop's share was never
 * collected.
 *
 * Runs on its own connection because the caller has already committed the
 * status change; a failure here leaves the payment pending for the next
 * delivery event rather than rolling back a delivery that really happened.
 */
async function settleCodForOrder(orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: paymentRows } = await client.query(
      `SELECT p.* FROM payments p
       JOIN orders o ON o.checkout_group_id = p.checkout_group_id
       WHERE o.id = $1 AND p.method = 'cod'
       FOR UPDATE OF p`,
      [orderId]
    );
    const payment = paymentRows[0];
    // Nothing to do for online payments, or for a payment already settled.
    if (!payment || TERMINAL.has(payment.status)) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows: totals } = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS live,
              COUNT(*) FILTER (WHERE status NOT IN ('cancelled', 'delivered'))::int AS outstanding,
              COALESCE(SUM(total_cents) FILTER (WHERE status = 'delivered'), 0)::int AS delivered_cents
       FROM orders WHERE checkout_group_id = $1`,
      [payment.checkout_group_id]
    );
    const { live, outstanding, delivered_cents: deliveredCents } = totals[0];

    let status = null;
    if (live === 0) status = 'cancelled';
    else if (outstanding === 0) status = 'successful';

    if (!status) {
      await client.query('ROLLBACK');
      return null;
    }

    const captured = status === 'successful' ? deliveredCents : 0;
    const { rows: updated } = await client.query(
      `UPDATE payments SET status = $2, amount_captured_cents = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [payment.id, status, captured]
    );
    await recordPaymentEvent(client, {
      paymentId: payment.id,
      event: status === 'successful' ? 'cod.collected' : 'cancelled',
      amountCents: captured,
      note: status === 'successful'
        ? 'Cash collected on delivery'
        : 'Every order in this purchase was cancelled',
    });

    await client.query('COMMIT');
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Shapes a payment for the API, with its attempts and ledger. */
async function loadPaymentDetail(paymentId) {
  const { rows } = await pool.query(
    `SELECT p.*, cg.reference AS group_reference
     FROM payments p JOIN checkout_groups cg ON cg.id = p.checkout_group_id
     WHERE p.id = $1`,
    [paymentId]
  );
  const payment = rows[0];
  if (!payment) return null;

  const { rows: attempts } = await pool.query(
    'SELECT * FROM payment_attempts WHERE payment_id = $1 ORDER BY id ASC',
    [paymentId]
  );
  const { rows: ledger } = await pool.query(
    `SELECT t.event, t.amount_cents, t.actor_role, t.note, t.created_at, u.full_name AS actor_name
     FROM payment_transactions t
     LEFT JOIN users u ON u.id = t.changed_by_user_id
     WHERE t.payment_id = $1 ORDER BY t.created_at ASC, t.id ASC`,
    [paymentId]
  );
  const { rows: refunds } = await pool.query(
    'SELECT * FROM refunds WHERE payment_id = $1 ORDER BY id ASC',
    [paymentId]
  );

  return { ...payment, attempts, ledger, refunds };
}

function toPaymentJson(p) {
  return {
    id: p.id,
    checkoutGroupId: p.checkout_group_id,
    groupReference: p.group_reference,
    method: p.method,
    provider: p.provider,
    status: p.status,
    amountCents: p.amount_cents,
    amountCapturedCents: p.amount_captured_cents,
    amountRefundedCents: p.amount_refunded_cents,
    failureReason: p.failure_reason,
    createdAt: p.created_at,
    attempts: (p.attempts ?? []).map((a) => ({
      id: a.id,
      method: a.method,
      status: a.status,
      providerOrderId: a.provider_order_id,
      failureReason: a.failure_reason,
      createdAt: a.created_at,
    })),
    refunds: (p.refunds ?? []).map((r) => ({
      id: r.id,
      orderId: r.order_id,
      amountCents: r.amount_cents,
      status: r.status,
      reason: r.reason,
      createdAt: r.created_at,
    })),
    ledger: (p.ledger ?? []).map((t) => ({
      event: t.event,
      amountCents: t.amount_cents,
      actorRole: t.actor_role,
      actorName: t.actor_name,
      note: t.note,
      createdAt: t.created_at,
    })),
  };
}

// ── Customer ──

async function getPaymentForGroup(req, res) {
  const { rows } = await pool.query(
    'SELECT p.id, cg.user_id FROM payments p JOIN checkout_groups cg ON cg.id = p.checkout_group_id WHERE p.checkout_group_id = $1',
    [req.params.groupId]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ message: 'Payment not found' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden' });
  }
  res.json(toPaymentJson(await loadPaymentDetail(row.id)));
}

/** Opens an attempt. The provider decides whether the customer has anywhere to go. */
async function createAttempt(req, res) {
  const { method } = req.body || {};
  if (method && !METHODS.includes(method)) {
    return res.status(400).json({ message: `method must be one of ${METHODS.join(', ')}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT p.*, cg.user_id AS owner_id FROM payments p
       JOIN checkout_groups cg ON cg.id = p.checkout_group_id
       WHERE p.checkout_group_id = $1 FOR UPDATE OF p`,
      [req.params.groupId]
    );
    const payment = rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Payment not found' });
    }
    if (payment.owner_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (TERMINAL.has(payment.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This payment is already ${payment.status}.` });
    }

    const attemptMethod = method || payment.method;
    const { rows: attemptRows } = await client.query(
      `INSERT INTO payment_attempts (payment_id, method, status) VALUES ($1, $2, 'pending') RETURNING *`,
      [payment.id, attemptMethod]
    );
    const attempt = attemptRows[0];

    const provider = providerForMethod(attemptMethod);
    const { providerOrderId, redirect } = provider.createAttempt({
      payment,
      attempt,
      amountCents: payment.amount_cents,
    });
    if (providerOrderId) {
      await client.query('UPDATE payment_attempts SET provider_order_id = $2 WHERE id = $1', [
        attempt.id,
        providerOrderId,
      ]);
    }
    await recordPaymentEvent(client, {
      paymentId: payment.id,
      attemptId: attempt.id,
      event: 'attempt.created',
      amountCents: payment.amount_cents,
      actorRole: 'customer',
      userId: req.user.id,
      note: `Attempt via ${attemptMethod.toUpperCase()}`,
    });

    await client.query('COMMIT');
    res.status(201).json({
      attemptId: attempt.id,
      status: 'pending',
      provider: provider.name,
      redirect: redirect ?? null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// ── Gateway ──

/**
 * The webhook receiver.
 *
 * Signature first, then parse, then apply once. A frontend success callback is
 * never enough to capture a payment — this is the only path that may.
 */
async function handleWebhook(req, res) {
  let provider;
  try {
    provider = getProvider(req.params.provider);
  } catch {
    return res.status(404).json({ message: 'Unknown provider' });
  }

  if (!provider.verifyWebhook({ headers: req.headers, rawBody: req.rawBody })) {
    return res.status(401).json({ message: 'Invalid signature' });
  }

  let parsed;
  try {
    parsed = provider.parseWebhook({ body: req.body });
  } catch (err) {
    return res.status(err.status ?? 400).json({ message: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The UNIQUE on provider_event_id is the real guard, but checking first
    // keeps a replay from looking like an error in the logs.
    const { rows: seen } = await client.query(
      'SELECT 1 FROM payment_transactions WHERE provider_event_id = $1',
      [parsed.providerEventId]
    );
    if (seen.length > 0) {
      await client.query('ROLLBACK');
      return res.json({ status: 'ignored', reason: 'already applied' });
    }

    const { rows } = await client.query(
      `SELECT p.* FROM payments p
       WHERE p.provider_payment_id = $1
          OR p.id = (SELECT payment_id FROM payment_attempts WHERE provider_order_id = $1 LIMIT 1)
       FOR UPDATE`,
      [parsed.providerPaymentId]
    );
    const payment = rows[0];
    if (!payment) {
      // Not a purchase payment — it may be a wallet top-up.
      const topup = await applyTopupEvent(client, parsed);
      if (topup) {
        await client.query('COMMIT');
        return res.json({ status: topup.status === 'ignored' ? 'ignored' : 'applied' });
      }
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'No payment matches this event' });
    }

    let status = payment.status;
    let captured = payment.amount_captured_cents;
    if (parsed.event === 'captured') {
      status = 'successful';
      captured = parsed.amountCents || payment.amount_cents;
    } else if (parsed.event === 'failed') {
      status = 'failed';
    } else if (parsed.event === 'cancelled') {
      status = 'cancelled';
    }

    await client.query(
      `UPDATE payments SET status = $2, amount_captured_cents = $3, provider_payment_id = COALESCE($4, provider_payment_id),
         failure_reason = COALESCE($5, failure_reason), updated_at = now()
       WHERE id = $1`,
      [payment.id, status, captured, parsed.providerPaymentId, parsed.failureReason]
    );
    await recordPaymentEvent(client, {
      paymentId: payment.id,
      event: parsed.event,
      amountCents: parsed.amountCents,
      providerEventId: parsed.providerEventId,
      actorRole: 'gateway',
      note: parsed.failureReason,
      payload: req.body,
    });

    // The stock this purchase is holding follows the money, in the same
    // transaction as the capture. A replayed webhook is already a no-op above,
    // and confirming twice would find nothing still held in any case.
    if (parsed.event === 'captured') {
      await confirmReservations(client, {
        groupId: payment.checkout_group_id,
        note: 'Payment captured',
      });
    } else if (parsed.event === 'failed' || parsed.event === 'cancelled') {
      await releaseReservations(client, {
        groupId: payment.checkout_group_id,
        note: `Payment ${parsed.event}`,
      });
    }

    await client.query('COMMIT');
    res.json({ status: 'applied' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Admin ──

function parsePaging(req, defaultPageSize = 25) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

async function listPayments(req, res) {
  const { status, method, q } = req.query;
  const { page, pageSize, offset } = parsePaging(req);
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (method) {
    params.push(method);
    conditions.push(`p.method = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const like = `$${params.length}`;
    conditions.push(
      `(cg.reference ILIKE ${like} OR u.full_name ILIKE ${like} OR u.email ILIKE ${like}
        OR p.provider_payment_id ILIKE ${like} OR CAST(p.id AS TEXT) ILIKE ${like})`
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const joins = `JOIN checkout_groups cg ON cg.id = p.checkout_group_id
     JOIN users u ON u.id = p.user_id`;

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM payments p ${joins} ${where}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT p.*, cg.reference AS group_reference, u.full_name AS customer_name, u.email AS customer_email,
            (SELECT COUNT(*)::int FROM orders o WHERE o.checkout_group_id = p.checkout_group_id) AS order_count
     FROM payments p ${joins} ${where}
     ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  res.json({ items: rows, total: countRows[0].total, page, pageSize });
}

async function getPayment(req, res) {
  const payment = await loadPaymentDetail(req.params.id);
  if (!payment) return res.status(404).json({ message: 'Payment not found' });
  res.json(toPaymentJson(payment));
}

/**
 * Raises a refund.
 *
 * The cap is the whole point: refunded plus this refund may never exceed what
 * was captured, and it is checked inside the transaction with the payment row
 * locked — two admins refunding at once would otherwise each see room for the
 * full amount.
 */
async function createRefund(req, res) {
  const { amountCents, reason, orderId } = req.body || {};
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ message: 'amountCents must be a positive integer' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [req.params.id]);
    const payment = rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Payment not found' });
    }
    if (payment.amount_captured_cents <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Nothing has been captured on this payment yet.' });
    }

    const remaining = payment.amount_captured_cents - payment.amount_refunded_cents;
    if (amountCents > remaining) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Refund exceeds the captured amount. At most ${remaining} paise can still be refunded.`,
      });
    }

    if (orderId) {
      const { rows: orderRows } = await client.query(
        'SELECT 1 FROM orders WHERE id = $1 AND checkout_group_id = $2',
        [orderId, payment.checkout_group_id]
      );
      if (orderRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'That order is not part of this purchase.' });
      }
    }

    const { rows: refundRows } = await client.query(
      `INSERT INTO refunds (payment_id, order_id, amount_cents, reason, requested_by_user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [payment.id, orderId || null, amountCents, reason || null, req.user.id]
    );
    const refund = refundRows[0];

    const provider = getProvider(payment.provider);
    const { providerRefundId, status: providerStatus } = provider.createRefund({ payment, refund });
    await client.query('UPDATE refunds SET provider_refund_id = $2, status = $3, updated_at = now() WHERE id = $1', [
      refund.id,
      providerRefundId,
      providerStatus,
    ]);
    await client.query(
      `INSERT INTO refund_transactions (refund_id, event, amount_cents, actor_role, changed_by_user_id, note)
       VALUES ($1, 'created', $2, 'admin', $3, $4)`,
      [refund.id, amountCents, req.user.id, reason || null]
    );

    // Refund totals drive the payment's status; it is never set by hand.
    const refunded = payment.amount_refunded_cents + amountCents;
    const status = refunded >= payment.amount_captured_cents ? 'refunded' : 'partially_refunded';
    await client.query(
      'UPDATE payments SET amount_refunded_cents = $2, status = $3, updated_at = now() WHERE id = $1',
      [payment.id, refunded, status]
    );
    await recordPaymentEvent(client, {
      paymentId: payment.id,
      event: 'refund.raised',
      amountCents,
      actorRole: 'admin',
      userId: req.user.id,
      note: reason || null,
    });

    await client.query('COMMIT');
    res.status(201).json({ ...refund, provider_refund_id: providerRefundId, status: providerStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }
}

async function listRefunds(req, res) {
  const { status } = req.query;
  const { page, pageSize, offset } = parsePaging(req);
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM refunds r ${where}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT r.*, cg.reference AS group_reference, u.full_name AS customer_name, p.method, p.provider
     FROM refunds r
     JOIN payments p ON p.id = r.payment_id
     JOIN checkout_groups cg ON cg.id = p.checkout_group_id
     JOIN users u ON u.id = p.user_id
     ${where}
     ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  res.json({ items: rows, total: countRows[0].total, page, pageSize });
}

/**
 * Approves a refund that was only ever requested — by a customer cancelling,
 * or by an approved return.
 *
 * createRefund is the admin raising one from nothing and settling it in the
 * same breath. This is the other half: a 'pending' row exists, nobody has sent
 * any money, and approving it is what hands the request to the provider and
 * moves the payment's refunded total. Kept apart so that a request can never
 * accidentally look settled just because it was recorded.
 */
async function approveRefund(req, res) {
  const { note } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [req.params.id]);
    const refund = rows[0];
    if (!refund) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Refund not found' });
    }
    if (refund.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This refund is already ${refund.status}.` });
    }

    const { rows: paymentRows } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [
      refund.payment_id,
    ]);
    const payment = paymentRows[0];

    // Re-checked at approval, not just at request time: other refunds on the
    // same purchase may have been approved since this one was raised.
    const remaining = payment.amount_captured_cents - payment.amount_refunded_cents;
    if (refund.amount_cents > remaining) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: `Only ${remaining} paise can still be refunded on this purchase.`,
      });
    }

    const provider = getProvider(payment.provider);
    const { providerRefundId, status: providerStatus } = provider.createRefund({ payment, refund });
    await client.query('UPDATE refunds SET provider_refund_id = $2, status = $3, updated_at = now() WHERE id = $1', [
      refund.id,
      providerRefundId,
      providerStatus,
    ]);
    await client.query(
      `INSERT INTO refund_transactions (refund_id, event, amount_cents, actor_role, changed_by_user_id, note)
       VALUES ($1, 'approved', $2, 'admin', $3, $4)`,
      [refund.id, refund.amount_cents, req.user.id, note || null]
    );

    const refunded = payment.amount_refunded_cents + refund.amount_cents;
    await client.query(
      'UPDATE payments SET amount_refunded_cents = $2, status = $3, updated_at = now() WHERE id = $1',
      [payment.id, refunded, refunded >= payment.amount_captured_cents ? 'refunded' : 'partially_refunded']
    );
    await recordPaymentEvent(client, {
      paymentId: payment.id,
      event: 'refund.approved',
      amountCents: refund.amount_cents,
      actorRole: 'admin',
      userId: req.user.id,
      note: note || null,
    });

    await client.query('COMMIT');
    res.json({ ...refund, provider_refund_id: providerRefundId, status: providerStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }
}

/** Declines a requested refund. Payment totals are untouched — nothing moved. */
async function rejectRefund(req, res) {
  const { note } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [req.params.id]);
    const refund = rows[0];
    if (!refund) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Refund not found' });
    }
    if (refund.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This refund is already ${refund.status}.` });
    }

    const { rows: updated } = await client.query(
      "UPDATE refunds SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *",
      [refund.id]
    );
    await client.query(
      `INSERT INTO refund_transactions (refund_id, event, amount_cents, actor_role, changed_by_user_id, note)
       VALUES ($1, 'rejected', $2, 'admin', $3, $4)`,
      [refund.id, refund.amount_cents, req.user.id, note || null]
    );
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The refunds raised against one of the caller's own orders.
 *
 * The customer's view of "where is my money": ownership is checked against the
 * order rather than the payment, so this cannot be used to read refunds on
 * someone else's purchase.
 */
async function listRefundsForOrder(req, res) {
  const { rows: orderRows } = await pool.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  if (!orderRows[0]) return res.status(404).json({ message: 'Order not found' });

  const { rows } = await pool.query(
    `SELECT id, order_id, amount_cents, reason, status, created_at, updated_at
     FROM refunds WHERE order_id = $1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}

module.exports = {
  createPaymentForGroup,
  settleCodForOrder,
  recordPaymentEvent,
  getPaymentForGroup,
  createAttempt,
  handleWebhook,
  listPayments,
  getPayment,
  createRefund,
  listRefunds,
  approveRefund,
  rejectRefund,
  listRefundsForOrder,
};
