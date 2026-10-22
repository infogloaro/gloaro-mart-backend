const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const rewards = require('../controllers/rewards.controller');

const router = express.Router();

// Reward points (SB11). The admin rules are under /api/admin/rewards/settings.
router.get('/me', requireAuth, requireRole('customer'), rewards.getMine);
router.get('/me/transactions', requireAuth, requireRole('customer'), rewards.getMyTransactions);

module.exports = router;
