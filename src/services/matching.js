/**
 * The vendor matching engine.
 *
 * Contracts per documents/SPRINT_5_VENDOR_MATCHING_SPEC.md.
 *
 * Given a product and a delivery address, this finds every shop selling the
 * same thing, works out which of them can actually serve the address, and ranks
 * what is left.
 *
 * Two ideas hold it together:
 *
 *   Equivalence is derived, not declared. products.match_key is a generated
 *   column, so "the same thing at another shop" is an index lookup rather than
 *   a master catalogue nobody maintains.
 *
 *   Every sub-score is normalised within the candidate set, so the score
 *   answers "which of these shops" rather than "how good is this shop" in the
 *   abstract. A lone candidate scores full marks on every relative axis, which
 *   is correct — there is nothing for it to be worse than.
 */
const pool = require('../config/db');
const { evaluateVendor, DEFAULT_RULES } = require('../controllers/serviceability.controller');

const STRATEGIES = ['recommended', 'fastest', 'cheapest', 'nearest', 'best_rated', 'pickup'];

/** A vendor with nothing on record is unknown, not bad. See §3 of the spec. */
const NEUTRAL = 0.5;

/** Full marks once a shop holds three times what the customer asked for. */
const STOCK_COVER_TARGET = 3;

async function loadWeights(client = pool) {
  const { rows } = await client.query('SELECT * FROM vendor_matching_weights WHERE id = 1');
  return rows[0];
}

/**
 * Turns a column of raw values into a 0..1 scorer.
 *
 * Nulls score neutral rather than worst: a shop that has never been rated and a
 * shop rated one star are not the same thing, and treating them alike would
 * mean no new vendor could ever earn its first order.
 */
function normaliser(values, { lowerIsBetter }) {
  const known = values.filter((v) => v != null && Number.isFinite(v));
  if (known.length === 0) return () => NEUTRAL;

  const min = Math.min(...known);
  const max = Math.max(...known);
  // Every candidate is equal on this axis, so none of them loses ground on it.
  if (max === min) return (v) => (v == null || !Number.isFinite(v) ? NEUTRAL : 1);

  return (v) => {
    if (v == null || !Number.isFinite(v)) return NEUTRAL;
    // Clamped because the scale is built from the deliverable candidates only;
    // a shop outside it still gets a score, it just cannot go past the ends.
    const position = Math.max(0, Math.min((v - min) / (max - min), 1));
    return lowerIsBetter ? 1 - position : position;
  };
}

function stockScore(availableQty, needed) {
  if (!needed || needed <= 0) return 1;
  return Math.min(availableQty / (needed * STOCK_COVER_TARGET), 1);
}

function ratingScore(metrics) {
  if (!metrics || !metrics.rating_count) return NEUTRAL;
  return Math.max(0, Math.min(Number(metrics.rating_sum) / metrics.rating_count / 5, 1));
}

/**
 * Acceptance and cancellation carry most of the weight; workload is a tiebreak
 * between two shops that behave the same but where one is already busy.
 */
function performanceScore(metrics, workloadScore) {
  if (!metrics || !metrics.orders_total) return NEUTRAL;
  const acceptance = metrics.orders_accepted / metrics.orders_total;
  const cancellation = metrics.orders_cancelled / metrics.orders_total;
  return 0.5 * acceptance + 0.3 * (1 - cancellation) + 0.2 * workloadScore;
}

/**
 * Scores a candidate set in place and returns it sorted best-first.
 *
 * Only 'recommended' uses the weighted score. The other five are single-key
 * sorts on purpose: a customer who asks for the nearest shop means the nearest
 * shop, not the nearest-weighted-by-five-other-things shop.
 */
