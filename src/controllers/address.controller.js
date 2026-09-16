const pool = require('../config/db');

const ADDRESS_TYPES = ['home', 'work', 'other'];

/** Shape the app expects — camelCase, plus a ready-made single-line form. */
function toApi(row) {
  if (!row) return null;
  const parts = [row.house_building, row.street, row.area, row.city, row.state]
    .filter((p) => p && String(p).trim())
    .join(', ');
  return {
    id: row.id,
    receiverName: row.receiver_name,
    mobileNumber: row.mobile_number,
    houseBuilding: row.house_building,
    street: row.street,
    area: row.area,
    landmark: row.landmark,
    city: row.city,
    district: row.district,
    state: row.state,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    addressType: row.address_type,
    isDefault: row.is_default,
    formatted: `${parts} - ${row.pincode}`,
  };
}

function validate(body, { partial = false } = {}) {
  const required = ['receiverName', 'houseBuilding', 'city', 'state', 'pincode', 'mobileNumber'];
  if (!partial) {
    for (const field of required) {
      if (!body[field] || !String(body[field]).trim()) return `${field} is required`;
    }
  }
  if (body.pincode != null && !/^\d{6}$/.test(String(body.pincode).trim())) {
    return 'pincode must be 6 digits';
  }
  if (body.mobileNumber != null && !/^\d{10}$/.test(String(body.mobileNumber).trim())) {
    return 'mobileNumber must be 10 digits';
  }
  if (body.addressType != null && !ADDRESS_TYPES.includes(body.addressType)) {
    return `addressType must be one of ${ADDRESS_TYPES.join(', ')}`;
  }
  return null;
}

async function listAddresses(req, res) {
  const { rows } = await pool.query(
    `SELECT * FROM addresses
     WHERE user_id = $1 AND is_active = true
     ORDER BY is_default DESC, updated_at DESC, id DESC`,
    [req.user.id]
  );
  res.json({ addresses: rows.map(toApi) });
}

