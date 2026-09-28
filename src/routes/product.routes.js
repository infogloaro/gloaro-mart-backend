const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const productController = require('../controllers/product.controller');
const { aiSearch } = require('../controllers/aiSearch.controller');
const productReview = require('../controllers/productReview.controller');
const search = require('../controllers/search.controller');

const router = express.Router();

router.post('/', requireAuth, requireRole('vendor'), productController.createProduct);
router.get('/mine', requireAuth, requireRole('vendor'), productController.getMyProducts);
router.post('/ai-search', aiSearch);
// Above '/:id' so 'search' is not read as a product id.
router.get('/search', search.searchProducts);
router.patch('/:id', requireAuth, requireRole('vendor'), productController.updateProduct);
router.delete('/:id', requireAuth, requireRole('vendor'), productController.deleteProduct);
router.get('/:id/tiers', productController.getTiers);
router.put('/:id/tiers', requireAuth, requireRole('vendor'), productController.setTiers);
router.get('/:id/reviews', productReview.listProductReviews);
router.put('/:id/review', requireAuth, requireRole('customer'), productReview.upsertProductReview);
router.get('/:id', productController.getProduct);
router.get('/', productController.listProducts);

module.exports = router;
