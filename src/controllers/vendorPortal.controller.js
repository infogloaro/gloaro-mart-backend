const pool = require('../config/db');
const shopFollows = require('../services/shopFollows');
const shopVisits = require('../services/shopVisits');

/**
 * The vendor's own operating view.
 * Contracts per documents/SPRINT_8_VENDOR_PORTAL_SPEC.md §5.
 *
 * Deliberately not a second analytics screen — analytics.controller already
 * answers "how is the shop doing". This answers "what needs doing right now",
 * which is a different question with a different shelf life.
 */

/**
 * What the vendor's home screen can answer truthfully today.
 *
 * No settlement or rating tiles: commission arrives in Phase 9 and reviews in
 * Phase 13, and a tile that always reads zero because the feature behind it does
 * not exist is worse than no tile at all.
 */
async function getDashboard(req, res) {
  const vendorId = req.vendorId;

  const [{ rows: today }, { rows: orders }, { rows: stock }, { rows: lowRows }, followers, visits, attention] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM(total_cents), 0)::int AS revenue_cents
       FROM orders
       WHERE vendor_id = $1 AND status <> 'cancelled' AND created_at >= date_trunc('day', now())`,
      [vendorId]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS new_orders,
              COUNT(*) FILTER (WHERE status IN ('confirmed', 'packed'))::int AS preparing,
              COUNT(*) FILTER (WHERE status = 'out_for_delivery')::int AS out_for_delivery,
              COUNT(*) FILTER (WHERE status NOT IN ('delivered', 'cancelled'))::int AS open_orders
       FROM orders WHERE vendor_id = $1`,
      [vendorId]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE available_qty = 0)::int AS out_of_stock,
              COUNT(*) FILTER (WHERE available_qty > 0 AND available_qty <= low_stock_threshold)::int AS low_stock,
              COALESCE(SUM(reserved_qty), 0)::int AS held_for_orders,
              COUNT(*)::int AS tracked_items
       FROM inventory WHERE vendor_id = $1`,
      [vendorId]
    ),
    // Named, not just counted: 'four items are low' is not something a vendor
    // can act on without knowing which four.
    pool.query(
      `SELECT i.id, i.available_qty, i.low_stock_threshold, p.name AS product_name,
              (SELECT string_agg(av.value, ' / ' ORDER BY a.sort_order, av.sort_order)
               FROM variant_attribute_values vav
               JOIN attribute_values av ON av.id = vav.attribute_value_id
               JOIN product_attributes a ON a.id = av.attribute_id
               WHERE vav.variant_id = i.variant_id) AS variant_label
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       WHERE i.vendor_id = $1
         AND (i.available_qty = 0 OR i.available_qty <= i.low_stock_threshold)
       ORDER BY i.available_qty ASC, p.name ASC
       LIMIT 10`,
      [vendorId]
    ),
    // SB4: who follows the shop. Before the migration the table isn't there;
    // the dashboard still answers, without this tile.
    shopFollows.followerStats(vendorId).catch((err) => {
      if (err.code === '42P01') return null;
      throw err;
    }),
    // SB5: shop-page visitors; left out before the migration, like followers.
    shopVisits.visitStats(vendorId).catch((err) => {
      if (err.code === '42P01') return null;
      throw err;
    }),
    attentionCounts(vendorId),
  ]);

  res.json({
    today: {
      orderCount: today[0].order_count,
      revenueCents: today[0].revenue_cents,
    },
    orders: {
      newOrders: orders[0].new_orders,
      preparing: orders[0].preparing,
      outForDelivery: orders[0].out_for_delivery,
      openOrders: orders[0].open_orders,
    },
    stock: {
      outOfStock: stock[0].out_of_stock,
      lowStock: stock[0].low_stock,
      heldForOrders: stock[0].held_for_orders,
      trackedItems: stock[0].tracked_items,
    },
    needsRestocking: lowRows.map((r) => ({
      inventoryId: r.id,
      productName: r.product_name,
      variantLabel: r.variant_label,
      availableQty: r.available_qty,
      lowStockThreshold: r.low_stock_threshold,
    })),
    ...(followers ? { followers } : {}),
    ...(visits ? { visits } : {}),
    attention,
  });
}

/**
 * VD3: things waiting on the shop besides orders and stock — questions where
 * the customer spoke last, reviews without a reply, and payouts that failed or
 * are on hold. A count whose table isn't there yet is left out.
 */
async function attentionCounts(vendorId) {
  const count = (sql) =>
    pool.query(sql, [vendorId]).then(
      ({ rows }) => rows[0].n,
      (err) => {
        if (err.code === '42P01' || err.code === '42703') return null;
        throw err;
      }
    );
  const [questions, reviews, payouts, returns] = await Promise.all([
    count(`SELECT COUNT(*)::int AS n FROM shop_enquiries WHERE vendor_id = $1 AND status <> 'closed' AND last_message_from = 'customer'`),
    count(`SELECT COUNT(*)::int AS n FROM vendor_reviews WHERE vendor_id = $1 AND status = 'published' AND vendor_reply IS NULL`),
    count(`SELECT COUNT(*)::int AS n FROM settlements WHERE vendor_id = $1 AND status IN ('failed', 'on_hold')`),
    // VD9: returns just asked for, or disputed, on the shop's orders.
    count(`SELECT COUNT(*)::int AS n FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE o.vendor_id = $1 AND r.status IN ('requested', 'disputed')`),
  ]);
  return {
    ...(questions == null ? {} : { unansweredQuestions: questions }),
    ...(reviews == null ? {} : { unansweredReviews: reviews }),
    ...(payouts == null ? {} : { payoutProblems: payouts }),
    ...(returns == null ? {} : { openReturns: returns }),
  };
}

// ------------------------------------------------------------ Home insights (VD1)

/** Presets, as days back from today (IST) for [from, to]. */
const INSIGHT_RANGES = { today: [0, 0], yesterday: [1, 1], '7d': [6, 0], '30d': [29, 0] };
const MAX_INSIGHT_DAYS = 366;

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const pctDelta = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : null);

/**
 * The shop's orders that really happened, with whether each is a sale.
 * Same rule as Admin → Analytics: free replacements never count, and an online
 * order only counts once paid — an unpaid one that timed out is not a sale
 * and not a cancellation the shop made either.
 * $1 = vendor id.
 */
const SHOP_ORDERS = `
  SELECT o.id, o.user_id, o.total_cents, o.created_at, o.status = 'cancelled' AS cancelled
  FROM orders o
  LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
  WHERE o.vendor_id = $1 AND o.replacement_of_order_id IS NULL
    AND (o.payment_method IN ('cod', 'credit') OR p.status IN ('successful', 'refunded', 'partially_refunded'))`;

/**
 * How the shop did over a range of days, against the range just before it.
 *
 * GET /api/vendor/insights?range=today|yesterday|7d|30d|custom[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 *
 * Days are Indian Standard Time. While the range includes today it is compared
 * with the previous range up to the same time of day, so a morning is never
 * measured against a whole day. The chart is by hour for one day, by day up to
 * 62 days, by month beyond.
 */
async function getInsights(req, res) {
  const vendorId = req.vendorId;
  const range = req.query.range || 'today';

  const { rows: t } = await pool.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today`);
  const today = t[0].today;

  let from;
  let to;
  if (range === 'custom') {
    ({ from, to } = req.query);
    if (!isDay(from) || !isDay(to)) return res.status(400).json({ message: 'from and to are dates like 2026-10-31' });
    if (from > to) return res.status(400).json({ message: 'from is after to' });
    if (from > today) return res.status(400).json({ message: 'from is in the future' });
    // A phone's "today" can be ahead of India's (another zone, or just past
    // midnight): stop at today rather than refuse.
    if (to > today) to = today;
    if (daysBetween(from, to) + 1 > MAX_INSIGHT_DAYS) return res.status(400).json({ message: `At most ${MAX_INSIGHT_DAYS} days` });
  } else if (INSIGHT_RANGES[range]) {
    from = addDays(today, -INSIGHT_RANGES[range][0]);
    to = addDays(today, -INSIGHT_RANGES[range][1]);
  } else {
    return res.status(400).json({ message: 'range is today, yesterday, 7d, 30d or custom' });
  }
  const days = daysBetween(from, to) + 1;
  const bucket = days === 1 ? 'hour' : days <= 62 ? 'day' : 'month';
  const bucketSql = { hour: 'hour', day: 'day', month: 'month' }[bucket];

  // [start, end) of the range and of the one before it; end stops at now.
  const W = `
    WITH w AS (
      SELECT ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AS s,
             LEAST((($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'), now()) AS e
    ), w2 AS (
      SELECT s, e, s - $4::int * interval '1 day' AS ps, e - $4::int * interval '1 day' AS pe FROM w
    )`;
  const args = [vendorId, from, to, days];

  const [totals, series, top] = await Promise.all([
    pool.query(
      `${W},
       o AS (${SHOP_ORDERS}),
       first_buy AS (SELECT user_id, MIN(created_at) AS at FROM o WHERE NOT cancelled GROUP BY user_id)
       SELECT
         COALESCE(SUM(o.total_cents) FILTER (WHERE NOT o.cancelled AND o.created_at >= w2.s AND o.created_at < w2.e), 0)::bigint AS sales,
         COUNT(*) FILTER (WHERE NOT o.cancelled AND o.created_at >= w2.s AND o.created_at < w2.e)::int AS orders,
         COUNT(*) FILTER (WHERE o.cancelled AND o.created_at >= w2.s AND o.created_at < w2.e)::int AS cancelled,
         COALESCE(SUM(o.total_cents) FILTER (WHERE NOT o.cancelled AND o.created_at >= w2.ps AND o.created_at < w2.pe), 0)::bigint AS p_sales,
         COUNT(*) FILTER (WHERE NOT o.cancelled AND o.created_at >= w2.ps AND o.created_at < w2.pe)::int AS p_orders,
         COUNT(*) FILTER (WHERE o.cancelled AND o.created_at >= w2.ps AND o.created_at < w2.pe)::int AS p_cancelled,
         (SELECT COUNT(*) FROM first_buy f WHERE f.at >= w2.s AND f.at < w2.e)::int AS new_customers,
         (SELECT COUNT(*) FROM first_buy f WHERE f.at >= w2.ps AND f.at < w2.pe)::int AS p_new_customers
       FROM w2 LEFT JOIN o ON o.created_at >= w2.ps AND o.created_at < w2.e
       GROUP BY w2.s, w2.e, w2.ps, w2.pe`,
      args
    ),
    pool.query(
      `${W},
       o AS (${SHOP_ORDERS}),
       first_buy AS (SELECT user_id, MIN(created_at) AS at FROM o WHERE NOT cancelled GROUP BY user_id),
       x AS (
         SELECT date_trunc('${bucketSql}', o.created_at AT TIME ZONE 'Asia/Kolkata') AS b,
                CASE WHEN o.cancelled THEN 0 ELSE o.total_cents END AS sales,
                CASE WHEN o.cancelled THEN 0 ELSE 1 END AS orders,
                CASE WHEN o.cancelled THEN 1 ELSE 0 END AS cancelled,
                0 AS new_customers
         FROM o, w2 WHERE o.created_at >= w2.s AND o.created_at < w2.e
         UNION ALL
         SELECT date_trunc('${bucketSql}', f.at AT TIME ZONE 'Asia/Kolkata'), 0, 0, 0, 1
         FROM first_buy f, w2 WHERE f.at >= w2.s AND f.at < w2.e
       )
       SELECT to_char(b, 'YYYY-MM-DD"T"HH24') AS b, SUM(sales)::bigint AS sales, SUM(orders)::int AS orders,
              SUM(cancelled)::int AS cancelled, SUM(new_customers)::int AS new_customers
       FROM x GROUP BY b`,
      args
    ),
    pool.query(
      `${W},
       o AS (${SHOP_ORDERS})
       SELECT oi.product_id, MAX(oi.product_name_snapshot) AS name,
              SUM(oi.quantity)::int AS quantity, SUM(oi.unit_price_cents * oi.quantity)::bigint AS revenue,
              (SELECT m.url FROM product_media m WHERE m.product_id = oi.product_id AND m.media_type = 'image'
                ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1) AS image_url
       FROM o JOIN order_items oi ON oi.order_id = o.id, w2
       WHERE NOT o.cancelled AND o.created_at >= w2.s AND o.created_at < w2.e
       GROUP BY oi.product_id
       ORDER BY revenue DESC, quantity DESC, oi.product_id
       LIMIT 5`,
      args
    ),
  ]);

  const r = totals.rows[0];
  const sales = Number(r.sales);
  const prevSales = Number(r.p_sales);
  const aov = r.orders ? Math.round(sales / r.orders) : 0;
  const prevAov = r.p_orders ? Math.round(prevSales / r.p_orders) : 0;

  // Every bucket of the range, zeros included, so the chart's x-axis is the range.
  const byKey = new Map(series.rows.map((s) => [s.b, s]));
  const keys = [];
  if (bucket === 'hour') {
    for (let h = 0; h < 24; h++) keys.push(`${from}T${String(h).padStart(2, '0')}`);
  } else if (bucket === 'day') {
    for (let i = 0; i < days; i++) keys.push(`${addDays(from, i)}T00`);
  } else {
    let [y, m] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      keys.push(`${y}-${String(m).padStart(2, '0')}-01T00`);
      m += 1;
      if (m > 12) (m = 1), (y += 1);
    }
  }

  res.json({
    range: { key: range, from, to, days, bucket, today: to === today },
    summary: {
      salesCents: sales,
      salesDeltaPercent: pctDelta(sales, prevSales),
      orders: r.orders,
      ordersDeltaPercent: pctDelta(r.orders, r.p_orders),
      aovCents: aov,
      aovDeltaPercent: pctDelta(aov, prevAov),
      cancelled: r.cancelled,
      cancelledDeltaPercent: pctDelta(r.cancelled, r.p_cancelled),
      newCustomers: r.new_customers,
      newCustomersDeltaPercent: pctDelta(r.new_customers, r.p_new_customers),
      previousSalesCents: prevSales,
    },
    series: keys.map((k) => {
      const s = byKey.get(k);
      return {
        at: k.slice(0, 13),
        salesCents: Number(s?.sales ?? 0),
        orders: s?.orders ?? 0,
        cancelled: s?.cancelled ?? 0,
        newCustomers: s?.new_customers ?? 0,
      };
    }),
    topProducts: top.rows.map((p) => ({
      productId: p.product_id,
      name: p.name,
      quantity: p.quantity,
      revenueCents: Number(p.revenue),
      imageUrl: p.image_url,
    })),
  });
}