async function createAddress(req, res) {
  const body = req.body || {};
  const problem = validate(body);
  if (problem) return res.status(400).json({ message: problem });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The first address a customer saves is always the default — otherwise
    // checkout would open with nothing selected and no way to guess.
    const { rows: existing } = await client.query(
      'SELECT 1 FROM addresses WHERE user_id = $1 AND is_active = true LIMIT 1',
      [req.user.id]
    );
    const makeDefault = existing.length === 0 || body.isDefault === true;

    if (makeDefault) {
      await client.query(
        'UPDATE addresses SET is_default = false, updated_at = now() WHERE user_id = $1 AND is_default = true',
        [req.user.id]
      );
    }

    const { rows } = await client.query(
      `INSERT INTO addresses
        (user_id, receiver_name, mobile_number, house_building, street, area, landmark,
         city, district, state, pincode, latitude, longitude, address_type, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        req.user.id,
        String(body.receiverName).trim(),
        String(body.mobileNumber).trim(),
        String(body.houseBuilding).trim(),
        body.street?.trim() || null,
        body.area?.trim() || null,
        body.landmark?.trim() || null,
        String(body.city).trim(),
        body.district?.trim() || null,
        String(body.state).trim(),
        String(body.pincode).trim(),
        body.latitude ?? null,
        body.longitude ?? null,
        body.addressType || 'home',
        makeDefault,
      ]
    );
    await client.query('COMMIT');
    res.status(201).json({ address: toApi(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateAddress(req, res) {
  const body = req.body || {};
  const problem = validate(body, { partial: true });
  if (problem) return res.status(400).json({ message: problem });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Scoped by user_id, so one customer can never edit another's address.
    const { rows: owned } = await client.query(
      'SELECT * FROM addresses WHERE id = $1 AND user_id = $2 AND is_active = true',
      [req.params.id, req.user.id]
    );
    if (!owned[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Address not found' });
    }

    if (body.isDefault === true) {
      await client.query(
        'UPDATE addresses SET is_default = false, updated_at = now() WHERE user_id = $1 AND is_default = true AND id <> $2',
        [req.user.id, req.params.id]
      );
    }

    const { rows } = await client.query(
      `UPDATE addresses SET
        receiver_name  = COALESCE($3, receiver_name),
        mobile_number  = COALESCE($4, mobile_number),
        house_building = COALESCE($5, house_building),
        street         = COALESCE($6, street),
        area           = COALESCE($7, area),
        landmark       = COALESCE($8, landmark),
        city           = COALESCE($9, city),
        district       = COALESCE($10, district),
        state          = COALESCE($11, state),
        pincode        = COALESCE($12, pincode),
        latitude       = COALESCE($13, latitude),
        longitude      = COALESCE($14, longitude),
        address_type   = COALESCE($15, address_type),
        is_default     = COALESCE($16, is_default),
        updated_at     = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        req.params.id,
        req.user.id,
        body.receiverName?.trim() ?? null,
        body.mobileNumber?.trim() ?? null,
        body.houseBuilding?.trim() ?? null,
        body.street?.trim() ?? null,
        body.area?.trim() ?? null,
        body.landmark?.trim() ?? null,
        body.city?.trim() ?? null,
        body.district?.trim() ?? null,
        body.state?.trim() ?? null,
        body.pincode?.trim() ?? null,
        body.latitude ?? null,
        body.longitude ?? null,
        body.addressType ?? null,
        body.isDefault === true ? true : null,
      ]
    );
    await client.query('COMMIT');
    res.json({ address: toApi(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function setDefaultAddress(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: owned } = await client.query(
      'SELECT 1 FROM addresses WHERE id = $1 AND user_id = $2 AND is_active = true',
      [req.params.id, req.user.id]
    );
    if (!owned[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Address not found' });
    }

    // Clearing and setting must share a transaction — the partial unique index
    // rejects two defaults, so doing this in two statements can fail halfway.
    await client.query(
      'UPDATE addresses SET is_default = false, updated_at = now() WHERE user_id = $1 AND is_default = true',
      [req.user.id]
    );
    const { rows } = await client.query(
      'UPDATE addresses SET is_default = true, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ address: toApi(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteAddress(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE addresses SET is_active = false, is_default = false, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND is_active = true
       RETURNING is_default`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Address not found' });
    }

    // Deleting the default leaves the customer with none. Promote the most
    // recently used remaining address so checkout still opens with one selected.
    await client.query(
      `UPDATE addresses SET is_default = true, updated_at = now()
       WHERE id = (
         SELECT id FROM addresses
         WHERE user_id = $1 AND is_active = true
         ORDER BY updated_at DESC, id DESC
         LIMIT 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM addresses WHERE user_id = $1 AND is_active = true AND is_default = true
       )`,
      [req.user.id]
    );
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Shared by serviceability and checkout — both need the row, not the API shape. */
async function findOwnedAddress(userId, addressId) {
  const { rows } = await pool.query(
    'SELECT * FROM addresses WHERE id = $1 AND user_id = $2 AND is_active = true',
    [addressId, userId]
  );
  return rows[0] || null;
}

/** Frozen copy stored on the order, so editing an address never rewrites history. */
function toSnapshot(row) {
  return {
    addressId: row.id,
    receiverName: row.receiver_name,
    mobileNumber: row.mobile_number,
    houseBuilding: row.house_building,
    street: row.street,
    area: row.area,
    landmark: row.landmark,
    city: row.city,
    district: row.district,
    state: row.state,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    addressType: row.address_type,
    capturedAt: new Date().toISOString(),
  };
}

module.exports = {
  listAddresses,
  createAddress,
  updateAddress,
  setDefaultAddress,
  deleteAddress,
  findOwnedAddress,
  toSnapshot,
  toApi,
};
