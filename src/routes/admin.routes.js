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
const matchingAdmin = require("../controllers/matchingAdmin.controller");
const commission = require("../controllers/commission.controller");
const kyc = require("../controllers/vendorKyc.controller");
const moderation = require("../controllers/moderation.controller");
const catalogueIo = require("../controllers/catalogueIo.controller");
const controlTower = require("../controllers/controlTower.controller");
const staff = require("../controllers/staff.controller");
const audit = require("../controllers/audit.controller");
const featureFlags = require("../controllers/featureFlag.controller");
const upload = require("../controllers/upload.controller");
const platformRegistry = require("../controllers/platformRegistry.controller");
const platformConnection = require("../controllers/platformConnection.controller");
const approval = require("../controllers/approval.controller");
const homeSections = require("../controllers/homeSection.controller");
const campaigns = require("../controllers/campaign.controller");
const review = require("../controllers/review.controller");
const cancellation = require("../controllers/cancellation.controller");
const support = require("../controllers/support.controller");
const shipment = require("../controllers/shipment.controller");
const deliveryPartner = require("../controllers/deliveryPartner.controller");
const invoice = require("../controllers/invoice.controller");
const creditNote = require("../controllers/creditNote.controller");
const settlement = require("../controllers/settlement.controller");
const replacement = require("../controllers/replacement.controller");
const businessAccounts = require("../controllers/business.controller");
const rfq = require("../controllers/rfq.controller");
const quotation = require("../controllers/quotation.controller");
const purchaseOrder = require("../controllers/purchaseOrder.controller");
const analyticsController = require("../controllers/analytics.controller");
const whatsappAdmin = require("../controllers/whatsapp.controller");
const adPricing = require("../controllers/adPricing.controller");
const adCampaign = require("../controllers/adCampaign.controller");
const adDashboard = require("../controllers/adDashboard.controller");
const adFixes = require("../controllers/adFixes.controller");
const offerModeration = require("../controllers/offerModeration.controller");
const platformHealthController = require("../controllers/platformHealth.controller");
const shopReports = require("../controllers/shopReports.controller");
const { requirePermission } = require("../middleware/rbac");

const router = express.Router();

router.use(requireAuth, requireRole("admin"));

// '/me' answers "what am I allowed to do", so it sits above the permission gate
// — a staff member with no role still has to be able to load the panel and be
// told that, rather than meeting a bare 403 at the door.
router.get("/me", staff.getMe);
router.post("/me/password/otp", staff.requestMyPasswordOtp);
router.post("/me/password/otp/confirm", staff.confirmMyPasswordOtp);
router.get("/permissions", staff.listPermissions);

// Phase 15 — everything below is gated by the role's permissions.
router.use(requirePermission);

// Above every other route so '/products/uploads' is never read as '/products/:id'.
// The first segment picks both the permission (via the gate above) and the folder.
router.post("/:area/uploads", upload.uploadImage);
router.get("/audit-logs", audit.listAuditLogs);
// Platform Registry. Deliberately absent from ROUTE_MODULES, so only a super
// admin passes requirePermission until per-category access lands (Phase 3).
router.get("/platform-categories", platformRegistry.listCategories);
router.post("/platform-categories", platformRegistry.createCategory);
router.patch("/platform-categories/:id", platformRegistry.updateCategory);
router.delete("/platform-categories/:id", platformRegistry.deleteCategory);
router.get("/platform-connectors", platformConnection.connectors);
router.get("/platform-health", platformHealthController.platformHealth);
router.get("/platforms", platformRegistry.listPlatforms);
router.post("/platforms", platformRegistry.createPlatform);
router.patch("/platforms/:id", platformRegistry.updatePlatform);
router.delete("/platforms/:id", platformRegistry.deletePlatform);
router.put("/platforms/:id/settings-form", platformConnection.updateSchema);
router.get("/platforms/:id/connections", platformConnection.listConnections);
router.put("/platforms/:id/connections/:environment", platformConnection.saveConnection);
router.post("/platforms/:id/connections/:environment/test", platformConnection.testConnection);
router.get("/platforms/:id/logs", platformConnection.listLogs);

