const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const pricing = require('../services/adPricing');
const { ALL_LEVELS } = require('../services/adSeeds');

/**
 * Admin → Ad Promotions → Pricing setup: the price list behind every ad
 * booking, and the calculator that prices one. Rules in services/adPricing.js;
 * plan in docs/ad-promotions-plan.md.
 */

class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const run = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof InputError || err instanceof pricing.QuoteError) return res.status(err.status).json({ message: err.message });
    if (err.code === '23505') return res.status(409).json({ message: 'That already exists.' });
    if (err.code === '23503') return res.status(409).json({ message: 'It is still in use, so it can’t be removed — switch it off instead.' });
    if (err.code === '23514') return res.status(400).json({ message: 'A value is out of range.' });
    throw err;
  }
};
const audit = (req, action, entityType, entityId, newValue, previousValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: 'ad_promotions', entityType, entityId, newValue, previousValue });

// ------------------------------------------------------------ input helpers

const has = (b, k) => b[k] !== undefined;
function text(v, label, max, { required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new InputError(`${label} is required.`);
  if (s.length > max) throw new InputError(`${label} is at most ${max} characters.`);
  return s || null;
}
function int(v, label, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (nullable && (v === null || v === '')) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}
function num(v, label, { min, max }) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new InputError(`${label} must be between ${min} and ${max}.`);
  return Math.round(n * 1000) / 1000;
}
const bool = (v, label) => {
  if (typeof v !== 'boolean') throw new InputError(`${label} is on or off.`);
  return v;
};
function date(v, label) {
  if (v === null || v === '') return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new InputError(`${label} is not a valid date.`);
  return new Date(t).toISOString();
}
const levels = (list, label) => {
  if (!Array.isArray(list) || list.some((l) => !ALL_LEVELS.includes(l))) throw new InputError(`${label} must be a list of: ${ALL_LEVELS.join(', ')}.`);
  return [...new Set(list)];
};

/** Builds "SET a = $2, b = $3" from the fields present; returns [sql, values]. */
function setClause(fields, startAt = 2) {
  const keys = Object.keys(fields);
  if (!keys.length) throw new InputError('Nothing to change.');
  return [keys.map((k, i) => `${k} = $${i + startAt}`).join(', '), keys.map((k) => fields[k])];
}

// ------------------------------------------------------------------ settings

const settingsJson = (s) => ({
  models: { fixed: s.model_fixed, commission: s.model_commission, fixedCommission: s.model_fixed_commission, package: s.model_package },
  commissionPercent: Number(s.commission_percent),
  fixedCommissionPercent: Number(s.fixed_commission_percent),
  attributionDays: s.attribution_days,
  taxPercent: Number(s.tax_percent),
  taxLabel: s.tax_label,
  sacCode: s.sac_code,
  currency: s.currency,
  homeCountry: s.home_country,
  minChargeCents: s.min_charge_cents,
  minBudgetCents: s.min_budget_cents,
  maxBudgetCents: s.max_budget_cents,
  maxHours: s.max_hours,
  cancellationFeePercent: Number(s.cancellation_fee_percent),
  prorataRefund: s.prorata_refund,
  updatedAt: s.updated_at,
});

const getSettings = run(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ad_settings WHERE id = 1');
  if (!rows[0]) throw new InputError('Ad pricing is not set up — run npm run migrate:ads.', 503);
  res.json(settingsJson(rows[0]));
});

