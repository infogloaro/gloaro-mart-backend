const express = require('express');
const banner = require('../controllers/banner.controller');

const router = express.Router();

router.get('/', banner.listActiveBanners);

module.exports = router;
