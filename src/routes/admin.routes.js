const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const admin = require("../controllers/admin.controller");
const banner = require("../controllers/banner.controller");
const category = require("../controllers/category.controller");
const brand = require("../controllers/brand.controller");
const settings = require("../controllers/settings.controller");
const product = require("../controllers/product.controller");
const org = require("../controllers/org.controller");
const adminOrg = require("../controllers/adminOrg.controller");
const delivery = require("../controllers/deliverySettings.controller");
const payment = require("../controllers/payment.controller");
const returns = require("../controllers/returns.controller");
const catalogue = require("../controllers/catalogue.controller");
const inventory = require("../controllers/inventory.controller");
const matching = require("../controllers/matching.controller");
const commission = require("../controllers/commission.controller");
const kyc = require("../controllers/vendorKyc.controller");
const moderation = require("../controllers/moderation.controller");
const catalogueIo = require("../controllers/catalogueIo.controller");
const controlTower = require("../controllers/controlTower.controller");
const staff = require("../controllers/staff.controller");
const audit = require("../controllers/audit.controller");
const featureFlags = require("../controllers/featureFlag.controller");
const { requirePermission } = require("../middleware/rbac");

const router = express.Router();

router.use(requireAuth, requireRole("admin"));

// '/me' answers "what am I allowed to do", so it sits above the permission gate
// — a staff member with no role still has to be able to load the panel and be
// told that, rather than meeting a bare 403 at the door.
router.get("/me", staff.getMe);
router.get("/permissions", staff.listPermissions);

// Phase 15 — everything below is gated by the role's permissions.
router.use(requirePermission);
router.get("/audit-logs", audit.listAuditLogs);
router.get("/feature-flags", featureFlags.listFlags);
router.post("/feature-flags", featureFlags.createFlag);
router.patch("/feature-flags/:id", featureFlags.updateFlag);
router.delete("/feature-flags/:id", featureFlags.deleteFlag);

// Staff and roles. Guarded by 'staff.manage' via the prefix map.
router.get("/staff", staff.listStaff);
router.post("/staff", staff.createStaff);
router.patch("/staff/:id", staff.updateStaff);
router.delete("/staff/:id", staff.revokeStaff);

router.get("/roles", staff.listRoles);
router.post("/roles", staff.createRole);
router.patch("/roles/:id", staff.updateRole);
router.delete("/roles/:id", staff.deleteRole);

router.get("/users", admin.listUsers);
router.get("/users/:id", admin.getUser);
router.patch("/users/:id/role", admin.updateUserRole);

router.get("/vendors", admin.listVendors);
// Above every '/vendors/:id' form so 'performance' is not read as a vendor id.
router.get("/vendors/performance", matching.listVendorPerformance);
router.get("/vendors/kyc-summary", kyc.listKycSummary);
router.get("/vendors/:id/performance", matching.getVendorPerformance);
router.get("/vendors/:id/documents", kyc.listVendorDocuments);
router.post("/vendors/:id/documents", kyc.createDocument);
router.patch("/vendors/:id/status", admin.updateVendorStatus);
router.patch("/vendors/:id", admin.updateVendor);

// Sprint 5 — the weights every vendor is ranked by, and the log of what those
// weights decided.
// Phase 18 — the order control tower: purchases, not vendor orders.
router.get("/control-tower", controlTower.listGroups);
router.get("/control-tower/summary", controlTower.getSummary);

// Phase 17 — CSV in and out for the catalogue.
router.get("/catalogue/export", catalogueIo.exportCsv);
router.post("/catalogue/import", catalogueIo.importCsv);

// Phase 17 — the product review queue. Above '/products/:id' so 'moderation'
// and 'moderation-counts' are not read as product ids.
router.get("/products/moderation", moderation.listQueue);
router.get("/products/moderation-counts", moderation.getCounts);
router.patch("/products/:id/moderation", moderation.review);
router.delete("/products/:id/moderation", moderation.resetToPending);

// Phase 16 — the KYC review queue and the decisions taken on it.
router.get("/vendor-documents", kyc.listDocuments);
router.patch("/vendor-documents/:docId/status", kyc.reviewDocument);

// Phase 9 — what the platform keeps from a sale. '/resolve' sits above '/:id'
// so it is not read as a plan id.
router.get("/commission-plans/resolve", commission.resolvePlan);
router.get("/commission-plans", commission.listPlans);
router.post("/commission-plans", commission.createPlan);
router.patch("/commission-plans/:id", commission.updatePlan);
router.delete("/commission-plans/:id", commission.deletePlan);

router.get("/matching/weights", matching.getWeights);
router.put("/matching/weights", matching.updateWeights);
router.get("/matching/logs", matching.listLogs);

router.get("/orders", admin.listAllOrders);
router.get("/orders/:id", admin.getAnyOrder);
router.patch("/orders/:id/status", admin.updateOrderStatus);

router.get("/products", admin.listAllProducts);
router.post("/products", admin.createAnyProduct);
router.get("/products/:id/tiers", product.getTiers);
router.put("/products/:id/tiers", admin.setAnyProductTiers);

// Sprint 4 — a product's variants and media. All above '/products/:id' so the
// literal path segments are matched before :id swallows them.
router.get("/products/:id/variants", catalogue.listVariants);
router.post("/products/:id/variants", catalogue.createVariant);
router.patch("/products/:id/variants/:variantId", catalogue.updateVariant);
router.delete("/products/:id/variants/:variantId", catalogue.deleteVariant);