const updateSettings = run(async (req, res) => {
  const b = req.body ?? {};
  const f = {};
  const m = b.models ?? {};
  if (has(m, 'fixed')) f.model_fixed = bool(m.fixed, 'Fixed fee');
  if (has(m, 'commission')) f.model_commission = bool(m.commission, 'Commission');
  if (has(m, 'fixedCommission')) f.model_fixed_commission = bool(m.fixedCommission, 'Fixed + commission');
  if (has(m, 'package')) f.model_package = bool(m.package, 'Packages');
  if (has(b, 'commissionPercent')) f.commission_percent = num(b.commissionPercent, 'Commission %', { min: 0, max: 100 });
  if (has(b, 'fixedCommissionPercent')) f.fixed_commission_percent = num(b.fixedCommissionPercent, 'Fixed + commission %', { min: 0, max: 100 });
  if (has(b, 'attributionDays')) f.attribution_days = int(b.attributionDays, 'Attribution days', { min: 1, max: 90 });
  if (has(b, 'taxPercent')) f.tax_percent = num(b.taxPercent, 'Tax %', { min: 0, max: 50 });
  if (has(b, 'taxLabel')) f.tax_label = text(b.taxLabel, 'Tax label', 20, { required: true });
  if (has(b, 'sacCode')) f.sac_code = text(b.sacCode, 'SAC code', 10, { required: true });
  if (has(b, 'minChargeCents')) f.min_charge_cents = int(b.minChargeCents, 'Minimum charge');
  if (has(b, 'minBudgetCents')) f.min_budget_cents = int(b.minBudgetCents, 'Minimum budget');
  if (has(b, 'maxBudgetCents')) f.max_budget_cents = int(b.maxBudgetCents, 'Maximum budget', { min: 1 });
  if (has(b, 'maxHours')) f.max_hours = int(b.maxHours, 'Longest campaign (hours)', { min: 1, max: 87600 });
  if (has(b, 'cancellationFeePercent')) f.cancellation_fee_percent = num(b.cancellationFeePercent, 'Cancellation fee %', { min: 0, max: 100 });
  if (has(b, 'prorataRefund')) f.prorata_refund = bool(b.prorataRefund, 'Pro-rata refund');
  const { rows: before } = await pool.query('SELECT * FROM ad_settings WHERE id = 1');
  const minB = f.min_budget_cents ?? before[0].min_budget_cents;
  const maxB = f.max_budget_cents ?? before[0].max_budget_cents;
  if (minB > maxB) throw new InputError('The minimum budget is above the maximum.');
  const enabled = ['model_fixed', 'model_commission', 'model_fixed_commission', 'model_package'].some((k) => (f[k] ?? before[0][k]));
  if (!enabled) throw new InputError('Keep at least one pricing model switched on.');
  const [set, values] = setClause({ ...f, updated_by: req.user.id }, 1);
  const { rows } = await pool.query(`UPDATE ad_settings SET ${set}, updated_at = now() WHERE id = 1 RETURNING *`, values);
  await audit(req, 'ads.settings_changed', 'ad_settings', 1, f);
  res.json(settingsJson(rows[0]));
});

// ------------------------------------------------- levels and duration packs

const levelJson = (l, packs) => ({
  key: l.key, label: l.label, description: l.description, minHours: l.min_hours, active: l.active, sortOrder: l.sort_order,
  packs: packs.filter((p) => p.level === l.key).map((p) => ({ id: p.id, hours: p.hours, priceCents: p.price_cents, active: p.active })),
});

const listLevels = run(async (req, res) => {
  const [{ rows: lv }, { rows: packs }] = await Promise.all([
    pool.query('SELECT * FROM ad_levels ORDER BY sort_order'),
    pool.query('SELECT * FROM ad_rate_packs ORDER BY level, hours'),
  ]);
  res.json(lv.map((l) => levelJson(l, packs)));
});

const updateLevel = run(async (req, res) => {
  const b = req.body ?? {};
  const f = {};
  if (has(b, 'label')) f.label = text(b.label, 'Label', 40, { required: true });
  if (has(b, 'description')) f.description = text(b.description, 'Description', 300);
  if (has(b, 'minHours')) f.min_hours = int(b.minHours, 'Minimum hours', { min: 1, max: 8760 });
  if (has(b, 'active')) f.active = bool(b.active, 'Active');
  const [set, values] = setClause(f);
  const { rows } = await pool.query(`UPDATE ad_levels SET ${set} WHERE key = $1 RETURNING *`, [req.params.key, ...values]);
  if (!rows[0]) throw new InputError('Unknown level', 404);
  await audit(req, 'ads.level_changed', 'ad_level', rows[0].key, f);
  const { rows: packs } = await pool.query('SELECT * FROM ad_rate_packs WHERE level = $1 ORDER BY hours', [rows[0].key]);
  res.json(levelJson(rows[0], packs));
});