function rank(candidates, weights, strategy = 'recommended') {
  // The scale is built from the shops that can actually serve this address.
  //
  // Including the others would let a shop 400km away stretch the distance axis
  // until a 13km shop scored 0.97 and ranked alongside one on the doorstep. A
  // candidate that cannot deliver is not a yardstick for the ones that can.
  const scale = candidates.filter((c) => c.deliverable);
  const basis = scale.length > 0 ? scale : candidates;

  const byDistance = normaliser(basis.map((c) => c.distanceKm), { lowerIsBetter: true });
  const byEta = normaliser(basis.map((c) => c.etaMinutes), { lowerIsBetter: true });
  const byPrice = normaliser(basis.map((c) => c.lineTotalCents), { lowerIsBetter: true });
  const byWorkload = normaliser(
    basis.map((c) => (c.metrics ? c.metrics.open_orders : null)),
    { lowerIsBetter: true }
  );

  const w = {
    stock: Number(weights.stock_weight),
    distance: Number(weights.distance_weight),
    delivery: Number(weights.delivery_weight),
    price: Number(weights.price_weight),
    rating: Number(weights.rating_weight),
    performance: Number(weights.performance_weight),
  };
  const totalWeight = Object.values(w).reduce((sum, n) => sum + n, 0);

  for (const c of candidates) {
    const scores = {
      stock: stockScore(c.availableQty, c.quantity),
      distance: byDistance(c.distanceKm),
      delivery: byEta(c.etaMinutes),
      price: byPrice(c.lineTotalCents),
      rating: ratingScore(c.metrics),
      performance: performanceScore(c.metrics, byWorkload(c.metrics ? c.metrics.open_orders : null)),
    };
    c.scores = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Number(v.toFixed(4))]));
    // Out of 100 so the figure means something on its own; a weighted sum of
    // 0..1 parts would change scale every time a weight is edited.
    c.score = totalWeight === 0
      ? 0
      : Number(
          ((w.stock * scores.stock + w.distance * scores.distance + w.delivery * scores.delivery +
            w.price * scores.price + w.rating * scores.rating + w.performance * scores.performance) /
            totalWeight * 100).toFixed(2)
        );
  }

  return sortByStrategy(candidates, strategy);
}

function sortByStrategy(candidates, strategy) {
  // A shop that cannot deliver never outranks one that can, whatever the sort —
  // it is returned so the app can explain why, not so it can be chosen.
  const last = Number.POSITIVE_INFINITY;
  const comparators = {
    recommended: (a, b) => b.score - a.score,
    fastest: (a, b) => (a.etaMinutes ?? last) - (b.etaMinutes ?? last),
    cheapest: (a, b) => a.lineTotalCents - b.lineTotalCents,
    nearest: (a, b) => (a.distanceKm ?? last) - (b.distanceKm ?? last),
    best_rated: (a, b) => ratingScore(b.metrics) - ratingScore(a.metrics),
    pickup: (a, b) => {
      const pick = (c) => (c.deliveryMethods.includes('pickup') ? 0 : 1);
      return pick(a) - pick(b) || (a.distanceKm ?? last) - (b.distanceKm ?? last);
    },
  };
  const compare = comparators[strategy] ?? comparators.recommended;
  return [...candidates].sort((a, b) => Number(b.deliverable) - Number(a.deliverable) || compare(a, b));
}

/**
 * Every shop selling the same thing as `productId`, evaluated against `address`.
 *
 * Serviceability is re-run here rather than trusted from an earlier check —
 * stock, prices and store hours all move between a product view and a tap, and
 * this is the same rule checkout already follows.
 */
