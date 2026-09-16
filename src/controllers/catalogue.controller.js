const pool = require('../config/db');
const {
  applyMovement,
  ensureInventoryRow,
  refreshProductMirrors,
} = require('../services/inventory');

/**
 * Attributes, variants and media.
 * Contracts per documents/SPRINT_4_CATALOGUE_INVENTORY_SPEC.md §3.
 *
 * A product may have zero variants — the simple case, unchanged — or many. The
 * moment it has one, its own price and stock stop being authored and start
 * being mirrored from the variants; see refreshProductMirrors.
 */

const INPUT_TYPES = ['select', 'text', 'number'];
const MEDIA_TYPES = ['image', 'video'];

/** 'Red / Large' — what the customer saw, snapshotted onto the order line. */
function variantLabel(values) {
  return values.map((v) => v.value).join(' / ') || null;
}

/**
 * Postgres' RESTRICT, in the language of the API.
 *
 * An explicit ON DELETE RESTRICT raises 23001 (restrict_violation); the same
 * delete blocked by a plain foreign key raises 23503. Both mean the row is
 * still referenced, so both are the same 409 here.
 */
function isInUse(err) {
  return err.code === '23001' || err.code === '23503';
}

// ── Reads shared with the public product endpoints ──

/**
 * Media, variants and the attribute definitions a product's category offers.
 *
 * Three queries rather than one join: a product with four variants, three
 * attribute values each and six images would come back as 72 rows to be
 * unpicked in JS, and the app needs the three lists separately anyway.
 */
async function loadProductCatalogue(productId) {
  const { rows: media } = await pool.query(
    `SELECT id, variant_id, media_type, url, alt_text, is_primary, sort_order
     FROM product_media WHERE product_id = $1
     ORDER BY is_primary DESC, sort_order ASC, id ASC`,
    [productId]
  );

  const { rows: variants } = await pool.query(
    `SELECT v.*, i.available_qty, i.low_stock_threshold
     FROM product_variants v
     LEFT JOIN inventory i ON i.variant_id = v.id
     WHERE v.product_id = $1
     ORDER BY v.sort_order ASC, v.id ASC`,
    [productId]
  );

  const { rows: variantValues } = variants.length
    ? await pool.query(
        `SELECT vav.variant_id, av.id AS value_id, av.value,
                a.id AS attribute_id, a.code, a.name
         FROM variant_attribute_values vav
         JOIN attribute_values av ON av.id = vav.attribute_value_id
         JOIN product_attributes a ON a.id = av.attribute_id
         WHERE vav.variant_id = ANY($1)
         ORDER BY a.sort_order ASC, av.sort_order ASC`,
        [variants.map((v) => v.id)]
      )
    : { rows: [] };

  const valuesByVariant = new Map();
  for (const row of variantValues) {
    if (!valuesByVariant.has(row.variant_id)) valuesByVariant.set(row.variant_id, []);
    valuesByVariant.get(row.variant_id).push({
      attributeId: row.attribute_id,
      code: row.code,
      name: row.name,
      valueId: row.value_id,
      value: row.value,
    });
  }

  // The attribute definitions the app renders its picker from — scoped to this
  // product's category, plus the ones that apply everywhere.
  const { rows: attributes } = await pool.query(
    `SELECT a.id, a.name, a.code, a.input_type, a.is_variant_defining, a.sort_order,
            COALESCE(
              json_agg(json_build_object('id', av.id, 'value', av.value)
                       ORDER BY av.sort_order, av.id)
              FILTER (WHERE av.id IS NOT NULL),
              '[]'
            ) AS values
     FROM product_attributes a
     LEFT JOIN attribute_values av ON av.attribute_id = a.id
     WHERE a.is_active = true
       AND (a.category_id IS NULL
            OR a.category_id = (SELECT c.id FROM categories c
                                JOIN products p ON p.category = c.name
                                WHERE p.id = $1))
     GROUP BY a.id
     ORDER BY a.sort_order ASC, a.id ASC`,
    [productId]
  );

  return {
    media: media.map((m) => ({
      id: m.id,
      variantId: m.variant_id,
      mediaType: m.media_type,
      url: m.url,
      altText: m.alt_text,
      isPrimary: m.is_primary,
      sortOrder: m.sort_order,
    })),
    variants: variants.map((v) => {
      const values = valuesByVariant.get(v.id) ?? [];
      return {
        id: v.id,
        sku: v.sku,
        label: variantLabel(values),
        priceCents: v.price_cents,
        mrpCents: v.mrp_cents,
        isActive: v.is_active,
        sortOrder: v.sort_order,
        availableQty: v.available_qty ?? 0,
        attributes: values,
      };
    }),
    attributes: attributes.map((a) => ({
      id: a.id,
      name: a.name,
      code: a.code,
      inputType: a.input_type,
      isVariantDefining: a.is_variant_defining,
      values: a.values,
    })),
  };
}