const createPack = run(async (req, res) => {
  const b = req.body ?? {};
  if (!ALL_LEVELS.includes(b.level)) throw new InputError('Choose a level.');
  const { rows } = await pool.query(
    'INSERT INTO ad_rate_packs (level, hours, price_cents) VALUES ($1, $2, $3) RETURNING *',
    [b.level, int(b.hours, 'Hours', { min: 1, max: 8760 }), int(b.priceCents, 'Price', { min: 1 })]
  );
  await audit(req, 'ads.pack_created', 'ad_rate_pack', rows[0].id, rows[0]);
  res.status(201).json({ id: rows[0].id, level: rows[0].level, hours: rows[0].hours, priceCents: rows[0].price_cents, active: rows[0].active });
});

const updatePack = run(async (req, res) => {
  const b = req.body ?? {};
  const f = {};
  if (has(b, 'hours')) f.hours = int(b.hours, 'Hours', { min: 1, max: 8760 });
  if (has(b, 'priceCents')) f.price_cents = int(b.priceCents, 'Price', { min: 1 });
  if (has(b, 'active')) f.active = bool(b.active, 'Active');
  const [set, values] = setClause(f);
  const { rows: before } = await pool.query('SELECT * FROM ad_rate_packs WHERE id = $1', [Number(req.params.id)]);
  if (!before[0]) throw new InputError('Price not found', 404);
  const { rows } = await pool.query(`UPDATE ad_rate_packs SET ${set} WHERE id = $1 RETURNING *`, [before[0].id, ...values]);
  await audit(req, 'ads.pack_changed', 'ad_rate_pack', rows[0].id, f, { hours: before[0].hours, price_cents: before[0].price_cents });
  res.json({ id: rows[0].id, level: rows[0].level, hours: rows[0].hours, priceCents: rows[0].price_cents, active: rows[0].active });
});

const deletePack = run(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM ad_rate_packs WHERE id = $1 RETURNING *', [Number(req.params.id)]);
  if (!rows[0]) throw new InputError('Price not found', 404);
  await audit(req, 'ads.pack_deleted', 'ad_rate_pack', rows[0].id, null, rows[0]);
  res.json({ deleted: true });
});

// ------------------------------------------------------------------- regions

const LEVEL_PARENT = { country: null, state: 'country', district: 'state', city: 'district', locality: 'city' };
const regionJson = (r) => ({
  id: r.id, level: r.level, name: r.name, parentId: r.parent_id, countryCode: r.country_code,
  latitude: r.latitude, longitude: r.longitude, radiusKm: r.radius_km == null ? null : Number(r.radius_km),
  audienceEstimate: r.audience_estimate, priceMultiplier: Number(r.price_multiplier), active: r.active,
  childCount: r.child_count ?? 0,
});

const listRegions = run(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, (SELECT COUNT(*)::int FROM ad_regions c WHERE c.parent_id = r.id) AS child_count
     FROM ad_regions r ORDER BY r.level <> 'country', r.name`
  );
  res.json(rows.map(regionJson));
});

async function regionFields(b, existing) {
  const f = {};
  const level = existing?.level ?? b.level;
  if (!existing) {
    if (!(level in LEVEL_PARENT)) throw new InputError('level is country, state, district, city or locality.');
    f.level = level;
  }
  if (has(b, 'name') || !existing) f.name = text(b.name, 'Name', 120, { required: true });
  if (has(b, 'parentId') || !existing) {
    const want = LEVEL_PARENT[level];
    if (want === null) f.parent_id = null;
    else {
      const { rows } = await pool.query('SELECT id, level, country_code FROM ad_regions WHERE id = $1', [Number(b.parentId)]);
      if (!rows[0] || rows[0].level !== want) throw new InputError(`A ${level} sits inside a ${want}.`);
      f.parent_id = rows[0].id;
      f.country_code = rows[0].country_code;
    }
  }
  if (level === 'country' && (has(b, 'countryCode') || !existing)) {
    const cc = String(b.countryCode ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) throw new InputError('Country code is two letters, e.g. IN, AE.');
    f.country_code = cc;
  }
  for (const [k, col, lo, hi] of [['latitude', 'latitude', -90, 90], ['longitude', 'longitude', -180, 180]]) {
    if (has(b, k)) f[col] = b[k] === null || b[k] === '' ? null : num(b[k], k, { min: lo, max: hi });
  }
  if (has(b, 'radiusKm')) f.radius_km = b.radiusKm === null || b.radiusKm === '' ? null : num(b.radiusKm, 'Radius (km)', { min: 0.1, max: 500 });
  if (has(b, 'audienceEstimate')) f.audience_estimate = int(b.audienceEstimate, 'Audience estimate', { nullable: true });
  if (has(b, 'priceMultiplier')) f.price_multiplier = num(b.priceMultiplier, 'Price multiplier', { min: 0.01, max: 100 });
  if (has(b, 'active')) f.active = bool(b.active, 'Active');
  if (level === 'locality') {
    const lat = f.latitude ?? existing?.latitude;
    const lng = f.longitude ?? existing?.longitude;
    const rad = f.radius_km ?? existing?.radius_km;
    if (lat == null || lng == null || rad == null) throw new InputError('A locality needs a map point (latitude, longitude) and a radius.');
  }
  return f;
}

const createRegion = run(async (req, res) => {
  const f = await regionFields(req.body ?? {}, null);
  const keys = Object.keys(f);
  const { rows } = await pool.query(
    `INSERT INTO ad_regions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => f[k])
  );
  await audit(req, 'ads.region_created', 'ad_region', rows[0].id, f);
  res.status(201).json(regionJson(rows[0]));
});

