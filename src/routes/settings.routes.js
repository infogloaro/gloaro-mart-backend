const express = require('express');
const settings = require('../controllers/settings.controller');

const router = express.Router();

router.get('/', settings.getPublicSettings);

module.exports = router;
