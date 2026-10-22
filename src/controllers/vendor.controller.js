const pool = require('../config/db');
const shopBranding = require('../services/shopBranding');
const shopTrust = require('../services/shopTrust');
const shopHours = require('../services/shopHours');
const shopFollows = require('../services/shopFollows');
const shopVisits = require('../services/shopVisits');

const BUSINESS_TYPES = ['b2b', 'b2c', 'both'];
// approved = newly approved shops first (SB2); visited / trending / ordered
// rank by popularity (SB5).
const VENDOR_SORTS = ['rating', 'newest', 'nearest', 'name', 'approved', 'visited', 'trending', 'ordered'];
const POPULARITY_SORTS = ['visited', 'trending', 'ordered'];

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
  const { rows } = await pool.query(
    `SELECT vp.*, ${shopTrust.verifiedSql('vp')} AS verified, ${shopFollows.followerCountSql('vp')} AS follower_count
     FROM vendor_profiles vp WHERE vp.user_id = $1`,
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Vendor profile not found' });
  res.json(rows[0]);
}

async function updateMyProfile(req, res) {
  const { businessName, businessType, gstNumber, addressLine, city, state, pincode, latitude, longitude } =
    req.body || {};
  // Description, logo and cover (SB1) and district (SB2): only the ones sent
  // change; '' clears.
  let branding;
  try {
    branding = shopBranding.brandingSet({ ...shopBranding.readBranding(req.body || {}), ...shopTrust.readPlace(req.body || {}) }, 11);
  } catch (err) {
    if (err instanceof shopBranding.BrandingError || err instanceof shopTrust.TrustError) {
      return res.status(err.status).json({ message: err.message });
    }
    throw err;
  }
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
      longitude = COALESCE($10, longitude)${branding.sql.map((s) => `,\n      ${s}`).join('')}
     WHERE user_id = $1
     RETURNING *`,
    [req.user.id, businessName, businessType, gstNumber, addressLine, city, state, pincode, latitude, longitude, ...branding.values]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Vendor profile not found' });
  res.json(rows[0]);
}

async function myVendorId(userId) {
  const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [userId]);
  return rows[0]?.id ?? null;
}

/** The shop's own gallery handlers (SB1): every photo with its status. */
const gallery = (fn) => async (req, res) => {
  const vendorId = await myVendorId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  try {
    await fn(vendorId, req, res);
  } catch (err) {
    if (err instanceof shopBranding.BrandingError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

const getMyGallery = gallery(async (vendorId, req, res) => {
  res.json({ items: await shopBranding.fullGallery(vendorId), max: shopBranding.MAX_PHOTOS });
});

const addGalleryPhoto = gallery(async (vendorId, req, res) => {
  res.status(201).json(await shopBranding.addPhoto(vendorId, req.body));
});

const updateGalleryPhoto = gallery(async (vendorId, req, res) => {
  res.json(await shopBranding.updatePhoto(vendorId, req.params.photoId, req.body));
});

const removeGalleryPhoto = gallery(async (vendorId, req, res) => {
  await shopBranding.removePhoto(vendorId, req.params.photoId);
  res.status(204).send();
});

/** The shop's own hours handlers (SB3): weekly timetable, timezone, holidays. */
const hours = (fn) => async (req, res) => {
  const vendorId = await myVendorId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  try {
    await fn(vendorId, req, res);
  } catch (err) {
    if (err instanceof shopHours.HoursError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

const getMyHours = hours(async (vendorId, req, res) => {
  res.json(await shopHours.getHours(vendorId));
});

const updateMyHours = hours(async (vendorId, req, res) => {
  res.json(await shopHours.saveHours(vendorId, shopHours.readWeek(req.body || {})));
});

const addMyHoliday = hours(async (vendorId, req, res) => {
  res.status(201).json(await shopHours.addHoliday(vendorId, req.body || {}));
});

const removeMyHoliday = hours(async (vendorId, req, res) => {
  await shopHours.removeHoliday(vendorId, req.params.holidayId);
  res.status(204).send();
});

/** Customer follows (SB4): follow / opt in to offers, unfollow, and my list. */
const follows = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof shopFollows.FollowError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

const followShop = follows(async (req, res) => {
  const { created, ...result } = await shopFollows.follow(req.user.id, req.params.id, req.body || {});
  res.status(created ? 201 : 200).json(result);
});

const unfollowShop = follows(async (req, res) => {
  res.json(await shopFollows.unfollow(req.user.id, req.params.id));
});

const listFollowedShops = follows(async (req, res) => {
  res.json({ items: await shopFollows.followedShops(req.user.id) });
});

const listFollowedShopIds = follows(async (req, res) => {
  res.json({ items: await shopFollows.followedIds(req.user.id) });
});

/** Shop-page views from the app (SB5); counted once per visitor per shop per day. */
async function recordShopViews(req, res) {
  try {
    const result = await shopVisits.recordViews({
      sessionId: req.body?.sessionId,
      events: req.body?.events,
      userId: req.user?.id,
      role: req.user?.role,
      userAgent: req.get('user-agent'),
    });
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof shopVisits.VisitError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
}

async function getPublicProfile(req, res) {
  const { rows } = await pool.query(
    `SELECT vp.id, vp.business_name, vp.business_type, vp.gst_number, vp.address_line,
            vp.city, vp.state, vp.pincode, vp.status, vp.description, vp.logo_url, vp.cover_image_url,
            dr.supports_delivery, dr.supports_pickup, dr.opens_at, dr.closes_at,
            CASE WHEN pm.rating_count > 0 THEN ROUND(pm.rating_sum / pm.rating_count, 2) END AS rating,
            COALESCE(pm.rating_count, 0) AS review_count,
            -- SB2: trust, place and the delivery facts a buyer checks first.
            vp.district, vp.latitude, vp.longitude, vp.approved_at, ${shopTrust.verifiedSql('vp')} AS verified,
            dr.delivery_charge_cents, dr.free_delivery_above_cents, dr.min_order_cents, dr.preparation_minutes,
            (SELECT COALESCE(array_agg(DISTINCT sa.pincode ORDER BY sa.pincode), '{}') FROM vendor_service_areas sa
              WHERE sa.vendor_id = vp.id AND sa.is_active AND sa.area_type = 'pincode' AND sa.pincode IS NOT NULL) AS service_pincodes,
            (SELECT MAX(sa.radius_km) FROM vendor_service_areas sa
              WHERE sa.vendor_id = vp.id AND sa.is_active AND sa.area_type = 'radius') AS service_radius_km,
            -- SB3: open now on the shop's clock, and today's hours.
            vp.timezone, ${shopHours.openNowSql('vp')} AS open_now, ${shopHours.todaySql('vp')} AS hours_today,
            -- SB4: followers, and whether the signed-in viewer is one.
            ${shopFollows.followerCountSql('vp')} AS follower_count,
            CASE WHEN $2::int IS NULL THEN NULL
                 ELSE EXISTS (SELECT 1 FROM shop_follows f WHERE f.vendor_id = vp.id AND f.user_id = $2::int) END AS following
     FROM vendor_profiles vp
     LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = vp.id
     LEFT JOIN vendor_performance_metrics pm ON pm.vendor_id = vp.id
     WHERE vp.id = $1 AND vp.status = 'approved'`,
    [req.params.id, req.user?.id ?? null]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Vendor not found' });
  const vendor = rows[0];
  res.json({
    ...vendor,
    rating: vendor.rating == null ? null : Number(vendor.rating),
    service_radius_km: vendor.service_radius_km == null ? null : Number(vendor.service_radius_km),
    // Visible photos only (SB1); hidden ones never reach customers.
    gallery: await shopBranding.publicGallery(vendor.id),
    // SB3: the weekly timetable ([] = the daily window) and coming holidays.
    ...(await shopHours.publicHours(vendor.id)),
  });
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
  // SB2: only shops with the Verified badge.
  if (req.query.verified === 'true') conditions.push(shopTrust.verifiedSql('vp'));
  // SB3: the filters the app used to apply on the phone, with the same rules
  // (a shop with no delivery settings yet matches neither delivery nor pickup),
  // plus open now from real hours and always-free delivery.
  if (req.query.openNow === 'true') conditions.push(`${shopHours.openNowSql('vp')} IS TRUE`);
  if (req.query.delivery === 'true') conditions.push('dr.supports_delivery IS TRUE');
  if (req.query.pickup === 'true') conditions.push('dr.supports_pickup IS TRUE');
  if (req.query.freeDelivery === 'true') conditions.push('(dr.supports_delivery IS TRUE AND dr.delivery_charge_cents = 0)');
  if (req.query.wholesale === 'true') conditions.push("vp.business_type IN ('b2b', 'both')");
  // SB5: a locality ("Popular in your area"); exact, ignoring case and spaces.
  for (const field of ['city', 'district', 'pincode']) {
    const value = typeof req.query[field] === 'string' ? req.query[field].trim() : '';
    if (value) conditions.push(`lower(trim(vp.${field})) = lower(${push(value)})`);
  }
  // SB5: Trending lists only shops whose visits are growing.
  if (sort === 'trending') conditions.push(shopVisits.TRENDING_CONDITION);
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
    approved: 'vp.approved_at DESC NULLS LAST, vp.created_at DESC',
    nearest: 'distance_km ASC NULLS LAST, vp.business_name ASC',
    name: 'vp.business_name ASC',
    visited: 'sv.visits_30d DESC, rating DESC NULLS LAST, vp.business_name ASC',
    trending: `${shopVisits.TREND_SCORE_SQL} DESC, sv.visits_7d DESC, vp.business_name ASC`,
    ordered: 'so.orders_30d DESC, rating DESC NULLS LAST, vp.business_name ASC',
  }[sort];
  // SB5: visit and order counts, only for the sorts that rank by them.
  const popular = POPULARITY_SORTS.includes(sort);

  const JOINS = `
    LEFT JOIN vendor_performance_metrics pm ON pm.vendor_id = vp.id
    LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = vp.id${popular ? shopVisits.popularityJoinSql('vp') : ''}`;

  const [{ rows }, { rows: countRows }, { rows: categoryRows }] = await Promise.all([
    pool.query(
      `SELECT vp.id, vp.business_name, vp.business_type, vp.description, vp.logo_url, vp.cover_image_url,
              vp.district, vp.approved_at, ${shopTrust.verifiedSql('vp')} AS verified,
              vp.address_line, vp.city, vp.state, vp.pincode, vp.status,
              dr.supports_delivery, dr.supports_pickup, dr.opens_at, dr.closes_at,
              dr.delivery_charge_cents, dr.free_delivery_above_cents,
              ${shopHours.openNowSql('vp')} AS open_now, ${shopHours.todaySql('vp')} AS hours_today,
              ${shopFollows.followerCountSql('vp')} AS follower_count,
              CASE WHEN pm.rating_count > 0 THEN ROUND(pm.rating_sum / pm.rating_count, 2) END AS rating,
              COALESCE(pm.rating_count, 0) AS review_count,
              (SELECT COUNT(*)::int FROM products p
                WHERE p.vendor_id = vp.id AND p.is_active = true AND p.moderation_status = 'approved') AS product_count,
              CASE WHEN vp.latitude IS NOT NULL AND vp.longitude IS NOT NULL
                        AND $1::float8 IS NOT NULL AND $2::float8 IS NOT NULL
                   THEN earth_distance(ll_to_earth($1, $2), ll_to_earth(vp.latitude, vp.longitude)) / 1000
              END AS distance_km${popular ? `, ${shopVisits.POPULARITY_FIELDS}` : ''}
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

module.exports = {
  createProfile,
  getMyProfile,
  updateMyProfile,
  getPublicProfile,
  listVendors,
  getMyGallery,
  addGalleryPhoto,
  updateGalleryPhoto,
  removeGalleryPhoto,
  getMyHours,
  updateMyHours,
  addMyHoliday,
  removeMyHoliday,
  followShop,
  unfollowShop,
  listFollowedShops,
  listFollowedShopIds,
  recordShopViews,
};
