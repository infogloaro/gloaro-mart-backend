const express = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { getVendorSummary, postEvents } = require('../controllers/analytics.controller');

const router = express.Router();

router.get('/vendor/summary', requireAuth, getVendorSummary);
// App sessions and funnel steps, signed in or not (Admin → Analytics).
router.post('/events', optionalAuth, postEvents);

module.exports = router;
