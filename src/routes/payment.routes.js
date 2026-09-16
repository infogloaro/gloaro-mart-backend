const express = require('express');
const { requireAuth } = require('../middleware/auth');
const paymentController = require('../controllers/payment.controller');

const router = express.Router();

// Deliberately unauthenticated: a gateway has no session. The signature check
// inside the handler is what makes this safe, and it runs before the body is
// treated as true.
router.post('/webhook/:provider', paymentController.handleWebhook);

router.get('/group/:groupId', requireAuth, paymentController.getPaymentForGroup);
router.post('/group/:groupId/attempts', requireAuth, paymentController.createAttempt);

module.exports = router;
