const express = require('express');
const { requireAuth } = require('../middleware/auth');
const bookings = require('../controllers/serviceBookings.controller');

/**
 * A customer's service bookings (NS10); see services/serviceBookings.js.
 *   POST /api/bookings { serviceId, startsAt, visitAddress?, note? }
 *   GET  /api/bookings?status=pending|upcoming|active|past, GET /api/bookings/:id
 *   POST /api/bookings/:id/cancel { reason? }, POST /api/bookings/:id/reschedule { startsAt }
 */
const router = express.Router();

router.use(requireAuth);
router.get('/', bookings.customerList);
router.post('/', bookings.customerCreate);
router.get('/:id', bookings.customerGet);
router.post('/:id/cancel', bookings.customerCancel);
// SV5: another free time, same length.
router.post('/:id/reschedule', bookings.customerReschedule);
// SV7: pay a booking online (opens, or re-opens, its Razorpay order).
router.post('/:id/pay', bookings.customerPay);
// SV9: the invoice of a completed booking (JSON; ?format=pdf or /invoice.pdf for the file).
router.get('/:id/invoice', bookings.customerInvoice);
router.get('/:id/invoice.pdf', bookings.customerInvoice);

module.exports = router;
