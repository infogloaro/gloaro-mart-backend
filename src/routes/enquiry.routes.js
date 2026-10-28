const express = require('express');
const { requireAuth } = require('../middleware/auth');
const enquiries = require('../controllers/shopEnquiries.controller');
const { uploadTo } = require('../controllers/upload.controller');

/**
 * "Ask the shop" for customers (SB9). The shop's side is under
 * /api/vendor/enquiries (vendorPortal.routes.js).
 *   GET  /api/enquiries/topics
 *   POST /api/enquiries { vendorId, topic, message, productId?, quantity?, fromAd? }
 *     topic 'service' (NS7): + serviceId, preferredDate, preferredSlot?, visitAddress?, photos[]?; message optional
 *   POST /api/enquiries/photos (multipart 'file') → { path } under /uploads/enquiries
 *   GET  /api/enquiries, GET /api/enquiries/:id
 *   POST /api/enquiries/:id/messages { message }, POST /api/enquiries/:id/close
 */
const router = express.Router();

router.get('/topics', enquiries.topics);
router.use(requireAuth);
router.get('/', enquiries.customerList);
router.post('/', enquiries.customerCreate);
// NS7: photos of the job for a service request, uploaded before sending.
router.post('/photos', uploadTo('enquiries'));
router.get('/:id', enquiries.customerGet);
router.post('/:id/messages', enquiries.customerReply);
router.post('/:id/close', enquiries.customerClose);
// NS9: rate the service once the shop marked it done (again = edit).
router.put('/:id/review', enquiries.customerReview);

module.exports = router;
