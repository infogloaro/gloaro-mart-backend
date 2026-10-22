/**
 * Public offers (SB6, schema "PUBLIC OFFERS"): the coupon rules a shop can
 * set (public in the hub, title, start, total uses, uses per customer, new
 * customers only, free delivery), checked the same way when a customer checks
 * a code and at checkout; and the offers hub list (public shop coupons plus
 * running Gloaro Mart campaigns).
 */
const pool = require('../config/db');
const shopTrust = require('./shopTrust');

const DISCOUNT_TYPES = ['flat', 'percentage', 'free_delivery'];
const MAX_LISTED = 100;

class OfferError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function optionalPositiveInt(value, name) {
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new OfferError(400, `${name} must be a whole number above 0, or empty for no limit.`);
  return n;
}

function optionalDate(value, name) {
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) throw new OfferError(400, `${name} must be a date.`);
  return d.toISOString();
}

/**
 * The SB6 coupon fields present in a body, checked. Only the ones sent are
 * returned (so an update changes just those); null / '' clears a limit.
 */
function readRules(body = {}) {
  const out = {};
  if (body.isPublic !== undefined) {
    if (typeof body.isPublic !== 'boolean') throw new OfferError(400, 'isPublic must be true or false.');
    out.is_public = body.isPublic;
  }
  if (body.title !== undefined) {
    if (body.title !== null && typeof body.title !== 'string') throw new OfferError(400, 'title must be text.');
    const t = (body.title ?? '').trim();
    if (t.length > 80) throw new OfferError(400, 'The title is at most 80 characters.');
    out.title = t || null;
  }
  if (body.startsAt !== undefined) out.starts_at = optionalDate(body.startsAt, 'startsAt');
  if (body.maxUses !== undefined) out.max_uses = optionalPositiveInt(body.maxUses, 'maxUses');
  if (body.perUserLimit !== undefined) out.per_user_limit = optionalPositiveInt(body.perUserLimit, 'perUserLimit');
  if (body.newCustomersOnly !== undefined) {
    if (typeof body.newCustomersOnly !== 'boolean') throw new OfferError(400, 'newCustomersOnly must be true or false.');
    out.new_customers_only = body.newCustomersOnly;
  }
  return out;
}

/** Checks the discount itself for a new coupon: type, and a value that makes sense. */
function readDiscount(body = {}) {
  const type = body.discountType;
  if (!DISCOUNT_TYPES.includes(type)) throw new OfferError(400, `discountType must be one of ${DISCOUNT_TYPES.join(', ')}.`);
  if (type === 'free_delivery') return { discount_type: type, discount_value: 0 };
  const value = Number(body.discountValue);
  if (!(value > 0)) throw new OfferError(400, 'discountValue must be above 0.');
  if (type === 'percentage' && value > 100) throw new OfferError(400, 'A percentage discount is at most 100.');
  return { discount_type: type, discount_value: value };
}

/** The money off: flat rupees, a percentage, or the shop's delivery charge. */
function discountCents(coupon, subtotalCents, deliveryChargeCents = 0) {
  if (coupon.discount_type === 'free_delivery') return Math.max(0, deliveryChargeCents || 0);
  if (coupon.discount_type === 'flat') return Math.min(Math.round(Number(coupon.discount_value) * 100), subtotalCents);
  return Math.min(Math.round((subtotalCents * Number(coupon.discount_value)) / 100), subtotalCents);
}

/**
 * The SB6 rules for one customer: started, uses left, their own limit, new
 * customers only. Uses are orders with this coupon that weren't cancelled.
 * Without a userId only the shared rules (start, total uses) are checked.
 * Throws an OfferError with the reason the customer sees.
 */
async function checkRules(coupon, { userId } = {}) {
  if (coupon.starts_at && new Date(coupon.starts_at) > new Date()) {
    throw new OfferError(400, `Coupon "${coupon.code}" starts on ${new Date(coupon.starts_at).toDateString()}.`);
  }
  const needUser = userId != null && (coupon.per_user_limit != null || coupon.new_customers_only);
  if (coupon.max_uses == null && !needUser) return;
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM orders WHERE coupon_id = $1 AND status <> 'cancelled') AS used,
       (SELECT COUNT(*)::int FROM orders WHERE coupon_id = $1 AND user_id = $2 AND status <> 'cancelled') AS used_by_me,
       (SELECT COUNT(*)::int FROM orders WHERE user_id = $2 AND status <> 'cancelled'
          AND ($3::int IS NULL OR vendor_id = $3::int)) AS my_orders`,
    [coupon.id, userId ?? null, coupon.vendor_id]
  );
  const r = rows[0];
  if (coupon.max_uses != null && r.used >= coupon.max_uses) throw new OfferError(400, `Coupon "${coupon.code}" has been used up.`);
  if (userId == null) return;
  if (coupon.per_user_limit != null && r.used_by_me >= coupon.per_user_limit) {
    throw new OfferError(400, `You've already used coupon "${coupon.code}" ${coupon.per_user_limit === 1 ? 'once' : `${coupon.per_user_limit} times`}.`);
  }
  if (coupon.new_customers_only && r.my_orders > 0) {
    throw new OfferError(400, `Coupon "${coupon.code}" is for first orders${coupon.vendor_id ? ' with this shop' : ''} only.`);
  }
}

