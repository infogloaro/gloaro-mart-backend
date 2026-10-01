const express = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const cartController = require('../controllers/cart.controller');

const router = express.Router();

// Logged-in users get a server-side cart; guests manage the cart on the device.
// optionalAuth attaches req.user when a valid token is present. When absent,
// the controller returns an empty cart — the app is expected to maintain a
// local cart and sync it after login.
router.get('/', optionalAuth, cartController.getCart);
router.post('/items', optionalAuth, cartController.addItem);
router.patch('/items/:productId', optionalAuth, cartController.updateItem);
router.delete('/items/:productId', optionalAuth, cartController.removeItem);

// Merge a guest's local cart into the server-side cart after login.
router.post('/merge', requireAuth, cartController.mergeCart);

module.exports = router;
