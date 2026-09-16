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
