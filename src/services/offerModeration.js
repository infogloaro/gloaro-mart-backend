/**
 * Shops' public coupons as the admin sees them, and hiding one from the
 * Gloaro Mart offers list (SB6b, schema "PUBLIC OFFER MODERATION"). Hidden =
 * not in /api/coupons/offers, no follower alerts, and the shop sees why; the
 * code itself still works, like a private coupon.
 */
const pool = require('../config/db');

const MAX_REASON = 300;
const PAGE_SIZE = 30;

class ModerationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(c) {
  return {
    id: c.id,
    code: c.code,
    title: c.title,
    discountType: c.discount_type,
    discountValue: Number(c.discount_value),
    minOrderCents: c.min_order_value_cents,
    startsAt: c.starts_at,
    expiresAt: c.expires_at,
    isActive: c.is_active,
    isPublic: c.is_public,
    maxUses: c.max_uses,
    used: c.used,
    newCustomersOnly: c.new_customers_only,
    hidden: c.hidden_at != null,
    hiddenAt: c.hidden_at,
    hiddenReason: c.hidden_reason,
    hiddenBy: c.hidden_by_name ?? null,
    shop: { id: c.vendor_id, name: c.business_name, city: c.city, status: c.shop_status },
    createdAt: c.created_at,
  };
}

const SELECT = `
  SELECT c.*, vp.business_name, vp.city, vp.status AS shop_status, hb.full_name AS hidden_by_name,
         (SELECT COUNT(*)::int FROM orders o WHERE o.coupon_id = c.id AND o.status <> 'cancelled') AS used
  FROM coupons c
  JOIN vendor_profiles vp ON vp.id = c.vendor_id
  LEFT JOIN users hb ON hb.id = c.hidden_by`;

/**
 * Shops' public coupons (and ones hidden from the list): status listed (in
 * the offers list now or later) | hidden | all; q matches code, title or shop.
 */
async function list(query = {}) {
  const status = ['listed', 'hidden', 'all'].includes(query.status) ? query.status : 'listed';
  const q = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim()}%` : null;
  const page = Math.max(1, Number(query.page) || 1);
  const where = `WHERE c.vendor_id IS NOT NULL AND (c.is_public OR c.hidden_at IS NOT NULL)
    AND ($1 = 'all' OR ($1 = 'hidden' AND c.hidden_at IS NOT NULL) OR ($1 = 'listed' AND c.hidden_at IS NULL))
    AND ($2::text IS NULL OR c.code ILIKE $2 OR c.title ILIKE $2 OR vp.business_name ILIKE $2)`;
  const [{ rows }, { rows: total }, { rows: counts }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY c.created_at DESC LIMIT ${PAGE_SIZE} OFFSET $3`, [status, q, (page - 1) * PAGE_SIZE]),
    pool.query(`SELECT COUNT(*)::int AS n FROM coupons c JOIN vendor_profiles vp ON vp.id = c.vendor_id ${where}`, [status, q]),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE hidden_at IS NULL AND is_public)::int AS listed, COUNT(*) FILTER (WHERE hidden_at IS NOT NULL)::int AS hidden
       FROM coupons WHERE vendor_id IS NOT NULL`
    ),
  ]);
  return { items: rows.map(json), total: total[0].n, page, pageSize: PAGE_SIZE, counts: counts[0] };
}

/**
 * Hides ({hidden: true, reason}) or shows a shop's coupon. Returns
 * { coupon, changed, vendorUserId } for the caller's audit and notification.
 */
async function setHidden(rawId, body = {}, adminId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new ModerationError(404, 'Coupon not found');
  if (typeof body.hidden !== 'boolean') throw new ModerationError(400, 'hidden must be true or false.');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (body.hidden && !reason) throw new ModerationError(400, 'Say why it is hidden; the shop sees this.');
  if (reason.length > MAX_REASON) throw new ModerationError(400, `Keep the reason under ${MAX_REASON} characters.`);
  const { rows: found } = await pool.query(
    'SELECT c.id, c.hidden_at, vp.user_id FROM coupons c JOIN vendor_profiles vp ON vp.id = c.vendor_id WHERE c.id = $1',
    [id]
  );
  if (!found[0]) throw new ModerationError(404, 'Coupon not found');
  const changed = body.hidden !== (found[0].hidden_at != null) || (body.hidden && reason);
  if (body.hidden) {
    await pool.query('UPDATE coupons SET hidden_at = COALESCE(hidden_at, now()), hidden_reason = $2, hidden_by = $3 WHERE id = $1', [id, reason, adminId ?? null]);
  } else {
    await pool.query('UPDATE coupons SET hidden_at = NULL, hidden_reason = NULL, hidden_by = NULL WHERE id = $1', [id]);
  }
  const { rows } = await pool.query(`${SELECT} WHERE c.id = $1`, [id]);
  return { coupon: json(rows[0]), changed: Boolean(changed), wasHidden: found[0].hidden_at != null, vendorUserId: found[0].user_id };
}

/** Tells the shop its coupon was taken out of the offers list, or is back. */
async function notifyShop(userId, coupon) {
  if (!userId) return;
  const title = coupon.hidden
    ? `${coupon.code} was taken out of Gloaro Mart offers`
    : `${coupon.code} is back in Gloaro Mart offers`;
  const body = coupon.hidden
    ? `Reason: ${coupon.hiddenReason}. The code still works for customers who have it. Contact Gloaro Mart support to discuss it.`
    : 'Customers can see it in the offers list again.';
  await pool.query(
    "INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'coupon_moderation', $2, $3, '/vendor/offers')",
    [userId, title.slice(0, 160), body]
  );
}

module.exports = { ModerationError, list, setHidden, notifyShop };
