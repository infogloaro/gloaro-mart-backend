const pool = require('../config/db');

async function getNearbyVendors(req, res) {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Number(req.query.radiusKm) || 10;
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ message: 'lat and lng are required' });
  }
  const { rows } = await pool.query(
    `SELECT id, business_name, business_type, city, state, latitude, longitude,
            (earth_distance(ll_to_earth($1, $2), ll_to_earth(latitude, longitude)) / 1000) AS distance_km
     FROM vendor_profiles
     WHERE status = 'approved'
       AND latitude IS NOT NULL AND longitude IS NOT NULL
       AND earth_box(ll_to_earth($1, $2), $3 * 1000) @> ll_to_earth(latitude, longitude)
     ORDER BY distance_km ASC
     LIMIT 50`,
    [lat, lng, radiusKm]
  );
  res.json(rows);
}

module.exports = { getNearbyVendors };
