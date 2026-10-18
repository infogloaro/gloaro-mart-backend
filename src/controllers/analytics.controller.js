const pool = require('../config/db');

async function getVendorProfileId(userId) {
  const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [userId]);
  return rows[0]?.id || null;
}

async function getVendorSummary(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const [{ rows: totalRow }, { rows: dailyRows }, { rows: volumeRow }, { rows: topByRevenue }, { rows: topByQty }] =
    await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(total_cents), 0) AS total_revenue_cents, COUNT(*) AS delivered_order_count
         FROM orders WHERE vendor_id = $1 AND status = 'delivered'`,
        [vendorId]
      ),
      pool.query(
        `SELECT date_trunc('day', updated_at) AS day, SUM(total_cents) AS revenue_cents
         FROM orders
         WHERE vendor_id = $1 AND status = 'delivered' AND updated_at >= now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`,
        [vendorId]
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS orders_last_30_days,
                COUNT(*) AS total_orders_all_time
         FROM orders WHERE vendor_id = $1`,
        [vendorId]
      ),
      pool.query(
        `SELECT oi.product_id, oi.product_name_snapshot,
                SUM(oi.unit_price_cents * oi.quantity) AS revenue_cents
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.vendor_id = $1 AND o.status = 'delivered'
         GROUP BY oi.product_id, oi.product_name_snapshot
         ORDER BY revenue_cents DESC LIMIT 5`,
        [vendorId]
      ),
      pool.query(
        `SELECT oi.product_id, oi.product_name_snapshot, SUM(oi.quantity) AS total_quantity
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.vendor_id = $1 AND o.status = 'delivered'
         GROUP BY oi.product_id, oi.product_name_snapshot
         ORDER BY total_quantity DESC LIMIT 5`,
        [vendorId]
      ),
    ]);

  const revenueByDay = new Map(dailyRows.map((r) => [r.day.toISOString().slice(0, 10), Number(r.revenue_cents)]));
  const dailyRevenue = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyRevenue.push({ date: key, revenueCents: revenueByDay.get(key) || 0 });
  }

  res.json({
    totalRevenueCents: Number(totalRow[0].total_revenue_cents),
    deliveredOrderCount: Number(totalRow[0].delivered_order_count),
    ordersLast30Days: Number(volumeRow[0].orders_last_30_days),
    totalOrdersAllTime: Number(volumeRow[0].total_orders_all_time),
    dailyRevenue,
    topProductsByRevenue: topByRevenue.map((r) => ({
      productId: r.product_id,
      name: r.product_name_snapshot,
      revenueCents: Number(r.revenue_cents),
    })),
    topProductsByQuantity: topByQty.map((r) => ({
      productId: r.product_id,
      name: r.product_name_snapshot,
      quantity: Number(r.total_quantity),
    })),
  });
}

// ------------------------------------------------------------ Admin → Analytics

/**
 * What counts as a sale: an order that wasn't cancelled, isn't a free
 * replacement, and is either COD/credit or actually paid online. Orders are
 * counted per purchase (one checkout, however many shops it split across).
 * Days are Indian Standard Time.
 */
const COUNTED = `
  SELECT o.id, o.user_id, o.vendor_id, o.total_cents, o.created_at, o.business_account_id, o.origin,
         o.delivery_address_snapshot, COALESCE(o.checkout_group_id::text, 'o' || o.id) AS purchase_key,
         (o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day
  FROM orders o
  LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
  WHERE o.status <> 'cancelled' AND o.replacement_of_order_id IS NULL
    AND (o.payment_method IN ('cod', 'credit') OR p.status IN ('successful', 'refunded', 'partially_refunded'))`;

const FUNNEL = [
  ['sessions', null],
  ['viewed_a_product', 'product_view'],
  ['added_to_cart', 'add_to_cart'],
  ['started_checkout', 'checkout_start'],
  ['ordered', 'order_placed'],
];

const delta = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);
const isoDay = (d) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

