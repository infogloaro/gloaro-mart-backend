const adFixes = require('../services/adFixes');
const { recordAudit } = require('../services/auditLog');

/**
 * Repeated ad taps for review (SB10), under Admin → Ad Promotions (the
 * ad_promotions permission):
 *   GET  /api/admin/ads/click-review?days=&campaignId=&status=open|marked|all&minSession=&minAddress=
 *   POST /api/admin/ads/click-review/mark { campaignId, day, by: session|address, key, invalid, note? }
 */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof adFixes.AdFixError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

const listRepeatedTaps = handle(async (req, res) => {
  res.json(await adFixes.listRepeatedTaps(req.query));
});

const markTaps = handle(async (req, res) => {
  const body = req.body || {};
  const result = await adFixes.markTaps(body, req.user.id);
  if (result.changed) {
    await recordAudit({
      actorUserId: req.user.id,
      action: body.invalid ? 'ad.taps_invalidated' : 'ad.taps_restored',
      module: 'ad_promotions',
      entityType: 'ad_campaign',
      entityId: Number(body.campaignId),
      newValue: { day: body.day, by: body.by, key: body.key, note: body.note || null, ...result },
    });
  }
  res.json(result);
});

module.exports = { listRepeatedTaps, markTaps };
