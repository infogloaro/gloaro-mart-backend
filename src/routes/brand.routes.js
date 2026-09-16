const express = require('express');
const brand = require('../controllers/brand.controller');

const router = express.Router();

router.get('/', brand.listActiveBrands);

module.exports = router;
