const pool = require('../config/db');

/**
 * The Ad Promotions price engine (schema PHASE 52). One function, quote(),
 * used by the admin calculator now and by the shop's booking and checkout
 * later — so the price a shop sees, the price it pays and the price the admin
 * checks are the same calculation. Every amount is integer paise.
 *
 *  1. Duration: the cheapest mix of the level's packs that covers the hours.
 *  2. Reach: that price for each chosen region, times the region's multiplier.
 *  3. Placement: for each slot, the reach price plus the slot's premium.
 *  4. Rules: seasonal, peak, volume, category, enterprise, multi-region, each a
 *     % of the rate-card subtotal (seasonal and peak only for the hours they cover).
 *  5. Package instead of 1–4, when one is chosen: its fixed price.
 *  6. Coupon, then the minimum charge, then the budget limits, then tax.
 *
 * The result carries a snapshot of every number used, kept with the campaign
 * so a later price change never alters what was paid.
 */

const HOUR = 3600000;
// Which regions each reach level is aimed at.
const REGION_LEVEL = { local: 'locality', city: 'city', district: 'district', state: 'state', country: 'country', international: 'country' };
const MODELS = { fixed: 'model_fixed', commission: 'model_commission', fixed_commission: 'model_fixed_commission', package: 'model_package' };

class QuoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pct = (value, percent) => Math.round((value * Number(percent)) / 100);

/**
 * The cheapest way to cover `hours` with the packs (each usable any number of
 * times; going over is allowed, so 20 hours can be one 24-hour pack if that's
 * cheaper). Returns { cents, packs: [{ hours, priceCents, count }] }.
 */
function cheapestCover(hours, packs) {
  if (!packs.length) return null;
  const max = hours + Math.max(...packs.map((p) => p.hours));
  const cost = new Array(max + 1).fill(Infinity);
  const pick = new Array(max + 1).fill(-1);
  cost[0] = 0;
  for (let h = 1; h <= max; h += 1) {
    for (let i = 0; i < packs.length; i += 1) {
      const p = packs[i];
      if (p.hours <= h && cost[h - p.hours] + p.price_cents < cost[h]) {
        cost[h] = cost[h - p.hours] + p.price_cents;
        pick[h] = i;
      }
    }
  }
  let best = -1;
  for (let h = hours; h <= max; h += 1) if (cost[h] < Infinity && (best === -1 || cost[h] < cost[best])) best = h;
  if (best === -1) return null;
  const counts = new Map();
  for (let h = best; h > 0; h -= packs[pick[h]].hours) {
    const p = packs[pick[h]];
    counts.set(p.hours, { hours: p.hours, priceCents: p.price_cents, count: (counts.get(p.hours)?.count ?? 0) + 1 });
  }
  return { cents: cost[best], coveredHours: best, packs: [...counts.values()].sort((a, b) => b.hours - a.hours) };
}

/** Hours of [start, end) that fall inside [from, to). */
function overlapHours(start, end, from, to) {
  const a = Math.max(start, from ?? -Infinity);
  const b = Math.min(end, to ?? Infinity);
  return b > a ? (b - a) / HOUR : 0;
}

/** Hours of [start, end) whose IST hour-of-day is in [fromHour, toHour) (wrapping past midnight). */
function peakHours(start, end, fromHour, toHour) {
  const IST = 5.5 * HOUR;
  let n = 0;
  for (let t = start; t < end; t += HOUR) {
    const h = new Date(t + IST).getUTCHours();
    const inside = fromHour <= toHour ? h >= fromHour && h < toHour : h >= fromHour || h < toHour;
    if (inside) n += Math.min(HOUR, end - t) / HOUR;
  }
  return n;
}

