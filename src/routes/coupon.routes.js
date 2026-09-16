const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const couponController = require('../controllers/coupon.controller');

const router = express.Router();

router.post('/', requireAuth, requireRole('vendor'), couponController.createCoupon);
router.get('/mine', requireAuth, requireRole('vendor'), couponController.getMyCoupons);
router.post('/validate', requireAuth, couponController.validateCoupon);
router.patch('/:id', requireAuth, requireRole('vendor'), couponController.updateCoupon);
router.delete('/:id', requireAuth, requireRole('vendor'), couponController.deleteCoupon);

module.exports = router;
