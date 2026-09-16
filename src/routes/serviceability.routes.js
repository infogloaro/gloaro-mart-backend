const express = require('express');
const { requireAuth } = require('../middleware/auth');
const serviceability = require('../controllers/serviceability.controller');

const router = express.Router();

router.post('/check', requireAuth, serviceability.check);

module.exports = router;