// ------------------------------------------------------------ Pause & busy (VD2)

const MAX_PAUSE_MINUTES = 24 * 60;

/** Where the shop stands right now: open or not, why, and any busy time. */
async function readStatus(vendorId) {
  const { rows } = await pool.query(
    `SELECT shop_open_at(vp.id, now()) AS open_now, shop_hours_open_at(vp.id, now()) AS hours_open_now,
            shop_paused_at(vp.id, now()) AS paused_now, vp.paused_until, vp.pause_note,
            shop_busy_minutes(vp.id, now()) AS busy_now, vp.busy_until,
            COALESCE(dr.preparation_minutes, 30) AS preparation_minutes
     FROM vendor_profiles vp LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = vp.id
     WHERE vp.id = $1`,
    [vendorId]
  );
  const r = rows[0];
  return {
    openNow: r.open_now,
    // null: the shop never gave hours (then it counts as open unless paused).
    hoursOpenNow: r.hours_open_now,
    paused: r.paused_now,
    // null while paused means "until I reopen".
    pausedUntil: r.paused_now ? r.paused_until : null,
    pauseNote: r.paused_now ? r.pause_note : null,
    busy: r.busy_now > 0,
    busyExtraMinutes: r.busy_now,
    busyUntil: r.busy_now > 0 ? r.busy_until : null,
    preparationMinutes: r.preparation_minutes,
  };
}

