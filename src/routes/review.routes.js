const express = require('express');
const { requireAuth } = require('../middleware/auth');
const review = require('../controllers/review.controller');
const { uploadTo } = require('../controllers/upload.controller');

/**
 * What a signed-in customer does with reviews once they exist. Leaving one is
 * under the thing reviewed: PUT /api/orders/:id/review (the shop) and
 * PUT /api/products/:id/review (a product).
 */
const router = express.Router();
router.use(requireAuth);

// Above '/:id' routes. Returns { path } to send in a review's photos array.
router.post('/photos', uploadTo('reviews'));
router.delete('/:id', review.deleteMyReview);
router.post('/:id/report', review.reportReview);
router.post('/:id/helpful', review.markHelpful);
router.delete('/:id/helpful', review.unmarkHelpful);

module.exports = router;
