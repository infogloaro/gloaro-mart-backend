const express = require('express');
const botAccess = require('../services/botAccess');

/**
 * The Gloaro WhatsApp bot's door into Gloaro Mart. Every call carries
 * X-Bot-Key (Admin → Channels → Bot access). The session it opens is a normal
 * customer login, used on /api/products, /api/cart, /api/addresses,
 * /api/orders — the app's own APIs. Contract: docs/whatsapp-plan.md §4.
 */
const router = express.Router();

router.use(async (req, res, next) => {
  const key = await botAccess.verifyKey(req.get('x-bot-key'));
  if (!key) return res.status(401).json({ message: 'A valid X-Bot-Key is required.' });
  req.botKey = key;
  next();
});

const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof botAccess.BotError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

// { phone, name? } → { token, expiresAt, salesChannel, customer }
router.post('/session', handle((req) => botAccess.openSession({ phone: req.body?.phone, name: req.body?.name })));
// The customer wrote STOP / START.
router.post('/opt-out', handle((req) => botAccess.setOptIn({ phone: req.body?.phone, optIn: false })));
router.post('/opt-in', handle((req) => botAccess.setOptIn({ phone: req.body?.phone, optIn: true })));

module.exports = router;