async function findCandidates({
  productId,
  quantity = 1,
  address,
  excludeVendorId = null,
  excludeSeedVendor = false,
  client = pool,
}) {
  const { rows: seedRows } = await client.query(
    'SELECT id, name, match_key, brand_id, vendor_id FROM products WHERE id = $1',
    [productId]
  );
  const seed = seedRows[0];
  if (!seed) {
    const err = new Error('Product not found');
    err.status = 404;
    throw err;
  }
  // 'Also available at' means somewhere else. The seed's own shop is dropped
  // unless the caller asked for the full list of everyone who stocks it.
  const excluded = excludeVendorId ?? (excludeSeedVendor ? seed.vendor_id : null);

  const { rows } = await client.query(
    `SELECT p.id AS product_id, p.name, p.price_cents, p.vendor_id, p.gst_rate_percent, p.moq,
            p.image_url,
            v.business_name, v.latitude, v.longitude,
            COALESCE((SELECT SUM(i.available_qty)::int FROM inventory i WHERE i.product_id = p.id), 0)
              AS available_qty,
            CASE WHEN v.latitude IS NOT NULL AND v.longitude IS NOT NULL
                      AND $2::float8 IS NOT NULL AND $3::float8 IS NOT NULL
                 THEN earth_distance(ll_to_earth($2, $3), ll_to_earth(v.latitude, v.longitude)) / 1000
            END AS distance_km,
            m.orders_total, m.orders_accepted, m.orders_rejected, m.orders_cancelled,
            m.orders_delivered, m.open_orders, m.rating_sum, m.rating_count
     FROM products p
     JOIN vendor_profiles v ON v.id = p.vendor_id
     LEFT JOIN vendor_performance_metrics m ON m.vendor_id = v.id
     WHERE p.match_key = $1
       AND p.is_active = true
       -- An unreviewed shop's listing must not be offered as an alternative,
       -- nor be picked as a replacement when another vendor rejects.
       AND p.moderation_status = 'approved'
       AND v.status = 'approved'
       AND ($4::int IS NULL OR p.vendor_id <> $4)`,
    [seed.match_key, address?.latitude ?? null, address?.longitude ?? null, excluded]
  );
  if (rows.length === 0) return { seed, candidates: [] };

  const vendorIds = [...new Set(rows.map((r) => r.vendor_id))];
  const [{ rows: areaRows }, { rows: ruleRows }] = await Promise.all([
    client.query('SELECT * FROM vendor_service_areas WHERE vendor_id = ANY($1) AND is_active = true', [vendorIds]),
    client.query('SELECT * FROM vendor_delivery_rules WHERE vendor_id = ANY($1)', [vendorIds]),
  ]);
  const areasByVendor = new Map();
  for (const area of areaRows) {
    if (!areasByVendor.has(area.vendor_id)) areasByVendor.set(area.vendor_id, []);
    areasByVendor.get(area.vendor_id).push(area);
  }
  const rulesByVendor = new Map(ruleRows.map((r) => [r.vendor_id, r]));

  const candidates = rows.map((r) => {
    const lineTotalCents = r.price_cents * quantity;
    const distanceKm = r.distance_km == null ? null : Number(r.distance_km);
    const hasStock = r.available_qty >= quantity;

    const rules = rulesByVendor.get(r.vendor_id) || { ...DEFAULT_RULES, vendor_id: r.vendor_id };

    // Reuses Sprint 1's decision matrix rather than a second copy of it: the
    // rules for "can this shop serve this address" must not differ between
    // browsing and checkout.
    //
    // Without an address there is nothing to check against, so the candidate is
    // returned unjudged rather than failed — an anonymous browser asking "who
    // else sells this" has not told us where they are.
    const evaluated = address
      ? evaluateVendor({
          vendor: { id: r.vendor_id, business_name: r.business_name },
          areas: areasByVendor.get(r.vendor_id) || [],
          rules,
          address,
          distanceKm,
          subtotalCents: lineTotalCents,
          hasStock,
        })
      : {
          vendorId: r.vendor_id,
          businessName: r.business_name,
          deliverable: hasStock,
          reason: hasStock ? undefined : 'OUT_OF_STOCK',
          distanceKm: null,
          deliveryMethods: [
            ...(rules.supports_delivery ? ['delivery'] : []),
            ...(rules.supports_pickup ? ['pickup'] : []),
          ],
          deliveryChargeCents: rules.delivery_charge_cents || 0,
          freeDeliveryApplied: false,
          etaMinutes: null,
        };

    return {
      ...evaluated,
      serviceabilityChecked: Boolean(address),
      productId: r.product_id,
      productName: r.name,
      imageUrl: r.image_url,
      unitPriceCents: r.price_cents,
      lineTotalCents,
      quantity,
      availableQty: r.available_qty,
      moq: r.moq,
      metrics: r.orders_total == null ? null : {
        orders_total: r.orders_total,
        orders_accepted: r.orders_accepted,
        orders_rejected: r.orders_rejected,
        orders_cancelled: r.orders_cancelled,
        orders_delivered: r.orders_delivered,
        open_orders: r.open_orders,
        rating_sum: r.rating_sum,
        rating_count: r.rating_count,
      },
      ratingAvg: r.rating_count ? Number((Number(r.rating_sum) / r.rating_count).toFixed(2)) : null,
      acceptanceRate: r.orders_total ? Number((r.orders_accepted / r.orders_total).toFixed(3)) : null,
    };
  });

  return { seed, candidates };
}

