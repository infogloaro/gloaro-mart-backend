const express = require('express');
const { requireAuth } = require('../middleware/auth');
const i18n = require('../controllers/i18n.controller');

// App languages (LG1). The admin side is under /api/admin/languages.
const router = express.Router();

router.get('/', i18n.getPublic);
router.put('/me', requireAuth, i18n.setMine);

module.exports = router;