/** The values on one variant, in picker order. Used for the order-line snapshot. */
async function loadVariantValues(client, variantId) {
  const { rows } = await client.query(
    `SELECT av.id AS value_id, av.value, a.id AS attribute_id, a.code, a.name
     FROM variant_attribute_values vav
     JOIN attribute_values av ON av.id = vav.attribute_value_id
     JOIN product_attributes a ON a.id = av.attribute_id
     WHERE vav.variant_id = $1
     ORDER BY a.sort_order ASC, av.sort_order ASC`,
    [variantId]
  );
  return rows;
}

// ── Admin: attributes ──

async function listAttributes(req, res) {
  const { categoryId, includeInactive } = req.query;
  const conditions = [];
  const params = [];
  if (categoryId) {
    params.push(Number(categoryId));
    // NULL means every category, so a scoped list must include the global ones
    // or Fashion would stop offering 'Material'.
    conditions.push(`(a.category_id = $${params.length} OR a.category_id IS NULL)`);
  }
  if (includeInactive !== 'true') conditions.push('a.is_active = true');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT a.*, c.name AS category_name,
            COALESCE(
              json_agg(json_build_object('id', av.id, 'value', av.value, 'sortOrder', av.sort_order)
                       ORDER BY av.sort_order, av.id)
              FILTER (WHERE av.id IS NOT NULL),
              '[]'
            ) AS values
     FROM product_attributes a
     LEFT JOIN categories c ON c.id = a.category_id
     LEFT JOIN attribute_values av ON av.attribute_id = a.id
     ${where}
     GROUP BY a.id, c.name
     ORDER BY a.sort_order ASC, a.id ASC`,
    params
  );
  res.json(rows);
}

async function createAttribute(req, res) {
  const { name, code, categoryId, inputType, isVariantDefining, sortOrder } = req.body || {};
  if (!name || !code) return res.status(400).json({ message: 'name and code are required' });
  if (inputType && !INPUT_TYPES.includes(inputType)) {
    return res.status(400).json({ message: `inputType must be one of ${INPUT_TYPES.join(', ')}` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO product_attributes (name, code, category_id, input_type, is_variant_defining, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, code, categoryId ?? null, inputType || 'select', isVariantDefining ?? true, sortOrder ?? 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: `The code '${code}' is already taken.` });
    throw err;
  }
}

async function updateAttribute(req, res) {
  const { name, categoryId, inputType, isVariantDefining, sortOrder, isActive } = req.body || {};
  if (inputType && !INPUT_TYPES.includes(inputType)) {
    return res.status(400).json({ message: `inputType must be one of ${INPUT_TYPES.join(', ')}` });
  }
  // code is deliberately not updatable: it is what a variant's meaning is keyed
  // on everywhere else, and renaming it silently re-points existing data.
  const { rows } = await pool.query(
    `UPDATE product_attributes SET
       name = COALESCE($2, name),
       category_id = COALESCE($3, category_id),
       input_type = COALESCE($4, input_type),
       is_variant_defining = COALESCE($5, is_variant_defining),
       sort_order = COALESCE($6, sort_order),
       is_active = COALESCE($7, is_active)
     WHERE id = $1 RETURNING *`,
    [req.params.id, name, categoryId, inputType, isVariantDefining, sortOrder, isActive]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Attribute not found' });
  res.json(rows[0]);
}

async function deleteAttribute(req, res) {
  try {
    const { rows } = await pool.query('DELETE FROM product_attributes WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Attribute not found' });
    res.status(204).send();
  } catch (err) {
    // The cascade to its values hits the RESTRICT on variant_attribute_values.
    if (isInUse(err)) {
      return res.status(409).json({ message: 'Some variants are still described by this attribute.' });
    }
    throw err;
  }
}

async function listAttributeValues(req, res) {
  const { rows } = await pool.query(
    'SELECT * FROM attribute_values WHERE attribute_id = $1 ORDER BY sort_order ASC, id ASC',
    [req.params.id]
  );
  res.json(rows);
}

async function createAttributeValue(req, res) {
  const { value, sortOrder } = req.body || {};
  if (!value) return res.status(400).json({ message: 'value is required' });

  const { rows: attr } = await pool.query('SELECT 1 FROM product_attributes WHERE id = $1', [req.params.id]);
  if (!attr[0]) return res.status(404).json({ message: 'Attribute not found' });

  try {
    const { rows } = await pool.query(
      'INSERT INTO attribute_values (attribute_id, value, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, value, sortOrder ?? 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: `'${value}' is already a value of this attribute.` });
    throw err;
  }
}

async function updateAttributeValue(req, res) {
  const { value, sortOrder } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE attribute_values SET value = COALESCE($3, value), sort_order = COALESCE($4, sort_order)
     WHERE id = $2 AND attribute_id = $1 RETURNING *`,
    [req.params.id, req.params.valueId, value, sortOrder]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Value not found' });
  res.json(rows[0]);
}