// Approvals. Rules are unmapped in ROUTE_MODULES (super admin only); the
// request queue is open to all staff and filtered per person in the controller.
router.get("/approval-rules", approval.listRules);
router.patch("/approval-rules/:action", approval.updateRule);
router.get("/approvals", approval.listRequests);
router.post("/approvals/:id/approve", approval.approve);
router.post("/approvals/:id/reject", approval.reject);
router.post("/approvals/:id/cancel", approval.cancel);

// Campaigns — guarded by the campaigns permission module. /summary above /:id.
router.get("/campaigns", campaigns.listCampaigns);
router.get("/campaigns/summary", campaigns.campaignSummary);
router.post("/campaigns", campaigns.createCampaign);
router.get("/campaigns/:id", campaigns.getCampaign);
router.patch("/campaigns/:id", campaigns.updateCampaign);
router.post("/campaigns/:id/resume", campaigns.resumeCampaign);
router.post("/campaigns/:id/pause", campaigns.pauseCampaign);
router.post("/campaigns/:id/end", campaigns.endCampaign);
router.get("/campaigns/:id/candidates", campaigns.candidates);
router.post("/campaigns/:id/participants", campaigns.addParticipant);
router.patch("/campaigns/:id/participants/:participantId", campaigns.updateParticipant);
router.delete("/campaigns/:id/participants/:participantId", campaigns.removeParticipant);

// Cancellations — guarded by the cancellations permission module. Literal paths above /:id.
router.get("/cancellations", cancellation.listCancellations);
router.get("/cancellations/summary", cancellation.cancellationSummary);
router.get("/cancellations/rules", cancellation.getRules);
router.put("/cancellations/rules", cancellation.putRules);
router.post("/cancellations/:id/approve", cancellation.approveCancellation);
router.post("/cancellations/:id/reject", cancellation.rejectCancellation);

// Invoices & GST — guarded by the invoices permission module. Literal paths above /:id.
router.get("/invoices", invoice.listInvoices);
router.get("/invoices/summary", invoice.invoiceSummary);
router.get("/invoices/export", invoice.exportInvoices);
router.post("/invoices/issue", invoice.issueInvoice);
router.get("/invoices/:id", invoice.getInvoice);
router.post("/invoices/:id/cancel", invoice.cancelInvoice);

// Settlements — guarded by the settlements permission module. Literal paths above /:id.
router.get("/settlements", settlement.listSettlements);
router.get("/settlements/summary", settlement.settlementSummary);
router.post("/settlements/approve", settlement.approveSettlements);
router.post("/settlements/generate", settlement.generateNow);
router.put("/settlements/bank-accounts/:vendorId", settlement.adminSaveBankAccount);
router.get("/settlements/:id", settlement.getSettlement);
router.post("/settlements/:id/approve", settlement.approveSettlements);
router.post("/settlements/:id/hold", settlement.holdSettlement);
router.post("/settlements/:id/pay", settlement.paySettlement);
router.post("/settlements/:id/fail", settlement.failSettlement);
router.post("/settlements/:id/adjustments", settlement.addAdjustment);

// Credit notes — guarded by the credit_notes permission module. /summary above /:id.
router.get("/credit-notes", creditNote.listCreditNotes);
router.get("/credit-notes/summary", creditNote.creditNoteSummary);
router.post("/credit-notes", creditNote.createCreditNote);
router.get("/credit-notes/:id", creditNote.getCreditNote);
router.post("/credit-notes/:id/cancel", creditNote.cancel);

// Shipments — guarded by the shipments permission module. /summary above /:id.
router.get("/shipments", shipment.listShipments);
router.get("/shipments/summary", shipment.shipmentSummary);
router.get("/shipments/:id", shipment.getShipment);
router.patch("/shipments/:id", shipment.updateShipment);
router.post("/shipments/:id/events", shipment.recordEvent);
router.post("/shipments/:id/assign", shipment.assignPartner);
// Under /shipments so the shipments permission covers picking a partner.
router.get("/shipments/:id/partners", deliveryPartner.availableForShipment);

