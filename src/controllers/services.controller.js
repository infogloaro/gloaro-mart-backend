const pool = require('../config/db');
const shopTrust = require('../services/shopTrust');
const shopHours = require('../services/shopHours');

/**
 * Local services for the app's Near Me Services tab (NS1). A provider is a
 * shop, so the shop part of every service is the shop list's own fields and
 * the rating is the shop's (vendor_reviews → vendor_performance_metrics).
 * Distance is only sent when the caller gave a point and the shop has one.
 *   GET /api/services/categories
 *   GET /api/services?categoryId&q&lat&lng&radiusKm&home&shop&openNow&minRating&minPrice&maxPrice&sort&page&pageSize
 *     (minPrice/maxPrice in paise: a service whose price or range touches them; on-request
 *     services have no price, so a price filter leaves them out)
 *   GET /api/services/:id
 */

const SORTS = ['recommended', 'nearest', 'rating', 'price_asc', 'price_desc'];

// What a customer may see of a service: active, by an approved shop, in an
// active category.
const VISIBLE = `s.status = 'active' AND vp.status = 'approved' AND c.is_active`;

function point(req) {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (req.query.lat === undefined || req.query.lng === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

const flag = (v) => v === 'true' || v === '1';

/** SELECT list for one service row with its shop as `shop`. $1/$2 = lat/lng (may be NULL). */
const SERVICE_FIELDS = `
  s.id, s.title, s.description, s.price_type, s.price_cents, s.price_max_cents, s.visit_fee_cents,
  s.duration_minutes, s.at_home, s.at_shop, s.images, s.video_url, s.updated_at,
  -- NS9: the service's own reviews (from requests the shop finished).
  (SELECT json_build_object('average', ROUND(AVG(r.rating)::numeric, 2), 'count', COUNT(*)::int)
     FROM service_reviews r WHERE r.service_id = s.id) AS reviews,
  json_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'name_ta', c.name_ta, 'name_hi', c.name_hi,
                    'image_url', c.image_url, 'icon_key', c.icon_key) AS category,
  CASE WHEN $1::float8 IS NOT NULL AND vp.latitude IS NOT NULL AND vp.longitude IS NOT NULL
       THEN earth_distance(ll_to_earth($1::float8, $2::float8), ll_to_earth(vp.latitude, vp.longitude)) / 1000 END AS distance_km,
  json_build_object(
    'id', vp.id, 'business_name', vp.business_name, 'business_type', vp.business_type,
    'description', vp.description, 'logo_url', vp.logo_url, 'cover_image_url', vp.cover_image_url,
    'address_line', vp.address_line, 'city', vp.city, 'district', vp.district, 'state', vp.state,
    'pincode', vp.pincode, 'landmark', vp.landmark, 'latitude', vp.latitude, 'longitude', vp.longitude,
    'contact', vp.contact, 'verified', ${shopTrust.verifiedSql('vp')},
    'supports_delivery', dr.supports_delivery, 'supports_pickup', dr.supports_pickup,
    'opens_at', dr.opens_at, 'closes_at', dr.closes_at,
    'open_now', ${shopHours.openNowSql('vp')}, 'hours_today', ${shopHours.todaySql('vp')},
    'rating', CASE WHEN pm.rating_count > 0 THEN ROUND(pm.rating_sum / pm.rating_count, 2) END,
    'review_count', COALESCE(pm.rating_count, 0)
  ) AS shop`;

const SERVICE_FROM = `
  FROM vendor_services s
  JOIN service_categories c ON c.id = s.category_id
  JOIN vendor_profiles vp ON vp.id = s.vendor_id
  LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = vp.id
  LEFT JOIN vendor_performance_metrics pm ON pm.vendor_id = vp.id`;

function shape(row) {
  const { distance_km: km, ...rest } = row;
  return { ...rest, distance_km: km == null ? null : Math.round(Number(km) * 100) / 100 };
}

async function categories(req, res) {
  const { rows } = await pool.query(
    `SELECT c.id, c.slug, c.name, c.name_ta, c.name_hi, c.group_key, c.icon_key, c.image_url, c.sort_order,
            (SELECT COUNT(DISTINCT s.vendor_id)::int FROM vendor_services s
               JOIN vendor_profiles vp ON vp.id = s.vendor_id
              WHERE s.category_id = c.id AND s.status = 'active' AND vp.status = 'approved') AS provider_count
     FROM service_categories c
     WHERE c.is_active
     ORDER BY c.sort_order, c.name`
  );
  res.json(rows);
}

async function list(req, res) {
  const at = point(req);
  if (at === undefined) return res.status(400).json({ message: 'lat and lng must be numbers' });
  const sort = req.query.sort ? String(req.query.sort) : 'recommended';
  if (!SORTS.includes(sort)) return res.status(400).json({ message: `sort must be one of ${SORTS.join(', ')}` });
  if (sort === 'nearest' && !at) return res.status(400).json({ message: 'sort=nearest needs lat and lng' });
  const radiusKm = req.query.radiusKm === undefined ? null : Number(req.query.radiusKm);
  if (radiusKm !== null && (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 500)) {
    return res.status(400).json({ message: 'radiusKm must be between 0 and 500' });
  }
  if (radiusKm !== null && !at) return res.status(400).json({ message: 'radiusKm needs lat and lng' });
  const minRating = req.query.minRating === undefined ? null : Number(req.query.minRating);
  if (minRating !== null && (!Number.isFinite(minRating) || minRating < 0 || minRating > 5)) {
    return res.status(400).json({ message: 'minRating must be between 0 and 5' });
  }
  const cents = (k) => (req.query[k] === undefined || req.query[k] === '' ? null : Number(req.query[k]));
  const minPrice = cents('minPrice');
  const maxPrice = cents('maxPrice');
  for (const [k, v] of [['minPrice', minPrice], ['maxPrice', maxPrice]]) {
    if (v !== null && (!Number.isInteger(v) || v < 0)) return res.status(400).json({ message: `${k} must be a whole number of paise` });
  }
  if (minPrice !== null && maxPrice !== null && maxPrice < minPrice) {
    return res.status(400).json({ message: 'maxPrice must not be below minPrice' });
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));

  const params = [at?.lat ?? null, at?.lng ?? null];
  const push = (v) => `$${params.push(v)}`;
  const where = [VISIBLE];
  if (req.query.categoryId !== undefined) {
    const id = Number.parseInt(req.query.categoryId, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'categoryId must be a number' });
    where.push(`s.category_id = ${push(id)}`);
  }
  if (req.query.vendorId !== undefined) {
    const id = Number.parseInt(req.query.vendorId, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'vendorId must be a number' });
    where.push(`s.vendor_id = ${push(id)}`);
  }
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  if (q) {
    const like = push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(s.title ILIKE ${like} OR s.description ILIKE ${like} OR vp.business_name ILIKE ${like}
                 OR c.name ILIKE ${like} OR c.name_ta ILIKE ${like} OR c.name_hi ILIKE ${like}
                 OR vp.city ILIKE ${like} OR vp.address_line ILIKE ${like})`);
  }
  if (flag(req.query.home)) where.push('s.at_home');
  if (flag(req.query.shop)) where.push('s.at_shop');
  if (flag(req.query.openNow)) where.push(`${shopHours.openNowSql('vp')} IS TRUE`);
  if (minRating !== null) where.push(`(pm.rating_count > 0 AND pm.rating_sum / pm.rating_count >= ${push(minRating)})`);
  if (minPrice !== null || maxPrice !== null) where.push("s.price_type <> 'on_request' AND s.price_cents IS NOT NULL");
  if (maxPrice !== null) where.push(`s.price_cents <= ${push(maxPrice)}`);
  if (minPrice !== null) where.push(`COALESCE(s.price_max_cents, s.price_cents) >= ${push(minPrice)}`);
  if (radiusKm !== null) {
    where.push(`vp.latitude IS NOT NULL AND vp.longitude IS NOT NULL
      AND earth_box(ll_to_earth($1::float8, $2::float8), ${push(radiusKm * 1000)}) @> ll_to_earth(vp.latitude, vp.longitude)
      AND earth_distance(ll_to_earth($1::float8, $2::float8), ll_to_earth(vp.latitude, vp.longitude)) <= $${params.length}`);
  }

  // Unknown distance / rating / price sort last, never first.
  const order = {
    recommended: at
      ? 'distance_km ASC NULLS LAST, pm.rating_count DESC NULLS LAST, s.updated_at DESC'
      : 'pm.rating_count DESC NULLS LAST, s.updated_at DESC',
    nearest: 'distance_km ASC NULLS LAST, s.id',
    rating: 'CASE WHEN pm.rating_count > 0 THEN pm.rating_sum / pm.rating_count END DESC NULLS LAST, pm.rating_count DESC NULLS LAST, s.id',
    price_asc: "CASE WHEN s.price_type = 'on_request' THEN NULL ELSE s.price_cents END ASC NULLS LAST, s.id",
    price_desc: "CASE WHEN s.price_type = 'on_request' THEN NULL ELSE COALESCE(s.price_max_cents, s.price_cents) END DESC NULLS LAST, s.id",
  }[sort];

  const whereSql = where.join(' AND ');
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(
      `SELECT ${SERVICE_FIELDS} ${SERVICE_FROM} WHERE ${whereSql}
       ORDER BY ${order} LIMIT ${push(pageSize)} OFFSET ${push((page - 1) * pageSize)}`,
      params
    ),
    // $1/$2 named here too, so Postgres knows their type when the filters don't use them.
    pool.query(
      `SELECT COUNT(*)::int AS total, $1::float8 AS lat, $2::float8 AS lng ${SERVICE_FROM} WHERE ${whereSql}`,
      params.slice(0, params.length - 2)
    ),
  ]);
  res.json({ items: rows.map(shape), total: count[0].total, page, pageSize });
}

async function getOne(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ message: 'Service not found' });
  const at = point(req);
  if (at === undefined) return res.status(400).json({ message: 'lat and lng must be numbers' });
  const { rows } = await pool.query(
    `SELECT ${SERVICE_FIELDS} ${SERVICE_FROM} WHERE ${VISIBLE} AND s.id = $3`,
    [at?.lat ?? null, at?.lng ?? null, id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Service not found' });
  res.json(shape(rows[0]));
}

module.exports = { categories, list, getOne };