/** GET /api/vendor/status */
async function getStatus(req, res) {
  res.json(await readStatus(req.vendorId));
}

/**
 * When a pause or busy spell ends, as SQL ($2 = minutes or null), or null for
 * a bad body. untilEndOfDay = midnight on the shop's own clock. Every form
 * mentions $2, so Postgres always knows its type.
 */
function endFrom(body, { required }) {
  if (body.untilEndOfDay === true) {
    return { sql: `(CASE WHEN $2::int IS NULL THEN (date_trunc('day', now() AT TIME ZONE vp.timezone) + interval '1 day') AT TIME ZONE vp.timezone END)`, minutes: null };
  }
  if (body.minutes === undefined || body.minutes === null) {
    return required ? null : { sql: '(CASE WHEN $2::int IS NOT NULL THEN now() END)', minutes: null };
  }
  const m = Number(body.minutes);
  if (!Number.isInteger(m) || m < 15 || m > MAX_PAUSE_MINUTES) return null;
  return { sql: `now() + $2::int * interval '1 minute'`, minutes: m };
}

/**
 * PUT /api/vendor/status
 *   { action: 'pause', minutes? | untilEndOfDay?, note? }   (neither = until reopened)
 *   { action: 'reopen' }
 *   { action: 'busy', extraMinutes, minutes | untilEndOfDay }
 *   { action: 'not_busy' }
 */
