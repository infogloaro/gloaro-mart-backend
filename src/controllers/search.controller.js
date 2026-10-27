const pool = require('../config/db');

/**
 * The shop's catalogue query: filters, sorting and facets.
 * Contracts per documents/SPRINT_6_SHOP_EXPERIENCE_SPEC.md.
 *
 * One builder serves both endpoints, so `GET /api/products` and
 * `GET /api/products/search` can never disagree about what a filter means —
 * they differ only in what they wrap the rows in.
 */

const AVERAGE_SPEED_KMPH = 20;
const DEFAULT_PREPARATION_MINUTES = 30;

const SORTS = ['relevance', 'price_asc', 'price_desc', 'newest', 'discount', 'nearest', 'fastest', 'rating', 'popular', 'top_rated'];

/**
 * Attribute filters from the query string: attr[3]=7 or attr[3]=7,9 (any of
 * the values of attribute 3; several attributes must all match).
 *
 * Express 5's default "simple" query parser leaves `attr[3]` as one flat key
 * rather than nesting it under `attr`, so both shapes are read — and it is
 * `attr[<attributeId>]` for one reason: the key keeps the attribute, so the
 * app can group the chosen values per attribute without a second lookup.
 *
 * @returns {Map<number, number[]>} attribute id → chosen value ids
 */
function parseAttrFilters(query) {
  const byAttribute = new Map();
  const add = (attributeKey, raw) => {
    const attributeId = Number(attributeKey);
    const ids = toIdList(raw);
    if (!Number.isInteger(attributeId) || attributeId <= 0 || ids.length === 0) return;
    byAttribute.set(attributeId, [...new Set([...(byAttribute.get(attributeId) ?? []), ...ids])]);
  };
  for (const [key, value] of Object.entries(query)) {
    const m = /^attr\[(\d+)\]$/.exec(key);
    if (m) add(m[1], value);
  }
  if (query.attr && typeof query.attr === 'object') {
    for (const [key, value] of Object.entries(query.attr)) add(key, value);
  }
  return byAttribute;
}

/** The query without any attribute filter — or without one attribute's. */
function withoutAttrFilters(query, attributeId = null) {
  const copy = {};
  for (const [key, value] of Object.entries(query)) {
    const m = /^attr\[(\d+)\]$/.exec(key);
    if (m && (attributeId == null || Number(m[1]) === attributeId)) continue;
    if (key === 'attr' && value && typeof value === 'object') {
      const kept = Object.fromEntries(Object.entries(value).filter(([k]) => attributeId != null && Number(k) !== attributeId));
      if (Object.keys(kept).length) copy.attr = kept;
      continue;
    }
    copy[key] = value;
  }
  return copy;
}

/**
 * A product "has" an attribute value when one of its variants is sold as it
 * or the product itself carries it (product_attribute_values).
 */
const PRODUCT_VALUES = `
  SELECT pav.product_id, pav.attribute_value_id FROM product_attribute_values pav
  UNION
  SELECT v.product_id, vav.attribute_value_id
  FROM product_variants v JOIN variant_attribute_values vav ON vav.variant_id = v.id
  WHERE v.is_active = true`;

/**
 * Derived columns every listing row needs, as SQL.
 *
 * $1 and $2 are the customer's latitude and longitude, always bound even when
 * absent — the CASE yields NULL for a shop we cannot place, and NULL distance
 * has to stay distinguishable from a distance of zero.
 */
const DERIVED = `
  CASE WHEN vp.latitude IS NOT NULL AND vp.longitude IS NOT NULL
            AND $1::float8 IS NOT NULL AND $2::float8 IS NOT NULL
       THEN earth_distance(ll_to_earth($1, $2), ll_to_earth(vp.latitude, vp.longitude)) / 1000
  END AS distance_km,
  CASE WHEN p.mrp_cents IS NOT NULL AND p.mrp_cents > p.price_cents
       THEN ROUND((p.mrp_cents - p.price_cents)::numeric * 100 / p.mrp_cents)
  END AS discount_percent,
  COALESCE((SELECT SUM(i.available_qty)::int FROM inventory i WHERE i.product_id = p.id), 0) AS available_qty,
  COALESCE(
    (SELECT m.url FROM product_media m WHERE m.product_id = p.id AND m.is_primary LIMIT 1),
    p.image_url
  ) AS primary_image_url,
  (SELECT COUNT(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.is_active = true) AS variant_count,
  CASE WHEN pm.rating_count > 0 THEN ROUND(pm.rating_sum / pm.rating_count, 2) END AS vendor_rating`;

