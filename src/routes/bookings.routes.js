const express = require('express');
const { requireAuth } = require('../middleware/auth');
const bookings = require('../controllers/serviceBookings.controller');

/**
 * A customer's service bookings (NS10); see services/serviceBookings.js.
 *   POST /api/bookings { serviceId, startsAt, visitAddress?, note? }
 *   GET  /api/bookings?status=pending|upcoming|active|past, GET /api/bookings/:id
 *   POST /api/bookings/:id/cancel { reason? }
 */
const router = express.Router();

router.use(requireAuth);
router.get('/', bookings.customerList);
router.post('/', bookings.customerCreate);
router.get('/:id', bookings.customerGet);
router.post('/:id/cancel', bookings.customerCancel);

module.exports = router;
