const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const walletController = require('../controllers/wallet.controller');

const router = express.Router();

router.get('/', requireAuth, requireRole('vendor'), walletController.getWallet);
router.get('/transactions', requireAuth, requireRole('vendor'), walletController.getTransactions);

module.exports = router;
