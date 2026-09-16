const pool = require('../config/db');
const { findOwnedAddress } = require('./address.controller');
const {
  STRATEGIES,
  loadWeights,
  rank,
  findCandidates,
  logMatch,
} = require('../services/matching');

/**
 * Who else can sell this, and which of them is best.
 * Contracts per documents/SPRINT_5_VENDOR_MATCHING_SPEC.md §4 and §8.
 *
 * These endpoints inform a decision the customer has not made yet. Nothing here
 * changes an order — checkout still sends the order to the shop the customer
 * chose, which is the rule the whole sprint is written around.
 */

/** Trims a scored candidate down to what the app actually renders. */
function toJson(c) {
  return {
    vendorId: c.vendorId,
    businessName: c.businessName,
    productId: c.productId,
    productName: c.productName,
    imageUrl: c.imageUrl,
    unitPriceCents: c.unitPriceCents,
    lineTotalCents: c.lineTotalCents,
    quantity: c.quantity,
    availableQty: c.availableQty,
    deliverable: c.deliverable,
    reason: c.reason ?? null,
    serviceabilityChecked: c.serviceabilityChecked,
    distanceKm: c.distanceKm,
    etaMinutes: c.etaMinutes,
    deliveryMethods: c.deliveryMethods,
    deliveryChargeCents: c.deliveryChargeCents,
    ratingAvg: c.ratingAvg,
    acceptanceRate: c.acceptanceRate,
    score: c.score,
    scores: c.scores,
  };
}

/**
 * Ranked shops for a basket of items, one ranking per item.
 *
 * Deliberately per-item rather than per-basket: two products rarely have the
 * same set of alternative shops, and collapsing them would offer the customer a
 * vendor that can only fill half the order.
 */
async function rankVendors(req, res) {
  const { addressId, items, strategy = 'recommended' } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items is required' });
  }
  if (!STRATEGIES.includes(strategy)) {
    return res.status(400).json({ message: `strategy must be one of ${STRATEGIES.join(', ')}` });
  }

  let address = null;
  if (addressId) {
    address = await findOwnedAddress(req.user.id, addressId);
    if (!address) return res.status(404).json({ message: 'Address not found' });
  }

  const weights = await loadWeights();
  const results = [];
  for (const item of items) {
    const quantity = Number(item.quantity) || 1;
    let found;
    try {
      found = await findCandidates({ productId: item.productId, quantity, address });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ message: err.message });
      throw err;
    }

    const ranked = rank(found.candidates, weights, strategy);
    await logMatch(pool, {
      userId: req.user.id,
      addressId: address?.id ?? null,
      context: 'browse',
      strategy,
      seed: found.seed,
      quantity,
      candidates: ranked,
      weights,
    });

    results.push({
      productId: found.seed.id,
      productName: found.seed.name,
      quantity,
      candidates: ranked.map(toJson),
    });
  }

  res.json({ strategy, items: results });
}

/**
 * The other shops selling one product. Public, so the product screen can show
 * "also available at" before anyone signs in.
 */
async function alternatives(req, res) {
  const quantity = Number(req.query.quantity) || 1;
  const strategy = req.query.strategy || 'recommended';
  if (!STRATEGIES.includes(strategy)) {
    return res.status(400).json({ message: `strategy must be one of ${STRATEGIES.join(', ')}` });
  }

  // An address is only usable when we know whose it is; an anonymous caller
  // gets an unjudged list rather than a serviceability check against nothing.
  let address = null;
  if (req.query.addressId && req.user) {
    address = await findOwnedAddress(req.user.id, req.query.addressId);
    if (!address) return res.status(404).json({ message: 'Address not found' });
  }

  let found;
  try {
    found = await findCandidates({
      productId: req.params.productId,
      quantity,
      address,
      excludeSeedVendor: req.query.includeSelf !== 'true',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }

  const weights = await loadWeights();
  const ranked = rank(found.candidates, weights, strategy);

  res.json({
    productId: found.seed.id,
    productName: found.seed.name,
    matchKey: found.seed.match_key,
    strategy,
    quantity,
    candidates: ranked.map(toJson),
  });
}

// ── Admin ──

async function getWeights(req, res) {
  res.json(await loadWeights());
}

async function updateWeights(req, res) {
  const body = req.body || {};
  const fields = {
    stockWeight: 'stock_weight',
    distanceWeight: 'distance_weight',
    deliveryWeight: 'delivery_weight',
    priceWeight: 'price_weight',
    ratingWeight: 'rating_weight',
    performanceWeight: 'performance_weight',
    reassignPriceTolerancePercent: 'reassign_price_tolerance_percent',
  };

  const assignments = [];
  const params = [];
  for (const [key, column] of Object.entries(fields)) {
    if (!(key in body)) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ message: `${key} must be a number of zero or more` });
    }
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  }
  if (assignments.length === 0) {
    return res.status(400).json({ message: 'No weights supplied' });
  }

  const { rows } = await pool.query(
    `UPDATE vendor_matching_weights SET ${assignments.join(', ')}, updated_at = now()
     WHERE id = 1 RETURNING *`,
    params
  );
  res.json(rows[0]);
}

