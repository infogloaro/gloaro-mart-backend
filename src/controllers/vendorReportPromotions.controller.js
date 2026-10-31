const pool = require('../config/db');

/**
 * VD22: did the shop's offers and ads pay off, over a range of days (India time)?
 *
 * GET /api/vendor/reports/promotions?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Offers: counted sales (not cancelled, not a free replacement, COD / credit
 * or paid online) that used a coupon, or got a campaign discount — orders,
 * sales and the discount given. Ads: each of the shop's ad campaigns with
 * activity in the range — views, taps, enquiries, orders and order value from
 * the daily ad stats; what the ad cost (its price, for the whole campaign)
 * and the commission charged on orders in these days.
 */

const MAX_DAYS = 366;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const COUNTED = `
  SELECT o.* FROM orders o
  LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
  WHERE o.vendor_id = $1 AND o.status <> 'cancelled' AND o.replacement_of_order_id IS NULL
    AND (o.payment_method IN ('cod', 'credit') OR p.status IN ('successful', 'refunded', 'partially_refunded'))
    AND o.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;

async function promotionsReport(req, res) {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to)) return res.status(400).json({ message: 'from and to are dates like 2026-10-31' });
  if (from > to) return res.status(400).json({ message: 'from is after to' });
  if (daysBetween(from, to) + 1 > MAX_DAYS) return res.status(400).json({ message: `At most ${MAX_DAYS} days` });
  const args = [req.vendorId, from, to];

  const [totals, coupons, ads] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_cents), 0)::bigint AS sales,
              COUNT(*) FILTER (WHERE coupon_code_snapshot IS NOT NULL OR campaign_discount_cents > 0)::int AS offer_orders,
              COALESCE(SUM(total_cents) FILTER (WHERE coupon_code_snapshot IS NOT NULL OR campaign_discount_cents > 0), 0)::bigint AS offer_sales,
              COALESCE(SUM(discount_cents) FILTER (WHERE coupon_code_snapshot IS NOT NULL), 0)::bigint AS coupon_discount,
              COUNT(*) FILTER (WHERE campaign_discount_cents > 0)::int AS campaign_orders,
              COALESCE(SUM(total_cents) FILTER (WHERE campaign_discount_cents > 0), 0)::bigint AS campaign_sales,
              COALESCE(SUM(campaign_discount_cents), 0)::bigint AS campaign_discount
       FROM (${COUNTED}) c`,
      args
    ),
    pool.query(
      `SELECT upper(coupon_code_snapshot) AS code, COUNT(*)::int AS orders, SUM(total_cents)::bigint AS sales, SUM(discount_cents)::bigint AS discount
       FROM (${COUNTED}) c WHERE coupon_code_snapshot IS NOT NULL
       GROUP BY 1 ORDER BY sales DESC, code`,
      args
    ),
    pool.query(
      `SELECT a.id, a.reference, a.title, a.status, a.starts_at, a.ends_at, a.total_cents, a.payment_status,
              SUM(s.impressions)::int AS views, SUM(s.clicks)::int AS taps, SUM(s.enquiries)::int AS enquiries,
              SUM(s.orders)::int AS orders, SUM(s.order_value_cents)::bigint AS order_value, SUM(s.commission_cents)::bigint AS commission
       FROM ad_campaigns a JOIN ad_stats_daily s ON s.campaign_id = a.id
       WHERE a.vendor_id = $1 AND s.day BETWEEN $2::date AND $3::date
       GROUP BY a.id ORDER BY SUM(s.order_value_cents) DESC, SUM(s.clicks) DESC, a.id`,
      args
    ),
  ]);

  const t = totals.rows[0];
  const adRows = ads.rows.map((a) => ({
    campaignId: a.id,
    reference: a.reference,
    title: a.title,
    status: a.status,
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    // The ad's price covers the whole campaign, not just these days.
    priceCents: ['paid', 'partially_refunded'].includes(a.payment_status) ? a.total_cents : 0,
    views: a.views,
    taps: a.taps,
    tapRatePercent: pct(a.taps, a.views),
    enquiries: a.enquiries,
    orders: a.orders,
    orderValueCents: Number(a.order_value),
    commissionCents: Number(a.commission),
  }));
  const sum = (k) => adRows.reduce((s, r) => s + r[k], 0);
  res.json({
    from,
    to,
    offers: {
      orders: t.orders,
      salesCents: Number(t.sales),
      offerOrders: t.offer_orders,
      offerSalesCents: Number(t.offer_sales),
      offerSharePercent: pct(t.offer_orders, t.orders),
      couponDiscountCents: Number(t.coupon_discount),
      campaign: { orders: t.campaign_orders, salesCents: Number(t.campaign_sales), discountCents: Number(t.campaign_discount) },
      coupons: coupons.rows.map((c) => ({ code: c.code, orders: c.orders, salesCents: Number(c.sales), discountCents: Number(c.discount) })),
    },
    ads: {
      views: sum('views'),
      taps: sum('taps'),
      tapRatePercent: pct(sum('taps'), sum('views')),
      enquiries: sum('enquiries'),
      orders: sum('orders'),
      orderValueCents: sum('orderValueCents'),
      commissionCents: sum('commissionCents'),
      campaigns: adRows,
    },
  });
}

module.exports = { promotionsReport };
