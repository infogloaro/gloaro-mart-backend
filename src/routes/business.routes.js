const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const business = require('../controllers/business.controller');
const rfq = require('../controllers/rfq.controller');
const quotation = require('../controllers/quotation.controller');
const purchaseOrder = require('../controllers/purchaseOrder.controller');
const { uploadTo } = require('../controllers/upload.controller');

/** A customer's business account: registering it, its team, addresses and credit statement. */
const router = express.Router();
router.use(requireAuth, requireRole('customer'));

// Returns { path } for a document's fileUrl.
router.post('/uploads', uploadTo('business'));
router.post('/accounts', business.registerAccount);
router.get('/me', business.getMine);
router.patch('/me', business.updateMine);
router.get('/me/statement', business.myStatement);
router.post('/me/members', business.addMember);
router.patch('/me/members/:memberId', business.updateMember);
router.delete('/me/members/:memberId', business.removeMember);
router.post('/me/addresses', business.addAddress);
router.delete('/me/addresses/:addressId', business.removeAddress);
router.post('/me/documents', business.addDocument);

// Requests for quotation raised by the business.
router.get('/rfqs', rfq.businessList);
router.post('/rfqs', rfq.businessCreate);
router.get('/rfqs/:id', rfq.businessGet);
router.post('/rfqs/:id/cancel', rfq.businessCancel);
// Deciding on the quotes received. Accept/reject need an owner or approver.
router.get('/quotations/:id', quotation.buyerGet);
router.post('/quotations/:id/accept', quotation.buyerAccept);
router.post('/quotations/:id/reject', quotation.buyerReject);
router.post('/quotations/:id/request-revision', quotation.buyerRequestRevision);
router.post('/quotations/:id/messages', quotation.buyerMessage);
// Purchase orders from awarded quotes. Cancel/close need an owner or approver.
router.get('/purchase-orders', purchaseOrder.buyerList);
router.get('/purchase-orders/:id', purchaseOrder.buyerGet);
router.post('/purchase-orders/:id/cancel', purchaseOrder.buyerCancel);
router.post('/purchase-orders/:id/close', purchaseOrder.buyerClose);

module.exports = router;