/** How many times each of the shop's coupons has been used (orders not cancelled). */
async function useCounts(couponIds) {
  if (couponIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT coupon_id, COUNT(*)::int AS n FROM orders
     WHERE coupon_id = ANY($1) AND status <> 'cancelled' GROUP BY coupon_id`,
    [couponIds]
  );
  return new Map(rows.map((r) => [r.coupon_id, r.n]));
}

function amountFields(type, value, centsValue) {
  if (type === 'percentage') return { percent: Number(value), amount_cents: null };
  if (type === 'flat') return { percent: null, amount_cents: centsValue };
  return { percent: null, amount_cents: null };
}

/**
 * The offers hub: public shop coupons that can be used now (active, started,
 * not expired, uses left, shop approved) and running campaigns. Filters:
 * vendorId, city, pincode (the shop's), type = coupon | campaign. Ending
 * soonest first; ones with no end last.
 */
async function listOffers(query = {}, { runningCampaigns }) {
  const vendorId = query.vendorId != null && query.vendorId !== '' ? Number(query.vendorId) : null;
  if (vendorId != null && (!Number.isInteger(vendorId) || vendorId <= 0)) throw new OfferError(400, 'vendorId must be a shop id.');
  const type = ['coupon', 'campaign'].includes(query.type) ? query.type : null;
  const city = typeof query.city === 'string' && query.city.trim() ? query.city.trim() : null;
  const pincode = typeof query.pincode === 'string' && /^\d{6}$/.test(query.pincode.trim()) ? query.pincode.trim() : null;

  const items = [];
  if (type !== 'campaign') {
    const { rows } = await pool.query(
      `SELECT c.*, vp.business_name, vp.logo_url, vp.city, vp.pincode, ${shopTrust.verifiedSql('vp')} AS verified,
              (SELECT COUNT(*)::int FROM orders o WHERE o.coupon_id = c.id AND o.status <> 'cancelled') AS used
       FROM coupons c
       LEFT JOIN vendor_profiles vp ON vp.id = c.vendor_id
       WHERE c.is_public AND c.is_active
         AND (c.starts_at IS NULL OR c.starts_at <= now())
         AND (c.expires_at IS NULL OR c.expires_at > now())
         AND (c.vendor_id IS NULL OR vp.status = 'approved')
         AND ($1::int IS NULL OR c.vendor_id = $1::int)
         AND ($2::text IS NULL OR lower(vp.city) = lower($2::text))
         AND ($3::text IS NULL OR vp.pincode = $3::text)
       ORDER BY c.expires_at ASC NULLS LAST, c.created_at DESC
       LIMIT ${MAX_LISTED}`,
      [vendorId, city, pincode]
    );
    for (const c of rows) {
      if (c.max_uses != null && c.used >= c.max_uses) continue;
      items.push({
        type: 'coupon',
        id: c.id,
        code: c.code,
        title: c.title,
        discount_type: c.discount_type,
        ...amountFields(c.discount_type, c.discount_value, Math.round(Number(c.discount_value) * 100)),
        max_discount_cents: null,
        min_order_cents: c.min_order_value_cents,
        starts_at: c.starts_at,
        ends_at: c.expires_at,
        new_customers_only: c.new_customers_only,
        per_user_limit: c.per_user_limit,
        uses_left: c.max_uses == null ? null : c.max_uses - c.used,
        shop: c.vendor_id == null ? null : { id: c.vendor_id, name: c.business_name, logo_url: c.logo_url, city: c.city, pincode: c.pincode, verified: c.verified },
      });
    }
  }
  if (type !== 'coupon' && city == null && pincode == null) {
    for (const k of await runningCampaigns()) {
      if (vendorId != null && k.vendorIds.length > 0 && !k.vendorIds.includes(vendorId)) continue;
      items.push({
        type: 'campaign',
        id: k.id,
        title: k.name,
        description: k.description,
        banner_url: k.bannerUrl,
        discount_type: k.discountType,
        ...amountFields(k.discountType, k.discountValue, k.discountValue),
        max_discount_cents: k.maxDiscountCents,
        min_order_cents: k.minOrderCents,
        starts_at: null,
        ends_at: k.endsAt,
        scope: k.scope,
        category_ids: k.categoryIds,
        vendor_ids: k.vendorIds,
      });
    }
  }
  const end = (x) => (x.ends_at ? new Date(x.ends_at).getTime() : Infinity);
  items.sort((a, b) => end(a) - end(b));
  return items.slice(0, MAX_LISTED);
}

module.exports = { OfferError, DISCOUNT_TYPES, readRules, readDiscount, discountCents, checkRules, useCounts, listOffers };
