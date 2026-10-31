const pool = require('../config/db');
const { performanceScore, ratingScore } = require('../services/matching');

/**
 * VD29: the shop's health — how it does on what decides how often it is
 * picked for orders, and what it can fix today.
 *
 * GET /api/vendor/health
 *
 * Reliability uses the matching engine's own formula (acceptance and
 * cancellation, without the busy-right-now tiebreak) and rating its own
 * rating score, from the same running totals the engine reads. Setup is
 * eight checks the shop controls. Score = 60 % reliability (or setup alone
 * before the first order), 20 % rating, 20 % setup.
 */
async function healthFor(vendorId) {
  const [{ rows: m }, { rows: s }] = await Promise.all([
    pool.query('SELECT * FROM vendor_performance_metrics WHERE vendor_id = $1', [vendorId]),
    pool.query(
      `SELECT vp.status, vp.kyc_submitted_at IS NOT NULL AS kyc_sent,
              (vp.logo_url IS NOT NULL OR vp.cover_image_url IS NOT NULL) AS has_picture,
              EXISTS (SELECT 1 FROM vendor_bank_accounts b WHERE b.vendor_id = vp.id) AS has_bank,
              (EXISTS (SELECT 1 FROM vendor_hours h WHERE h.vendor_id = vp.id)
                OR EXISTS (SELECT 1 FROM vendor_delivery_rules dr WHERE dr.vendor_id = vp.id AND dr.opens_at IS NOT NULL)) AS has_hours,
              (SELECT COUNT(*) FROM products p WHERE p.vendor_id = vp.id AND p.is_active)::int AS products,
              (SELECT COUNT(*) FROM products p WHERE p.vendor_id = vp.id AND p.is_active AND COALESCE(trim(p.image_url), '') <> '')::int AS with_photo,
              (SELECT COUNT(*) FROM products p WHERE p.vendor_id = vp.id AND p.is_active AND COALESCE(trim(p.hsn_code), '') <> '')::int AS with_hsn,
              (SELECT COUNT(*) FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.vendor_id = vp.id AND p.is_active)::int AS stock_rows,
              (SELECT COUNT(*) FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.vendor_id = vp.id AND p.is_active AND i.low_stock_threshold > 0)::int AS with_alert,
              (SELECT COUNT(*) FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.vendor_id = vp.id AND p.is_active AND i.available_qty = 0)::int AS out_of_stock
       FROM vendor_profiles vp WHERE vp.id = $1`,
      [vendorId]
    ),
  ]);
  const metrics = m[0] || null;
  const x = s[0];
  const share = (part, whole) => (whole > 0 ? part / whole : 0);

  const checks = [
    { key: 'documents', label: 'Registration documents sent', done: x.kyc_sent, fix: 'Send your ID and shop photo (Shop → documents).' },
    { key: 'bank', label: 'Bank account added', done: x.has_bank, fix: 'Add a bank account in Payouts so Gloaro Mart can pay you.' },
    { key: 'hours', label: 'Opening hours set', done: x.has_hours, fix: 'Set your hours so customers know when you deliver.' },
    { key: 'picture', label: 'Shop logo or cover photo', done: x.has_picture, fix: 'Add a logo or a photo of your shop front.' },
    { key: 'photos', label: 'Every product has a photo', done: x.products > 0 && x.with_photo === x.products, fix: `${x.products - x.with_photo} products have no photo.` },
    { key: 'hsn', label: 'HSN codes on products', done: x.products > 0 && x.with_hsn === x.products, fix: `${x.products - x.with_hsn} products have no HSN code — needed on GST invoices.` },
    { key: 'alerts', label: 'Low-stock alert levels set', done: x.stock_rows > 0 && x.with_alert === x.stock_rows, fix: `${x.stock_rows - x.with_alert} items have no alert level, so you aren't told when they run low.` },
    { key: 'stock', label: 'Nothing out of stock', done: x.stock_rows > 0 && x.out_of_stock === 0, fix: `${x.out_of_stock} items are out of stock — restock or hide them.` },
  ];
  const setup = share(checks.filter((c) => c.done).length, checks.length);

  const ordersTotal = metrics?.orders_total ?? 0;
  // The engine's performance score with no workload tiebreak, rescaled to 0–1.
  const reliability = ordersTotal ? performanceScore(metrics, 0) / 0.8 : null;
  const rated = metrics?.rating_count > 0;
  const rating = rated ? ratingScore(metrics) : null;
  const score = Math.round(
    100 * ((reliability ?? setup) * 0.6 + (rating ?? (reliability ?? setup)) * 0.2 + setup * 0.2)
  );

  return {
    score,
    // Before the first order the score is the setup alone.
    basedOnOrders: ordersTotal > 0,
    orders: {
      total: ordersTotal,
      accepted: metrics?.orders_accepted ?? 0,
      rejected: metrics?.orders_rejected ?? 0,
      cancelled: metrics?.orders_cancelled ?? 0,
      delivered: metrics?.orders_delivered ?? 0,
      acceptancePercent: ordersTotal ? Math.round((metrics.orders_accepted / ordersTotal) * 1000) / 10 : null,
      cancellationPercent: ordersTotal ? Math.round((metrics.orders_cancelled / ordersTotal) * 1000) / 10 : null,
      averageFulfilmentMinutes: metrics?.orders_delivered ? Math.round(Number(metrics.fulfilment_minutes_total) / metrics.orders_delivered) : null,
    },
    rating: rated ? { average: Math.round((Number(metrics.rating_sum) / metrics.rating_count) * 10) / 10, count: metrics.rating_count } : null,
    reliabilityPercent: reliability == null ? null : Math.round(reliability * 100),
    setupDone: checks.filter((c) => c.done).length,
    checks: checks.map((c) => ({ key: c.key, label: c.label, done: c.done, fix: c.done ? null : c.fix })),
  };
}

async function getHealth(req, res) {
  res.json(await healthFor(req.vendorId));
}

module.exports = { getHealth, healthFor };
