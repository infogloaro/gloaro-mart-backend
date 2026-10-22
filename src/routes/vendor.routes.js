const express = require('express');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');
const vendorController = require('../controllers/vendor.controller');
const delivery = require('../controllers/deliverySettings.controller');
const { getVendorProducts } = require('../controllers/product.controller');
const review = require('../controllers/review.controller');
const { uploadTo } = require('../controllers/upload.controller');

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

// Shop branding & gallery (SB1). Pictures upload to /uploads/vendors first;
// the profile and gallery only accept paths from there.
router.post('/uploads', requireAuth, requireRole('vendor'), uploadTo('vendors'));
router.get('/gallery', requireAuth, requireRole('vendor'), vendorController.getMyGallery);
router.post('/gallery', requireAuth, requireRole('vendor'), vendorController.addGalleryPhoto);
router.patch('/gallery/:photoId', requireAuth, requireRole('vendor'), vendorController.updateGalleryPhoto);
router.delete('/gallery/:photoId', requireAuth, requireRole('vendor'), vendorController.removeGalleryPhoto);

// Shop hours (SB3): weekly timetable, timezone and holidays.
router.get('/hours', requireAuth, requireRole('vendor'), vendorController.getMyHours);
router.put('/hours', requireAuth, requireRole('vendor'), vendorController.updateMyHours);
router.post('/holidays', requireAuth, requireRole('vendor'), vendorController.addMyHoliday);
router.delete('/holidays/:holidayId', requireAuth, requireRole('vendor'), vendorController.removeMyHoliday);

// Public: the Mart tab's shop-discovery grid. Must stay above '/:id' for the
// same reason 'delivery-settings' does.
router.get('/', vendorController.listVendors);

router.get('/:id/products', getVendorProducts);
// Public: what a customer reads before deciding to buy from this shop.
router.get('/:id/reviews', optionalAuth, review.listVendorReviews);
router.get('/:id', vendorController.getPublicProfile);

module.exports = router;