async function setStatus(req, res) {
  const body = req.body || {};
  const vendorId = req.vendorId;
  switch (body.action) {
    case 'pause': {
      const end = endFrom(body, { required: false });
      if (!end) return res.status(400).json({ message: `minutes is 15–${MAX_PAUSE_MINUTES}, or send untilEndOfDay` });
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 80) || null : null;
      await pool.query(
        `UPDATE vendor_profiles vp SET paused = true, paused_until = ${end.sql}, pause_note = $3 WHERE vp.id = $1`,
        [vendorId, end.minutes, note]
      );
      break;
    }
    case 'reopen':
      await pool.query(`UPDATE vendor_profiles SET paused = false, paused_until = NULL, pause_note = NULL WHERE id = $1`, [vendorId]);
      break;
    case 'busy': {
      const extra = Number(body.extraMinutes);
      if (!Number.isInteger(extra) || extra < 5 || extra > 180) return res.status(400).json({ message: 'extraMinutes is 5–180' });
      // Busy always ends by itself, so a forgotten switch can't slow the shop for days.
      const end = endFrom(body, { required: true });
      if (!end) return res.status(400).json({ message: `Say how long: minutes 15–${MAX_PAUSE_MINUTES}, or untilEndOfDay` });
      await pool.query(
        `UPDATE vendor_profiles vp SET busy_until = ${end.sql}, busy_extra_minutes = $3 WHERE vp.id = $1`,
        [vendorId, end.minutes, extra]
      );
      break;
    }
    case 'not_busy':
      await pool.query(`UPDATE vendor_profiles SET busy_until = NULL, busy_extra_minutes = 0 WHERE id = $1`, [vendorId]);
      break;
    default:
      return res.status(400).json({ message: 'action is pause, reopen, busy or not_busy' });
  }
  res.json(await readStatus(vendorId));
}