router.get("/products/:id/media", catalogue.listMedia);
router.post("/products/:id/media", catalogue.createMedia);
router.delete("/products/:id/media/:mediaId", catalogue.deleteMedia);

router.get("/products/:id", admin.getAnyProduct);
router.patch("/products/:id", admin.updateAnyProduct);
router.delete("/products/:id", admin.deleteAnyProduct);

// Promoting an image is addressed by the media row itself, not by its product —
// the caller has the id from the list above and the product is implied by it.
router.patch("/media/:id/primary", catalogue.setPrimaryMedia);

// Sprint 4 — attributes and their values.
router.get("/attributes", catalogue.listAttributes);
router.post("/attributes", catalogue.createAttribute);
router.get("/attributes/:id/values", catalogue.listAttributeValues);
router.post("/attributes/:id/values", catalogue.createAttributeValue);
router.patch("/attributes/:id/values/:valueId", catalogue.updateAttributeValue);
router.delete(
  "/attributes/:id/values/:valueId",
  catalogue.deleteAttributeValue,
);
router.patch("/attributes/:id", catalogue.updateAttribute);
router.delete("/attributes/:id", catalogue.deleteAttribute);

// Sprint 4 — stock. The movement log is the reason any figure here is what it is.
router.get("/inventory", inventory.listInventory);
router.get("/inventory/:id/movements", inventory.getMovements);
router.patch("/inventory/:id", inventory.adjustInventory);

router.get("/categories", category.listAllCategories);
router.post("/categories", category.createCategory);
router.patch("/categories/:id", category.updateCategory);
router.delete("/categories/:id", category.deleteCategory);

router.get("/brands", brand.listAllBrands);
router.post("/brands", brand.createBrand);
router.patch("/brands/:id", brand.updateBrand);
router.delete("/brands/:id", brand.deleteBrand);

router.get("/settings", settings.getSettings);
router.put("/settings", settings.updateSettings);

router.get("/coupons", admin.listPlatformCoupons);
router.post("/coupons", admin.createPlatformCoupon);
router.patch("/coupons/:id", admin.updatePlatformCoupon);
router.delete("/coupons/:id", admin.deletePlatformCoupon);

router.get("/reports/summary", admin.getPlatformSummary);

// Payments & refunds (Sprint 3). '/payments/:id' stays below the literal
// '/payments' list route, and refunds are raised against a payment.
router.get("/payments", payment.listPayments);
router.get("/payments/:id", payment.getPayment);
router.post("/payments/:id/refunds", payment.createRefund);
router.get("/refunds", payment.listRefunds);
// Deciding a refund someone else requested — a customer cancelling, or an
// approved return. Approving is what actually hands it to the provider.
router.post("/refunds/:id/approve", payment.approveRefund);
router.post("/refunds/:id/reject", payment.rejectRefund);

// Returns. Approving one raises the refund it entitles the customer to; that
// refund then goes through the approval above like any other.
router.get("/returns", returns.listReturns);
router.post("/returns/:returnId/approve", returns.approveReturn);
router.post("/returns/:returnId/reject", returns.rejectReturn);

// Organisation hierarchy. Creates reuse the member-facing handlers in
// org.controller; edits and deletes are admin-only and live in adminOrg.
router.get("/org/states", adminOrg.listStates);
router.post("/org/states", org.createState);
router.patch("/org/states/:id", adminOrg.updateState);
router.delete("/org/states/:id", adminOrg.deleteState);

router.get("/org/districts", adminOrg.listDistricts);
router.post("/org/districts", org.createDistrict);
router.patch("/org/districts/:id", adminOrg.updateDistrict);
router.delete("/org/districts/:id", adminOrg.deleteDistrict);

router.get("/org/chapters", adminOrg.listChapters);
router.post("/org/chapters", org.createChapter);
router.get("/org/chapters/:id/members", adminOrg.listChapterMembers);
router.delete(
  "/org/chapters/:id/members/:userId",
  adminOrg.removeChapterMember,
);
router.patch("/org/chapters/:id", adminOrg.updateChapter);
router.delete("/org/chapters/:id", adminOrg.deleteChapter);

router.get("/referrals", adminOrg.listReferrals);
router.get("/referrals/summary", adminOrg.getReferralSummary);
router.patch("/referrals/:id/status", adminOrg.updateReferralStatus);

router.get("/wallets", adminOrg.listWallets);
router.get("/wallets/:vendorId/transactions", adminOrg.getWalletTransactions);

router.get("/banners", banner.listAllBanners);
router.post("/banners", banner.createBanner);
router.patch("/banners/:id", banner.updateBanner);
router.delete("/banners/:id", banner.deleteBanner);

// Sprint 1 — admin override of any vendor's serviceability and delivery rules.
router.get("/vendors/:id/service-areas", delivery.adminGetAreas);
router.post("/vendors/:id/service-areas", delivery.adminAddArea);
router.delete("/vendors/:id/service-areas/:areaId", delivery.adminDeleteArea);
router.get("/vendors/:id/delivery-settings", delivery.adminGetSettings);
router.put("/vendors/:id/delivery-settings", delivery.adminUpdateSettings);

module.exports = router;
