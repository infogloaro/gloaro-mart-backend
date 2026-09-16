const pool = require('../config/db');

/**
 * Returned when a vendor has no vendor_delivery_rules row yet.
 *
 * Deliberately not a 404: the vendor and admin forms must be able to render for
 * a first-time setup, and every vendor predates this table.
 */
function defaultsFor(vendorId) {
  return {
    vendor_id: Number(vendorId),
    delivery_charge_cents: 0,
    free_delivery_above_cents: null,
    min_order_cents: 0,
    preparation_minutes: 30,
    supports_delivery: true,
    supports_pickup: false,
    opens_at: null,
    closes_at: null,
    updated_at: null,
  };
}

async function vendorIdForUser(userId) {
  const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [userId]);
  return rows[0]?.id || null;
}

async function readRules(vendorId) {
  const { rows } = await pool.query('SELECT * FROM vendor_delivery_rules WHERE vendor_id = $1', [vendorId]);
  return rows[0] || defaultsFor(vendorId);
}

function validateRules(body) {
  const ints = {
    deliveryChargeCents: body.deliveryChargeCents,
    minOrderCents: body.minOrderCents,
    preparationMinutes: body.preparationMinutes,
  };
  for (const [key, value] of Object.entries(ints)) {
    if (value != null && (!Number.isInteger(Number(value)) || Number(value) < 0)) {
      return `${key} must be a non-negative whole number`;
    }
  }
  if (
    body.freeDeliveryAboveCents != null &&
    (!Number.isInteger(Number(body.freeDeliveryAboveCents)) || Number(body.freeDeliveryAboveCents) < 0)
  ) {
    return 'freeDeliveryAboveCents must be a non-negative whole number or null';
  }
  // A vendor with neither method configured could take no orders at all, which
  // is never what the operator meant.
  if (body.supportsDelivery === false && body.supportsPickup === false) {
    return 'A vendor must support delivery, pickup, or both';
  }
  for (const key of ['opensAt', 'closesAt']) {
    if (body[key] != null && !/^\d{2}:\d{2}(:\d{2})?$/.test(String(body[key]))) {
      return `${key} must be HH:MM`;
    }
  }
  if ((body.opensAt == null) !== (body.closesAt == null)) {
    return 'Set both opensAt and closesAt, or neither';
  }
  return null;
}

async function upsertRules(vendorId, body) {
  const { rows } = await pool.query(
    `INSERT INTO vendor_delivery_rules
      (vendor_id, delivery_charge_cents, free_delivery_above_cents, min_order_cents,
       preparation_minutes, supports_delivery, supports_pickup, opens_at, closes_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (vendor_id) DO UPDATE SET
       delivery_charge_cents     = EXCLUDED.delivery_charge_cents,
       free_delivery_above_cents = EXCLUDED.free_delivery_above_cents,
       min_order_cents           = EXCLUDED.min_order_cents,
       preparation_minutes       = EXCLUDED.preparation_minutes,
       supports_delivery         = EXCLUDED.supports_delivery,
       supports_pickup           = EXCLUDED.supports_pickup,
       opens_at                  = EXCLUDED.opens_at,
       closes_at                 = EXCLUDED.closes_at,
       updated_at                = now()
     RETURNING *`,
    [
      vendorId,
      Number(body.deliveryChargeCents ?? 0),
      body.freeDeliveryAboveCents == null ? null : Number(body.freeDeliveryAboveCents),
      Number(body.minOrderCents ?? 0),
      Number(body.preparationMinutes ?? 30),
      body.supportsDelivery !== false,
      body.supportsPickup === true,
      body.opensAt || null,
      body.closesAt || null,
    ]
  );
  return rows[0];
}

function validateArea(body) {
  if (!['radius', 'pincode'].includes(body.areaType)) {
    return "areaType must be 'radius' or 'pincode'";
  }
  if (body.areaType === 'radius') {
    const km = Number(body.radiusKm);
    if (!Number.isFinite(km) || km <= 0) return 'radiusKm must be greater than zero';
  } else if (!/^\d{6}$/.test(String(body.pincode || '').trim())) {
    return 'pincode must be 6 digits';
  }
  return null;
}

async function listAreas(vendorId) {
  const { rows } = await pool.query(
    'SELECT * FROM vendor_service_areas WHERE vendor_id = $1 AND is_active = true ORDER BY id ASC',
    [vendorId]
  );
  return rows;
}

async function insertArea(vendorId, body) {
  const { rows } = await pool.query(
    `INSERT INTO vendor_service_areas (vendor_id, area_type, radius_km, pincode)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [
      vendorId,
      body.areaType,
      body.areaType === 'radius' ? Number(body.radiusKm) : null,
      body.areaType === 'pincode' ? String(body.pincode).trim() : null,
    ]
  );
  return rows[0];
}

// --- Vendor-scoped handlers ---

async function getMySettings(req, res) {
  const vendorId = await vendorIdForUser(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  res.json(await readRules(vendorId));
}

async function updateMySettings(req, res) {
  const vendorId = await vendorIdForUser(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  const problem = validateRules(req.body || {});
  if (problem) return res.status(400).json({ message: problem });
  res.json(await upsertRules(vendorId, req.body || {}));
}

async function getMyAreas(req, res) {
  const vendorId = await vendorIdForUser(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  res.json(await listAreas(vendorId));
}

async function addMyArea(req, res) {
  const vendorId = await vendorIdForUser(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  const problem = validateArea(req.body || {});
  if (problem) return res.status(400).json({ message: problem });
  res.status(201).json(await insertArea(vendorId, req.body));
}

async function deleteMyArea(req, res) {
  const vendorId = await vendorIdForUser(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  const { rowCount } = await pool.query(
    'UPDATE vendor_service_areas SET is_active = false WHERE id = $1 AND vendor_id = $2 AND is_active = true',
    [req.params.id, vendorId]
  );
  if (rowCount === 0) return res.status(404).json({ message: 'Service area not found' });
  res.status(204).send();
}

// --- Admin handlers (any vendor by id) ---

async function adminGetSettings(req, res) {
  res.json(await readRules(req.params.id));
}

async function adminUpdateSettings(req, res) {
  const problem = validateRules(req.body || {});
  if (problem) return res.status(400).json({ message: problem });
  const { rows } = await pool.query('SELECT 1 FROM vendor_profiles WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Vendor not found' });
  res.json(await upsertRules(req.params.id, req.body || {}));
}

async function adminGetAreas(req, res) {
  res.json(await listAreas(req.params.id));
}

async function adminAddArea(req, res) {
  const problem = validateArea(req.body || {});
  if (problem) return res.status(400).json({ message: problem });
  const { rows } = await pool.query('SELECT 1 FROM vendor_profiles WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Vendor not found' });
  res.status(201).json(await insertArea(req.params.id, req.body));
}

async function adminDeleteArea(req, res) {
  const { rowCount } = await pool.query(
    'UPDATE vendor_service_areas SET is_active = false WHERE id = $1 AND vendor_id = $2 AND is_active = true',
    [req.params.areaId, req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ message: 'Service area not found' });
  res.status(204).send();
}

module.exports = {
  getMySettings,
  updateMySettings,
  getMyAreas,
  addMyArea,
  deleteMyArea,
  adminGetSettings,
  adminUpdateSettings,
  adminGetAreas,
  adminAddArea,
  adminDeleteArea,
};