// Delivery partners — guarded by the delivery_partners permission module. Literal paths above /:id.
router.get("/delivery-partners", deliveryPartner.listPartners);
router.get("/delivery-partners/summary", deliveryPartner.partnerSummary);
router.post("/delivery-partners", deliveryPartner.createPartner);
router.get("/delivery-partners/:id", deliveryPartner.getPartner);
router.patch("/delivery-partners/:id", deliveryPartner.updatePartner);
router.post("/delivery-partners/:id/approve", deliveryPartner.approvePartner);
router.post("/delivery-partners/:id/reject", deliveryPartner.rejectPartner);
router.post("/delivery-partners/:id/suspend", deliveryPartner.suspendPartner);
router.post("/delivery-partners/:id/documents", deliveryPartner.addDocument);
router.patch("/delivery-partners/:id/documents/:docId", deliveryPartner.reviewDocument);
router.post("/delivery-partners/:id/cod-handovers", deliveryPartner.recordCodHandover);

// Support tickets — guarded by the support permission module. /summary above /:id.
router.get("/support/tickets", support.adminListTickets);
router.get("/support/tickets/summary", support.adminSummary);
router.get("/support/tickets/:id", support.adminGetTicket);
router.patch("/support/tickets/:id", support.adminUpdateTicket);
router.post("/support/tickets/:id/messages", support.adminAddMessage);
router.get("/support/agents", support.listAgents);

// Reviews & Ratings — guarded by the reviews permission module. /summary above /:id.
router.get("/reviews", review.adminListReviews);
router.get("/reviews/summary", review.adminSummary);
router.patch("/reviews/:id", review.adminModerate);
router.post("/reviews/:id/dismiss-reports", review.adminDismissReports);
router.delete("/reviews/:id/reply", review.adminDeleteReply);

// Home sections — guarded by the home_sections permission module.
router.get("/home-sections", homeSections.listSections);
router.post("/home-sections", homeSections.createSection);
router.put("/home-sections/order", homeSections.reorderSections);
router.patch("/home-sections/:id", homeSections.updateSection);
router.delete("/home-sections/:id", homeSections.deleteSection);
router.get("/home-sections/:id/candidates", homeSections.candidates);

router.get("/feature-flags", featureFlags.listFlags);
router.post("/feature-flags", featureFlags.createFlag);
router.patch("/feature-flags/:id", featureFlags.updateFlag);
router.delete("/feature-flags/:id", featureFlags.deleteFlag);

// Staff and roles. Guarded by 'staff.manage' via the prefix map.
router.get("/staff", staff.listStaff);
router.post("/staff", staff.createStaff);
router.patch("/staff/:id", staff.updateStaff);
router.patch("/staff/:id/password", staff.resetStaffPassword);
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
// Wrong-shop-details reports (SB7), under the vendors permission; above '/vendors/:id'.
router.get("/vendors/reports", shopReports.adminListReports);
router.get("/vendors/reports/:reportId", shopReports.adminGetReport);
router.patch("/vendors/reports/:reportId", shopReports.adminCloseReport);
router.get("/vendors/:id/performance", matching.getVendorPerformance);
router.get("/vendors/:id/documents", kyc.listVendorDocuments);
router.post("/vendors/:id/documents", kyc.createDocument);
router.patch("/vendors/:id/status", admin.updateVendorStatus);
router.patch("/vendors/:id", admin.updateVendor);
// Shop gallery (SB1): every photo with its status; hide one with a reason.
router.get("/vendors/:id/gallery", admin.getVendorGallery);
// Verified badge (SB2): hold it back with a reason, or release it.
router.patch("/vendors/:id/verification", admin.setVendorVerificationHold);
// Shop hours (SB3): see and set a shop's weekly timetable and timezone.
router.get("/vendors/:id/hours", admin.getVendorHours);
router.put("/vendors/:id/hours", admin.updateVendorHours);
router.patch("/vendors/:id/gallery/:photoId", admin.setVendorGalleryPhotoStatus);

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
// The admin page's rules, log and re-route queue (vendor_routing permission).
router.get("/matching/config", matchingAdmin.getConfig);
router.put("/matching/config", matchingAdmin.putConfig);
router.get("/matching/summary", matchingAdmin.matchingSummary);
router.get("/matching/logs", matchingAdmin.listLogs);
router.get("/matching/reassignments", matchingAdmin.listReassignments);
router.post("/matching/reassignments/:id/approve", matchingAdmin.approveReassignment);
router.post("/matching/reassignments/:id/reject", matchingAdmin.rejectReassignment);

