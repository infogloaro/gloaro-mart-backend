const pool = require('../config/db');
const publicOffers = require('../services/publicOffers');
const { runningCampaigns } = require('./campaign.controller');

async function getVendorProfileId(userId) {
  const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [userId]);
  return rows[0]?.id || null;
}

// Flat rupees, a percentage, or (SB6) the shop's delivery charge.
const computeDiscountCents = publicOffers.discountCents;

/** Answers an OfferError with its status; anything else is a real error. */
const offers = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof publicOffers.OfferError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

const createCoupon = offers(async (req, res) => {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const { code, minOrderValueCents, expiresAt } = req.body || {};
  if (!code || !['flat', 'percentage', 'free_delivery'].includes(req.body?.discountType)) {
    return res.status(400).json({ message: 'code, a valid discountType, and a positive discountValue are required' });
  }
  const discount = publicOffers.readDiscount(req.body);
  // SB6: public in the offers hub, title, start, limits; all optional.
  const rules = publicOffers.readRules(req.body);
  const cols = Object.keys(rules);
  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons (vendor_id, code, discount_type, discount_value, min_order_value_cents, expires_at${cols.map((c) => `, ${c}`).join('')})
       VALUES ($1, $2, $3, $4, $5, $6${cols.map((_, i) => `, $${7 + i}`).join('')})
       RETURNING *`,
      [vendorId, code.toUpperCase(), discount.discount_type, discount.discount_value, minOrderValueCents ?? 0, expiresAt || null, ...Object.values(rules)]
    );
    res.status(201).json({ ...rows[0], uses_count: 0 });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'You already have a coupon with this code' });
    }
    throw err;
  }
});

async function getMyCoupons(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  const { rows } = await pool.query('SELECT * FROM coupons WHERE vendor_id = $1 ORDER BY created_at DESC', [
    vendorId,
  ]);
  // SB6: how often each was used (orders not cancelled).
  const used = await publicOffers.useCounts(rows.map((r) => r.id));
  res.json(rows.map((r) => ({ ...r, uses_count: used.get(r.id) ?? 0 })));
}

const updateCoupon = offers(async (req, res) => {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const { isActive, expiresAt } = req.body || {};
  const rules = publicOffers.readRules(req.body || {});
  const sets = Object.keys(rules).map((c, i) => `,\n      ${c} = $${5 + i}`).join('');
  const { rows } = await pool.query(
    `UPDATE coupons SET
      is_active = COALESCE($3, is_active),
      expires_at = COALESCE($4, expires_at)${sets}
     WHERE id = $1 AND vendor_id = $2
     RETURNING *`,
    [req.params.id, vendorId, isActive, expiresAt, ...Object.values(rules)]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Coupon not found' });
  res.json(rows[0]);
});

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

const validateCoupon = offers(async (req, res) => {
  const { vendorId, code, subtotalCents, deliveryChargeCents } = req.body || {};
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
  // SB6: started, uses left, this customer's own limit, new customers only.
  await publicOffers.checkRules(coupon, { userId: req.user?.id });
  const delivery = Number.isInteger(deliveryChargeCents) ? deliveryChargeCents : 0;
  const discountCents = computeDiscountCents(coupon, subtotalCents, delivery);
  res.json({
    couponId: coupon.id,
    code: coupon.code,
    discountCents,
    // A free-delivery coupon takes off the delivery charge, which checkout knows.
    ...(coupon.discount_type === 'free_delivery' ? { freeDelivery: true } : {}),
  });
});

// Re-validates and resolves a coupon server-side at checkout time. Returns
// { couponId, code, discountCents } or throws a { status, message } error object
// the caller (order.controller.js) turns into a 400 response. SB6: [userId]
// checks the customer's own limits; [deliveryChargeCents] is what a
// free-delivery coupon takes off.
async function resolveCouponForCheckout(vendorId, code, subtotalCents, { userId, deliveryChargeCents = 0 } = {}) {
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
  try {
    await publicOffers.checkRules(coupon, { userId });
  } catch (err) {
    if (err instanceof publicOffers.OfferError) throw { status: err.status, message: err.message };
    throw err;
  }
  return { couponId: coupon.id, code: coupon.code, discountCents: computeDiscountCents(coupon, subtotalCents, deliveryChargeCents) };
}

/** The offers hub (SB6): public shop coupons and running campaigns. */
const listPublicOffers = offers(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ items: await publicOffers.listOffers(req.query, { runningCampaigns }) });
});

module.exports = {
  createCoupon,
  getMyCoupons,
  updateCoupon,
  deleteCoupon,
  validateCoupon,
  resolveCouponForCheckout,
  listPublicOffers,
};