const updateRegion = run(async (req, res) => {
  const { rows: cur } = await pool.query('SELECT * FROM ad_regions WHERE id = $1', [Number(req.params.id)]);
  if (!cur[0]) throw new InputError('Region not found', 404);
  const f = await regionFields(req.body ?? {}, cur[0]);
  const [set, values] = setClause(f);
  const { rows } = await pool.query(`UPDATE ad_regions SET ${set}, updated_at = now() WHERE id = $1 RETURNING *`, [cur[0].id, ...values]);
  await audit(req, 'ads.region_changed', 'ad_region', rows[0].id, f);
  res.json(regionJson(rows[0]));
});

const deleteRegion = run(async (req, res) => {
  const { rows: kids } = await pool.query('SELECT COUNT(*)::int AS n FROM ad_regions WHERE parent_id = $1', [Number(req.params.id)]);
  if (kids[0].n) throw new InputError('Remove or move the places inside it first.', 409);
  const { rows } = await pool.query('DELETE FROM ad_regions WHERE id = $1 RETURNING *', [Number(req.params.id)]);
  if (!rows[0]) throw new InputError('Region not found', 404);
  await audit(req, 'ads.region_deleted', 'ad_region', rows[0].id, null, { name: rows[0].name, level: rows[0].level });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------- placements

const placementJson = (p) => ({
  key: p.key, name: p.name, description: p.description, formats: p.formats, allowedLevels: p.allowed_levels,
  maxLivePerRegion: p.max_live_per_region, premiumPercent: Number(p.premium_percent), premiumCents: p.premium_cents,
  sponsoredLabel: p.sponsored_label, active: p.active, sortOrder: p.sort_order,
});

const listPlacements = run(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ad_placements ORDER BY sort_order, key');
  res.json(rows.map(placementJson));
});

function placementFields(b, isNew) {
  const f = {};
  if (isNew) {
    const key = String(b.key ?? '').trim();
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(key)) throw new InputError('Key uses lowercase letters, digits and underscores, e.g. home_banner.');
    f.key = key;
  }
  if (has(b, 'name') || isNew) f.name = text(b.name, 'Name', 80, { required: true });
  if (has(b, 'description')) f.description = text(b.description, 'Description', 300);
  if (has(b, 'formats')) {
    if (!Array.isArray(b.formats) || b.formats.some((x) => !/^\d{2,4}x\d{2,4}$/.test(String(x)))) throw new InputError('Formats are sizes like 1200x400.');
    f.formats = JSON.stringify([...new Set(b.formats.map(String))]);
  }
  if (has(b, 'allowedLevels')) f.allowed_levels = JSON.stringify(levels(b.allowedLevels, 'Allowed levels'));
  if (has(b, 'maxLivePerRegion')) f.max_live_per_region = int(b.maxLivePerRegion, 'Ads at once', { min: 1, max: 100 });
  if (has(b, 'premiumPercent')) f.premium_percent = num(b.premiumPercent, 'Premium %', { min: -90, max: 1000 });
  if (has(b, 'premiumCents')) f.premium_cents = int(b.premiumCents, 'Premium (fixed)');
  if (has(b, 'sponsoredLabel')) f.sponsored_label = bool(b.sponsoredLabel, 'Sponsored label');
  if (has(b, 'active')) f.active = bool(b.active, 'Active');
  if (has(b, 'sortOrder')) f.sort_order = int(b.sortOrder, 'Order', { max: 10000 });
  return f;
}

