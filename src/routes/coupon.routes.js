const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const couponController = require('../controllers/coupon.controller');

const router = express.Router();

router.post('/', requireAuth, requireRole('vendor'), couponController.createCoupon);
router.get('/mine', requireAuth, requireRole('vendor'), couponController.getMyCoupons);
// Public: the offers hub (SB6), public shop coupons and running campaigns.
router.get('/offers', couponController.listPublicOffers);
router.post('/validate', requireAuth, couponController.validateCoupon);
router.patch('/:id', requireAuth, requireRole('vendor'), couponController.updateCoupon);
router.delete('/:id', requireAuth, requireRole('vendor'), couponController.deleteCoupon);

module.exports = router;
