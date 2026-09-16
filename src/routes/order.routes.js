const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const orderController = require('../controllers/order.controller');
const reassignment = require('../controllers/reassignment.controller');
const payment = require('../controllers/payment.controller');
const returns = require('../controllers/returns.controller');
const review = require('../controllers/review.controller');

const router = express.Router();

// Ids reach Postgres as query parameters, and a non-numeric one is a type
// error there, not a lookup miss — which surfaces as a 500 for what is really
// a malformed URL. Rejected up front so every :id route below answers 404.
const numericId = (req, res, next, value) =>
  /^\d+$/.test(value) ? next() : res.status(404).json({ message: 'Not found' });

router.param('id', numericId);
router.param('returnId', numericId);

router.post('/checkout', requireAuth, orderController.checkout);
router.get('/vendor', requireAuth, requireRole('vendor'), orderController.getVendorOrders);
// Literal paths stay above '/:id', or Express matches 'groups' as an order id.
router.get('/groups', requireAuth, orderController.getOrderGroups);
router.get('/groups/:id', requireAuth, orderController.getOrderGroup);
router.get('/groups/:id/reassignments', requireAuth, reassignment.listForGroup);
router.get('/', requireAuth, orderController.getMyOrders);
router.get('/:id/history', requireAuth, orderController.getOrderHistory);
// The customer's own view of money owed back to them, on their own order.
router.get('/:id/refunds', requireAuth, payment.listRefundsForOrder);
// Returns: raised against a delivered order, decided by an admin.
router.post('/:id/returns', requireAuth, returns.requestReturn);
router.get('/:id/returns', requireAuth, returns.listReturnsForOrder);
router.delete('/:id/returns/:returnId', requireAuth, returns.cancelReturn);
// Shop review, earned by a delivered order. PUT because there is one per
// order and changing your mind replaces it.
router.put('/:id/review', requireAuth, review.upsertReview);
router.get('/:id/review', requireAuth, review.getReviewForOrder);
router.get('/:id', requireAuth, orderController.getOrder);
router.patch('/:id/status', requireAuth, requireRole('vendor'), orderController.updateStatus);
// The customer's own cancel. Not a status PATCH: that route is the vendor's
// fulfilment path and is role-locked to them.
router.post('/:id/cancel', requireAuth, orderController.cancelOrder);
// Its own route, not a status value: 'I can't fill this' and 'this order is
// over' are different events, and only the first one re-routes.
router.post('/:id/reject', requireAuth, requireRole('vendor', 'admin'), reassignment.rejectOrder);

module.exports = router;
