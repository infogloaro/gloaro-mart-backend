const pool = require('./../config/db');

/**
 * Returns on delivered orders.
 *
 * A return is a *request*, not money moving: the customer raises it, an admin
 * decides, and only an approval produces a refund. That refund then goes
 * through the same approval as any other, so nothing here sends money — it
 * only ever queues it.
 */

const REASON_CODES = ['damaged', 'wrong_item', 'not_as_described', 'missing_items', 'other'];

/** How long after delivery a return can still be raised. */
const RETURN_WINDOW_DAYS = 7;

/**
 * When the order was actually delivered.
 *
 * Read from the status history rather than orders.updated_at: that column moves
 * on any later write, which would silently extend or shorten someone's return
 * window. The history row is written once and never changes.
 */
async function deliveredAtFor(orderId) {
  const { rows } = await pool.query(
    `SELECT created_at FROM order_status_history
     WHERE order_id = $1 AND to_status = 'delivered'
     ORDER BY created_at DESC LIMIT 1`,
    [orderId]
  );
  return rows[0]?.created_at ?? null;
}

/**
 * Whether an order can still be returned, and why not when it cannot.
 *
 * Shared by the request handler and the order payload so the button the app
 * shows and the rule the server enforces can never disagree.
 */
function returnEligibility(order, deliveredAt) {
  if (order.status !== 'delivered') {
    return { eligible: false, reason: 'Only delivered orders can be returned.' };
  }
  // Orders delivered before the history table existed have no row. Refusing
  // them would be worse than allowing one late return, so they stay eligible.
  if (!deliveredAt) return { eligible: true, daysLeft: RETURN_WINDOW_DAYS };

  const elapsedDays = (Date.now() - new Date(deliveredAt).getTime()) / 86400000;
  if (elapsedDays > RETURN_WINDOW_DAYS) {
    return {
      eligible: false,
      reason: `The ${RETURN_WINDOW_DAYS}-day return window for this order has closed.`,
    };
  }
  return { eligible: true, daysLeft: Math.max(0, Math.ceil(RETURN_WINDOW_DAYS - elapsedDays)) };
}

async function requestReturn(req, res) {
  const { reasonCode, comment } = req.body || {};
  if (!REASON_CODES.includes(reasonCode)) {
    return res.status(400).json({ message: `reasonCode must be one of ${REASON_CODES.join(', ')}` });
  }

  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  const order = rows[0];
  if (!order) return res.status(404).json({ message: 'Order not found' });

  const eligibility = returnEligibility(order, await deliveredAtFor(order.id));
  if (!eligibility.eligible) return res.status(409).json({ message: eligibility.reason });

  try {
    const { rows: created } = await pool.query(
      `INSERT INTO order_returns (order_id, user_id, reason_code, comment)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [order.id, req.user.id, reasonCode, comment || null]
    );
    res.status(201).json(created[0]);
  } catch (err) {
    // The partial unique index: one open request per order.
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A return request for this order is already open.' });
    }
    throw err;
  }
}

/** The caller's own return requests for one order. */
async function listReturnsForOrder(req, res) {
  const { rows: orderRows } = await pool.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  if (!orderRows[0]) return res.status(404).json({ message: 'Order not found' });

  const { rows } = await pool.query(
    `SELECT id, order_id, reason_code, comment, status, resolution_note, refund_id, created_at, reviewed_at
     FROM order_returns WHERE order_id = $1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}

/** The customer withdrawing a request an admin has not decided yet. */
async function cancelReturn(req, res) {
  const { rows } = await pool.query(
    `UPDATE order_returns SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'requested' RETURNING *`,
    [req.params.returnId, req.user.id]
  );
  if (!rows[0]) {
    return res.status(409).json({ message: 'That request no longer exists or has already been decided.' });
  }
  res.json(rows[0]);
}

// --- Admin ---

async function listReturns(req, res) {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE r.status = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT r.*, o.total_cents, o.vendor_id, o.payment_method,
            vp.business_name, u.full_name AS customer_name, u.email AS customer_email,
            cg.reference AS group_reference
     FROM order_returns r
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN vendor_profiles vp ON vp.id = o.vendor_id
     JOIN users u ON u.id = r.user_id
     LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
     ${where}
     ORDER BY r.created_at DESC`,
    params
  );
  res.json(rows);
}

/**
 * Approving a return raises the refund it entitles the customer to.
 *
 * The refund lands as 'pending' like any other request — approving the return
 * says the customer is owed the money, not that it has been sent. An admin
 * still approves the refund itself, which is what hands it to the provider.
 *
 * COD orders have nothing captured, so there is no refund to raise; the return
 * is approved on its own and settling up happens off-platform.
 */
async function approveReturn(req, res) {
  const { note } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM order_returns WHERE id = $1 FOR UPDATE', [
      req.params.returnId,
    ]);
    const request = rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Return request not found' });
    }
    if (request.status !== 'requested') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This request is already ${request.status}.` });
    }

    const { rows: orderRows } = await client.query('SELECT * FROM orders WHERE id = $1', [request.order_id]);
    const order = orderRows[0];

    let refundId = null;
    const { rows: paymentRows } = await client.query(
      `SELECT * FROM payments WHERE checkout_group_id = $1 AND method <> 'cod' FOR UPDATE`,
      [order.checkout_group_id]
    );
    const payment = paymentRows[0];

    if (payment && payment.amount_captured_cents > 0) {
      const remaining = payment.amount_captured_cents - payment.amount_refunded_cents;
      const amountCents = Math.min(order.total_cents, remaining);
      if (amountCents > 0) {
        const { rows: refundRows } = await client.query(
          `INSERT INTO refunds (payment_id, order_id, amount_cents, reason, requested_by_user_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [payment.id, order.id, amountCents, `Return approved: ${request.reason_code}`, request.user_id]
        );
        refundId = refundRows[0].id;
        await client.query(
          `INSERT INTO refund_transactions (refund_id, event, amount_cents, actor_role, changed_by_user_id, note)
           VALUES ($1, 'requested', $2, 'admin', $3, $4)`,
          [refundId, amountCents, req.user.id, 'Raised by an approved return']
        );
      }
    }

    const { rows: updated } = await client.query(
      `UPDATE order_returns
       SET status = 'approved', refund_id = $2, resolution_note = $3,
           reviewed_by_user_id = $4, reviewed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [request.id, refundId, note || null, req.user.id]
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

async function rejectReturn(req, res) {
  const { note } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE order_returns
     SET status = 'rejected', resolution_note = $2, reviewed_by_user_id = $3,
         reviewed_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'requested' RETURNING *`,
    [req.params.returnId, note || null, req.user.id]
  );
  if (!rows[0]) {
    return res.status(409).json({ message: 'That request no longer exists or has already been decided.' });
  }
  res.json(rows[0]);
}

module.exports = {
  REASON_CODES,
  RETURN_WINDOW_DAYS,
  returnEligibility,
  deliveredAtFor,
  requestReturn,
  listReturnsForOrder,
  cancelReturn,
  listReturns,
  approveReturn,
  rejectReturn,
};