// ------------------------------------------------------------ Product stats (VD13)

/**
 * GET /api/vendor/products/stats?days=7|30|90 — per product over the last
 * days (IST): views and add-to-carts from the app's events, and real sales
 * (same "counted" rule as insights). conversion = orders ÷ sessions that
 * viewed it; null when nobody viewed it.
 */
async function productStats(req, res) {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const { rows } = await pool.query(
    `WITH w AS (
       SELECT ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - ($2::int - 1) * interval '1 day') AT TIME ZONE 'Asia/Kolkata') AS s
     ),
     ev AS (
       SELECT e.product_id,
              COUNT(*) FILTER (WHERE e.event = 'product_view')::int AS views,
              COUNT(DISTINCT e.session_id) FILTER (WHERE e.event = 'product_view')::int AS viewers,
              COUNT(*) FILTER (WHERE e.event = 'add_to_cart')::int AS carts
       FROM analytics_events e JOIN products p ON p.id = e.product_id, w
       WHERE p.vendor_id = $1 AND e.occurred_at >= w.s
       GROUP BY e.product_id
     ),
     o AS (${SHOP_ORDERS}),
     sold AS (
       SELECT oi.product_id, COUNT(DISTINCT o.id)::int AS orders, SUM(oi.quantity)::int AS units,
              SUM(oi.unit_price_cents * oi.quantity)::bigint AS revenue
       FROM o JOIN order_items oi ON oi.order_id = o.id, w
       WHERE NOT o.cancelled AND o.created_at >= w.s
       GROUP BY oi.product_id
     )
     SELECT p.id, p.name, p.image_url, p.is_active,
            COALESCE(ev.views, 0) AS views, COALESCE(ev.viewers, 0) AS viewers, COALESCE(ev.carts, 0) AS carts,
            COALESCE(sold.orders, 0) AS orders, COALESCE(sold.units, 0) AS units, COALESCE(sold.revenue, 0) AS revenue
     FROM products p
     LEFT JOIN ev ON ev.product_id = p.id
     LEFT JOIN sold ON sold.product_id = p.id
     WHERE p.vendor_id = $1
     ORDER BY COALESCE(sold.revenue, 0) DESC, COALESCE(ev.views, 0) DESC, p.name`,
    [req.vendorId, days]
  );
  res.json({
    days,
    items: rows.map((r) => ({
      productId: r.id,
      name: r.name,
      imageUrl: r.image_url,
      isActive: r.is_active,
      views: r.views,
      addToCarts: r.carts,
      orders: r.orders,
      units: r.units,
      revenueCents: Number(r.revenue),
      conversionPercent: r.viewers > 0 ? Math.round((r.orders / r.viewers) * 1000) / 10 : null,
    })),
  });
}

