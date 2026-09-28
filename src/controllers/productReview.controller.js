const pool = require('../config/db');

/**
 * Product reviews, earned by a delivered order that contained the product.
 * Shop-level reviews live in review.controller.js; these rate the item itself.
 */

/**
 * Leaves or updates the caller's review of a product.
 *
 * Only someone with a delivered order containing the product may rate it, so
 * a rating always comes from a real purchase. An upsert on (product, user):
 * changing your mind edits the review instead of adding a second one.
 */
async function upsertProductReview(req, res) {
  const { rating, comment } = req.body || {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: 'rating must be a whole number from 1 to 5' });
  }
  if (comment !== undefined && comment !== null && (typeof comment !== 'string' || comment.length > 2000)) {
    return res.status(400).json({ message: 'comment must be text of up to 2000 characters' });
  }

  const { rows: bought } = await pool.query(
    `SELECT 1 FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = $1 AND o.user_id = $2 AND o.status = 'delivered'
      LIMIT 1`,
    [req.params.id, req.user.id]
  );
  if (!bought[0]) {
    return res.status(403).json({ message: 'You can review a product once an order containing it has been delivered.' });
  }

  // xmax = 0 marks a freshly inserted row, which is how create is told from edit.
  const { rows } = await pool.query(
    `INSERT INTO product_reviews (product_id, user_id, rating, comment)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_id, user_id) DO UPDATE SET
       rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()
     RETURNING id, product_id, rating, comment, created_at, updated_at, (xmax = 0) AS created`,
    [req.params.id, req.user.id, rating, comment || null]
  );
  const { created, ...review } = rows[0];
  res.status(created ? 201 : 200).json(review);
}

/**
 * A product's reviews, newest first, with its rating summary.
 *
 * Public: this is what a customer reads before deciding to buy.
 */
async function listProductReviews(req, res) {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const { rows: exists } = await pool.query('SELECT 1 FROM products WHERE id = $1', [req.params.id]);
  if (!exists[0]) return res.status(404).json({ message: 'Product not found' });

  const { rows: buckets } = await pool.query(
    'SELECT rating, COUNT(*)::int AS count FROM product_reviews WHERE product_id = $1 GROUP BY rating',
    [req.params.id]
  );
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let total = 0;
  for (const b of buckets) {
    distribution[b.rating] = b.count;
    count += b.count;
    total += b.rating * b.count;
  }

  const { rows } = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.full_name AS customer_name
       FROM product_reviews r
       JOIN users u ON u.id = r.user_id
      WHERE r.product_id = $1
      ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
    [req.params.id, limit, offset]
  );

  res.json({
    average: count ? Math.round((total / count) * 100) / 100 : null,
    count,
    distribution,
    reviews: rows,
  });
}

module.exports = { upsertProductReview, listProductReviews };
