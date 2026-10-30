const pool = require('../config/db');
const { findOwnedAddress } = require('./address.controller');
const { resolveUnitPriceCents } = require('./product.controller');
const shopHours = require('../services/shopHours');
const deliveryRouting = require('../services/deliveryRouting');

/** Average city delivery speed used for the Phase 1 ETA. Replaced in Phase 3. */
const AVERAGE_SPEED_KMPH = 20;

/**
 * SH1: a shop with no service areas delivers locally this far; beyond it the
 * order ships by courier. Matches the app's "near you" radius.
 */
const UNRESTRICTED_LOCAL_KM = 15;

const DEFAULT_RULES = {
  delivery_charge_cents: 0,
  free_delivery_above_cents: null,
  min_order_cents: 0,
  preparation_minutes: 30,
  supports_delivery: true,
  supports_pickup: false,
  opens_at: null,
  closes_at: null,
  ships_outside_area: true,
  outstation_charge_cents: 6000,
  outstation_eta_days: 4,
};

/**
 * Vendors with no configured rules must still be able to sell — every vendor
 * predates this table. Missing rules mean "delivers, free, no minimum".
 */
function rulesFor(map, vendorId) {
  return map.get(vendorId) || { ...DEFAULT_RULES, vendor_id: vendorId };
}

/**
 * A shop is open when now falls inside [opens_at, closes_at). A window that
 * wraps past midnight (22:00–02:00) is treated as two spans.
 *
 * SB3: rules.open_now, when the caller looked it up (shopHours.openNowFor),
 * is the answer on the shop's own clock with weekly hours and holidays, and
 * wins. null there means the shop never gave hours: still open, as before.
 */
function isOpenNow(rules, now = new Date()) {
  if (rules.open_now === true || rules.open_now === false) return rules.open_now;
  if (!rules.opens_at || !rules.closes_at) return true;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (t) => {
    const [h, m] = String(t).split(':');
    return Number(h) * 60 + Number(m);
  };
  const open = toMinutes(rules.opens_at);
  const close = toMinutes(rules.closes_at);
  if (open === close) return true;
  return open < close ? minutesNow >= open && minutesNow < close : minutesNow >= open || minutesNow < close;
}

function etaMinutes(rules, distanceKm) {
  const travel = distanceKm == null ? 0 : Math.ceil((distanceKm / AVERAGE_SPEED_KMPH) * 60);
  return (rules.preparation_minutes ?? 30) + travel;
}

/**
 * Decides whether one vendor can serve one address.
 *
 * A vendor is serviceable if ANY of its active areas matches: a radius rule
 * needs coordinates on both the shop and the address, a pincode rule does not.
 * A vendor with no areas configured at all is treated as unrestricted, so the
 * existing catalogue keeps working before anyone opens the admin screens.
 *
 * SH1: outside the area (or, for an unrestricted shop, beyond
 * UNRESTRICTED_LOCAL_KM) the shop still serves the address by courier unless
 * it turned ships_outside_area off: delivery only, the outstation charge, and
 * an ETA in days (etaMinutes stays null so older apps show no minutes).
 *
 * DR1: with delivery routing on, the shop's areas still decide whether it
 * serves the address at all, but distance decides how: up to the routing
 * radius it is a local delivery by the platform's riders (GoKart), beyond it
 * a courier shipment (Shiprocket). The radius also replaces
 * UNRESTRICTED_LOCAL_KM for shops with no areas. Without a distance (no
 * coordinates) an in-area address stays local. `partner` names who carries it.
 */
