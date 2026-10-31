const pool = require('../config/db');
const settlements = require('../services/settlements');

/**
 * "Your plan & fees" for the shop (VD26): what Gloaro Mart keeps, read from the
 * real settings only — commission plans, the settlement config (TDS / TCS and
 * the weekly cycle) and the ad price list.
 *
 * GET /api/vendor/plan
 *
 * Every amount is worked out by the settlement service itself (commissionFor,
 * grossFor), so this page can't disagree with what a payout takes.
 */

const EXAMPLE_CENTS = 100000; // ₹1,000

/**
 * A client for settlements.commissionFor() on an order that doesn't exist:
 * the order's lines come from [items], every other query (the commission plans)
 * goes to the database as usual.
 */
function previewClient(items) {
  return {
    query: (sql, params) => (/FROM order_items/.test(sql) ? Promise.resolve({ rows: items }) : pool.query(sql, params)),
  };
}

/** What commissionFor() takes on one order of this shop with these lines. */
function commissionOn(vendorId, items) {
  const order = { id: null, vendor_id: vendorId, replacement_of_order_id: null };
  return settlements.commissionFor(previewClient(items.map((i) => ({ value: i.value, category: i.category }))), order);
}

async function getPlan(req, res) {
  const vendorId = req.vendorId;
  const [{ rows: plans }, { rows: cfgRows }, { rows: cats }, { rows: cycle }, { rows: lag }, { rows: adSet }, { rows: packages }, { rows: packs }] = await Promise.all([
    pool.query(
      `SELECT p.scope, p.vendor_id, c.name AS category, p.commission_percent::float AS pct, p.flat_fee_cents
       FROM commission_plans p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active AND (p.scope = 'global' OR (p.scope = 'vendor' AND p.vendor_id = $1) OR p.scope = 'category')`,
      [vendorId]
    ),
    pool.query('SELECT tds_percent::float AS tds, tcs_percent::float AS tcs FROM settlement_config WHERE id = 1'),
    // The categories this shop sells in, most products first.
    pool.query(
      `SELECT MIN(TRIM(category)) AS category, COUNT(*)::int AS products FROM products
       WHERE vendor_id = $1 AND NULLIF(TRIM(category), '') IS NOT NULL
       GROUP BY LOWER(TRIM(category)) ORDER BY products DESC, 1`,
      [vendorId]
    ),
    pool.query(
      `SELECT to_char(w, 'YYYY-MM-DD') AS start, to_char(w + 6, 'YYYY-MM-DD') AS end, to_char(w + 7, 'YYYY-MM-DD') AS settles_on
       FROM (SELECT date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata')::date AS w) x`
    ),
    // How long payouts have taken lately (same measure as the wallet's next payout).
    pool.query(
      `SELECT COUNT(*)::int AS n,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY (paid_at AT TIME ZONE 'Asia/Kolkata')::date - period_end) AS days
       FROM settlements WHERE status = 'paid' AND paid_at > now() - interval '120 days'`
    ),
    pool.query('SELECT * FROM ad_settings WHERE id = 1'),
    pool.query(
      `SELECT p.id, p.name, p.tier, p.description, p.level, l.label AS level_label, p.hours, p.price_cents
       FROM ad_packages p LEFT JOIN ad_levels l ON l.key = p.level WHERE p.active ORDER BY p.sort_order, p.price_cents`
    ),
    // The cheapest way in at each reach: its shortest active pack.
    pool.query(
      `SELECT DISTINCT ON (l.key) l.key AS level, l.label, l.sort_order, r.hours, r.price_cents
       FROM ad_levels l JOIN ad_rate_packs r ON r.level = l.key AND r.active
       WHERE l.active ORDER BY l.key, r.hours, r.price_cents`
    ),
  ]);
  const cfg = cfgRows[0] ?? { tds: 0, tcs: 0 };

  const own = plans.find((p) => p.scope === 'vendor') ?? null;
  const global = plans.find((p) => p.scope === 'global') ?? null;
  const byCategory = new Map(plans.filter((p) => p.scope === 'category' && p.category).map((p) => [p.category.toLowerCase(), p]));

  // The flat fee: commission on an order with no lines is the fee alone.
  const flatFeeCents = await commissionOn(vendorId, []);
  // The rate on each category this shop sells in, by the same rule.
  const categories = [];
  for (const c of cats) {
    const cents = (await commissionOn(vendorId, [{ value: EXAMPLE_CENTS, category: c.category }])) - flatFeeCents;
    const source = own ? 'shop' : byCategory.has(c.category.toLowerCase()) ? 'category' : global ? 'standard' : 'none';
    categories.push({ category: c.category, products: c.products, percent: (cents * 100) / EXAMPLE_CENTS, source });
  }
  const otherCents = (await commissionOn(vendorId, [{ value: EXAMPLE_CENTS, category: null }])) - flatFeeCents;

  // A ₹1,000 order in the shop's main category, paid, no GST, delivery fee or discount.
  const main = cats[0]?.category ?? null;
  const exampleOrder = {
    id: null, vendor_id: vendorId, coupon_id: null, replacement_of_order_id: null,
    total_cents: EXAMPLE_CENTS, subtotal_cents: EXAMPLE_CENTS, discount_cents: 0, campaign_discount_cents: 0,
    points_discount_cents: 0, platform_paid_cents: 0,
  };
  const gross = await settlements.grossFor(pool, exampleOrder);
  const commission = await commissionOn(vendorId, [{ value: EXAMPLE_CENTS, category: main }]);
  // TDS on gross, TCS on the taxable value — as generateDueSettlements() withholds them.
  const tds = Math.round((gross * cfg.tds) / 100);
  const tcs = Math.round((exampleOrder.subtotal_cents * cfg.tcs) / 100);

  const s = adSet[0];
  const days = lag[0].n > 0 ? Number(lag[0].days) : null;
  res.json({
    commission: {
      source: own ? 'shop' : global ? 'standard' : 'none',
      shopPercent: own ? own.pct : null,
      standardPercent: global ? global.pct : null,
      otherCategoriesPercent: (otherCents * 100) / EXAMPLE_CENTS,
      flatFeeCents,
      categories,
    },
    taxes: { tdsPercent: cfg.tds, tcsPercent: cfg.tcs },
    // The platform takes no payment-gateway or cash-on-delivery fee from shops:
    // a payout starts from what the customer paid (grossFor), nothing else is taken.
    paymentFees: { gatewayCents: 0, codCents: 0 },
    cycle: {
      kind: 'weekly',
      start: cycle[0].start,
      end: cycle[0].end,
      settlesOn: cycle[0].settles_on,
      typicalPayoutDays: days,
      basedOnPayouts: lag[0].n,
    },
    example: {
      category: main,
      orderCents: EXAMPLE_CENTS,
      grossCents: gross,
      commissionCents: commission,
      tdsCents: tds,
      tcsCents: tcs,
      netCents: gross - commission - tds - tcs,
    },
    ads: s
      ? {
          models: { fixed: s.model_fixed, commission: s.model_commission, fixedCommission: s.model_fixed_commission, package: s.model_package },
          commissionPercent: Number(s.commission_percent),
          fixedCommissionPercent: Number(s.fixed_commission_percent),
          attributionDays: s.attribution_days,
          taxPercent: Number(s.tax_percent),
          taxLabel: s.tax_label,
          minChargeCents: s.min_charge_cents,
          cancellationFeePercent: Number(s.cancellation_fee_percent),
          packages: s.model_package
            ? packages.map((p) => ({ id: p.id, name: p.name, tier: p.tier, description: p.description, level: p.level, levelLabel: p.level_label ?? p.level, hours: p.hours, priceCents: p.price_cents }))
            : [],
          from: s.model_fixed || s.model_fixed_commission
            ? packs.sort((a, b) => a.sort_order - b.sort_order).map((r) => ({ level: r.level, label: r.label, hours: r.hours, priceCents: r.price_cents }))
            : [],
        }
      : null,
  });
}

module.exports = { getPlan };
