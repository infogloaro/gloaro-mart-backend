const express = require('express');
const { requireAuth } = require('../middleware/auth');
const cartController = require('../controllers/cart.controller');

const router = express.Router();

router.get('/', requireAuth, cartController.getCart);
router.post('/items', requireAuth, cartController.addItem);
router.patch('/items/:productId', requireAuth, cartController.updateItem);
router.delete('/items/:productId', requireAuth, cartController.removeItem);

module.exports = router;