async function deleteAttributeValue(req, res) {
  try {
    const { rows } = await pool.query(
      'DELETE FROM attribute_values WHERE id = $2 AND attribute_id = $1 RETURNING id',
      [req.params.id, req.params.valueId]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Value not found' });
    res.status(204).send();
  } catch (err) {
    if (isInUse(err)) {
      return res.status(409).json({ message: 'Some variants are still sold as this value.' });
    }
    throw err;
  }
}

// ── Admin: variants ──

async function listVariants(req, res) {
  const { rows: product } = await pool.query('SELECT 1 FROM products WHERE id = $1', [req.params.id]);
  if (!product[0]) return res.status(404).json({ message: 'Product not found' });
  const { variants } = await loadProductCatalogue(req.params.id);
  res.json(variants);
}

/**
 * Adds a variant, its attribute values and its stock row.
 *
 * One transaction, because a variant with no stock row cannot be reserved
 * against and a variant with no attribute values is an unnamed duplicate of
 * whatever else the product sells.
 */
async function createVariant(req, res) {
  const { sku, priceCents, mrpCents, sortOrder, attributeValueIds, availableQty, lowStockThreshold } = req.body || {};
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    return res.status(400).json({ message: 'A valid priceCents is required' });
  }
  const valueIds = Array.isArray(attributeValueIds) ? attributeValueIds : [];
  if (valueIds.length === 0) {
    return res.status(400).json({ message: 'attributeValueIds is required — a variant is what its attributes say it is' });
  }
  if (availableQty != null && (!Number.isInteger(availableQty) || availableQty < 0)) {
    return res.status(400).json({ message: 'availableQty must be a non-negative integer' });
  }

  const { rows: productRows } = await pool.query('SELECT id, vendor_id FROM products WHERE id = $1', [req.params.id]);
  const product = productRows[0];
  if (!product) return res.status(404).json({ message: 'Product not found' });

  // Two values of the same attribute would make the variant both Small and
  // Large. There is no single-table constraint that catches this, so it is
  // checked here.
  const { rows: values } = await pool.query(
    'SELECT id, attribute_id FROM attribute_values WHERE id = ANY($1)',
    [valueIds]
  );
  if (values.length !== valueIds.length) {
    return res.status(400).json({ message: 'One or more attribute values do not exist' });
  }
  const attributeIds = new Set(values.map((v) => v.attribute_id));
  if (attributeIds.size !== values.length) {
    return res.status(400).json({ message: 'A variant cannot take two values of the same attribute' });
  }

  // This handler serves both the admin route and the vendor one, so movements
  // record who actually made the change rather than assuming an admin.
  const actorRole = req.user.role === 'vendor' ? 'vendor' : 'admin';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Whether this is the product's first variant decides what happens to the
    // stock it holds as a simple product — read before the insert.
    const { rows: existing } = await client.query(
      'SELECT COUNT(*)::int AS n FROM product_variants WHERE product_id = $1',
      [product.id]
    );
    const isFirst = existing[0].n === 0;

    const { rows: variantRows } = await client.query(
      `INSERT INTO product_variants (product_id, sku, price_cents, mrp_cents, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [product.id, sku || null, priceCents, mrpCents ?? null, sortOrder ?? 0]
    );
    const variant = variantRows[0];

    for (const valueId of valueIds) {
      await client.query(
        'INSERT INTO variant_attribute_values (variant_id, attribute_value_id) VALUES ($1, $2)',
        [variant.id, valueId]
      );
    }

    const inventoryRow = await ensureInventoryRow(client, {
      productId: product.id,
      variantId: variant.id,
      vendorId: product.vendor_id,
    });
    if (lowStockThreshold != null) {
      await client.query('UPDATE inventory SET low_stock_threshold = $2 WHERE id = $1', [
        inventoryRow.id,
        lowStockThreshold,
      ]);
    }
    if (availableQty) {
      await applyMovement(client, {
        inventoryId: inventoryRow.id,
        deltaAvailable: availableQty,
        reason: 'restocked',
        actorRole,
        userId: req.user.id,
        note: 'Opening stock for a new variant',
      });
    }

    // The product's own stock row is what it sold as a simple product. Leaving
    // it funded would double-count that stock against the variants and, worse,
    // leave the product sellable without choosing one.
    if (isFirst) {
      const { rows: simple } = await client.query(
        'SELECT * FROM inventory WHERE product_id = $1 AND variant_id IS NULL FOR UPDATE',
        [product.id]
      );
      if (simple[0] && simple[0].available_qty > 0) {
        await applyMovement(client, {
          inventoryId: simple[0].id,
          deltaAvailable: -simple[0].available_qty,
          reason: 'adjusted',
          actorRole,
          userId: req.user.id,
          note: 'Moved off the product row — this product now sells by variant',
        });
      }
    }

    await refreshProductMirrors(client, product.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ message: 'That SKU is already used by another variant of this product.' });
    }
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

  const { variants } = await loadProductCatalogue(product.id);
  res.status(201).json(variants);
}

async function updateVariant(req, res) {
  const { sku, priceCents, mrpCents, sortOrder, isActive } = req.body || {};
  if (priceCents != null && (!Number.isInteger(priceCents) || priceCents < 0)) {
    return res.status(400).json({ message: 'priceCents must be a non-negative integer' });
  }

  const client = await pool.connect();
  let variant;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE product_variants SET
         sku = COALESCE($3, sku),
         price_cents = COALESCE($4, price_cents),
         mrp_cents = COALESCE($5, mrp_cents),
         sort_order = COALESCE($6, sort_order),
         is_active = COALESCE($7, is_active),
         updated_at = now()
       WHERE id = $2 AND product_id = $1 RETURNING *`,
      [req.params.id, req.params.variantId, sku, priceCents, mrpCents, sortOrder, isActive]
    );
    variant = rows[0];
    if (!variant) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Variant not found' });
    }
    // A price change moves the product's 'from' price with it.
    await refreshProductMirrors(client, variant.product_id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ message: 'That SKU is already used by another variant of this product.' });
    }
    throw err;
  } finally {
    client.release();
  }

  res.json(variant);
}

