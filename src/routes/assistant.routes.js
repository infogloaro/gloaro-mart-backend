const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const assistant = require('../controllers/assistant.controller');

// The app's in-app shopping assistant. Signed in, it can also read the
// shopper's own orders.
const router = express.Router();

router.post('/chat', optionalAuth, assistant.chat);

module.exports = router;
