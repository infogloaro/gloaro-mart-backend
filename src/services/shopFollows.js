/**
 * Shop follows (SB4, schema "SHOP FOLLOWS"): a customer favourites a shop,
 * and may opt in to hear about its new offers (sent from SB8). Following is
 * idempotent, like the wishlist: a double tap is one follow.
 */
const pool = require('../config/db');
const shopTrust = require('./shopTrust');
const shopHours = require('./shopHours');

const MAX_LISTED = 200;

class FollowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** SQL: how many customers follow the shop [alias]. */
function followerCountSql(alias = 'vp') {
  return `(SELECT COUNT(*)::int FROM shop_follows sf WHERE sf.vendor_id = ${alias}.id)`;
}

function readVendorId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new FollowError(404, 'Shop not found');
  return id;
}

/** { notifyOffers? } from a body; anything but true / false is refused. */
function readNotify(body = {}) {
  if (body.notifyOffers === undefined) return undefined;
  if (typeof body.notifyOffers !== 'boolean') throw new FollowError(400, 'notifyOffers must be true or false.');
  return body.notifyOffers;
}

async function state(userId, vendorId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM shop_follows WHERE user_id = $1 AND vendor_id = $2) AS following,
            (SELECT notify_offers FROM shop_follows WHERE user_id = $1 AND vendor_id = $2) AS notify_offers,
            (SELECT COUNT(*)::int FROM shop_follows WHERE vendor_id = $2) AS follower_count`,
    [userId, vendorId]
  );
  return { following: rows[0].following, notify_offers: rows[0].notify_offers ?? false, follower_count: rows[0].follower_count };
}

/**
 * Follows an approved shop (or changes the offers opt-in of a follow). The
 * shop's own owner can't follow it. Returns { following, notify_offers,
 * follower_count } and whether the follow is new.
 */
async function follow(userId, rawVendorId, body) {
  const vendorId = readVendorId(rawVendorId);
  const notify = readNotify(body);
  const { rows } = await pool.query("SELECT id, user_id FROM vendor_profiles WHERE id = $1 AND status = 'approved'", [vendorId]);
  if (!rows[0]) throw new FollowError(404, 'Shop not found');
  if (rows[0].user_id === userId) throw new FollowError(400, "You can't follow your own shop.");
  const { rows: done } = await pool.query(
    `INSERT INTO shop_follows (user_id, vendor_id, notify_offers, notify_offers_at)
     VALUES ($1, $2, COALESCE($3::boolean, false), CASE WHEN $3::boolean THEN now() END)
     ON CONFLICT (user_id, vendor_id) DO UPDATE SET
       notify_offers = COALESCE($3::boolean, shop_follows.notify_offers),
       notify_offers_at = CASE
         WHEN $3::boolean IS TRUE AND NOT shop_follows.notify_offers THEN now()
         WHEN $3::boolean IS FALSE THEN NULL
         ELSE shop_follows.notify_offers_at END
     RETURNING (xmax = 0) AS created`,
    [userId, vendorId, notify ?? null]
  );
  return { ...(await state(userId, vendorId)), created: done[0].created };
}

/** Unfollows; fine whether or not there was a follow. */
async function unfollow(userId, rawVendorId) {
  const vendorId = readVendorId(rawVendorId);
  await pool.query('DELETE FROM shop_follows WHERE user_id = $1 AND vendor_id = $2', [userId, vendorId]);
  return state(userId, vendorId);
}

/** The caller's followed shops that are open for business, newest follow first. */
async function followedShops(userId) {
  const { rows } = await pool.query(
    `SELECT vp.id, vp.business_name, vp.business_type, vp.description, vp.logo_url, vp.cover_image_url,
            vp.address_line, vp.city, vp.state, vp.pincode, vp.district, vp.status,
            ${shopTrust.verifiedSql('vp')} AS verified,
            dr.supports_delivery, dr.supports_pickup, dr.opens_at, dr.closes_at,
            dr.delivery_charge_cents, dr.free_delivery_above_cents,
            ${shopHours.openNowSql('vp')} AS open_now, ${shopHours.todaySql('vp')} AS hours_today,
            CASE WHEN pm.rating_count > 0 THEN ROUND(pm.rating_sum / pm.rating_count, 2) END AS rating,
            COALESCE(pm.rating_count, 0) AS review_count,
            (SELECT COUNT(*)::int FROM products p
              WHERE p.vendor_id = vp.id AND p.is_active = true AND p.moderation_status = 'approved') AS product_count,
            ${followerCountSql('vp')} AS follower_count,
            sf.notify_offers, sf.created_at AS followed_at
     FROM shop_follows sf
     JOIN vendor_profiles vp ON vp.id = sf.vendor_id AND vp.status = 'approved'
     LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = vp.id
     LEFT JOIN vendor_performance_metrics pm ON pm.vendor_id = vp.id
     WHERE sf.user_id = $1
     ORDER BY sf.created_at DESC
     LIMIT ${MAX_LISTED}`,
    [userId]
  );
  return rows.map((r) => ({ ...r, rating: r.rating == null ? null : Number(r.rating) }));
}

/** Just the ids (and opt-ins), for drawing the hearts on shop cards. */
async function followedIds(userId) {
  const { rows } = await pool.query(
    `SELECT sf.vendor_id, sf.notify_offers FROM shop_follows sf
     JOIN vendor_profiles vp ON vp.id = sf.vendor_id AND vp.status = 'approved'
     WHERE sf.user_id = $1 ORDER BY sf.created_at DESC`,
    [userId]
  );
  return rows;
}

/** What the shop sees: how many follow it, how many want offers, and new this week. */
async function followerStats(vendorId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE notify_offers)::int AS notify_offers,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_this_week
     FROM shop_follows WHERE vendor_id = $1`,
    [vendorId]
  );
  return { total: rows[0].total, notifyOffers: rows[0].notify_offers, newThisWeek: rows[0].new_this_week };
}

module.exports = { FollowError, followerCountSql, follow, unfollow, followedShops, followedIds, followerStats, state };
