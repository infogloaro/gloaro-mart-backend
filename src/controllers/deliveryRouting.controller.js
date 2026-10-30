const pool = require('../config/db');
const routing = require('../services/deliveryRouting');
const { recordAudit } = require('../services/auditLog');

/**
 * Admin → Shipments → Delivery routing (DR1): the distance up to which the
 * platform's own riders (GoKart) deliver, and who ships beyond it
 * (Shiprocket). Applies to the next checkout; orders already placed keep the
 * partner they were given.
 */

async function getSettings(req, res) {
  res.json(routing.settingsJson(await routing.getSettings(pool, { fresh: true })));
}

async function updateSettings(req, res) {
  const b = req.body ?? {};
  const set = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return res.status(400).json({ message: 'enabled is on or off.' });
    set.enabled = b.enabled;
  }
  if (b.localRadiusKm !== undefined) {
    const km = Number(b.localRadiusKm);
    if (!Number.isFinite(km) || km <= 0 || km > 500 || Math.round(km * 10) !== km * 10) {
      return res.status(400).json({ message: 'Local delivery distance must be from 0.1 to 500 km (one decimal).' });
    }
    set.local_radius_km = km;
  }
  if (b.localPartner !== undefined) {
    if (!routing.PARTNERS.local.includes(b.localPartner)) return res.status(400).json({ message: 'Local partner is gokart or manual.' });
    set.local_partner = b.localPartner;
  }
  if (b.outstationPartner !== undefined) {
    if (!routing.PARTNERS.outstation.includes(b.outstationPartner)) {
      return res.status(400).json({ message: 'Outstation partner is shiprocket or manual.' });
    }
    set.outstation_partner = b.outstationPartner;
  }
  const keys = Object.keys(set);
  if (!keys.length) return res.status(400).json({ message: 'Nothing to change.' });

  const before = await routing.getSettings(pool, { fresh: true });
  await pool.query('INSERT INTO delivery_routing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  await pool.query(
    `UPDATE delivery_routing_settings SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')},
       updated_by = $${keys.length + 1}, updated_at = now()
     WHERE id = 1`,
    [...keys.map((k) => set[k]), req.user.id]
  );
  routing.forget();
  await recordAudit({
    actorUserId: req.user.id,
    action: 'delivery_routing.updated',
    module: 'shipments',
    entityType: 'delivery_routing_settings',
    entityId: 1,
    newValue: set,
    previousValue: Object.fromEntries(keys.map((k) => [k, before[k]])),
  }).catch(() => {});
  res.json(routing.settingsJson(await routing.getSettings(pool, { fresh: true })));
}

module.exports = { getSettings, updateSettings };
