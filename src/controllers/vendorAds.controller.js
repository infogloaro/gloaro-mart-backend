const pool = require('../config/db');
const pricing = require('../services/adPricing');
const campaigns = require('../services/adCampaigns');
const admin = require('./adCampaign.controller');

/**
 * Vendor portal → Advertise: a shop books, pays for and follows its own ads.
 * The same rules as the admin side (services/adCampaigns.js) — only who may
 * act differs: a shop sees and changes only its own campaigns, can't approve
 * or reject, and its bookings always wait for GLOARO's approval.
 * Contract: docs/ad-promotions-plan.md §8.
 */

const PAGE_SIZE = 20;
const run = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof campaigns.CampaignError || err instanceof pricing.QuoteError) {
      return res.status(err.status).json({ message: err.message, ...(err.quote ? { quote: err.quote } : {}) });
    }
    if (err.code === '23505') return res.status(409).json({ message: 'That was already done.' });
    throw err;
  }
};

/** The campaign, if it's this shop's. */
async function own(req) {
  const { rows } = await pool.query('SELECT id FROM ad_campaigns WHERE id = $1 AND vendor_id = $2', [Number(req.params.id), req.vendorId]);
  if (!rows[0]) throw new campaigns.CampaignError(404, 'Campaign not found');
  return rows[0].id;
}

const detail = async (res, id, status = 200) => res.status(status).json(await admin.loadDetail(id));

/** Everything the booking screen needs, in one call. */
const options = run(async (req, res) => {
  const [settings, levels, regions, placements, packages, categories] = await Promise.all([
    pool.query('SELECT * FROM ad_settings WHERE id = 1'),
    pool.query('SELECT key, label, description, min_hours FROM ad_levels WHERE active ORDER BY sort_order'),
    pool.query('SELECT id, level, name, parent_id, country_code, audience_estimate FROM ad_regions WHERE active ORDER BY level, name'),
    pool.query('SELECT key, name, description, formats, allowed_levels, sponsored_label FROM ad_placements WHERE active ORDER BY sort_order'),
    pool.query('SELECT * FROM ad_packages WHERE active ORDER BY sort_order'),
    pool.query('SELECT id, name FROM categories WHERE is_active ORDER BY sort_order, name'),
  ]);
  const s = settings.rows[0];
  res.json({
    models: { fixed: s.model_fixed, commission: s.model_commission, fixedCommission: s.model_fixed_commission, package: s.model_package },
    commissionPercent: Number(s.commission_percent),
    fixedCommissionPercent: Number(s.fixed_commission_percent),
    attributionDays: s.attribution_days,
    taxPercent: Number(s.tax_percent),
    taxLabel: s.tax_label,
    currency: s.currency,
    homeCountry: s.home_country,
    cancellationFeePercent: Number(s.cancellation_fee_percent),
    prorataRefund: s.prorata_refund,
    levels: levels.rows.map((l) => ({ key: l.key, label: l.label, description: l.description, minHours: l.min_hours })),
    regions: regions.rows.map((r) => ({ id: r.id, level: r.level, name: r.name, parentId: r.parent_id, countryCode: r.country_code, audienceEstimate: r.audience_estimate })),
    placements: placements.rows.map((p) => ({ key: p.key, name: p.name, description: p.description, formats: p.formats, allowedLevels: p.allowed_levels, sponsoredLabel: p.sponsored_label })),
    packages: packages.rows.map((p) => ({
      id: p.id, name: p.name, tier: p.tier, description: p.description, level: p.level, hours: p.hours, priceCents: p.price_cents,
      placements: p.placements, maxRegions: p.max_regions,
    })),
    categories: categories.rows,
  });
});

/** The price before booking — the shop's own deals (enterprise rules) apply. */
const quote = run(async (req, res) => {
  res.json(await pricing.quote({ ...(req.body ?? {}), vendorId: req.vendorId }));
});

