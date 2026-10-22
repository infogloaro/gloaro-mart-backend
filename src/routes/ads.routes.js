const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const serving = require('../services/adServing');
const adFixes = require('../services/adFixes');

/**
 * Shop ads in the app (Ad Promotions). Public: signed-out shoppers see ads
 * too; signing in only lets a tap be credited to a later order.
 *   GET  /api/ads?placement=&lat=&lng=&city=&district=&state=&country=&categoryId=&limit=
 *   POST /api/ads/events  { sessionId, events: [{ campaignId, placement, type, at? }] }
 */
const router = express.Router();

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof serving.ServeError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

// A plain per-address limit on reports, as for analytics events.
const WINDOW_MS = 60000;
const MAX_PER_WINDOW = 120;
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 10000) for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
    return false;
  }
  h.n += 1;
  return h.n > MAX_PER_WINDOW;
}

router.get('/', handle(async (req, res) => {
  res.json(await serving.serve(req.query));
}));

router.post('/events', optionalAuth, handle(async (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ message: 'Too many ad reports — batch them.' });
  const accepted = await serving.recordEvents({
    sessionId: req.body?.sessionId,
    events: req.body?.events,
    userId: req.user?.id,
    ipHash: adFixes.ipHash(adFixes.clientIp(req)),
  });
  res.status(202).json({ accepted });
}));

module.exports = router;