function evaluateVendor({ vendor, areas, rules, address, distanceKm, subtotalCents, hasStock, routing = null }) {
  const routed = routing?.enabled === true;
  const localKm = routed ? Number(routing.local_radius_km) : UNRESTRICTED_LOCAL_KM;
  const result = {
    vendorId: vendor.id,
    businessName: vendor.business_name,
    deliverable: false,
    distanceKm: distanceKm == null ? null : Number(distanceKm.toFixed(2)),
    deliveryMethods: [],
    deliveryMode: null,
    deliveryChargeCents: 0,
    freeDeliveryApplied: false,
    etaMinutes: null,
    etaDays: null,
    partner: null,
  };

  if (rules.supports_delivery) result.deliveryMethods.push('delivery');
  if (rules.supports_pickup) result.deliveryMethods.push('pickup');

  if (!hasStock) return { ...result, reason: 'OUT_OF_STOCK' };
  if (result.deliveryMethods.length === 0) return { ...result, reason: 'NO_DELIVERY_PARTNER' };

  const radiusAreas = areas.filter((a) => a.area_type === 'radius');
  const pincodeAreas = areas.filter((a) => a.area_type === 'pincode');

  let inArea;
  if (areas.length === 0) {
    inArea = distanceKm == null || distanceKm <= localKm;
  } else {
    const pincodeMatch = pincodeAreas.some((a) => a.pincode === address.pincode);
    const radiusMatch =
      distanceKm != null && radiusAreas.some((a) => distanceKm <= Number(a.radius_km));
    inArea = pincodeMatch || radiusMatch;
  }

  const ships = rules.supports_delivery && rules.ships_outside_area !== false;
  const local = routed && distanceKm != null ? distanceKm <= localKm : inArea;
  const courier = !local && (inArea ? rules.supports_delivery : ships);
  if (!inArea && !ships) {
    // Distinguish "we don't cover your pincode" from "you're too far", so the
    // app can say something specific rather than one generic line.
    const reason =
      radiusAreas.length === 0 || distanceKm == null ? 'PINCODE_NOT_SERVED' : 'OUT_OF_SERVICE_AREA';
    return { ...result, reason };
  }
  if (courier) result.deliveryMethods = ['delivery'];

  if (subtotalCents < (rules.min_order_cents || 0)) {
    return { ...result, reason: 'BELOW_MIN_ORDER' };
  }
  if (!isOpenNow(rules)) {
    return { ...result, reason: 'STORE_CLOSED' };
  }

  const threshold = rules.free_delivery_above_cents;
  const freeDeliveryApplied = threshold != null && subtotalCents >= threshold;

  if (courier) {
    const charge = rules.outstation_charge_cents ?? DEFAULT_RULES.outstation_charge_cents;
    return {
      ...result,
      deliverable: true,
      deliveryMode: 'courier',
      deliveryChargeCents: freeDeliveryApplied ? 0 : charge,
      freeDeliveryApplied,
      etaDays: rules.outstation_eta_days ?? DEFAULT_RULES.outstation_eta_days,
      partner: deliveryRouting.partnerFor(routing, 'courier'),
    };
  }

  return {
    ...result,
    deliverable: true,
    deliveryMode: 'local',
    deliveryChargeCents: freeDeliveryApplied ? 0 : rules.delivery_charge_cents || 0,
    freeDeliveryApplied,
    etaMinutes: etaMinutes(rules, distanceKm),
    // A pickup-only shop has nobody to carry the order.
    partner: rules.supports_delivery ? deliveryRouting.partnerFor(routing, 'local') : null,
  };
}

/**
 * Core check, shared by the HTTP endpoint and by checkout.
 *
 * Checkout must call this again rather than trusting the client's earlier
 * result — stock, prices and store hours move between the check and the tap.
 */