const list = run(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [req.vendorId];
  let where = 'WHERE c.vendor_id = $1';
  if (req.query.status) {
    const s = String(req.query.status).split(',');
    if (s.some((x) => !admin.STATUSES.includes(x))) return res.status(400).json({ message: 'Unknown status' });
    params.push(s);
    where += ` AND c.status = ANY($${params.length})`;
  }
  const [{ rows }, { rows: count }, { rows: counts }] = await Promise.all([
    pool.query(`${admin.SELECT} ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(`SELECT COUNT(*)::int AS total FROM ad_campaigns c ${where}`, params),
    pool.query('SELECT status, COUNT(*)::int AS n FROM ad_campaigns WHERE vendor_id = $1 GROUP BY status', [req.vendorId]),
  ]);
  res.json({
    items: rows.map(admin.toJson),
    total: count[0].total,
    page,
    pageSize: PAGE_SIZE,
    counts: Object.fromEntries(admin.STATUSES.map((s) => [s, counts.find((x) => x.status === s)?.n ?? 0])),
  });
});

const get = run(async (req, res) => detail(res, await own(req)));

const create = run(async (req, res) => {
  // The shop is always the caller, whatever the body says.
  const id = await campaigns.createDraft({ body: { ...(req.body ?? {}), vendorId: req.vendorId }, userId: req.user.id, role: 'vendor' });
  await detail(res, id, 201);
});

const update = run(async (req, res) => {
  const id = await own(req);
  const { vendorId: _ignored, ...body } = req.body ?? {};
  void _ignored;
  await campaigns.updateDraft({ id, body, userId: req.user.id });
  await detail(res, id);
});

const addAsset = run(async (req, res) => {
  await campaigns.addAsset({ id: await own(req), body: req.body });
  await detail(res, Number(req.params.id), 201);
});

const removeAsset = run(async (req, res) => {
  await campaigns.removeAsset({ id: await own(req), assetId: req.params.assetId });
  await detail(res, Number(req.params.id));
});

const pay = run(async (req, res) => {
  const id = await own(req);
  const b = req.body ?? {};
  await campaigns.pay({
    id, method: b.method, reference: b.reference, acceptTotalCents: b.acceptTotalCents,
    idempotencyKey: req.get('idempotency-key') || b.idempotencyKey, userId: req.user.id, role: 'vendor',
  });
  await detail(res, id);
});

const pause = run(async (req, res) => {
  const id = await own(req);
  await campaigns.pause({ id, userId: req.user.id, role: 'vendor' });
  await detail(res, id);
});

const resume = run(async (req, res) => {
  const id = await own(req);
  await campaigns.resume({ id, userId: req.user.id, role: 'vendor' });
  await detail(res, id);
});

const cancel = run(async (req, res) => {
  const id = await own(req);
  await campaigns.cancel({ id, reason: req.body?.reason, userId: req.user.id, role: 'vendor' });
  await detail(res, id);
});

const extend = run(async (req, res) => {
  const id = await own(req);
  const b = req.body ?? {};
  await campaigns.extend({
    id, hours: b.hours, method: b.method, reference: b.reference, acceptTotalCents: b.acceptTotalCents,
    idempotencyKey: req.get('idempotency-key') || b.idempotencyKey, userId: req.user.id, role: 'vendor',
  });
  await detail(res, id);
});

const renew = run(async (req, res) => {
  const id = await own(req);
  const newId = await campaigns.renew({ id, startsAt: req.body?.startsAt, hours: req.body?.hours, userId: req.user.id, role: 'vendor' });
  await detail(res, newId, 201);
});

const stats = run(async (req, res) => {
  await own(req);
  // Same numbers the admin sees for the campaign.
  return require('./adDashboard.controller').campaignStats(req, res);
});

module.exports = { options, quote, list, get, create, update, addAsset, removeAsset, pay, pause, resume, cancel, extend, renew, stats };
