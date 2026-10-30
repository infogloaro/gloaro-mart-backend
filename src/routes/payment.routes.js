const express = require('express');
const { requireAuth } = require('../middleware/auth');
const paymentController = require('../controllers/payment.controller');

const router = express.Router();

// Deliberately unauthenticated: a gateway has no session. The signature check
// inside the handler is what makes this safe, and it runs before the body is
// treated as true.
router.post('/webhook/:provider', paymentController.handleWebhook);

// RZ3: which ways of paying checkout offers (no secrets).
router.get('/options', paymentController.paymentOptions);
// RZ2: the app's Razorpay success callback, checked server-side before anything counts.
router.post('/razorpay/verify', requireAuth, paymentController.verifyPayment);

router.get('/group/:groupId', requireAuth, paymentController.getPaymentForGroup);
router.post('/group/:groupId/attempts', requireAuth, paymentController.createAttempt);

module.exports = router;
