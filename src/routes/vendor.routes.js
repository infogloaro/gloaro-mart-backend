const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const vendorController = require('../controllers/vendor.controller');
const delivery = require('../controllers/deliverySettings.controller');
const { getVendorProducts } = require('../controllers/product.controller');
const review = require('../controllers/review.controller');

const router = express.Router();

router.post('/profile', requireAuth, requireRole('vendor'), vendorController.createProfile);
router.get('/profile', requireAuth, requireRole('vendor'), vendorController.getMyProfile);
router.patch('/profile', requireAuth, requireRole('vendor'), vendorController.updateMyProfile);

// Must stay above '/:id' — Express would otherwise match 'delivery-settings'
// as a vendor id and hand it to getPublicProfile.
router.get('/delivery-settings', requireAuth, requireRole('vendor'), delivery.getMySettings);
router.put('/delivery-settings', requireAuth, requireRole('vendor'), delivery.updateMySettings);
router.get('/service-areas', requireAuth, requireRole('vendor'), delivery.getMyAreas);
router.post('/service-areas', requireAuth, requireRole('vendor'), delivery.addMyArea);
router.delete('/service-areas/:id', requireAuth, requireRole('vendor'), delivery.deleteMyArea);

// Public: the Mart tab's shop-discovery grid. Must stay above '/:id' for the
// same reason 'delivery-settings' does.
router.get('/', vendorController.listVendors);

router.get('/:id/products', getVendorProducts);
// Public: what a customer reads before deciding to buy from this shop.
router.get('/:id/reviews', review.listVendorReviews);
router.get('/:id', vendorController.getPublicProfile);

module.exports = router;
