const express = require('express');
const services = require('../controllers/services.controller');
const enquiries = require('../controllers/shopEnquiries.controller');
const bookings = require('../controllers/serviceBookings.controller');

/** Local services on Near Me (NS1); see services.controller.js. */
const router = express.Router();

router.get('/categories', services.categories);
router.get('/', services.list);
// SV3: the first free time of each service on a list page.
router.get('/next-slots', bookings.nextSlots);
router.get('/:id/reviews', enquiries.serviceReviewsList);
// NS10: free times to book.
router.get('/:id/slots', bookings.slots);
router.get('/:id/availability', bookings.availability);
router.get('/:id', services.getOne);

module.exports = router;
