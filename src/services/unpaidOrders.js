const pool = require('../config/db');
const { releaseExpiredHolds } = require('./inventory');

/**
 * RZ5: online orders that were never paid. Their stock hold runs out after
 * HOLD_MINUTES; this puts the stock back, cancels the orders and closes the
 * payment, on a timer (server.js) as well as at the next checkout. A payment
 * that still arrives later is captured and refunded at once
 * (payment.controller refundCancelledShare).
 */
async function expireUnpaid() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { cancelledOrders } = await releaseExpiredHolds(client);
    const closed = [];
    if (cancelledOrders.length) {
      const { rows } = await client.query(
        `UPDATE payments p SET status = 'cancelled', failure_reason = 'Not paid in time', updated_at = now()
         FROM checkout_groups cg
         WHERE cg.id = p.checkout_group_id
           AND p.status IN ('created', 'pending') AND p.method NOT IN ('cod', 'credit')
           AND cg.id IN (SELECT checkout_group_id FROM orders WHERE id = ANY($1))
           AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.checkout_group_id = cg.id AND o.status <> 'cancelled')
         RETURNING p.id, p.checkout_group_id`,
        [cancelledOrders.map((o) => o.id)]
      );
      for (const p of rows) {
        await client.query(
          `INSERT INTO payment_transactions (payment_id, event, amount_cents, actor_role, note)
           VALUES ($1, 'cancelled', 0, 'system', 'Not paid before the stock hold ran out')`,
          [p.id]
        );
        await client.query("UPDATE checkout_groups SET payment_status = 'failed', updated_at = now() WHERE id = $1", [p.checkout_group_id]);
        closed.push(p.id);
      }
    }
    await client.query('COMMIT');
    return { cancelledOrders: cancelledOrders.map((o) => o.id), closedPayments: closed };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { expireUnpaid };
