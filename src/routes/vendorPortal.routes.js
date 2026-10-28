const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  attachVendor,
  requireOwnedProduct,
  requireOwnedInventory,
  requireOwnedMedia,
} = require('../middleware/ownership');
const catalogue = require('../controllers/catalogue.controller');
const inventory = require('../controllers/inventory.controller');
const portal = require('../controllers/vendorPortal.controller');
const campaigns = require('../controllers/campaign.controller');
const reviews = require('../controllers/review.controller');
const settlements = require('../controllers/settlement.controller');
const rfq = require('../controllers/rfq.controller');
const quotation = require('../controllers/quotation.controller');
const purchaseOrder = require('../controllers/purchaseOrder.controller');
const vendorAds = require('../controllers/vendorAds.controller');
const enquiries = require('../controllers/shopEnquiries.controller');
const vendorServices = require('../controllers/vendorServices.controller');
const serviceBookings = require('../controllers/serviceBookings.controller');
const { uploadTo } = require('../controllers/upload.controller');

/**
 * The vendor's own catalogue and stock.
 * Contracts per documents/SPRINT_8_VENDOR_PORTAL_SPEC.md.
 *
 * These hand off to the same controllers the admin routes use. The difference
 * is entirely in the guards above them — one implementation, two doors, so a
 * fix to variant validation cannot land for admins and miss vendors.
 */
const router = express.Router();

// Resolved once for the whole router, so no handler below can forget to look up
// which vendor is asking — forgetting that is exactly how an ownership check
// gets silently skipped.
router.use(requireAuth, requireRole('vendor'), attachVendor);

router.get('/dashboard', portal.getDashboard);

// Campaigns the shop would pay for, and joining or leaving them.
router.get('/campaigns', campaigns.vendorCampaigns);
router.post('/campaigns/:id/opt-in', campaigns.vendorOptIn);
router.post('/campaigns/:id/opt-out', campaigns.vendorOptIn);

// Reviews of the shop and its products, and the shop's public replies.
router.get('/reviews', reviews.vendorListReviews);
router.put('/reviews/:id/reply', reviews.vendorReply);
router.delete('/reviews/:id/reply', reviews.vendorDeleteReply);

// Payouts: the shop's settlements and the account they're paid into.
router.get('/settlements', settlements.vendorListSettlements);
router.get('/settlements/:id', settlements.vendorGetSettlement);
router.get('/bank-account', settlements.vendorGetBankAccount);
router.put('/bank-account', settlements.vendorSaveBankAccount);

// Requests for quotation the shop was invited to, and its quotations.
router.get('/rfqs', rfq.vendorList);
router.get('/rfqs/:id', rfq.vendorGet);
router.post('/rfqs/:id/decline', rfq.vendorDecline);
router.post('/rfqs/:id/quotations', rfq.vendorQuote);
router.get('/quotations/:id/messages', quotation.vendorThread);
router.post('/quotations/:id/messages', quotation.vendorMessage);
router.post('/quotations/:id/withdraw', quotation.vendorWithdraw);

// Purchase orders the shop won: acknowledging, delivering, confirming payment.
router.get('/purchase-orders', purchaseOrder.vendorList);
router.get('/purchase-orders/:id', purchaseOrder.vendorGet);
router.post('/purchase-orders/:id/acknowledge', purchaseOrder.vendorAcknowledge);
router.post('/purchase-orders/:id/start', purchaseOrder.vendorStart);
router.post('/purchase-orders/:id/deliveries', purchaseOrder.vendorDeliver);
router.put('/purchase-orders/:id/invoice-number', purchaseOrder.vendorInvoiceNumber);
router.post('/purchase-orders/:id/payments', purchaseOrder.vendorPayment);

// Advertise: the shop's own ad bookings (Ad Promotions). Approval stays with GLOARO.
router.get('/ads/options', vendorAds.options);
router.post('/ads/quote', vendorAds.quote);
router.post('/ads/uploads', uploadTo('ads'));
router.get('/ads/campaigns', vendorAds.list);
router.post('/ads/campaigns', vendorAds.create);
router.get('/ads/campaigns/:id', vendorAds.get);
router.patch('/ads/campaigns/:id', vendorAds.update);
router.get('/ads/campaigns/:id/stats', vendorAds.stats);
router.post('/ads/campaigns/:id/assets', vendorAds.addAsset);
router.delete('/ads/campaigns/:id/assets/:assetId', vendorAds.removeAsset);
router.post('/ads/campaigns/:id/pay', vendorAds.pay);
router.post('/ads/campaigns/:id/pause', vendorAds.pause);
router.post('/ads/campaigns/:id/resume', vendorAds.resume);
router.post('/ads/campaigns/:id/cancel', vendorAds.cancel);
router.post('/ads/campaigns/:id/extend', vendorAds.extend);
router.post('/ads/campaigns/:id/renew', vendorAds.renew);

// Customers' questions to the shop ("Ask the shop", SB9).
// The shop's services on Near Me → Services (NS5).
router.get('/services', vendorServices.list);
router.post('/services', vendorServices.create);
router.patch('/services/:id', vendorServices.update);
router.delete('/services/:id', vendorServices.remove);

// NS10: bookings of the shop's services, and times it blocks.
router.get('/bookings', serviceBookings.vendorList);
router.get('/bookings/:id', serviceBookings.vendorGet);
// accept | reject | start | complete | cancel (anything else is refused by the service).
router.post('/bookings/:id/:action', serviceBookings.vendorMove);
router.get('/booking-blocks', serviceBookings.vendorBlocks);
router.post('/booking-blocks', serviceBookings.vendorAddBlock);
router.delete('/booking-blocks/:id', serviceBookings.vendorRemoveBlock);

router.get('/enquiries', enquiries.vendorList);
router.get('/enquiries/:id', enquiries.vendorGet);
router.post('/enquiries/:id/messages', enquiries.vendorReply);
router.post('/enquiries/:id/close', enquiries.vendorClose);
// NS9: the work of a service request is done (the customer is asked to rate it).
router.post('/enquiries/:id/service-done', enquiries.vendorServiceDone);

// Read-only: attributes are platform-owned, so there is no POST here.
router.get('/attributes', portal.listAttributes);

// --- Variants and media on the vendor's own products ---

router.get('/products/:id/variants', requireOwnedProduct, catalogue.listVariants);
router.post('/products/:id/variants', requireOwnedProduct, catalogue.createVariant);
router.patch('/products/:id/variants/:variantId', requireOwnedProduct, catalogue.updateVariant);
router.delete('/products/:id/variants/:variantId', requireOwnedProduct, catalogue.deleteVariant);

router.get('/products/:id/media', requireOwnedProduct, catalogue.listMedia);
router.post('/products/:id/media', requireOwnedProduct, catalogue.createMedia);
router.delete('/products/:id/media/:mediaId', requireOwnedProduct, catalogue.deleteMedia);

// Addressed by the media row rather than its product, so its guard walks back
// to the owning product instead of reading :id as a product id.
router.patch('/media/:id/primary', requireOwnedMedia, catalogue.setPrimaryMedia);

// --- Stock ---

// listInventory prefers req.vendorId — set by attachVendor above — over any
// vendorId the caller sent, which is what makes reusing the admin list handler
// safe here. Express 5's req.query is a read-only getter, so rewriting the
// query string in middleware is not an option.
router.get('/inventory', inventory.listInventory);
router.get('/inventory/:id/movements', requireOwnedInventory, inventory.getMovements);
router.patch('/inventory/:id', requireOwnedInventory, inventory.adjustInventory);

module.exports = router;
