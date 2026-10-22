const express = require('express');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');
const vendorController = require('../controllers/vendor.controller');
const delivery = require('../controllers/deliverySettings.controller');
const { getVendorProducts } = require('../controllers/product.controller');
const review = require('../controllers/review.controller');
const { uploadTo } = require('../controllers/upload.controller');
const shopReports = require('../controllers/shopReports.controller');

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

// Followed shops (SB4): the caller's own list; above '/:id' like the rest.
router.get('/following', requireAuth, vendorController.listFollowedShops);
router.get('/following/ids', requireAuth, vendorController.listFollowedShopIds);
router.post('/:id/follow', requireAuth, vendorController.followShop);
router.delete('/:id/follow', requireAuth, vendorController.unfollowShop);

// Shop-page views (SB5), public; a signed-in viewer counts once across devices.
// A plain per-address limit, as for ad and analytics reports.
const VIEW_WINDOW_MS = 60000;
const MAX_VIEW_REPORTS = 60;
const viewHits = new Map();
function tooManyViews(ip) {
  const now = Date.now();
  const h = viewHits.get(ip);
  if (!h || now - h.start > VIEW_WINDOW_MS) {
    viewHits.set(ip, { start: now, n: 1 });
    if (viewHits.size > 10000) for (const [k, v] of viewHits) if (now - v.start > VIEW_WINDOW_MS) viewHits.delete(k);
    return false;
  }
  h.n += 1;
  return h.n > MAX_VIEW_REPORTS;
}
router.post('/views', optionalAuth, (req, res, next) => {
  if (tooManyViews(req.ip)) return res.status(429).json({ message: 'Too many view reports — batch them.' });
  next();
}, vendorController.recordShopViews);

// Reports of wrong shop details (SB7). The reasons list is above '/:id'.
router.get('/report-reasons', shopReports.listReasons);
router.post('/:id/report', requireAuth, shopReports.reportShop);
router.get('/:id/report', requireAuth, shopReports.getMyReport);

// Public: the Mart tab's shop-discovery grid. Must stay above '/:id' for the
// same reason 'delivery-settings' does.
router.get('/', vendorController.listVendors);

router.get('/:id/products', getVendorProducts);
// Public: what a customer reads before deciding to buy from this shop.
router.get('/:id/reviews', optionalAuth, review.listVendorReviews);
// optionalAuth: a signed-in viewer also learns whether they follow it (SB4).
router.get('/:id', optionalAuth, vendorController.getPublicProfile);

module.exports = router;