const JOINS = `
  JOIN vendor_profiles vp ON vp.id = p.vendor_id
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = vp.id
  LEFT JOIN vendor_performance_metrics pm ON pm.vendor_id = vp.id`;

/** Preparation time plus travel, as SQL — needed both to filter and to sort by. */
function etaExpression() {
  return `(COALESCE(dr.preparation_minutes, ${DEFAULT_PREPARATION_MINUTES}) +
     CASE WHEN vp.latitude IS NOT NULL AND vp.longitude IS NOT NULL
               AND $1::float8 IS NOT NULL AND $2::float8 IS NOT NULL
          THEN CEIL(earth_distance(ll_to_earth($1, $2), ll_to_earth(vp.latitude, vp.longitude))
                    / 1000 / ${AVERAGE_SPEED_KMPH} * 60)
          ELSE 0 END)`;
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Accepts ?brandId=1&brandId=4 and ?brandId=1,4 alike. */
function toIdList(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Turns a query string into a WHERE clause.
 *
 * Params always start with latitude and longitude so the derived columns above
 * can reference $1 and $2 whatever else is filtered on.
 */
function buildFilters(query) {
  const lat = toNumber(query.lat ?? query.latitude);
  const lng = toNumber(query.lng ?? query.longitude);
  const params = [lat, lng];
  const conditions = [
    'p.is_active = true',
    "p.moderation_status = 'approved'",
    "vp.status = 'approved'",
    // Always-true, and there for the parse step rather than the planner. $1 and
    // $2 are bound for every query built here, but the count and facet queries
    // reuse this WHERE without selecting the distance columns — leaving the two
    // parameters supplied and unreferenced, which Postgres rejects as
    // "could not determine data type of parameter $1". The casts pin them.
    '($1::float8 IS NULL OR $2::float8 IS NULL OR true)',
  ];

  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.category) conditions.push(`p.category = ${push(query.category)}`);
  if (query.categoryId) {
    conditions.push(`p.category = (SELECT c.name FROM categories c WHERE c.id = ${push(Number(query.categoryId))})`);
  }
  // One shop, or any of several (vendorIds=3,9 — the "Sold by" filter).
  const vendorIds = toIdList(query.vendorIds);
  if (query.vendorId) conditions.push(`p.vendor_id = ${push(Number(query.vendorId))}`);
  else if (vendorIds.length > 0) conditions.push(`p.vendor_id = ANY(${push(vendorIds)})`);
  // Sub-category within the category (Men / Women / Mobiles …), any case.
  if (query.subcategory) conditions.push(`lower(p.subcategory) = lower(${push(String(query.subcategory))})`);

  // Dynamic attribute filters, e.g. attr[3]=7,9 -> "is sold as (or carries)
  // value 7 or 9 of attribute 3"; attr[3]=… and attr[5]=… must both hold.
  // Vendor-agnostic and category-agnostic on purpose: an attribute id already
  // implies its category.
  for (const valueIds of parseAttrFilters(query).values()) {
    conditions.push(
      `EXISTS (SELECT 1 FROM (${PRODUCT_VALUES}) pv
               WHERE pv.product_id = p.id AND pv.attribute_value_id = ANY(${push(valueIds)}))`
    );
  }

  const brandIds = toIdList(query.brandId ?? query.brandIds);
  if (brandIds.length > 0) conditions.push(`p.brand_id = ANY(${push(brandIds)})`);

  if (query.q) conditions.push(`p.name ILIKE ${push(`%${query.q}%`)}`);

  const minPrice = toNumber(query.minPriceCents);
  const maxPrice = toNumber(query.maxPriceCents);
  if (minPrice != null) conditions.push(`p.price_cents >= ${push(minPrice)}`);
  if (maxPrice != null) conditions.push(`p.price_cents <= ${push(maxPrice)}`);

  const minDiscount = toNumber(query.minDiscountPercent);
  if (minDiscount != null) {
    conditions.push(
      `(p.mrp_cents IS NOT NULL AND p.mrp_cents > p.price_cents
        AND (p.mrp_cents - p.price_cents)::numeric * 100 / p.mrp_cents >= ${push(minDiscount)})`
    );
  }

  if (query.inStock === 'true') {
    conditions.push(
      '(SELECT COALESCE(SUM(i.available_qty), 0) FROM inventory i WHERE i.product_id = p.id) > 0'
    );
  }

  // minRating is the SHOP's rating (kept for the apps in the field);
  // minProductRating is the product's own, from its published reviews.
  const minRating = toNumber(query.minRating);
  if (minRating != null) {
    conditions.push(`(pm.rating_count > 0 AND pm.rating_sum / pm.rating_count >= ${push(minRating)})`);
  }
  const minProductRating = toNumber(query.minProductRating);
  if (minProductRating != null) {
    conditions.push(`(p.rating_count > 0 AND p.rating_average >= ${push(minProductRating)})`);
  }

  const maxEta = toNumber(query.maxEtaMinutes);
  if (maxEta != null) conditions.push(`${etaExpression()} <= ${push(maxEta)}`);

  // Unknown is not the same as far away. A shop that has not finished
  // onboarding has no coordinates, and dropping it would empty the catalogue of
  // every new vendor the moment a customer shares their location.
  const radiusKm = toNumber(query.radiusKm);
  if (radiusKm != null && lat != null && lng != null) {
    conditions.push(
      `(vp.latitude IS NULL OR vp.longitude IS NULL
        OR earth_distance(ll_to_earth($1, $2), ll_to_earth(vp.latitude, vp.longitude)) / 1000 <= ${push(radiusKm)})`
    );
  }

  return { where: `WHERE ${conditions.join(' AND ')}`, params, lat, lng };
}

/**
 * ORDER BY for a sort key.
 *
 * Everything that can be null sorts NULLS LAST: a product with no MRP has no
 * discount, and a missing value should never win a ranking.
 */
function orderBy(sort, hasQuery) {
  switch (sort) {
    case 'price_asc':
      return 'p.price_cents ASC, p.id DESC';
    case 'price_desc':
      return 'p.price_cents DESC, p.id DESC';
    case 'newest':
      return 'p.created_at DESC, p.id DESC';
    case 'discount':
      return 'discount_percent DESC NULLS LAST, p.created_at DESC';
    case 'nearest':
      return 'distance_km ASC NULLS LAST, p.created_at DESC';
    case 'fastest':
      return 'eta_minutes ASC NULLS LAST, p.created_at DESC';
    case 'rating':
      return 'vendor_rating DESC NULLS LAST, p.created_at DESC';
    case 'top_rated':
      // The product's own reviews; among equals, the more-reviewed first.
      return 'p.rating_average DESC NULLS LAST, p.rating_count DESC, p.created_at DESC';
    case 'popular':
      // Units sold across the product's stock rows; newest first among equals.
      return '(SELECT COALESCE(SUM(i.sold_qty), 0) FROM inventory i WHERE i.product_id = p.id) DESC, p.created_at DESC';
    case 'relevance':
    default:
      // Nothing to be relevant to without a search term, so recency stands in.
      // :Q is filled in by queryCatalogue, which owns the parameter list.
      return hasQuery
        ? `(CASE WHEN lower(p.name) = lower(:Q) THEN 0
                 WHEN p.name ILIKE (:Q || '%') THEN 1
                 ELSE 2 END), length(p.name) ASC, p.created_at DESC`
        : 'p.created_at DESC, p.id DESC';
  }
}

/** The rows for a filtered, sorted page of the catalogue. */
async function queryCatalogue(query, { limit = 100, offset = 0 } = {}) {
  const { where, params, lat, lng } = buildFilters(query);
  const sort = SORTS.includes(query.sort) ? query.sort : 'relevance';

  // Relevance needs the search term a second time, as an equality and a prefix
  // rather than the LIKE buildFilters bound.
  //
  // It goes on a copy, not on `params`. The caller reuses `params` with `where`
  // alone for the count and facet queries, and an extra parameter that only the
  // ORDER BY references would leave those queries binding one value too many.
  const queryParams = [...params];
  let order = orderBy(sort, Boolean(query.q));
  if (order.includes(':Q')) {
    queryParams.push(query.q);
    order = order.replaceAll(':Q', `$${queryParams.length}`);
  }

  const { rows } = await pool.query(
    `SELECT p.*, b.name AS brand_name, vp.business_name AS vendor_name,
            COALESCE(NULLIF(btrim(vp.city), ''), vp.district) AS vendor_city,
            dr.supports_delivery, dr.supports_pickup,
            ${DERIVED},
            ${etaExpression()} AS eta_minutes
     FROM products p ${JOINS}
     ${where}
     ORDER BY ${order}
     LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    queryParams
  );
  return { rows, where, params, sort, lat, lng };
}

/** One listing row, in the shape the product card renders. */
function toListingJson(r) {
  return {
    ...r,
    primary_image_url: r.primary_image_url,
    discount_percent: r.discount_percent == null ? null : Number(r.discount_percent),
    distance_km: r.distance_km == null ? null : Number(Number(r.distance_km).toFixed(2)),
    eta_minutes: r.eta_minutes == null ? null : Number(r.eta_minutes),
    vendor_rating: r.vendor_rating == null ? null : Number(r.vendor_rating),
    in_stock: r.available_qty > 0,
  };
}

/**
 * Facets for the filter sheet.
 *
 * Counted against the same WHERE the results used, minus the facet's own
 * filter — otherwise picking a brand would leave that brand as the only one
 * offered, and the customer could never widen the choice again.
 */
async function loadFacets(query) {
  const withoutBrand = { ...query };
  delete withoutBrand.brandId;
  delete withoutBrand.brandIds;
  const brandScope = buildFilters(withoutBrand);

  const withoutCategory = { ...query };
  delete withoutCategory.category;
  delete withoutCategory.categoryId;
  const categoryScope = buildFilters(withoutCategory);

  const priceScope = { ...query };
  delete priceScope.minPriceCents;
  delete priceScope.maxPriceCents;
  const priceRangeScope = buildFilters(priceScope);

  // Sub-categories belong to a category, so they are offered once one is
  // chosen; counted without the sub-category filter itself.
  const withoutSubcategory = { ...query };
  delete withoutSubcategory.subcategory;
  const subcategoryScope = buildFilters(withoutSubcategory);
  const subcategoriesPromise = query.category || query.categoryId
    ? pool.query(
        `SELECT p.subcategory AS name, COUNT(*)::int AS count
         FROM products p ${JOINS} ${subcategoryScope.where} AND p.subcategory IS NOT NULL AND p.subcategory <> ''
         GROUP BY p.subcategory ORDER BY count DESC, p.subcategory ASC`,
        subcategoryScope.params
      )
    : Promise.resolve({ rows: [] });

  // Attribute facets (RAM, size, fabric, ...) only make sense once the
  // customer has narrowed to one category — a mixed catalogue has no shared
  // attribute set to offer chips for. Counted against the full current filter
  // set (category included), since attributes narrow further rather than
  // replace the category — except each attribute's own filter, which is left
  // out the way brands are, so a second size can still be ticked.
  const attributesPromise = query.category || query.categoryId ? loadAttributeFacets(query) : Promise.resolve([]);

  // Shops among the results (counted without the shop filter) for "Sold by".
  const withoutVendor = { ...query };
  delete withoutVendor.vendorId;
  delete withoutVendor.vendorIds;
  const vendorScope = buildFilters(withoutVendor);

  // Whether rating and discount filters have anything to bite on, so the app
  // can hide a filter that no product here could ever match.
  const withoutQuality = { ...query };
  delete withoutQuality.minProductRating;
  delete withoutQuality.minDiscountPercent;
  const qualityScope = buildFilters(withoutQuality);

  const [brands, categories, price, attributes, subcategories, vendors, quality] = await Promise.all([
    pool.query(
      `SELECT b.id, b.name, COUNT(*)::int AS count
       FROM products p ${JOINS} ${brandScope.where} AND p.brand_id IS NOT NULL
       GROUP BY b.id, b.name ORDER BY count DESC, b.name ASC`,
      brandScope.params
    ),
    pool.query(
      `SELECT p.category AS name, COUNT(*)::int AS count
       FROM products p ${JOINS} ${categoryScope.where} AND p.category IS NOT NULL
       GROUP BY p.category ORDER BY count DESC, p.category ASC`,
      categoryScope.params
    ),
    pool.query(
      `SELECT MIN(p.price_cents)::int AS min_price_cents, MAX(p.price_cents)::int AS max_price_cents
       FROM products p ${JOINS} ${priceRangeScope.where}`,
      priceRangeScope.params
    ),
    attributesPromise,
    subcategoriesPromise,
    pool.query(
      `SELECT vp.id, vp.business_name AS name, COUNT(*)::int AS count
       FROM products p ${JOINS} ${vendorScope.where}
       GROUP BY vp.id, vp.business_name ORDER BY count DESC, vp.business_name ASC
       LIMIT 200`,
      vendorScope.params
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE p.rating_count > 0)::int AS rated,
              COUNT(*) FILTER (WHERE p.mrp_cents IS NOT NULL AND p.mrp_cents > p.price_cents)::int AS discounted
       FROM products p ${JOINS} ${qualityScope.where}`,
      qualityScope.params
    ),
  ]);

  return {
    brands: brands.rows,
    categories: categories.rows,
    subcategories: subcategories.rows,
    vendors: vendors.rows,
    priceRange: {
      minPriceCents: price.rows[0]?.min_price_cents ?? 0,
      maxPriceCents: price.rows[0]?.max_price_cents ?? 0,
    },
    ratedProducts: quality.rows[0]?.rated ?? 0,
    discountedProducts: quality.rows[0]?.discounted ?? 0,
    attributes,
  };
}

