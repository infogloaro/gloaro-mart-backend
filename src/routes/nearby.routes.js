const express = require('express');
const { getNearbyVendors } = require('../controllers/nearby.controller');

const router = express.Router();

router.get('/vendors', getNearbyVendors);

module.exports = router;