/**
 * Writes the run to vendor_matching_logs.
 *
 * The candidates are stored as they were scored. Recomputing them later would
 * use today's stock and today's weights, and could never explain a decision
 * made last week.
 */
async function logMatch(client, { userId, addressId, context, strategy, seed, quantity, candidates, weights }) {
  const winner = candidates.find((c) => c.deliverable) ?? null;
  await client.query(
    `INSERT INTO vendor_matching_logs
       (user_id, address_id, context, strategy, match_key, product_id, quantity,
        candidate_count, selected_vendor_id, weights, candidates)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      userId ?? null,
      addressId ?? null,
      context,
      strategy,
      seed.match_key,
      seed.id,
      quantity,
      candidates.length,
      winner?.vendorId ?? null,
      JSON.stringify(weights),
      JSON.stringify(
        candidates.map((c) => ({
          vendorId: c.vendorId,
          businessName: c.businessName,
          productId: c.productId,
          deliverable: c.deliverable,
          reason: c.reason ?? null,
          score: c.score,
          scores: c.scores,
          distanceKm: c.distanceKm,
          etaMinutes: c.etaMinutes,
          lineTotalCents: c.lineTotalCents,
          availableQty: c.availableQty,
        }))
      ),
    ]
  );
}

/**
 * Moves a vendor's counters.
 *
 * open_orders is floored at zero rather than left to the CHECK constraint: a
 * double-fired 'delivered' should not abort the transaction that carried a real
 * delivery.
 */
async function bumpMetrics(client, vendorId, deltas = {}) {
  const {
    ordersTotal = 0, ordersAccepted = 0, ordersRejected = 0,
    ordersCancelled = 0, ordersDelivered = 0, openOrders = 0, fulfilmentMinutes = 0,
  } = deltas;

  await client.query(
    `INSERT INTO vendor_performance_metrics
       (vendor_id, orders_total, orders_accepted, orders_rejected, orders_cancelled,
        orders_delivered, open_orders, fulfilment_minutes_total)
     VALUES ($1, GREATEST($2, 0), GREATEST($3, 0), GREATEST($4, 0), GREATEST($5, 0),
             GREATEST($6, 0), GREATEST($7, 0), GREATEST($8, 0))
     ON CONFLICT (vendor_id) DO UPDATE SET
       orders_total = GREATEST(vendor_performance_metrics.orders_total + $2, 0),
       orders_accepted = GREATEST(vendor_performance_metrics.orders_accepted + $3, 0),
       orders_rejected = GREATEST(vendor_performance_metrics.orders_rejected + $4, 0),
       orders_cancelled = GREATEST(vendor_performance_metrics.orders_cancelled + $5, 0),
       orders_delivered = GREATEST(vendor_performance_metrics.orders_delivered + $6, 0),
       open_orders = GREATEST(vendor_performance_metrics.open_orders + $7, 0),
       fulfilment_minutes_total = GREATEST(vendor_performance_metrics.fulfilment_minutes_total + $8, 0),
       updated_at = now()`,
    [vendorId, ordersTotal, ordersAccepted, ordersRejected, ordersCancelled, ordersDelivered, openOrders, fulfilmentMinutes]
  );
}

/** The counter movement each order status transition implies. */
function metricsForTransition(fromStatus, toStatus, minutesOpen = 0) {
  if (toStatus === 'confirmed' && fromStatus === 'pending') return { ordersAccepted: 1 };
  if (toStatus === 'delivered') return { ordersDelivered: 1, openOrders: -1, fulfilmentMinutes: Math.round(minutesOpen) };
  if (toStatus === 'cancelled') return { ordersCancelled: 1, openOrders: -1 };
  return null;
}

module.exports = {
  STRATEGIES,
  NEUTRAL,
  loadWeights,
  normaliser,
  stockScore,
  ratingScore,
  performanceScore,
  rank,
  sortByStrategy,
  findCandidates,
  logMatch,
  bumpMetrics,
  metricsForTransition,
};
