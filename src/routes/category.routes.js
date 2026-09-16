const express = require('express');
const category = require('../controllers/category.controller');

const router = express.Router();

router.get('/', category.listActiveCategories);

module.exports = router;
