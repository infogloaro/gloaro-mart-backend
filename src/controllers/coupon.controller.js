const pool = require('../config/db');

async function getVendorProfileId(userId) {
  const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [userId]);
  return rows[0]?.id || null;
}

function computeDiscountCents(coupon, subtotalCents) {
  if (coupon.discount_type === 'flat') {
    return Math.min(Math.round(Number(coupon.discount_value) * 100), subtotalCents);
  }
  return Math.min(Math.round((subtotalCents * Number(coupon.discount_value)) / 100), subtotalCents);
}

async function createCoupon(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const { code, discountType, discountValue, minOrderValueCents, expiresAt } = req.body || {};
  if (!code || !['flat', 'percentage'].includes(discountType) || !(Number(discountValue) > 0)) {
    return res.status(400).json({ message: 'code, a valid discountType, and a positive discountValue are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons (vendor_id, code, discount_type, discount_value, min_order_value_cents, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [vendorId, code.toUpperCase(), discountType, discountValue, minOrderValueCents ?? 0, expiresAt || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'You already have a coupon with this code' });
    }
    throw err;
  }
}

async function getMyCoupons(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  const { rows } = await pool.query('SELECT * FROM coupons WHERE vendor_id = $1 ORDER BY created_at DESC', [
    vendorId,
  ]);
  res.json(rows);
}

async function updateCoupon(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const { isActive, expiresAt } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE coupons SET
      is_active = COALESCE($3, is_active),
      expires_at = COALESCE($4, expires_at)
     WHERE id = $1 AND vendor_id = $2
     RETURNING *`,
    [req.params.id, vendorId, isActive, expiresAt]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Coupon not found' });
  res.json(rows[0]);
}

async function deleteCoupon(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const { rows } = await pool.query(
    'UPDATE coupons SET is_active = false WHERE id = $1 AND vendor_id = $2 RETURNING id',
    [req.params.id, vendorId]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Coupon not found' });
  res.status(204).send();
}

async function validateCoupon(req, res) {
  const { vendorId, code, subtotalCents } = req.body || {};
  if (!vendorId || !code || !Number.isInteger(subtotalCents)) {
    return res.status(400).json({ message: 'vendorId, code, and subtotalCents are required' });
  }
  const { rows } = await pool.query(
    `SELECT * FROM coupons WHERE (vendor_id = $1 OR vendor_id IS NULL) AND code = $2 AND is_active = true
     ORDER BY vendor_id NULLS LAST LIMIT 1`,
    [vendorId, code.toUpperCase()]
  );
  const coupon = rows[0];
  if (!coupon) return res.status(404).json({ message: 'Invalid coupon code' });
  if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) {
    return res.status(400).json({ message: 'This coupon has expired' });
  }
  if (subtotalCents < coupon.min_order_value_cents) {
    return res.status(400).json({
      message: `This coupon requires a minimum order of ₹${(coupon.min_order_value_cents / 100).toFixed(2)}`,
    });
  }
  const discountCents = computeDiscountCents(coupon, subtotalCents);
  res.json({ couponId: coupon.id, code: coupon.code, discountCents });
}

// Re-validates and resolves a coupon server-side at checkout time. Returns
// { couponId, code, discountCents } or throws a { status, message } error object
// the caller (order.controller.js) turns into a 400 response.
async function resolveCouponForCheckout(vendorId, code, subtotalCents) {
  const { rows } = await pool.query(
    `SELECT * FROM coupons WHERE (vendor_id = $1 OR vendor_id IS NULL) AND code = $2 AND is_active = true
     ORDER BY vendor_id NULLS LAST LIMIT 1`,
    [vendorId, code.toUpperCase()]
  );
  const coupon = rows[0];
  if (!coupon) {
    throw { status: 400, message: `Coupon "${code}" is no longer valid` };
  }
  if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) {
    throw { status: 400, message: `Coupon "${code}" has expired` };
  }
  if (subtotalCents < coupon.min_order_value_cents) {
    throw { status: 400, message: `Coupon "${code}" requires a higher order value` };
  }
  return { couponId: coupon.id, code: coupon.code, discountCents: computeDiscountCents(coupon, subtotalCents) };
}

module.exports = {
  createCoupon,
  getMyCoupons,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
  resolveCouponForCheckout,
};