async function evaluate({ userId, addressId, items }) {
  const address = await findOwnedAddress(userId, addressId);
  if (!address) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('items is required');
    err.status = 400;
    throw err;
  }

  const productIds = items.map((i) => Number(i.productId)).filter((id) => Number.isFinite(id));
  const { rows: products } = await pool.query(
    `SELECT p.id, p.name, p.vendor_id, p.price_cents, p.stock_quantity, p.is_active,
            v.business_name, v.latitude, v.longitude,
            CASE WHEN v.latitude IS NOT NULL AND v.longitude IS NOT NULL
                      AND $2::float8 IS NOT NULL AND $3::float8 IS NOT NULL
                 THEN earth_distance(ll_to_earth($2, $3), ll_to_earth(v.latitude, v.longitude)) / 1000
            END AS distance_km
     FROM products p
     JOIN vendor_profiles v ON v.id = p.vendor_id
     WHERE p.id = ANY($1)`,
    [productIds, address.latitude, address.longitude]
  );

  const missing = productIds.filter((id) => !products.some((p) => p.id === id));
  if (missing.length > 0) {
    const err = new Error(`Unknown product: ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const { rows: tierRows } = await pool.query(
    'SELECT * FROM product_price_tiers WHERE product_id = ANY($1)',
    [productIds]
  );
  const tiersByProduct = new Map();
  for (const tier of tierRows) {
    if (!tiersByProduct.has(tier.product_id)) tiersByProduct.set(tier.product_id, []);
    tiersByProduct.get(tier.product_id).push(tier);
  }

  const vendorIds = [...new Set(products.map((p) => p.vendor_id))];
  const [{ rows: areaRows }, { rows: ruleRows }, openNow, routing] = await Promise.all([
    pool.query('SELECT * FROM vendor_service_areas WHERE vendor_id = ANY($1) AND is_active = true', [vendorIds]),
    pool.query('SELECT * FROM vendor_delivery_rules WHERE vendor_id = ANY($1)', [vendorIds]),
    shopHours.openNowFor(vendorIds),
    deliveryRouting.getSettings(),
  ]);
  const areasByVendor = new Map();
  for (const area of areaRows) {
    if (!areasByVendor.has(area.vendor_id)) areasByVendor.set(area.vendor_id, []);
    areasByVendor.get(area.vendor_id).push(area);
  }
  const rulesByVendor = new Map(ruleRows.map((r) => [r.vendor_id, r]));

  const byVendor = new Map();
  for (const item of items) {
    const product = products.find((p) => p.id === Number(item.productId));
    const quantity = Number(item.quantity) || 0;
    if (!byVendor.has(product.vendor_id)) byVendor.set(product.vendor_id, []);
    byVendor.get(product.vendor_id).push({ product, quantity });
  }

  const vendors = [];
  for (const [vendorId, entries] of byVendor) {
    const first = entries[0].product;
    const subtotalCents = entries.reduce(
      (sum, e) =>
        sum +
        resolveUnitPriceCents(
          { price_cents: e.product.price_cents },
          e.quantity,
          tiersByProduct.get(e.product.id)
        ) *
          e.quantity,
      0
    );
    const hasStock = entries.every((e) => e.product.is_active && e.product.stock_quantity >= e.quantity);

    const evaluated = evaluateVendor({
      vendor: { id: vendorId, business_name: first.business_name },
      areas: areasByVendor.get(vendorId) || [],
      rules: { ...rulesFor(rulesByVendor, vendorId), open_now: openNow.get(vendorId) },
      address,
      distanceKm: first.distance_km == null ? null : Number(first.distance_km),
      subtotalCents,
      hasStock,
      routing,
    });

    evaluated.items = entries.map((e) => ({
      productId: e.product.id,
      available: e.product.is_active && e.product.stock_quantity >= e.quantity,
      quantity: e.quantity,
    }));
    vendors.push(evaluated);
  }

  const deliverable = vendors.length > 0 && vendors.every((v) => v.deliverable);
  return {
    deliverable,
    vendors,
    totals: {
      deliveryChargeCents: vendors.reduce((sum, v) => sum + (v.deliverable ? v.deliveryChargeCents : 0), 0),
      maxEtaMinutes: vendors.reduce((max, v) => Math.max(max, v.etaMinutes || 0), 0) || null,
    },
  };
}

async function check(req, res) {
  const { addressId, items } = req.body || {};
  if (!addressId) return res.status(400).json({ message: 'addressId is required' });
  try {
    res.json(await evaluate({ userId: req.user.id, addressId, items }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }
}

// evaluateVendor is exported for testing — it holds the whole decision matrix
// and is the one piece worth exercising without a database.
module.exports = { check, evaluate, evaluateVendor, isOpenNow, etaMinutes, DEFAULT_RULES };