async function deleteVariant(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: held } = await client.query(
      `SELECT COUNT(*)::int AS n FROM inventory_reservations r
       JOIN inventory i ON i.id = r.inventory_id
       WHERE i.variant_id = $1 AND r.status = 'held'`,
      [req.params.variantId]
    );
    if (held[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Stock of this variant is held for an open order.' });
    }

    const { rows } = await client.query(
      'DELETE FROM product_variants WHERE id = $2 AND product_id = $1 RETURNING product_id',
      [req.params.id, req.params.variantId]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Variant not found' });
    }
    await refreshProductMirrors(client, rows[0].product_id);
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Admin: media ──

async function listMedia(req, res) {
  const { rows } = await pool.query(
    `SELECT * FROM product_media WHERE product_id = $1
     ORDER BY is_primary DESC, sort_order ASC, id ASC`,
    [req.params.id]
  );
  res.json(rows);
}

async function createMedia(req, res) {
  const { url, mediaType, altText, isPrimary, sortOrder, variantId } = req.body || {};
  if (!url) return res.status(400).json({ message: 'url is required' });
  if (mediaType && !MEDIA_TYPES.includes(mediaType)) {
    return res.status(400).json({ message: `mediaType must be one of ${MEDIA_TYPES.join(', ')}` });
  }

  const { rows: product } = await pool.query('SELECT 1 FROM products WHERE id = $1', [req.params.id]);
  if (!product[0]) return res.status(404).json({ message: 'Product not found' });

  const client = await pool.connect();
  let media;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO product_media (product_id, variant_id, media_type, url, alt_text, is_primary, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.params.id, variantId ?? null, mediaType || 'image', url, altText || null, isPrimary === true, sortOrder ?? 0]
    );
    media = rows[0];
    if (media.is_primary) await refreshProductMirrors(client, media.product_id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // The partial unique index, not a check in this handler: promoting an image
    // is a deliberate act with its own endpoint, so uploading a second 'primary'
    // is a mistake worth refusing.
    if (err.code === '23505') {
      return res.status(409).json({
        message: 'This product already has a primary image. Promote this one instead.',
      });
    }
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json(media);
}

/** Demote the incumbent and promote this one, atomically — the index allows no overlap. */
async function setPrimaryMedia(req, res) {
  const client = await pool.connect();
  let media;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM product_media WHERE id = $1', [req.params.id]);
    media = rows[0];
    if (!media) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Media not found' });
    }
    if (media.media_type !== 'image') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Only an image can be the primary media.' });
    }

    await client.query(
      'UPDATE product_media SET is_primary = false WHERE product_id = $1 AND is_primary',
      [media.product_id]
    );
    const { rows: promoted } = await client.query(
      'UPDATE product_media SET is_primary = true WHERE id = $1 RETURNING *',
      [media.id]
    );
    media = promoted[0];
    await refreshProductMirrors(client, media.product_id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json(media);
}

async function deleteMedia(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'DELETE FROM product_media WHERE id = $2 AND product_id = $1 RETURNING product_id, is_primary',
      [req.params.id, req.params.mediaId]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Media not found' });
    }
    // Deleting the primary leaves image_url pointing at a row that no longer
    // exists, so the next image in order is promoted rather than leaving the
    // product without one.
    if (rows[0].is_primary) {
      await client.query(
        `UPDATE product_media SET is_primary = true
         WHERE id = (SELECT id FROM product_media
                     WHERE product_id = $1 AND media_type = 'image'
                     ORDER BY sort_order ASC, id ASC LIMIT 1)`,
        [rows[0].product_id]
      );
      await refreshProductMirrors(client, rows[0].product_id);
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  variantLabel,
  loadProductCatalogue,
  loadVariantValues,
  listAttributes,
  createAttribute,
  updateAttribute,
  deleteAttribute,
  listAttributeValues,
  createAttributeValue,
  updateAttributeValue,
  deleteAttributeValue,
  listVariants,
  createVariant,
  updateVariant,
  deleteVariant,
  listMedia,
  createMedia,
  setPrimaryMedia,
  deleteMedia,
};