async function adminAnalytics(req, res) {
  const days = req.query.days == null ? 30 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) return res.status(400).json({ message: 'days is 1–365' });

  // The window: today and the days before it, in IST; and the same length before that.
  const { rows: b } = await pool.query(
    `SELECT ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - ($1::int - 1) * interval '1 day') AT TIME ZONE 'Asia/Kolkata') AS start_at,
            ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - (2 * $1::int - 1) * interval '1 day') AT TIME ZONE 'Asia/Kolkata') AS prev_at,
            to_char((now() AT TIME ZONE 'Asia/Kolkata')::date - ($1::int - 1), 'YYYY-MM-DD') AS first_day`,
    [days]
  );
  const { start_at: startAt, prev_at: prevAt, first_day: firstDay } = b[0];
  const W = 'c.created_at >= $1';

  const [totals, daily, vendors, locations, customers, funnel] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(c.total_cents) FILTER (WHERE ${W}), 0)::bigint AS gmv,
              COUNT(DISTINCT c.purchase_key) FILTER (WHERE ${W})::int AS orders,
              COALESCE(SUM(c.total_cents) FILTER (WHERE c.created_at < $1), 0)::bigint AS prev_gmv,
              COUNT(DISTINCT c.purchase_key) FILTER (WHERE c.created_at < $1)::int AS prev_orders
       FROM (${COUNTED}) c WHERE c.created_at >= $2`,
      [startAt, prevAt]
    ),
    pool.query(
      `SELECT to_char(c.day, 'YYYY-MM-DD') AS day, SUM(c.total_cents)::bigint AS gmv, COUNT(DISTINCT c.purchase_key)::int AS orders,
              COALESCE(SUM(c.total_cents) FILTER (WHERE c.business_account_id IS NULL AND c.origin IS DISTINCT FROM 'near_me'), 0)::bigint AS shop,
              COALESCE(SUM(c.total_cents) FILTER (WHERE c.business_account_id IS NOT NULL), 0)::bigint AS b2b,
              COALESCE(SUM(c.total_cents) FILTER (WHERE c.business_account_id IS NULL AND c.origin = 'near_me'), 0)::bigint AS near_me
       FROM (${COUNTED}) c WHERE ${W} GROUP BY c.day`,
      [startAt]
    ),
    pool.query(
      `SELECT c.vendor_id, vp.business_name, vp.city, COUNT(*)::int AS orders, SUM(c.total_cents)::bigint AS gmv
       FROM (${COUNTED}) c JOIN vendor_profiles vp ON vp.id = c.vendor_id WHERE ${W}
       GROUP BY c.vendor_id, vp.business_name, vp.city ORDER BY gmv DESC, c.vendor_id LIMIT 10`,
      [startAt]
    ),
    // The delivery city; a pickup (no address) is the shop's own city.
    pool.query(
      `SELECT city, COUNT(DISTINCT purchase_key)::int AS orders, COUNT(DISTINCT user_id)::int AS customers, SUM(total_cents)::bigint AS gmv
       FROM (SELECT c.*, COALESCE(initcap(lower(NULLIF(trim(c.delivery_address_snapshot->>'city'), ''))),
                                  initcap(lower(NULLIF(trim(vp.city), ''))), 'Unknown') AS city
             FROM (${COUNTED}) c JOIN vendor_profiles vp ON vp.id = c.vendor_id WHERE ${W}) x
       GROUP BY city ORDER BY gmv DESC, city LIMIT 10`,
      [startAt]
    ),
    // Per customer in the window: purchases in it, and whether they had bought before it.
    pool.query(
      `SELECT COUNT(*)::int AS customers,
              COUNT(*) FILTER (WHERE w.purchases > 1)::int AS repeat,
              COUNT(*) FILTER (WHERE w.first_ever >= $1)::int AS new_customers,
              COUNT(*) FILTER (WHERE w.first_ever < $1)::int AS returning
       FROM (
         SELECT c.user_id, COUNT(DISTINCT c.purchase_key) AS purchases,
                (SELECT MIN(a.created_at) FROM (${COUNTED}) a WHERE a.user_id = c.user_id) AS first_ever
         FROM (${COUNTED}) c WHERE ${W} GROUP BY c.user_id
       ) w`,
      [startAt]
    ),
    // A session counts as reaching a step if it reached that step or any later one,
    // so the funnel never widens (a cart added from a list skips "viewed").
    pool.query(
      `SELECT COUNT(*)::int AS sessions,
              COUNT(*) FILTER (WHERE s.reach >= 1)::int AS viewed,
              COUNT(*) FILTER (WHERE s.reach >= 2)::int AS carted,
              COUNT(*) FILTER (WHERE s.reach >= 3)::int AS checkout,
              COUNT(*) FILTER (WHERE s.reach >= 4)::int AS ordered
       FROM (
         SELECT session_id, MAX(CASE event WHEN 'product_view' THEN 1 WHEN 'add_to_cart' THEN 2
                                           WHEN 'checkout_start' THEN 3 WHEN 'order_placed' THEN 4 ELSE 0 END) AS reach
         FROM analytics_events WHERE occurred_at >= $1 GROUP BY session_id
       ) s`,
      [startAt]
    ),
  ]);

  const t = totals.rows[0];
  const gmv = Number(t.gmv);
  const c = customers.rows[0];
  const f = funnel.rows[0];

  // Every day of the window, zeros included, so the charts' x-axis is the window — unless nothing sold at all.
  const byDay = new Map(daily.rows.map((r) => [r.day, r]));
  const series = [];
  const channels = [];
  if (daily.rows.length) {
    const [y, m, d] = firstDay.split('-').map(Number);
    for (let i = 0; i < days; i++) {
      const date = isoDay(new Date(Date.UTC(y, m - 1, d + i)));
      const r = byDay.get(date);
      series.push({ date, gmvCents: Number(r?.gmv ?? 0), orders: r?.orders ?? 0 });
      channels.push({ date, shopCents: Number(r?.shop ?? 0), b2bCents: Number(r?.b2b ?? 0), nearMeCents: Number(r?.near_me ?? 0) });
    }
  }

  res.json({
    summary: {
      gmvCents: gmv,
      gmvDeltaPercent: delta(gmv, Number(t.prev_gmv)),
      orders: t.orders,
      ordersDeltaPercent: delta(t.orders, t.prev_orders),
      aovCents: t.orders ? Math.round(gmv / t.orders) : 0,
      conversionRate: f.sessions ? f.ordered / f.sessions : null,
      repeatRate: c.customers ? c.repeat / c.customers : null,
      newCustomers: c.new_customers,
      returningCustomers: c.returning,
    },
    series,
    channels,
    vendors: vendors.rows.map((v) => ({ vendorId: v.vendor_id, vendorName: v.business_name, city: v.city, orders: v.orders, gmvCents: Number(v.gmv) })),
    locations: locations.rows.map((l) => ({ city: l.city, orders: l.orders, customers: l.customers, gmvCents: Number(l.gmv) })),
    funnel: f.sessions
      ? FUNNEL.map(([stage], i) => ({ stage, count: [f.sessions, f.viewed, f.carted, f.checkout, f.ordered][i] }))
      : [],
  });
}

// ------------------------------------------------------------- app events

const { recordBatch, AnalyticsError } = require('../services/analytics');

// A plain per-address limit: the endpoint is open to signed-out sessions.
const WINDOW_MS = 60000;
const MAX_PER_WINDOW = 120;
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 10000) for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
    return false;
  }
  h.n += 1;
  return h.n > MAX_PER_WINDOW;
}

async function postEvents(req, res) {
  if (tooMany(req.ip)) return res.status(429).json({ message: 'Too many analytics requests — batch them.' });
  try {
    const accepted = await recordBatch({
      sessionId: req.body?.sessionId,
      platform: req.body?.platform,
      events: req.body?.events,
      userId: req.user?.id,
    });
    res.status(202).json({ accepted });
  } catch (err) {
    if (err instanceof AnalyticsError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
}

module.exports = { getVendorSummary, adminAnalytics, postEvents };
