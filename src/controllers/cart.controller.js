const pool = require('../config/db');

/**
 * A cart line names a product and, when the product sells by variant, which
 * variant. Sprint 4 added the second half; every route still works without it,
 * so an app build already in the field keeps adding simple products unchanged.
 */

async function getOrCreateActiveCart(userId) {
  const existing = await pool.query("SELECT * FROM carts WHERE user_id = $1 AND status = 'active'", [userId]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await pool.query(
    "INSERT INTO carts (user_id, status) VALUES ($1, 'active') RETURNING *",
    [userId]
  );
  return created.rows[0];
}

/**
 * Checks a variant against the product it is claimed to belong to.
 *
 * Returns an error message, or null when the pairing is sound. A product that
 * has variants may not be bought without naming one: falling back to a default
 * would silently ship a Large to someone who chose Small.
 */
async function validateVariant(productId, variantId) {
  if (variantId != null) {
    const { rows } = await pool.query(
      'SELECT is_active FROM product_variants WHERE id = $1 AND product_id = $2',
      [variantId, productId]
    );
    if (!rows[0]) return 'That variant does not belong to this product';
    if (!rows[0].is_active) return 'That variant is no longer available';
    return null;
  }

  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM product_variants WHERE product_id = $1 AND is_active = true',
    [productId]
  );
  return rows[0].n > 0 ? 'This product is sold by variant — choose one' : null;
}

async function getCart(req, res) {
  const cart = await getOrCreateActiveCart(req.user.id);
  const { rows } = await pool.query(
    `SELECT ci.product_id, ci.variant_id, ci.quantity, p.name, p.currency, p.vendor_id, p.is_active,
            p.gst_rate_percent, p.moq,
            -- The variant's price when there is one, the product's otherwise.
            COALESCE(v.price_cents, p.price_cents) AS price_cents,
            COALESCE(vm.url, p.image_url) AS image_url,
            i.available_qty,
            (SELECT string_agg(av.value, ' / ' ORDER BY a.sort_order, av.sort_order)
             FROM variant_attribute_values vav
             JOIN attribute_values av ON av.id = vav.attribute_value_id
             JOIN product_attributes a ON a.id = av.attribute_id
             WHERE vav.variant_id = ci.variant_id) AS variant_label
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants v ON v.id = ci.variant_id
     LEFT JOIN product_media vm ON vm.variant_id = ci.variant_id AND vm.is_primary
     LEFT JOIN inventory i ON i.product_id = ci.product_id
                          AND i.variant_id IS NOT DISTINCT FROM ci.variant_id
     WHERE ci.cart_id = $1`,
    [cart.id]
  );
  res.json({ cartId: cart.id, items: rows });
}

async function addItem(req, res) {
  const { productId, quantity, variantId } = req.body || {};
  if (!productId || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: 'productId and a positive integer quantity are required' });
  }
  if (variantId != null && (!Number.isInteger(variantId) || variantId < 1)) {
    return res.status(400).json({ message: 'variantId must be a positive integer or null' });
  }

  const problem = await validateVariant(productId, variantId);
  if (problem) return res.status(400).json({ message: problem });

  const cart = await getOrCreateActiveCart(req.user.id);
  // Two conflict targets because the uniqueness is enforced by two partial
  // indexes — a NULL variant_id never collides with another NULL, so the simple
  // case needs its own predicate.
  await pool.query(
    variantId == null
      ? `INSERT INTO cart_items (cart_id, product_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (cart_id, product_id) WHERE variant_id IS NULL
         DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`
      : `INSERT INTO cart_items (cart_id, product_id, quantity, variant_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cart_id, product_id, variant_id) WHERE variant_id IS NOT NULL
         DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
    variantId == null ? [cart.id, productId, quantity] : [cart.id, productId, quantity, variantId]
  );
  res.status(201).json({ message: 'Added to cart' });
}

/** The variant a line-level route is addressing, from the body or the query string. */
function addressedVariant(req) {
  const raw = req.body?.variantId ?? req.query?.variantId;
  return raw == null || raw === '' ? null : Number(raw);
}

async function updateItem(req, res) {
  const { quantity } = req.body || {};
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: 'A positive integer quantity is required' });
  }
  const cart = await getOrCreateActiveCart(req.user.id);
  const { rows } = await pool.query(
    `UPDATE cart_items SET quantity = $3
     WHERE cart_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $4
     RETURNING *`,
    [cart.id, req.params.productId, quantity, addressedVariant(req)]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Item not in cart' });
  res.json(rows[0]);
}

async function removeItem(req, res) {
  const cart = await getOrCreateActiveCart(req.user.id);
  await pool.query(
    'DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3',
    [cart.id, req.params.productId, addressedVariant(req)]
  );
  res.status(204).send();
}

module.exports = { getCart, addItem, updateItem, removeItem, getOrCreateActiveCart, validateVariant };
