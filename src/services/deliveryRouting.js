const pool = require('../config/db');

/**
 * Delivery routing (DR1): who carries an order, by its distance from the
 * shop. Up to local_radius_km the platform's own riders (GoKart) deliver it;
 * beyond that a courier (Shiprocket) ships it. Admin edits the one row in
 * delivery_routing_settings.
 *
 * Checkout and matching read it on every call, so it is cached briefly. A
 * database without the table yet (code deployed before the migration) gets
 * the defaults rather than a failed checkout.
 */

const PARTNERS = { local: ['gokart', 'manual'], outstation: ['shiprocket', 'manual'] };
const DEFAULTS = { enabled: true, local_radius_km: 25, local_partner: 'gokart', outstation_partner: 'shiprocket', updated_at: null };
const CACHE_MS = 30_000;

let cached = null;
let cachedAt = 0;

async function getSettings(db = pool, { fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < CACHE_MS) return cached;
  try {
    const { rows } = await db.query('SELECT * FROM delivery_routing_settings WHERE id = 1');
    const row = rows[0] || {};
    cached = { ...DEFAULTS, ...row, local_radius_km: Number(row.local_radius_km ?? DEFAULTS.local_radius_km) };
  } catch (err) {
    if (err.code !== '42P01') throw err;
    cached = { ...DEFAULTS };
  }
  cachedAt = Date.now();
  return cached;
}

function forget() {
  cached = null;
}

/** The partner for a delivery in `mode` ('local' | 'courier'), or null when routing is off. */
function partnerFor(settings, mode) {
  if (!settings?.enabled) return null;
  if (mode === 'local') return settings.local_partner;
  if (mode === 'courier') return settings.outstation_partner;
  return null;
}

const settingsJson = (s) => ({
  enabled: s.enabled,
  localRadiusKm: Number(s.local_radius_km),
  localPartner: s.local_partner,
  outstationPartner: s.outstation_partner,
  updatedAt: s.updated_at,
});

module.exports = { PARTNERS, DEFAULTS, getSettings, forget, partnerFor, settingsJson };
