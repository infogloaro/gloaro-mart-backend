const pool = require('../config/db');
const { loadProductCatalogue } = require('./catalogue.controller');
const { setSimpleStock } = require('../services/inventory');
const { queryCatalogue, toListingJson, SORTS } = require('./search.controller');

async function getVendorProfileId(userId) {
  const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [userId]);
  return rows[0]?.id || null;
}

// Resolves qty -> unit price, honoring bulk tiers, falling back to base price.
function resolveUnitPriceCents(product, quantity, tiers) {
  const tier = (tiers || [])
    .filter((t) => quantity >= t.min_quantity && (t.max_quantity == null || quantity <= t.max_quantity))
    .sort((a, b) => b.min_quantity - a.min_quantity)[0];
  return tier ? tier.unit_price_cents : product.price_cents;
}

async function attachTiers(products) {
  if (products.length === 0) return products;
  const ids = products.map((p) => p.id);
  const { rows: tierRows } = await pool.query(
    'SELECT * FROM product_price_tiers WHERE product_id = ANY($1) ORDER BY min_quantity ASC',
    [ids]
  );
  const tiersByProduct = new Map();
  for (const tier of tierRows) {
    if (!tiersByProduct.has(tier.product_id)) tiersByProduct.set(tier.product_id, []);
    tiersByProduct.get(tier.product_id).push(tier);
  }
  return products.map((p) => ({ ...p, tiers: tiersByProduct.get(p.id) || [] }));
}

async function createProduct(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const { name, description, priceCents, currency, stockQuantity, imageUrl, category, brandId, gstRatePercent, moq } =
    req.body || {};
  if (!name || !Number.isInteger(priceCents) || priceCents < 0) {
    return res.status(400).json({ message: 'name and a valid priceCents are required' });
  }
  if (brandId != null && (!Number.isInteger(brandId) || brandId < 1)) {
    return res.status(400).json({ message: 'brandId must be a positive integer or null' });
  }
  if (brandId != null) {
    const { rows: brandRows } = await pool.query('SELECT 1 FROM brands WHERE id = $1 AND is_active = true', [brandId]);
    if (!brandRows[0]) return res.status(404).json({ message: 'Brand not found' });
  }
  // The product and its stock row are one transaction. A product without one
  // cannot be reserved against, so checkout would refuse the thing that was
  // just created.
  const client = await pool.connect();
  let product;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO products (vendor_id, name, description, price_cents, currency, stock_quantity, image_url, category, brand_id, gst_rate_percent, moq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        vendorId,
        name,
        description || null,
        priceCents,
        currency || 'INR',
        stockQuantity ?? 0,
        imageUrl || null,
        category || null,
        brandId ?? null,
        gstRatePercent ?? 0,
        moq ?? 1,
      ]
    );
    product = rows[0];
    await openingStock(client, product, req.user.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json(product);
}

/**
 * The stock row and primary image a newly created product starts with.
 *
 * Both columns it reads are mirrors from here on, so this is the one moment
 * they are treated as authored values rather than derived ones.
 */
async function openingStock(client, product, userId) {
  await setSimpleStock(client, {
    productId: product.id,
    vendorId: product.vendor_id,
    targetQty: product.stock_quantity ?? 0,
    userId,
    note: 'Opening stock',
  });
  if (product.image_url && product.image_url.trim()) {
    await client.query(
      `INSERT INTO product_media (product_id, media_type, url, is_primary, sort_order)
       VALUES ($1, 'image', $2, true, 0)`,
      [product.id, product.image_url]
    );
  }
}

async function getMyProducts(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  const { rows } = await pool.query(
    'SELECT * FROM products WHERE vendor_id = $1 ORDER BY created_at DESC',
    [vendorId]
  );
  res.json(rows);
}

