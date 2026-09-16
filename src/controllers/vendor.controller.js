const pool = require('../config/db');

const BUSINESS_TYPES = ['b2b', 'b2c', 'both'];
const VENDOR_SORTS = ['rating', 'newest', 'nearest', 'name'];

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function createProfile(req, res) {
  const { businessName, businessType, gstNumber, addressLine, city, state, pincode, latitude, longitude } =
    req.body || {};
  if (!businessName || !BUSINESS_TYPES.includes(businessType)) {
    return res.status(400).json({ message: 'businessName and a valid businessType are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO vendor_profiles
        (user_id, business_name, business_type, gst_number, address_line, city, state, pincode, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.id, businessName, businessType, gstNumber || null, addressLine || null, city || null, state || null, pincode || null, latitude ?? null, longitude ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Vendor profile already exists' });
    }
    throw err;
  }
}

async function getMyProfile(req, res) {
  const { rows } = await pool.query('SELECT * FROM vendor_profiles WHERE user_id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Vendor profile not found' });
  res.json(rows[0]);
}

async function updateMyProfile(req, res) {
  const { businessName, businessType, gstNumber, addressLine, city, state, pincode, latitude, longitude } =
    req.body || {};
  const { rows } = await pool.query(
    `UPDATE vendor_profiles SET
      business_name = COALESCE($2, business_name),
      business_type = COALESCE($3, business_type),
      gst_number = COALESCE($4, gst_number),
      address_line = COALESCE($5, address_line),
      city = COALESCE($6, city),
      state = COALESCE($7, state),
      pincode = COALESCE($8, pincode),
      latitude = COALESCE($9, latitude),
      longitude = COALESCE($10, longitude)
     WHERE user_id = $1
     RETURNING *`,
    [req.user.id, businessName, businessType, gstNumber, addressLine, city, state, pincode, latitude, longitude]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Vendor profile not found' });
  res.json(rows[0]);
}

async function getPublicProfile(req, res) {
  const { rows } = await pool.query(
    `SELECT vp.id, vp.business_name, vp.business_type, vp.gst_number, vp.address_line,
            vp.city, vp.state, vp.pincode, vp.status, vp.description, vp.logo_url, vp.cover_image_url,
            dr.supports_delivery, dr.supports_pickup, dr.opens_at, dr.closes_at,
            CASE WHEN pm.rating_count > 0 THEN ROUND(pm.rating_sum / pm.rating_count, 2) END AS rating,
            COALESCE(pm.rating_count, 0) AS review_count
     FROM vendor_profiles vp
     LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = vp.id
     LEFT JOIN vendor_performance_metrics pm ON pm.vendor_id = vp.id
     WHERE vp.id = $1 AND vp.status = 'approved'`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Vendor not found' });
  const vendor = rows[0];
  res.json({ ...vendor, rating: vendor.rating == null ? null : Number(vendor.rating) });
}

/**
 * Public shop discovery: the Mart tab's "browse all approved shops" grid.
 *
 * `status = 'approved'` is the only visibility gate — a suspended or pending
 * vendor has no other flag to check, so this is also what makes a shop
 * disappear the instant Admin suspends it.
 */
async function listVendors(req, res) {
  const sort = VENDOR_SORTS.includes(req.query.sort) ? req.query.sort : 'rating';
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
  const lat = toNumber(req.query.lat ?? req.query.latitude);
  const lng = toNumber(req.query.lng ?? req.query.longitude);

  const params = [lat, lng];
  const conditions = [
    "vp.status = 'approved'",
    '($1::float8 IS NULL OR $2::float8 IS NULL OR true)',
  ];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (req.query.q) conditions.push(`vp.business_name ILIKE ${push(`%${req.query.q}%`)}`);
  if (req.query.businessType && BUSINESS_TYPES.includes(req.query.businessType)) {
    conditions.push(`vp.business_type = ${push(req.query.businessType)}`);
  }
  if (req.query.category) {
    conditions.push(
      `EXISTS (SELECT 1 FROM products p WHERE p.vendor_id = vp.id AND p.category = ${push(req.query.category)}
        AND p.is_active = true AND p.moderation_status = 'approved')`
    );
  }
  const minRating = toNumber(req.query.minRating);
  if (minRating != null) {
    conditions.push(`(pm.rating_count > 0 AND pm.rating_sum / pm.rating_count >= ${push(minRating)})`);
  }
  const radiusKm = toNumber(req.query.radiusKm);
  if (radiusKm != null && lat != null && lng != null) {
    conditions.push(
      `(vp.latitude IS NULL OR vp.longitude IS NULL
        OR earth_distance(ll_to_earth($1, $2), ll_to_earth(vp.latitude, vp.longitude)) / 1000 <= ${push(radiusKm)})`
    );
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const orderBy = {
    rating: 'rating DESC NULLS LAST, vp.business_name ASC',
    newest: 'vp.created_at DESC',
    nearest: 'distance_km ASC NULLS LAST, vp.business_name ASC',
    name: 'vp.business_name ASC',
  }[sort];

  const JOINS = `
    LEFT JOIN vendor_performance_metrics pm ON pm.vendor_id = vp.id
    LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = vp.id`;

  const [{ rows }, { rows: countRows }, { rows: categoryRows }] = await Promise.all([
    pool.query(
      `SELECT vp.id, vp.business_name, vp.business_type, vp.description, vp.logo_url, vp.cover_image_url,
              vp.address_line, vp.city, vp.state, vp.pincode, vp.status,
              dr.supports_delivery, dr.supports_pickup, dr.opens_at, dr.closes_at,
              CASE WHEN pm.rating_count > 0 THEN ROUND(pm.rating_sum / pm.rating_count, 2) END AS rating,
              COALESCE(pm.rating_count, 0) AS review_count,
              (SELECT COUNT(*)::int FROM products p
                WHERE p.vendor_id = vp.id AND p.is_active = true AND p.moderation_status = 'approved') AS product_count,
              CASE WHEN vp.latitude IS NOT NULL AND vp.longitude IS NOT NULL
                        AND $1::float8 IS NOT NULL AND $2::float8 IS NOT NULL
                   THEN earth_distance(ll_to_earth($1, $2), ll_to_earth(vp.latitude, vp.longitude)) / 1000
              END AS distance_km
       FROM vendor_profiles vp ${JOINS}
       ${where}
       ORDER BY ${orderBy}
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM vendor_profiles vp ${JOINS} ${where}`, params),
    // Shop counts per category, for the "browse by category" rail — counted
    // without the category filter so picking one never removes the others.
    pool.query(
      `SELECT p.category AS name, COUNT(DISTINCT p.vendor_id)::int AS count
       FROM products p
       JOIN vendor_profiles vp ON vp.id = p.vendor_id
       WHERE vp.status = 'approved' AND p.is_active = true AND p.moderation_status = 'approved'
         AND p.category IS NOT NULL
       GROUP BY p.category ORDER BY count DESC, p.category ASC`,
      []
    ),
  ]);

  res.json({
    items: rows.map((r) => ({
      ...r,
      rating: r.rating == null ? null : Number(r.rating),
      distance_km: r.distance_km == null ? null : Number(Number(r.distance_km).toFixed(2)),
    })),
    total: countRows[0].total,
    page,
    pageSize,
    sort,
    categoryFacets: categoryRows,
  });
}

module.exports = { createProfile, getMyProfile, updateMyProfile, getPublicProfile, listVendors };
