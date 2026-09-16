const pool = require('./../config/db');

/**
 * Shop reviews, earned by delivered orders.
 *
 * The aggregate lives on vendor_performance_metrics.rating_sum/rating_count,
 * which search sort, the minRating filter and the matching engine have all
 * been reading since Sprint 6 — scoring neutral because nothing wrote to it.
 * This is what finally writes to it.
 *
 * Every review is tied to the order that earned it, so a rating cannot be left
 * by someone who never bought, and the aggregate can be rebuilt from the rows.
 */

/**
 * Applies a rating delta to a shop's aggregate.
 *
 * A delta rather than a recount: reviews are written one at a time and the
 * table is the source of truth if the two ever drift (the migration rebuilds
 * from it). Passing a negative `sumDelta` with a zero `countDelta` is how an
 * edited rating moves the total without double-counting the review.
 */
async function bumpRating(client, vendorId, sumDelta, countDelta) {
  await client.query(
    `INSERT INTO vendor_performance_metrics (vendor_id, rating_sum, rating_count)
     VALUES ($1, GREATEST($2, 0), GREATEST($3, 0))
     ON CONFLICT (vendor_id) DO UPDATE SET
       rating_sum = GREATEST(vendor_performance_metrics.rating_sum + $2, 0),
       rating_count = GREATEST(vendor_performance_metrics.rating_count + $3, 0),
       updated_at = now()`,
    [vendorId, sumDelta, countDelta]
  );
}

/**
 * Leaves or updates the review for one delivered order.
 *
 * An upsert rather than a create: changing your mind about a shop is normal,
 * and the alternative is a second endpoint plus an edit permission check for
 * something the unique index already scopes to one row per order.
 */
async function upsertReview(req, res) {
  const { rating, comment } = req.body || {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: 'rating must be a whole number from 1 to 5' });
  }

  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  const order = rows[0];
  if (!order) return res.status(404).json({ message: 'Order not found' });
  if (order.status !== 'delivered') {
    return res.status(409).json({ message: 'You can review a shop once your order has been delivered.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      'SELECT * FROM vendor_reviews WHERE order_id = $1 FOR UPDATE',
      [order.id]
    );
    const existing = existingRows[0];

    const { rows: saved } = await client.query(
      `INSERT INTO vendor_reviews (order_id, vendor_id, user_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id) DO UPDATE SET
         rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()
       RETURNING *`,
      [order.id, order.vendor_id, req.user.id, rating, comment || null]
    );

    // An edit moves the sum by the difference and leaves the count alone; a
    // new review adds both.
    if (existing) {
      await bumpRating(client, order.vendor_id, rating - existing.rating, 0);
    } else {
      await bumpRating(client, order.vendor_id, rating, 1);
    }

    await client.query('COMMIT');
    res.status(existing ? 200 : 201).json(saved[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The caller's own review for one order, or null if they have not left one. */
async function getReviewForOrder(req, res) {
  const { rows: orderRows } = await pool.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  if (!orderRows[0]) return res.status(404).json({ message: 'Order not found' });

  const { rows } = await pool.query('SELECT * FROM vendor_reviews WHERE order_id = $1', [req.params.id]);
  res.json(rows[0] ?? null);
}

/**
 * A shop's reviews, newest first, with its rating summary.
 *
 * Public: this is what a customer reads before deciding to buy.
 */
async function listVendorReviews(req, res) {
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  const { rows: summaryRows } = await pool.query(
    `SELECT COALESCE(rating_count, 0)::int AS count,
            CASE WHEN rating_count > 0 THEN ROUND(rating_sum / rating_count, 2)::float END AS average
     FROM vendor_performance_metrics WHERE vendor_id = $1`,
    [req.params.id]
  );

  const { rows } = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.full_name AS customer_name
     FROM vendor_reviews r
     JOIN users u ON u.id = r.user_id
     WHERE r.vendor_id = $1
     ORDER BY r.created_at DESC LIMIT $2`,
    [req.params.id, limit]
  );

  // A shop with no metrics row has simply never been rated.
  const summary = summaryRows[0] ?? { count: 0, average: null };

  // The star breakdown, so the UI can show the usual 5-to-1 bar chart.
  const { rows: buckets } = await pool.query(
    `SELECT rating, COUNT(*)::int AS count FROM vendor_reviews
     WHERE vendor_id = $1 GROUP BY rating`,
    [req.params.id]
  );
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const b of buckets) distribution[b.rating] = b.count;

  res.json({ average: summary.average, count: summary.count, distribution, reviews: rows });
}

module.exports = {
  bumpRating,
  upsertReview,
  getReviewForOrder,
  listVendorReviews,
};