router.get("/orders", admin.listAllOrders);
// Sales channels for the Orders filter, read from the Platform Registry. Under
// /orders so it needs orders.view, not registry access. Above /orders/:id.
router.get("/orders/channels", platformRegistry.listOrderChannels);
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

// SB6b: shops' public coupons, and hiding one from the offers list.
router.get("/coupons/shop", offerModeration.listShopCoupons);
router.patch("/coupons/shop/:id", offerModeration.setShopCouponHidden);
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
router.get("/returns/summary", returns.returnSummary);
router.get("/returns/:returnId", returns.getReturn);
router.post("/returns/:returnId/approve", returns.approveReturn);
router.post("/returns/:returnId/reject", returns.rejectReturn);
router.post("/returns/:returnId/receive", returns.receiveReturn);
router.post("/returns/:returnId/refund", returns.releaseRefund);

// RFQs — guarded by the rfq permission module. /summary above /:id.
router.get("/rfqs", rfq.adminList);
router.get("/rfqs/summary", rfq.adminSummary);
router.get("/rfqs/:id", rfq.adminGet);
router.post("/rfqs/:id/invite", rfq.adminInvite);
router.post("/rfqs/:id/close", rfq.adminClose);
router.post("/rfqs/:id/cancel", rfq.adminCancel);

// Quotations — guarded by the quotations permission module. /summary above /:id.
router.get("/quotations", quotation.adminList);
router.get("/quotations/summary", quotation.adminSummary);
router.get("/quotations/:id", quotation.adminGet);
router.post("/quotations/:id/award", quotation.adminAward);
router.post("/quotations/:id/reject", quotation.adminReject);
router.post("/quotations/:id/request-revision", quotation.adminRequestRevision);
router.post("/quotations/:id/messages", quotation.adminMessage);

// Channels and WhatsApp — guarded by the channels permission module.
router.get("/channels", whatsappAdmin.listChannels);
router.post("/channels/whatsapp/setup", whatsappAdmin.setupWhatsapp);
router.get("/channels/bot-keys", whatsappAdmin.listBotKeys);
router.post("/channels/bot-keys", whatsappAdmin.createBotKey);
router.delete("/channels/bot-keys/:id", whatsappAdmin.revokeBotKey);
router.get("/whatsapp/templates", whatsappAdmin.listTemplates);
router.post("/whatsapp/templates", whatsappAdmin.createTemplate);
router.post("/whatsapp/templates/sync", whatsappAdmin.syncTemplates);
router.patch("/whatsapp/templates/:id", whatsappAdmin.updateTemplate);
router.delete("/whatsapp/templates/:id", whatsappAdmin.deleteTemplate);
router.post("/whatsapp/templates/:id/submit", whatsappAdmin.submitTemplate);
router.get("/whatsapp/rules", whatsappAdmin.listRules);
router.patch("/whatsapp/rules/:event", whatsappAdmin.updateRule);
router.get("/whatsapp/messages", whatsappAdmin.listMessages);
router.post("/whatsapp/messages/:id/retry", whatsappAdmin.retryMessage);
router.post("/whatsapp/test-send", whatsappAdmin.testSend);

