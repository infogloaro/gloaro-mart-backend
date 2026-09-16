const express = require('express');
const { requireAuth } = require('../middleware/auth');
const wishlist = require('../controllers/wishlist.controller');

const router = express.Router();

// Every route is the caller's own list; there is no cross-user read.
router.get('/', requireAuth, wishlist.listWishlist);
// Literal path above '/:productId' so 'ids' is not read as a product id.
router.get('/ids', requireAuth, wishlist.listWishlistIds);
router.post('/', requireAuth, wishlist.addToWishlist);
router.delete('/:productId', requireAuth, wishlist.removeFromWishlist);

module.exports = router;