// ------------------------------------------------------------ Order documents (VD7)

const orderDocuments = require('../services/orderDocuments');

/**
 * POST /api/vendor/orders/:id/documents { kind: invoice | packing-slip | label }
 * → { path, expiresInMinutes }: a short-lived link to the printable page, for
 * the shop's own order only. The app opens API base + path in the browser.
 */
async function documentLink(req, res) {
  const orderId = Number(req.params.id);
  const kind = req.body?.kind;
  if (!Number.isInteger(orderId)) return res.status(404).json({ message: 'Order not found' });
  if (!orderDocuments.KINDS.includes(kind)) return res.status(400).json({ message: `kind is ${orderDocuments.KINDS.join(', ')}` });
  const { rows } = await pool.query('SELECT 1 FROM orders WHERE id = $1 AND vendor_id = $2', [orderId, req.vendorId]);
  if (!rows[0]) return res.status(404).json({ message: 'Order not found' });
  const token = orderDocuments.linkToken(orderId, req.vendorId, kind);
  res.json({ path: `/api/orders/documents/${token}`, expiresInMinutes: orderDocuments.LINK_MINUTES });
}

/** GET /api/orders/documents/:token — the page itself (no login: the link is the key). */
async function documentPage(req, res) {
  const t = orderDocuments.readToken(req.params.token);
  const html = t ? await orderDocuments.render(t.kind, t.orderId, t.vendorId) : null;
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.set('Referrer-Policy', 'no-referrer');
  if (!html) {
    return res
      .status(t ? 404 : 410)
      .type('html')
      .send('<!DOCTYPE html><meta charset="utf-8"><p style="font-family:sans-serif">This link has expired. Open the document again from the Gloaro Mart app.</p>');
  }
  res.type('html').send(html);
}

/**
 * The attribute definitions a vendor may build variants from.
 *
 * Read-only on purpose. A shop inventing its own 'Size' would fragment the
 * filter facets every other shop shares, so attributes stay platform-owned.
 */
async function listAttributes(req, res) {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.code, a.input_type, a.is_variant_defining, c.name AS category_name,
            a.is_filter, a.filter_kind, a.unit, a.subcategories,
            COALESCE(
              json_agg(json_build_object('id', av.id, 'value', av.value, 'colorHex', av.color_hex)
                       ORDER BY av.sort_order, av.id)
              FILTER (WHERE av.id IS NOT NULL),
              '[]'
            ) AS values
     FROM product_attributes a
     LEFT JOIN categories c ON c.id = a.category_id
     LEFT JOIN attribute_values av ON av.attribute_id = a.id
     WHERE a.is_active = true
       AND ($1::text IS NULL OR c.name = $1 OR a.category_id IS NULL)
     GROUP BY a.id, c.name
     ORDER BY a.sort_order ASC, a.id ASC`,
    [req.query.category || null]
  );
  res.json(rows);
}

module.exports = { getDashboard, getInsights, getStatus, setStatus, productStats, documentLink, documentPage, listAttributes };
