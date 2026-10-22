const moderation = require('../services/offerModeration');
const { recordAudit } = require('../services/auditLog');

/**
 * Shops' public coupons under Admin → Offers & Coupons (offers permission):
 *   GET   /api/admin/coupons/shop?status=listed|hidden|all&q=&page=
 *   PATCH /api/admin/coupons/shop/:id { hidden, reason }
 */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof moderation.ModerationError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

const listShopCoupons = handle(async (req, res) => {
  res.json(await moderation.list(req.query));
});

const setShopCouponHidden = handle(async (req, res) => {
  const { coupon, changed, wasHidden, vendorUserId } = await moderation.setHidden(req.params.id, req.body || {}, req.user.id);
  if (changed) {
    await recordAudit({
      actorUserId: req.user.id,
      action: coupon.hidden ? 'coupon.hidden' : 'coupon.shown',
      module: 'offers',
      entityType: 'coupon',
      entityId: coupon.id,
      previousValue: { hidden: wasHidden },
      newValue: { hidden: coupon.hidden, reason: coupon.hiddenReason },
    });
    // Only a real change of state tells the shop (a reworded reason doesn't).
    if (coupon.hidden !== wasHidden) await moderation.notifyShop(vendorUserId, coupon);
  }
  res.json(coupon);
});

module.exports = { listShopCoupons, setShopCouponHidden };
