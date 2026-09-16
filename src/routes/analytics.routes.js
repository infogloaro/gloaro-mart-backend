const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getVendorSummary } = require('../controllers/analytics.controller');

const router = express.Router();

router.get('/vendor/summary', requireAuth, getVendorSummary);

module.exports = router;
