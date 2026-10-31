const pool = require('../config/db');

/**
 * VD21: what the shop lost between order and delivery, over a range of days
 * (India time): cancellations (who and why), orders that moved to another
 * shop (turned down, or not accepted in time) and returns (why, and what was
 * refunded), with rates against orders placed / delivered.
 *
 * GET /api/vendor/reports/cancellations?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

const MAX_DAYS = 366;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

async function cancellationsReport(req, res) {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to)) return res.status(400).json({ message: 'from and to are dates like 2026-10-31' });
  if (from > to) return res.status(400).json({ message: 'from is after to' });
  if (daysBetween(from, to) + 1 > MAX_DAYS) return res.status(400).json({ message: `At most ${MAX_DAYS} days` });

  // [$2, $3) as instants: the start of `from` to the end of `to`, India time.
  const W = `$2::date::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const E = `($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const args = [req.vendorId, from, to];

  const [placed, cancelled, byWho, byReason, moved, delivered, returns, returnReasons] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS n FROM orders WHERE vendor_id = $1 AND replacement_of_order_id IS NULL AND created_at >= ${W} AND created_at < ${E}`,
      args
    ),
    // Cancelled in the range: when the order went to "cancelled".
    pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(o.total_cents), 0)::bigint AS amount
       FROM orders o
       WHERE o.vendor_id = $1 AND o.status = 'cancelled' AND o.replacement_of_order_id IS NULL
         AND EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'cancelled' AND h.created_at >= ${W} AND h.created_at < ${E})`,
      args
    ),
    // Who: the approved cancellation request, else whoever moved it to cancelled.
    pool.query(
      `WITH c AS (
         SELECT o.id,
                COALESCE(
                  (SELECT oc.requested_by FROM order_cancellations oc WHERE oc.order_id = o.id AND oc.status IN ('approved', 'auto_approved') ORDER BY oc.id DESC LIMIT 1),
                  (SELECT h.actor_role FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'cancelled' ORDER BY h.id DESC LIMIT 1),
                  'system') AS who,
                (SELECT h.created_at FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'cancelled' ORDER BY h.id DESC LIMIT 1) AS at
         FROM orders o WHERE o.vendor_id = $1 AND o.status = 'cancelled' AND o.replacement_of_order_id IS NULL
       )
       SELECT who, COUNT(*)::int AS n FROM c WHERE at >= ${W} AND at < ${E} GROUP BY who ORDER BY n DESC, who`,
      args
    ),
    pool.query(
      `WITH c AS (
         SELECT (SELECT oc.reason_code FROM order_cancellations oc WHERE oc.order_id = o.id AND oc.status IN ('approved', 'auto_approved') ORDER BY oc.id DESC LIMIT 1) AS reason,
                (SELECT h.created_at FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'cancelled' ORDER BY h.id DESC LIMIT 1) AS at
         FROM orders o WHERE o.vendor_id = $1 AND o.status = 'cancelled' AND o.replacement_of_order_id IS NULL
       )
       SELECT COALESCE(reason, 'not_given') AS reason, COUNT(*)::int AS n FROM c WHERE at >= ${W} AND at < ${E} GROUP BY 1 ORDER BY n DESC, 1`,
      args
    ),
    // Orders that left the shop: turned down by the shop, or not accepted in time (the system).
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE actor_role = 'vendor')::int AS turned_down,
              COUNT(*) FILTER (WHERE actor_role = 'system')::int AS not_accepted,
              COUNT(*) FILTER (WHERE actor_role NOT IN ('vendor', 'system'))::int AS moved_by_others
       FROM order_assignment_history WHERE from_vendor_id = $1 AND created_at >= ${W} AND created_at < ${E}`,
      args
    ),
    pool.query(
      `SELECT COUNT(DISTINCT h.order_id)::int AS n FROM order_status_history h JOIN orders o ON o.id = h.order_id
       WHERE o.vendor_id = $1 AND h.to_status = 'delivered' AND h.created_at >= ${W} AND h.created_at < ${E}`,
      args
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE r.status = 'refunded')::int AS refunded,
              COUNT(*) FILTER (WHERE r.status = 'rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE r.status IN ('requested', 'approved', 'pickup_scheduled', 'picked_up', 'received', 'disputed'))::int AS open,
              COALESCE(SUM(r.approved_refund_cents) FILTER (WHERE r.status = 'refunded'), 0)::bigint AS refunded_amount
       FROM order_returns r JOIN orders o ON o.id = r.order_id
       WHERE o.vendor_id = $1 AND r.status <> 'cancelled' AND r.created_at >= ${W} AND r.created_at < ${E}`,
      args
    ),
    pool.query(
      `SELECT r.reason_code AS reason, COUNT(*)::int AS n FROM order_returns r JOIN orders o ON o.id = r.order_id
       WHERE o.vendor_id = $1 AND r.status <> 'cancelled' AND r.created_at >= ${W} AND r.created_at < ${E}
       GROUP BY 1 ORDER BY n DESC, 1`,
      args
    ),
  ]);

  const placedN = placed.rows[0].n;
  const c = cancelled.rows[0];
  const m = moved.rows[0];
  const r = returns.rows[0];
  const deliveredN = delivered.rows[0].n;
  res.json({
    from,
    to,
    placed: placedN,
    delivered: deliveredN,
    cancelled: {
      count: c.n,
      amountCents: Number(c.amount),
      ratePercent: rate(c.n, placedN),
      byWho: byWho.rows.map((x) => ({ who: x.who, count: x.n })),
      byReason: byReason.rows.map((x) => ({ reason: x.reason, count: x.n })),
    },
    movedAway: { turnedDown: m.turned_down, notAcceptedInTime: m.not_accepted, other: m.moved_by_others },
    returns: {
      count: r.n,
      open: r.open,
      refunded: r.refunded,
      rejected: r.rejected,
      refundedCents: Number(r.refunded_amount),
      ratePercent: rate(r.n, deliveredN),
      byReason: returnReasons.rows.map((x) => ({ reason: x.reason, count: x.n })),
    },
  });
}

module.exports = { cancellationsReport };