const createPlacement = run(async (req, res) => {
  const f = placementFields(req.body ?? {}, true);
  const keys = Object.keys(f);
  const { rows } = await pool.query(
    `INSERT INTO ad_placements (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => f[k])
  );
  await audit(req, 'ads.placement_created', 'ad_placement', rows[0].key, f);
  res.status(201).json(placementJson(rows[0]));
});

const updatePlacement = run(async (req, res) => {
  const f = placementFields(req.body ?? {}, false);
  const [set, values] = setClause(f);
  const { rows } = await pool.query(`UPDATE ad_placements SET ${set} WHERE key = $1 RETURNING *`, [req.params.key, ...values]);
  if (!rows[0]) throw new InputError('Placement not found', 404);
  await audit(req, 'ads.placement_changed', 'ad_placement', rows[0].key, f);
  res.json(placementJson(rows[0]));
});

// --------------------------------------------------------------------- rules

const RULE_KINDS = ['seasonal', 'peak', 'volume', 'category', 'enterprise', 'multi_region'];
const ruleJson = (r) => ({
  id: r.id, name: r.name, kind: r.kind, conditions: r.conditions, adjustPercent: Number(r.adjust_percent), priority: r.priority,
  startsAt: r.starts_at, endsAt: r.ends_at, active: r.active, updatedAt: r.updated_at,
});

function ruleConditions(kind, c = {}) {
  switch (kind) {
    case 'seasonal':
      return {};
    case 'peak': {
      const from = int(c.fromHour, 'From hour', { max: 23 });
      const to = int(c.toHour, 'To hour', { max: 24 });
      if (from === to) throw new InputError('Peak hours need a start and end that differ.');
      return { fromHour: from, toHour: to };
    }
    case 'volume':
      return { minHours: int(c.minHours, 'Minimum hours', { min: 1, max: 87600 }) };
    case 'multi_region':
      return { minRegions: int(c.minRegions, 'Minimum regions', { min: 2, max: 1000 }) };
    case 'category':
    case 'enterprise': {
      const key = kind === 'category' ? 'categoryIds' : 'vendorIds';
      const list = Array.isArray(c[key]) ? [...new Set(c[key].map(Number))].filter(Number.isInteger) : [];
      if (!list.length) throw new InputError(kind === 'category' ? 'Pick at least one category.' : 'Pick at least one shop.');
      return { [key]: list };
    }
    default:
      throw new InputError(`kind is one of ${RULE_KINDS.join(', ')}.`);
  }
}

async function ruleFields(b, existing) {
  const kind = existing?.kind ?? b.kind;
  if (!RULE_KINDS.includes(kind)) throw new InputError(`kind is one of ${RULE_KINDS.join(', ')}.`);
  const f = existing ? {} : { kind };
  if (has(b, 'name') || !existing) f.name = text(b.name, 'Name', 80, { required: true });
  if (has(b, 'conditions') || !existing) f.conditions = JSON.stringify(ruleConditions(kind, b.conditions ?? {}));
  if (has(b, 'adjustPercent') || !existing) f.adjust_percent = num(b.adjustPercent, 'Adjustment %', { min: -90, max: 500 });
  if (has(b, 'priority')) f.priority = int(b.priority, 'Priority', { max: 10000 });
  if (has(b, 'startsAt')) f.starts_at = date(b.startsAt, 'Start');
  if (has(b, 'endsAt')) f.ends_at = date(b.endsAt, 'End');
  if (has(b, 'active')) f.active = bool(b.active, 'Active');
  const from = f.starts_at !== undefined ? f.starts_at : existing?.starts_at;
  const to = f.ends_at !== undefined ? f.ends_at : existing?.ends_at;
  if (kind === 'seasonal' && (!from || !to)) throw new InputError('A seasonal rule needs a start and an end.');
  if (from && to && new Date(to) <= new Date(from)) throw new InputError('The end is before the start.');
  return f;
}

const listRules = run(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ad_pricing_rules ORDER BY priority, id');
  res.json(rows.map(ruleJson));
});

const createRule = run(async (req, res) => {
  const f = await ruleFields(req.body ?? {}, null);
  const keys = Object.keys(f);
  const { rows } = await pool.query(
    `INSERT INTO ad_pricing_rules (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => f[k])
  );
  await audit(req, 'ads.rule_created', 'ad_pricing_rule', rows[0].id, f);
  res.status(201).json(ruleJson(rows[0]));
});