async function loadConfig(db) {
  // One after another: inside a transaction `db` is a single client, which
  // runs one query at a time.
  const settings = await db.query('SELECT * FROM ad_settings WHERE id = 1');
  const levels = await db.query('SELECT * FROM ad_levels');
  const packs = await db.query('SELECT * FROM ad_rate_packs WHERE active ORDER BY level, hours');
  const placements = await db.query('SELECT * FROM ad_placements');
  const rules = await db.query('SELECT * FROM ad_pricing_rules WHERE active ORDER BY priority, id');
  if (!settings.rows[0]) throw new QuoteError(503, 'Ad pricing is not set up yet.');
  return {
    settings: settings.rows[0],
    levels: new Map(levels.rows.map((l) => [l.key, l])),
    packs: packs.rows,
    placements: new Map(placements.rows.map((p) => [p.key, p])),
    rules: rules.rows,
  };
}

const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number))].filter(Number.isInteger);

/**
 * input: { vendorId?, categoryId?, model, level, regionIds[], placements[],
 *          startsAt, endsAt (or hours), packageId?, couponCode?, now? }
 */
async function quote(input, db = pool) {
  const cfg = await loadConfig(db);
  const s = cfg.settings;
  const model = input.model ?? (input.packageId ? 'package' : 'fixed');
  if (!MODELS[model]) throw new QuoteError(400, `model is one of ${Object.keys(MODELS).join(', ')}.`);
  if (!s[MODELS[model]]) throw new QuoteError(409, `The ${model.replace('_', ' + ')} pricing model is switched off.`);

  // The package, if any, fixes level, hours and the allowed slots.
  let pkg = null;
  if (model === 'package') {
    const { rows } = await db.query('SELECT * FROM ad_packages WHERE id = $1 AND active', [Number(input.packageId)]);
    pkg = rows[0];
    if (!pkg) throw new QuoteError(400, 'Choose an active package.');
  }

  const levelKey = pkg ? pkg.level : input.level;
  const level = cfg.levels.get(levelKey);
  if (!level || !level.active) throw new QuoteError(400, 'Choose an available reach level.');

  // When.
  const now = input.now ? new Date(input.now).getTime() : Date.now();
  const start = input.startsAt ? Date.parse(input.startsAt) : NaN;
  if (Number.isNaN(start)) throw new QuoteError(400, 'startsAt is required.');
  if (start < now - 5 * 60000) throw new QuoteError(400, 'The campaign can’t start in the past.');
  let hours;
  if (pkg) hours = pkg.hours;
  else if (input.endsAt) {
    const end = Date.parse(input.endsAt);
    if (Number.isNaN(end) || end <= start) throw new QuoteError(400, 'endsAt must be after startsAt.');
    hours = Math.ceil((end - start) / HOUR);
  } else hours = Number(input.hours);
  if (!Number.isInteger(hours) || hours < 1) throw new QuoteError(400, 'Give the duration in whole hours.');
  if (hours < level.min_hours) throw new QuoteError(400, `${level.label} campaigns run for at least ${level.min_hours} hour(s).`);
  if (hours > s.max_hours) throw new QuoteError(400, `Campaigns run for at most ${s.max_hours} hours.`);
  const end = start + hours * HOUR;

  // Where.
  const regionIds = ids(input.regionIds);
  if (!regionIds.length) throw new QuoteError(400, 'Choose at least one region.');
  if (pkg && regionIds.length > pkg.max_regions) throw new QuoteError(400, `The ${pkg.name} package covers up to ${pkg.max_regions} region(s).`);
  const { rows: regions } = await db.query('SELECT * FROM ad_regions WHERE id = ANY($1)', [regionIds]);
  if (regions.length !== regionIds.length) throw new QuoteError(400, 'A chosen region does not exist.');
  for (const r of regions) {
    if (!r.active) throw new QuoteError(400, `${r.name} is not available for ads.`);
    if (r.level !== REGION_LEVEL[levelKey]) throw new QuoteError(400, `${r.name} is a ${r.level}; ${level.label} ads target ${REGION_LEVEL[levelKey]} regions.`);
    if (levelKey === 'country' && r.country_code !== s.home_country) throw new QuoteError(400, `${r.name} is abroad — use International reach.`);
    if (levelKey === 'international' && r.country_code === s.home_country) throw new QuoteError(400, `${r.name} is the home country — use Country reach.`);
  }

  // Which slots.
  const placementKeys = [...new Set(Array.isArray(input.placements) ? input.placements : [])];
  if (!placementKeys.length) throw new QuoteError(400, 'Choose at least one placement.');
  const placements = placementKeys.map((k) => {
    const p = cfg.placements.get(k);
    if (!p || !p.active) throw new QuoteError(400, `${k} is not an available placement.`);
    if (!(p.allowed_levels ?? []).includes(levelKey)) throw new QuoteError(400, `${p.name} isn't offered for ${level.label} reach.`);
    if (pkg && !(pkg.placements ?? []).includes(k)) throw new QuoteError(400, `${p.name} isn't part of the ${pkg.name} package.`);
    return p;
  });

  const lines = [];
  let subtotal;
  let duration = null;
  const rulesApplied = [];

  if (pkg) {
    subtotal = pkg.price_cents;
    lines.push({ kind: 'package', label: `${pkg.name} package — ${pkg.hours} h, ${level.label}`, amountCents: pkg.price_cents });
  } else {
    // 1. Duration.
    duration = cheapestCover(hours, cfg.packs.filter((p) => p.level === levelKey));
    if (!duration) throw new QuoteError(409, `No ${level.label} prices are set yet.`);
    // 2–3. Each slot × each region.
    subtotal = 0;
    for (const p of placements) {
      let slot = 0;
      for (const r of regions) slot += Math.round(duration.cents * Number(r.price_multiplier));
      const premium = pct(slot, p.premium_percent) + p.premium_cents;
      const amount = slot + premium;
      subtotal += amount;
      lines.push({
        kind: 'placement',
        label: `${p.name} — ${regions.map((r) => r.name).join(', ')}`,
        placement: p.key,
        baseCents: slot,
        premiumCents: premium,
        amountCents: amount,
      });
    }
    // 4. Rules, each a % of the rate-card subtotal.
    const base = subtotal;
    for (const rule of cfg.rules) {
      const c = rule.conditions ?? {};
      let share = 0; // how much of the booking the rule covers, 0..1
      switch (rule.kind) {
        case 'seasonal':
          share = overlapHours(start, end, rule.starts_at && new Date(rule.starts_at).getTime(), rule.ends_at && new Date(rule.ends_at).getTime()) / hours;
          break;
        case 'peak':
          share = Number.isInteger(c.fromHour) && Number.isInteger(c.toHour) ? peakHours(start, end, c.fromHour, c.toHour) / hours : 0;
          break;
        case 'volume':
          share = hours >= Number(c.minHours ?? Infinity) ? 1 : 0;
          break;
        case 'multi_region':
          share = regions.length >= Number(c.minRegions ?? Infinity) ? 1 : 0;
          break;
        case 'category':
          share = input.categoryId != null && (c.categoryIds ?? []).map(Number).includes(Number(input.categoryId)) ? 1 : 0;
          break;
        case 'enterprise':
          share = input.vendorId != null && (c.vendorIds ?? []).map(Number).includes(Number(input.vendorId)) ? 1 : 0;
          break;
        default:
          share = 0;
      }
      // Seasonal / volume rules with their own validity window apply only when booked inside it.
      if (rule.kind !== 'seasonal' && ((rule.starts_at && now < new Date(rule.starts_at).getTime()) || (rule.ends_at && now >= new Date(rule.ends_at).getTime()))) share = 0;
      if (share <= 0) continue;
      const amount = Math.round((base * Number(rule.adjust_percent) * share) / 100);
      if (amount === 0) continue;
      subtotal += amount;
      rulesApplied.push({ id: rule.id, name: rule.name, kind: rule.kind, adjustPercent: Number(rule.adjust_percent), share: Math.round(share * 1000) / 1000, amountCents: amount });
      lines.push({ kind: 'rule', label: `${rule.name} (${Number(rule.adjust_percent) > 0 ? '+' : ''}${Number(rule.adjust_percent)}%${share < 1 ? ` on ${Math.round(share * 100)}% of the hours` : ''})`, amountCents: amount });
    }
  }

  // Commission-only campaigns pay nothing upfront.
  if (model === 'commission') {
    lines.length = 0;
    rulesApplied.length = 0;
    subtotal = 0;
    lines.push({ kind: 'commission', label: `No upfront fee — ${Number(s.commission_percent)}% of orders this ad brings in (${s.attribution_days}-day window)`, amountCents: 0 });
  }

  // 6. Coupon.
  let discount = 0;
  let coupon = null;
  if (input.couponCode) {
    const { rows } = await db.query('SELECT * FROM ad_coupons WHERE upper(code) = upper($1)', [String(input.couponCode).trim()]);
    const c = rows[0];
    const usable = c && c.active && (!c.starts_at || now >= new Date(c.starts_at).getTime()) && (!c.ends_at || now < new Date(c.ends_at).getTime())
      && (c.max_uses == null || c.used_count < c.max_uses);
    if (!usable) throw new QuoteError(400, 'That coupon is not valid.');
    if (subtotal < c.min_spend_cents) throw new QuoteError(400, `That coupon needs a booking of ₹${(c.min_spend_cents / 100).toFixed(2)} or more.`);
    discount = c.kind === 'percent' ? pct(subtotal, c.value) : c.value;
    if (c.max_discount_cents) discount = Math.min(discount, c.max_discount_cents);
    discount = Math.min(discount, subtotal);
    coupon = { id: c.id, code: c.code, kind: c.kind, value: c.value };
    lines.push({ kind: 'coupon', label: `Coupon ${c.code}`, amountCents: -discount });
  }

  let taxable = subtotal - discount;
  if (model !== 'commission') {
    if (taxable < s.min_charge_cents) {
      lines.push({ kind: 'minimum', label: 'Minimum charge', amountCents: s.min_charge_cents - taxable });
      taxable = s.min_charge_cents;
    }
    if (taxable < s.min_budget_cents) throw new QuoteError(400, `The smallest booking is ₹${(s.min_budget_cents / 100).toFixed(2)}.`);
    if (taxable > s.max_budget_cents) throw new QuoteError(400, `The largest booking is ₹${(s.max_budget_cents / 100).toFixed(2)} — contact GLOARO for more.`);
  }
  const tax = pct(taxable, s.tax_percent);
  const commissionPercent = model === 'commission' ? Number(s.commission_percent) : model === 'fixed_commission' ? Number(s.fixed_commission_percent) : 0;

  return {
    model,
    level: levelKey,
    hours,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    currency: s.currency,
    lines,
    subtotalCents: subtotal,
    discountCents: discount,
    taxableCents: taxable,
    taxPercent: Number(s.tax_percent),
    taxLabel: s.tax_label,
    taxCents: tax,
    totalCents: taxable + tax,
    commissionPercent,
    attributionDays: commissionPercent ? s.attribution_days : null,
    audienceEstimate: regions.every((r) => r.audience_estimate != null) ? regions.reduce((n, r) => n + r.audience_estimate, 0) : null,
    // Everything the price came from, kept with the campaign.
    snapshot: {
      quotedAt: new Date(now).toISOString(),
      settings: {
        taxPercent: Number(s.tax_percent), sacCode: s.sac_code, minChargeCents: s.min_charge_cents,
        commissionPercent: Number(s.commission_percent), fixedCommissionPercent: Number(s.fixed_commission_percent), attributionDays: s.attribution_days,
      },
      duration,
      package: pkg && { id: pkg.id, name: pkg.name, hours: pkg.hours, priceCents: pkg.price_cents },
      regions: regions.map((r) => ({ id: r.id, name: r.name, level: r.level, multiplier: Number(r.price_multiplier) })),
      placements: placements.map((p) => ({ key: p.key, name: p.name, premiumPercent: Number(p.premium_percent), premiumCents: p.premium_cents })),
      rules: rulesApplied,
      coupon,
      vendorId: input.vendorId ?? null,
      categoryId: input.categoryId ?? null,
    },
  };
}

module.exports = { QuoteError, REGION_LEVEL, MODELS, cheapestCover, quote };
