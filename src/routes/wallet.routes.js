const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const customerWallet = require('../controllers/customerWallet.controller');
const walletController = require('../controllers/wallet.controller');

const router = express.Router();

router.get('/', requireAuth, requireRole('vendor'), walletController.getWallet);
router.get('/transactions', requireAuth, requireRole('vendor'), walletController.getTransactions);

// Customer wallet. The vendor earnings wallet above keeps '/' and '/transactions'.
router.get('/me', requireAuth, requireRole('customer'), customerWallet.getBalance);
router.get('/me/transactions', requireAuth, requireRole('customer'), customerWallet.getTransactions);
router.post('/topup', requireAuth, requireRole('customer'), customerWallet.createTopup);
router.get('/topup/:id', requireAuth, requireRole('customer'), customerWallet.getTopup);

module.exports = router;