async function listLogs(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const conditions = [];
  const params = [];
  if (req.query.context) {
    params.push(req.query.context);
    conditions.push(`l.context = $${params.length}`);
  }
  if (req.query.productId) {
    params.push(Number(req.query.productId));
    conditions.push(`l.product_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM vendor_matching_logs l ${where}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT l.*, u.full_name AS customer_name, vp.business_name AS selected_vendor_name
     FROM vendor_matching_logs l
     LEFT JOIN users u ON u.id = l.user_id
     LEFT JOIN vendor_profiles vp ON vp.id = l.selected_vendor_id
     ${where}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]
  );

  res.json({ items: rows, total: countRows[0].total, page, pageSize });
}

// The rate expressions are identical for the list and the single-vendor read, so
// they live here rather than being kept in step by hand in two places.
const PERFORMANCE_RATES = `
  CASE WHEN m.orders_total > 0 THEN m.orders_accepted::float / m.orders_total END AS acceptance_rate,
  CASE WHEN m.orders_total > 0 THEN m.orders_rejected::float / m.orders_total END AS rejection_rate,
  CASE WHEN m.orders_total > 0 THEN m.orders_cancelled::float / m.orders_total END AS cancellation_rate,
  CASE WHEN m.orders_delivered > 0 THEN m.fulfilment_minutes_total::float / m.orders_delivered END
    AS avg_fulfilment_minutes,
  -- ::float matters: rating_sum is NUMERIC, and pg hands NUMERIC back as a
  -- string, so an uncast division would reach the client as "4.5000000000000000"
  -- and break any caller doing arithmetic on it. The other rates already cast.
  CASE WHEN m.rating_count > 0 THEN m.rating_sum::float / m.rating_count END AS rating_avg`;

/**
 * Every vendor's scorecard in one read, for the admin performance table.
 *
 * LEFT JOIN from vendor_profiles, not from the metrics table: a vendor that has
 * never been matched has no metrics row at all, and inner-joining would drop it
 * from the list entirely — the admin would see a shorter roster than Vendors
 * shows and read it as missing data. COALESCE gives those vendors honest zeros.
 */
async function listVendorPerformance(req, res) {
  const { rows } = await pool.query(
    `SELECT vp.id AS vendor_id, vp.business_name, vp.status,
            COALESCE(m.orders_total, 0) AS orders_total,
            COALESCE(m.orders_accepted, 0) AS orders_accepted,
            COALESCE(m.orders_rejected, 0) AS orders_rejected,
            COALESCE(m.orders_cancelled, 0) AS orders_cancelled,
            COALESCE(m.orders_delivered, 0) AS orders_delivered,
            COALESCE(m.open_orders, 0) AS open_orders,
            COALESCE(m.rating_count, 0) AS rating_count,
            m.updated_at,
            ${PERFORMANCE_RATES}
     FROM vendor_profiles vp
     LEFT JOIN vendor_performance_metrics m ON m.vendor_id = vp.id
     ORDER BY COALESCE(m.orders_total, 0) DESC, vp.business_name ASC`
  );
  res.json(rows);
}

/** Counters plus the rates derived from them — the rates are never stored. */
async function getVendorPerformance(req, res) {
  const { rows } = await pool.query(
    `SELECT m.*, vp.business_name,
            ${PERFORMANCE_RATES}
     FROM vendor_performance_metrics m
     JOIN vendor_profiles vp ON vp.id = m.vendor_id
     WHERE m.vendor_id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'No performance record for that vendor' });
  res.json(rows[0]);
}

module.exports = {
  rankVendors,
  alternatives,
  getWeights,
  updateWeights,
  listLogs,
  listVendorPerformance,
  getVendorPerformance,
};
