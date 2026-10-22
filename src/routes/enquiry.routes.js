const express = require('express');
const { requireAuth } = require('../middleware/auth');
const enquiries = require('../controllers/shopEnquiries.controller');

/**
 * "Ask the shop" for customers (SB9). The shop's side is under
 * /api/vendor/enquiries (vendorPortal.routes.js).
 *   GET  /api/enquiries/topics
 *   POST /api/enquiries { vendorId, topic, message, productId?, quantity?, fromAd? }
 *   GET  /api/enquiries, GET /api/enquiries/:id
 *   POST /api/enquiries/:id/messages { message }, POST /api/enquiries/:id/close
 */
const router = express.Router();

router.get('/topics', enquiries.topics);
router.use(requireAuth);
router.get('/', enquiries.customerList);
router.post('/', enquiries.customerCreate);
router.get('/:id', enquiries.customerGet);
router.post('/:id/messages', enquiries.customerReply);
router.post('/:id/close', enquiries.customerClose);

module.exports = router;