/**
 * Attribute facets: every filterable attribute that a product in scope carries
 * (through a variant or directly), with its values and how many products have
 * each. Attributes meant for certain sub-categories only (Sleeve → Men,
 * Women) are left out once a different sub-category is chosen.
 *
 * Counted against the full filter set — except the attribute's own filter:
 * one query for the attributes without a selection, and one per selected
 * attribute with that attribute's values removed from the WHERE, so the
 * customer sees what a second Size would give them.
 */
async function loadAttributeFacets(query) {
  const selected = parseAttrFilters(query);

  const facetRows = async (scopeQuery, onlyAttributeId) => {
    const scope = buildFilters(scopeQuery);
    const params = [...scope.params, query.subcategory ? String(query.subcategory) : null];
    const subParam = `$${params.length}`;
    let only = '';
    if (onlyAttributeId != null) {
      params.push(onlyAttributeId);
      only = `AND pa.id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `WITH scope AS (SELECT p.id FROM products p ${JOINS} ${scope.where})
       SELECT pa.id AS attribute_id, pa.name AS attribute_name, pa.code, pa.filter_kind, pa.unit,
              pa.subcategories, pa.sort_order AS attribute_order,
              av.id AS value_id, av.value, av.color_hex, av.sort_order AS value_order,
              COUNT(DISTINCT pv.product_id)::int AS count
       FROM (${PRODUCT_VALUES}) pv
       JOIN scope ON scope.id = pv.product_id
       JOIN attribute_values av ON av.id = pv.attribute_value_id
       JOIN product_attributes pa ON pa.id = av.attribute_id AND pa.is_active = true AND pa.is_filter = true
       WHERE (pa.subcategories IS NULL OR ${subParam}::text IS NULL
              OR EXISTS (SELECT 1 FROM unnest(pa.subcategories) s WHERE lower(s) = lower(${subParam}::text)))
         ${only}
       GROUP BY pa.id, av.id
       ORDER BY pa.sort_order ASC, pa.id ASC, av.sort_order ASC, av.id ASC`,
      params
    );
    return rows;
  };

  const [plain, ...perSelected] = await Promise.all([
    facetRows(query, null),
    ...[...selected.keys()].map((attributeId) => facetRows(withoutAttrFilters(query, attributeId), attributeId)),
  ]);

  // Group the flat value rows back into one entry per attribute, in the
  // shape the filter page renders: a labelled group of value chips.
  const attributesById = new Map();
  const take = (rows) => {
    for (const row of rows) {
      if (!attributesById.has(row.attribute_id)) {
        attributesById.set(row.attribute_id, {
          id: row.attribute_id,
          name: row.attribute_name,
          code: row.code,
          filterKind: row.filter_kind,
          unit: row.unit,
          subcategories: row.subcategories,
          sortOrder: row.attribute_order,
          values: [],
        });
      }
      attributesById.get(row.attribute_id).values.push({
        id: row.value_id,
        value: row.value,
        colorHex: row.color_hex,
        count: row.count,
      });
    }
  };
  take(plain.filter((row) => !selected.has(row.attribute_id)));
  for (const rows of perSelected) take(rows);

  return [...attributesById.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/**
 * The filter UI's endpoint: results, paging and the facets to filter by, in one
 * round trip. A second call for facets could disagree with the results it is
 * meant to describe.
 */
async function searchProducts(req, res) {
  if (req.query.sort && !SORTS.includes(req.query.sort)) {
    return res.status(400).json({ message: `sort must be one of ${SORTS.join(', ')}` });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 24));

  const { rows, where, params, sort } = await queryCatalogue(req.query, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const [{ rows: countRows }, facets] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM products p ${JOINS} ${where}`, params),
    loadFacets(req.query),
  ]);

  res.json({
    items: rows.map(toListingJson),
    total: countRows[0].total,
    page,
    pageSize,
    sort,
    facets,
  });
}

module.exports = { searchProducts, queryCatalogue, toListingJson, buildFilters, SORTS };