const updateRule = run(async (req, res) => {
  const { rows: cur } = await pool.query('SELECT * FROM ad_pricing_rules WHERE id = $1', [Number(req.params.id)]);
  if (!cur[0]) throw new InputError('Rule not found', 404);
  const f = await ruleFields(req.body ?? {}, cur[0]);
  const [set, values] = setClause(f);
  const { rows } = await pool.query(`UPDATE ad_pricing_rules SET ${set}, updated_at = now() WHERE id = $1 RETURNING *`, [cur[0].id, ...values]);
  await audit(req, 'ads.rule_changed', 'ad_pricing_rule', rows[0].id, f);
  res.json(ruleJson(rows[0]));
});

const deleteRule = run(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM ad_pricing_rules WHERE id = $1 RETURNING *', [Number(req.params.id)]);
  if (!rows[0]) throw new InputError('Rule not found', 404);
  await audit(req, 'ads.rule_deleted', 'ad_pricing_rule', rows[0].id, null, { name: rows[0].name });
  res.json({ deleted: true });
});

// ------------------------------------------------------------------ packages

const TIERS = ['basic', 'growth', 'premium', 'enterprise', 'custom'];
const packageJson = (p) => ({
  id: p.id, name: p.name, tier: p.tier, description: p.description, level: p.level, hours: p.hours, priceCents: p.price_cents,
  placements: p.placements, maxRegions: p.max_regions, active: p.active, sortOrder: p.sort_order,
});

async function packageFields(b, isNew) {
  const f = {};
  if (has(b, 'name') || isNew) f.name = text(b.name, 'Name', 60, { required: true });
  if (has(b, 'tier') || isNew) {
    if (!TIERS.includes(b.tier)) throw new InputError(`tier is one of ${TIERS.join(', ')}.`);
    f.tier = b.tier;
  }
  if (has(b, 'description')) f.description = text(b.description, 'Description', 300);
  if (has(b, 'level') || isNew) {
    if (!ALL_LEVELS.includes(b.level)) throw new InputError('Choose a reach level.');
    f.level = b.level;
  }
  if (has(b, 'hours') || isNew) f.hours = int(b.hours, 'Hours', { min: 1, max: 8760 });
  if (has(b, 'priceCents') || isNew) f.price_cents = int(b.priceCents, 'Price', { min: 1 });
  if (has(b, 'placements') || isNew) {
    const list = Array.isArray(b.placements) ? [...new Set(b.placements)] : [];
    if (!list.length) throw new InputError('Pick at least one placement.');
    const { rows } = await pool.query('SELECT key FROM ad_placements WHERE key = ANY($1)', [list]);
    if (rows.length !== list.length) throw new InputError('A chosen placement does not exist.');
    f.placements = JSON.stringify(list);
  }
  if (has(b, 'maxRegions')) f.max_regions = int(b.maxRegions, 'Regions', { min: 1, max: 100 });
  if (has(b, 'active')) f.active = bool(b.active, 'Active');
  if (has(b, 'sortOrder')) f.sort_order = int(b.sortOrder, 'Order', { max: 10000 });
  return f;
}

const listPackages = run(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ad_packages ORDER BY sort_order, id');
  res.json(rows.map(packageJson));
});

