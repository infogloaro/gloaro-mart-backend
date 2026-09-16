const express = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const matching = require('../controllers/matching.controller');
const reassignment = require('../controllers/reassignment.controller');

const router = express.Router();

// Ranking a basket needs an address, and an address needs an owner.
router.post('/vendors', requireAuth, matching.rankVendors);

// 'Also available at' is public — the product screen shows it before sign-in.
// optionalAuth so a signed-in caller can still pass an addressId and get a real
// serviceability check rather than an unjudged list.
router.get('/alternatives/:productId', optionalAuth, matching.alternatives);

// Reassignments the customer still has to decide on.
router.get('/reassignments', requireAuth, reassignment.listPending);
router.post('/reassignments/:id/respond', requireAuth, reassignment.respond);

module.exports = router;
