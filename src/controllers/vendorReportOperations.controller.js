const pool = require('../config/db');

/**
 * DB4 (2026-11-08): how the shop runs, over a range of days (India time).
 *
 * - busyHours: orders placed by weekday (0 = Monday … 6 = Sunday) and hour
 *   (0–23), with their value, so the shop can see when to keep staff and
 *   stock ready;
 * - timings: how long orders took from placed to accepted, accepted to
 *   packed, and packed to delivered — median and 90th percentile minutes,
 *   from order_status_history (each step's first time).
 *
 * Read-only; replacement orders are left out, as in the other reports.
 *
 * GET /api/vendor/reports/operations?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

const MAX_DAYS = 366;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

async function operationsReport(req, res) {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to)) return res.status(400).json({ message: 'from and to are dates like 2026-10-31' });
  if (from > to) return res.status(400).json({ message: 'from is after to' });
  if (daysBetween(from, to) + 1 > MAX_DAYS) return res.status(400).json({ message: `At most ${MAX_DAYS} days` });

  const W = `$2::date::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const E = `($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const args = [req.vendorId, from, to];

  const [grid, timings] = await Promise.all([
    // ISO weekday 1–7 → 0–6, hour of the day in India time.
    pool.query(
      `SELECT (EXTRACT(ISODOW FROM o.created_at AT TIME ZONE 'Asia/Kolkata')::int - 1) AS dow,
              EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
              COUNT(*)::int AS orders,
              COALESCE(SUM(o.total_cents) FILTER (WHERE o.status <> 'cancelled'), 0)::bigint AS sales
       FROM orders o
       WHERE o.vendor_id = $1 AND o.replacement_of_order_id IS NULL
         AND o.created_at >= ${W} AND o.created_at < ${E}
       GROUP BY 1, 2`,
      args
    ),
    // First time each step was reached, per order placed in the range.
    pool.query(
      `WITH steps AS (
         SELECT o.id, o.created_at AS placed,
                (SELECT MIN(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'confirmed') AS accepted,
                (SELECT MIN(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'packed') AS packed,
                (SELECT MIN(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'delivered') AS delivered
         FROM orders o
         WHERE o.vendor_id = $1 AND o.replacement_of_order_id IS NULL
           AND o.created_at >= ${W} AND o.created_at < ${E}
       ),
       d AS (
         SELECT EXTRACT(EPOCH FROM (accepted - placed)) / 60 AS accept_min,
                EXTRACT(EPOCH FROM (packed - accepted)) / 60 AS pack_min,
                EXTRACT(EPOCH FROM (delivered - packed)) / 60 AS deliver_min
         FROM steps
       )
       SELECT COUNT(accept_min) FILTER (WHERE accept_min >= 0)::int AS accept_n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY accept_min) FILTER (WHERE accept_min >= 0) AS accept_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY accept_min) FILTER (WHERE accept_min >= 0) AS accept_p90,
              COUNT(pack_min) FILTER (WHERE pack_min >= 0)::int AS pack_n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY pack_min) FILTER (WHERE pack_min >= 0) AS pack_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY pack_min) FILTER (WHERE pack_min >= 0) AS pack_p90,
              COUNT(deliver_min) FILTER (WHERE deliver_min >= 0)::int AS deliver_n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY deliver_min) FILTER (WHERE deliver_min >= 0) AS deliver_p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY deliver_min) FILTER (WHERE deliver_min >= 0) AS deliver_p90
       FROM d`,
      args
    ),
  ]);

  const orders = Array.from({ length: 7 }, () => Array(24).fill(0));
  const sales = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of grid.rows) {
    if (r.dow < 0 || r.dow > 6 || r.hour < 0 || r.hour > 23) continue;
    orders[r.dow][r.hour] = r.orders;
    sales[r.dow][r.hour] = Number(r.sales);
  }
  const t = timings.rows[0] || {};
  const step = (n, p50, p90) => ({ orders: n || 0, medianMinutes: round1(p50), p90Minutes: round1(p90) });

  res.json({
    range: { from, to },
    busyHours: { orders, salesCents: sales },
    timings: {
      accept: step(t.accept_n, t.accept_p50, t.accept_p90),
      pack: step(t.pack_n, t.pack_p50, t.pack_p90),
      deliver: step(t.deliver_n, t.deliver_p50, t.deliver_p90),
    },
  });
}

module.exports = { operationsReport };