// Ad Promotions pricing — guarded by the ad_promotions permission module.
router.get("/ads/settings", adPricing.getSettings);
router.patch("/ads/settings", adPricing.updateSettings);
router.get("/ads/levels", adPricing.listLevels);
router.patch("/ads/levels/:key", adPricing.updateLevel);
router.post("/ads/packs", adPricing.createPack);
router.patch("/ads/packs/:id", adPricing.updatePack);
router.delete("/ads/packs/:id", adPricing.deletePack);
router.get("/ads/regions", adPricing.listRegions);
router.post("/ads/regions", adPricing.createRegion);
router.patch("/ads/regions/:id", adPricing.updateRegion);
router.delete("/ads/regions/:id", adPricing.deleteRegion);
router.get("/ads/placements", adPricing.listPlacements);
router.post("/ads/placements", adPricing.createPlacement);
router.patch("/ads/placements/:key", adPricing.updatePlacement);
router.get("/ads/rules", adPricing.listRules);
router.post("/ads/rules", adPricing.createRule);
router.patch("/ads/rules/:id", adPricing.updateRule);
router.delete("/ads/rules/:id", adPricing.deleteRule);
router.get("/ads/packages", adPricing.listPackages);
router.post("/ads/packages", adPricing.createPackage);
router.patch("/ads/packages/:id", adPricing.updatePackage);
router.get("/ads/coupons", adPricing.listCoupons);
router.post("/ads/coupons", adPricing.createCoupon);
router.patch("/ads/coupons/:id", adPricing.updateCoupon);
router.get("/ads/options", adPricing.options);
router.post("/ads/quote", adPricing.quote);
// Ad campaigns and their money. Fixed paths above /:id.
router.get("/ads/dashboard", adDashboard.dashboard);
router.get("/ads/export", adDashboard.exportCsv);
router.get("/ads/campaigns/:id/stats", adDashboard.campaignStats);
router.get("/ads/payments", adCampaign.payments);
router.post("/ads/payments/:paymentId/confirm", adCampaign.confirmPayment);
router.post("/ads/refunds/:refundId/complete", adCampaign.completeRefund);
router.get("/ads/campaigns", adCampaign.list);
router.post("/ads/campaigns", adCampaign.create);
router.get("/ads/campaigns/:id", adCampaign.get);
router.patch("/ads/campaigns/:id", adCampaign.update);
router.get("/ads/campaigns/:id/quote", adCampaign.requote);
router.post("/ads/campaigns/:id/assets", adCampaign.addAsset);
router.delete("/ads/campaigns/:id/assets/:assetId", adCampaign.removeAsset);
router.post("/ads/campaigns/:id/pay", adCampaign.pay);
router.post("/ads/campaigns/:id/approve", adCampaign.approve);
router.post("/ads/campaigns/:id/reject", adCampaign.reject);
router.post("/ads/campaigns/:id/pause", adCampaign.pause);
router.post("/ads/campaigns/:id/resume", adCampaign.resume);
router.post("/ads/campaigns/:id/cancel", adCampaign.cancel);
router.post("/ads/campaigns/:id/extend", adCampaign.extend);
router.post("/ads/campaigns/:id/renew", adCampaign.renew);
// SB10: repeated taps on one ad, reviewed and marked "don't bill".
router.get("/ads/click-review", adFixes.listRepeatedTaps);
router.post("/ads/click-review/mark", adFixes.markTaps);

// Analytics — guarded by the analytics permission module.
router.get("/analytics", analyticsController.adminAnalytics);

// Purchase orders — guarded by the purchase_orders permission module. /summary above /:id.
router.get("/purchase-orders", purchaseOrder.adminList);
router.get("/purchase-orders/summary", purchaseOrder.adminSummary);
router.get("/purchase-orders/:id", purchaseOrder.adminGet);
router.post("/purchase-orders/:id/resend", purchaseOrder.adminResend);
router.post("/purchase-orders/:id/cancel", purchaseOrder.adminCancel);
router.post("/purchase-orders/:id/close", purchaseOrder.adminClose);

// Business accounts — guarded by the business_accounts permission module. /summary above /:id.
router.get("/business-accounts", businessAccounts.adminList);
router.get("/business-accounts/summary", businessAccounts.adminSummary);
router.get("/business-accounts/:id", businessAccounts.adminGet);
router.post("/business-accounts/:id/verify", businessAccounts.adminVerify);
router.post("/business-accounts/:id/reject", businessAccounts.adminReject);
router.post("/business-accounts/:id/suspend", businessAccounts.adminSuspend);
router.patch("/business-accounts/:id/credit", businessAccounts.adminSetCredit);
router.post("/business-accounts/:id/payments", businessAccounts.adminRecordPayment);

// Replacements — guarded by the replacements permission module. /summary above /:id.
router.get("/replacements", replacement.listReplacements);
router.get("/replacements/summary", replacement.replacementSummary);
router.get("/replacements/:id", replacement.getReplacement);
router.post("/replacements/:id/approve", replacement.approveReplacement);
router.post("/replacements/:id/reassign", replacement.reassignReplacement);
router.post("/replacements/:id/cancel", replacement.cancelReplacement);

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
