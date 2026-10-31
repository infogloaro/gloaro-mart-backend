const pool = require('../config/db');

/**
 * Reports for the shop (VD16). Each report is one handler here; the app lists
 * them on its Reports page.
 */

const MAX_REPORT_DAYS = 366;

// A real calendar day: 2026-13-01 and 2026-02-30 are refused, not thrown on.
const isDay = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * The shop's orders that really happened, with whether each is a sale — the
 * same rule as Home insights (vendorPortal.controller SHOP_ORDERS) and Admin →
 * Analytics: free replacements never count, and an online order only counts
 * once paid. $1 = vendor id.
 */
const SHOP_ORDERS = `
  SELECT o.id, o.user_id, o.total_cents, o.created_at, o.status = 'cancelled' AS cancelled
  FROM orders o
  LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
  WHERE o.vendor_id = $1 AND o.replacement_of_order_id IS NULL
    AND (o.payment_method IN ('cod', 'credit') OR p.status IN ('successful', 'refunded', 'partially_refunded'))`;

/**
 * Checks ?from&to (IST days, YYYY-MM-DD). Missing means today; a "to" past
 * India's today stops at today. Returns { from, to, days, today } or { error }.
 */
async function reportRange(query) {
  const { rows } = await pool.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today`);
  const today = rows[0].today;
  let from = query.from ?? today;
  let to = query.to ?? today;
  if (!isDay(from) || !isDay(to)) return { error: 'from and to are dates like 2026-10-31' };
  if (from > to) return { error: 'from is after to' };
  if (from > today) return { error: 'from is in the future' };
  if (to > today) to = today;
  const days = daysBetween(from, to) + 1;
  if (days > MAX_REPORT_DAYS) return { error: `At most ${MAX_REPORT_DAYS} days` };
  return { from, to, days, today };
}

/**
 * Sales over a range of days: totals, every day of the range, sales by
 * category and the top 10 products.
 *
 * GET /api/vendor/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Totals and days use the order total (what the customer paid the shop);
 * categories and products use item value (price × quantity), so they don't
 * add up to the total when there are delivery fees or discounts.
 */
async function salesReport(req, res) {
  const r = await reportRange(req.query);
  if (r.error) return res.status(400).json({ message: r.error });
  const { from, to, days } = r;

  // [start, end) of the range in IST.
  const W = `
    WITH w AS (
      SELECT ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AS s,
             (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') AS e
    )`;
  const args = [req.vendorId, from, to];

  const [byDay, byCategory, top] = await Promise.all([
    pool.query(
      `${W},
       o AS (${SHOP_ORDERS})
       SELECT to_char((o.created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE NOT o.cancelled)::int AS orders,
              COALESCE(SUM(o.total_cents) FILTER (WHERE NOT o.cancelled), 0)::bigint AS sales,
              COUNT(*) FILTER (WHERE o.cancelled)::int AS cancelled
       FROM o, w WHERE o.created_at >= w.s AND o.created_at < w.e
       GROUP BY 1`,
      args
    ),
    pool.query(
      `${W},
       o AS (${SHOP_ORDERS})
       SELECT COALESCE(NULLIF(TRIM(p.category), ''), 'Other') AS category,
              COUNT(DISTINCT o.id)::int AS orders, SUM(oi.quantity)::int AS units,
              SUM(oi.unit_price_cents * oi.quantity)::bigint AS sales
       FROM o JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.id = oi.product_id, w
       WHERE NOT o.cancelled AND o.created_at >= w.s AND o.created_at < w.e
       GROUP BY 1
       ORDER BY sales DESC, category`,
      args
    ),
    pool.query(
      `${W},
       o AS (${SHOP_ORDERS})
       SELECT oi.product_id, MAX(oi.product_name_snapshot) AS name,
              COUNT(DISTINCT o.id)::int AS orders, SUM(oi.quantity)::int AS units,
              SUM(oi.unit_price_cents * oi.quantity)::bigint AS sales
       FROM o JOIN order_items oi ON oi.order_id = o.id, w
       WHERE NOT o.cancelled AND o.created_at >= w.s AND o.created_at < w.e
       GROUP BY oi.product_id
       ORDER BY sales DESC, units DESC, oi.product_id
       LIMIT 10`,
      args
    ),
  ]);

  // Every day of the range, zeros included, so the table reads as a calendar.
  const seen = new Map(byDay.rows.map((d) => [d.day, d]));
  const dayRows = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    const d = seen.get(day);
    dayRows.push({ day, orders: d ? d.orders : 0, salesCents: d ? Number(d.sales) : 0, cancelled: d ? d.cancelled : 0 });
  }
  const orders = dayRows.reduce((n, d) => n + d.orders, 0);
  const sales = dayRows.reduce((n, d) => n + d.salesCents, 0);
  const cancelled = dayRows.reduce((n, d) => n + d.cancelled, 0);

  res.json({
    range: { from, to, days },
    totals: { orders, salesCents: sales, avgOrderCents: orders ? Math.round(sales / orders) : 0, cancelled },
    days: dayRows,
    categories: byCategory.rows.map((c) => ({ category: c.category, orders: c.orders, units: c.units, salesCents: Number(c.sales) })),
    topProducts: top.rows.map((p) => ({ productId: p.product_id, name: p.name, orders: p.orders, units: p.units, salesCents: Number(p.sales) })),
  });
}

module.exports = { salesReport };
