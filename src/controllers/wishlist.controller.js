const pool = require('./../config/db');

/**
 * Saved products.
 *
 * A bookmark, not a second cart: no quantity and no price snapshot. Listing
 * joins the product live so a saved item always shows today's price, today's
 * stock, and disappears the moment the shop delists it — a wishlist that
 * quotes a stale price is worse than no wishlist.
 */

async function listWishlist(req, res) {
  const { rows } = await pool.query(
    `SELECT p.*, w.created_at AS saved_at, vp.business_name AS vendor_name
     FROM wishlist_items w
     JOIN products p ON p.id = w.product_id
     LEFT JOIN vendor_profiles vp ON vp.id = p.vendor_id
     WHERE w.user_id = $1
       AND p.is_active = true
       AND p.moderation_status = 'approved'
     ORDER BY w.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
}

/**
 * Saves a product. Idempotent: tapping the heart twice on a slow connection
 * is one save, not an error the customer has to understand.
 */
async function addToWishlist(req, res) {
  const { productId } = req.body || {};
  if (!Number.isInteger(productId)) {
    return res.status(400).json({ message: 'productId is required' });
  }

  const { rows: productRows } = await pool.query(
    "SELECT id FROM products WHERE id = $1 AND is_active = true AND moderation_status = 'approved'",
    [productId]
  );
  if (!productRows[0]) return res.status(404).json({ message: 'Product not found' });

  const { rows } = await pool.query(
    `INSERT INTO wishlist_items (user_id, product_id) VALUES ($1, $2)
     ON CONFLICT (user_id, product_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [req.user.id, productId]
  );
  res.status(201).json(rows[0]);
}

async function removeFromWishlist(req, res) {
  await pool.query('DELETE FROM wishlist_items WHERE user_id = $1 AND product_id = $2', [
    req.user.id,
    req.params.productId,
  ]);
  // 204 whether or not a row went: the caller wanted it gone, and it is.
  res.status(204).send();
}

/**
 * Just the saved product ids.
 *
 * The catalogue needs to fill in hearts across a whole page of products, and
 * asking per product would be a request per tile.
 */
async function listWishlistIds(req, res) {
  const { rows } = await pool.query('SELECT product_id FROM wishlist_items WHERE user_id = $1', [
    req.user.id,
  ]);
  res.json(rows.map((r) => r.product_id));
}

module.exports = {
  listWishlist,
  addToWishlist,
  removeFromWishlist,
  listWishlistIds,
};