const createPackage = run(async (req, res) => {
  const f = await packageFields(req.body ?? {}, true);
  const keys = Object.keys(f);
  const { rows } = await pool.query(
    `INSERT INTO ad_packages (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => f[k])
  );
  await audit(req, 'ads.package_created', 'ad_package', rows[0].id, f);
  res.status(201).json(packageJson(rows[0]));
});

const updatePackage = run(async (req, res) => {
  const f = await packageFields(req.body ?? {}, false);
  const [set, values] = setClause(f);
  const { rows } = await pool.query(`UPDATE ad_packages SET ${set} WHERE id = $1 RETURNING *`, [Number(req.params.id), ...values]);
  if (!rows[0]) throw new InputError('Package not found', 404);
  await audit(req, 'ads.package_changed', 'ad_package', rows[0].id, f);
  res.json(packageJson(rows[0]));
});

// ------------------------------------------------------------------- coupons

const couponJson = (c) => ({
  id: c.id, code: c.code, kind: c.kind, value: c.value, maxDiscountCents: c.max_discount_cents, minSpendCents: c.min_spend_cents,
  maxUses: c.max_uses, usedCount: c.used_count, startsAt: c.starts_at, endsAt: c.ends_at, active: c.active,
});

function couponFields(b, isNew) {
  const f = {};
  if (has(b, 'code') || isNew) {
    const code = String(b.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new InputError('Code is 3–30 letters, digits, - or _.');
    f.code = code;
  }
  if (has(b, 'kind') || isNew) {
    if (!['percent', 'flat'].includes(b.kind)) throw new InputError('kind is percent or flat.');
    f.kind = b.kind;
  }
  if (has(b, 'value') || isNew) f.value = int(b.value, 'Value', { min: 1, max: (f.kind ?? b.kind) === 'percent' ? 100 : 100000000 });
  if (has(b, 'maxDiscountCents')) f.max_discount_cents = int(b.maxDiscountCents, 'Maximum discount', { min: 1, nullable: true });
  if (has(b, 'minSpendCents')) f.min_spend_cents = int(b.minSpendCents, 'Minimum spend');
  if (has(b, 'maxUses')) f.max_uses = int(b.maxUses, 'Uses', { min: 1, nullable: true });
  if (has(b, 'startsAt')) f.starts_at = date(b.startsAt, 'Start');
  if (has(b, 'endsAt')) f.ends_at = date(b.endsAt, 'End');
  if (has(b, 'active')) f.active = bool(b.active, 'Active');
  return f;
}

const listCoupons = run(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ad_coupons ORDER BY active DESC, created_at DESC');
  res.json(rows.map(couponJson));
});

const createCoupon = run(async (req, res) => {
  const f = couponFields(req.body ?? {}, true);
  const keys = Object.keys(f);
  const { rows } = await pool.query(
    `INSERT INTO ad_coupons (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => f[k])
  );
  await audit(req, 'ads.coupon_created', 'ad_coupon', rows[0].id, f);
  res.status(201).json(couponJson(rows[0]));
});

const updateCoupon = run(async (req, res) => {
  const f = couponFields(req.body ?? {}, false);
  const [set, values] = setClause(f);
  const { rows } = await pool.query(`UPDATE ad_coupons SET ${set} WHERE id = $1 RETURNING *`, [Number(req.params.id), ...values]);
  if (!rows[0]) throw new InputError('Coupon not found', 404);
  await audit(req, 'ads.coupon_changed', 'ad_coupon', rows[0].id, f);
  res.json(couponJson(rows[0]));
});

// ---------------------------------------------------- calculator and choices

/** Everything the calculator's pickers need, without needing the Vendors or Categories permission. */
const options = run(async (req, res) => {
  const [{ rows: shops }, { rows: cats }, { rows: pkgs }] = await Promise.all([
    pool.query("SELECT id, business_name, city FROM vendor_profiles WHERE status = 'approved' ORDER BY business_name"),
    pool.query('SELECT id, name FROM categories WHERE is_active ORDER BY sort_order, name'),
    pool.query('SELECT * FROM ad_packages WHERE active ORDER BY sort_order'),
  ]);
  res.json({
    shops: shops.map((s) => ({ id: s.id, name: s.business_name, city: s.city })),
    categories: cats,
    packages: pkgs.map(packageJson),
    regionLevelFor: pricing.REGION_LEVEL,
  });
});

const quote = run(async (req, res) => {
  res.json(await pricing.quote(req.body ?? {}));
});

module.exports = {
  getSettings, updateSettings,
  listLevels, updateLevel, createPack, updatePack, deletePack,
  listRegions, createRegion, updateRegion, deleteRegion,
  listPlacements, createPlacement, updatePlacement,
  listRules, createRule, updateRule, deleteRule,
  listPackages, createPackage, updatePackage,
  listCoupons, createCoupon, updateCoupon,
  options, quote,
};