async function updateProduct(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const {
    name,
    description,
    priceCents,
    currency,
    stockQuantity,
    imageUrl,
    category,
    brandId,
    isActive,
    gstRatePercent,
    moq,
  } = req.body || {};
  if (brandId != null && (!Number.isInteger(brandId) || brandId < 1)) {
    return res.status(400).json({ message: 'brandId must be a positive integer or null' });
  }
  if (brandId != null) {
    const { rows: brandRows } = await pool.query('SELECT 1 FROM brands WHERE id = $1 AND is_active = true', [brandId]);
    if (!brandRows[0]) return res.status(404).json({ message: 'Brand not found' });
  }
  if (stockQuantity != null && (!Number.isInteger(stockQuantity) || stockQuantity < 0)) {
    return res.status(400).json({ message: 'stockQuantity must be a non-negative integer' });
  }

  // stock_quantity is absent from this UPDATE on purpose: it is a mirror of the
  // stock row now, and writing it here would be both unexplained and undone by
  // the next refresh. The field still works — it goes through a movement below.
  const client = await pool.connect();
  let product;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE products SET
        name = COALESCE($3, name),
        description = COALESCE($4, description),
        price_cents = COALESCE($5, price_cents),
        currency = COALESCE($6, currency),
        image_url = COALESCE($7, image_url),
        category = COALESCE($8, category),
        brand_id = COALESCE($9, brand_id),
        is_active = COALESCE($10, is_active),
        gst_rate_percent = COALESCE($11, gst_rate_percent),
        moq = COALESCE($12, moq),
        updated_at = now()
       WHERE id = $1 AND vendor_id = $2
       RETURNING *`,
      [
        req.params.id,
        vendorId,
        name,
        description,
        priceCents,
        currency,
        imageUrl,
        category,
        brandId,
        isActive,
        gstRatePercent,
        moq,
      ]
    );
    product = rows[0];
    if (!product) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Product not found' });
    }
    if (stockQuantity != null) {
      await setSimpleStock(client, {
        productId: product.id,
        vendorId,
        targetQty: stockQuantity,
        userId: req.user.id,
        note: 'Stock updated by the vendor',
      });
      const { rows: fresh } = await client.query('SELECT * FROM products WHERE id = $1', [product.id]);
      product = fresh[0];
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

  res.json(product);
}

async function deleteProduct(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const { rows } = await pool.query(
    `UPDATE products SET is_active = false, updated_at = now() WHERE id = $1 AND vendor_id = $2 RETURNING id`,
    [req.params.id, vendorId]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Product not found' });
  res.status(204).send();
}

async function getProduct(req, res) {
  const { rows } = await pool.query(
    `SELECT p.*, b.name AS brand_name FROM products p
     JOIN vendor_profiles vp ON vp.id = p.vendor_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.id = $1 AND p.is_active = true AND p.moderation_status = 'approved'
       AND vp.status = 'approved'`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Product not found' });
  const [withTiers] = await attachTiers(rows);
  // Added alongside the existing fields rather than replacing them: an app build
  // already in the field reads price_cents, stock_quantity and image_url, and
  // those are still true — mirrored from the variants and media below.
  const catalogue = await loadProductCatalogue(withTiers.id);
  res.json({ ...withTiers, ...catalogue });
}

async function getVendorProducts(req, res) {
  const { rows } = await pool.query(
    `SELECT p.* FROM products p
     JOIN vendor_profiles vp ON vp.id = p.vendor_id
     WHERE p.vendor_id = $1 AND p.is_active = true AND p.moderation_status = 'approved'
       AND vp.status = 'approved'
     ORDER BY p.created_at DESC`,
    [req.params.id]
  );
  const withTiers = req.query.includeTiers === 'true' ? await attachTiers(rows) : rows;
  res.json(withTiers);
}

// Shared WHERE-builder reused by listProducts (plain keyword search) and
// aiSearch.controller.js (LLM-parsed filters) so both stay in sync.
async function queryProducts({ category, brandId, q, minPriceCents, maxPriceCents, limit = 100 }) {
  // moderation_status gates the shop: a product waiting for review, or rejected,
  // is invisible to customers no matter what its vendor set is_active to.
  const conditions = ['p.is_active = true', "p.moderation_status = 'approved'", "vp.status = 'approved'"];
  const params = [];
  if (category) {
    params.push(category);
    conditions.push(`p.category = $${params.length}`);
  }
  if (brandId) {
    params.push(brandId);
    conditions.push(`p.brand_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`p.name ILIKE $${params.length}`);
  }
  if (minPriceCents != null) {
    params.push(minPriceCents);
    conditions.push(`p.price_cents >= $${params.length}`);
  }
  if (maxPriceCents != null) {
    params.push(maxPriceCents);
    conditions.push(`p.price_cents <= $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT p.*, b.name AS brand_name FROM products p
     JOIN vendor_profiles vp ON vp.id = p.vendor_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY p.created_at DESC LIMIT ${limit}`,
    params
  );
  return rows;
}

/**
 * The catalogue, as a bare array.
 *
 * Still an array on purpose: every app build in the field unpacks this response
 * as one, and wrapping it in { items, total } would break all of them. The
 * envelope lives at GET /api/products/search instead.
 *
 * Filtering and sorting go through the shared builder in search.controller, so
 * a filter cannot mean one thing here and another there. That is also where the
 * location parameters this endpoint has been sent since Phase 1 — and ignored
 * until now — are finally honoured.
 */
async function listProducts(req, res) {
  const { includeTiers } = req.query;
  if (req.query.sort && !SORTS.includes(req.query.sort)) {
    return res.status(400).json({ message: `sort must be one of ${SORTS.join(', ')}` });
  }
  const { rows } = await queryCatalogue(req.query, { limit: Number(req.query.limit) || 100 });
  const listing = rows.map(toListingJson);
  const withTiers = includeTiers === 'true' ? await attachTiers(listing) : listing;
  res.json(withTiers);
}

async function getTiers(req, res) {
  const { rows } = await pool.query(
    'SELECT * FROM product_price_tiers WHERE product_id = $1 ORDER BY min_quantity ASC',
    [req.params.id]
  );
  res.json(rows);
}

async function setTiers(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const { rows: productRows } = await pool.query('SELECT id FROM products WHERE id = $1 AND vendor_id = $2', [
    req.params.id,
    vendorId,
  ]);
  if (!productRows[0]) return res.status(404).json({ message: 'Product not found' });

  const tiers = Array.isArray(req.body?.tiers) ? req.body.tiers : [];
  for (const tier of tiers) {
    if (!Number.isInteger(tier.minQuantity) || tier.minQuantity < 1 || !Number.isInteger(tier.unitPriceCents)) {
      return res.status(400).json({ message: 'Each tier requires a valid minQuantity and unitPriceCents' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM product_price_tiers WHERE product_id = $1', [req.params.id]);
    for (const tier of tiers) {
      await client.query(
        `INSERT INTO product_price_tiers (product_id, min_quantity, max_quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, tier.minQuantity, tier.maxQuantity ?? null, tier.unitPriceCents]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    'SELECT * FROM product_price_tiers WHERE product_id = $1 ORDER BY min_quantity ASC',
    [req.params.id]
  );
  res.json(rows);
}

module.exports = {
  createProduct,
  getMyProducts,
  updateProduct,
  deleteProduct,
  getProduct,
  getVendorProducts,
  listProducts,
  getTiers,
  setTiers,
  resolveUnitPriceCents,
  queryProducts,
  attachTiers,
};
