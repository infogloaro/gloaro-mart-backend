const pool = require('./../config/db');
const { recordAudit } = require('../services/auditLog');

/**
 * Reviews of shops and of products, and their moderation.
 *
 * A shop review is earned by a delivered order (Phase 13). A product review can
 * be left by any signed-in customer, but only one backed by a delivered order
 * containing that product is "verified" and goes live at once; an unverified
 * one waits for an admin. Anything taken down and then edited goes back to the
 * queue, so editing is not a way around a moderator.
 *
 * The shop aggregate lives on vendor_performance_metrics.rating_sum/count —
 * read by search sort, the minRating filter and the matching engine — and the
 * product one on products.rating_count/rating_average. Both are rebuilt from
 * the published rows whenever a review changes, so they can never drift.
 *
 * 'flagged' is a published review with open reports. It is still live; the
 * admin either takes it down (reports upheld) or keeps it (reports dismissed).
 */

const MODULE = 'customers';
const ADMIN_PAGE_SIZE = 20;
const PHOTO_PATH = /^\/uploads\/reviews\/[\w.-]+$/;
const MAX_PHOTOS = 5;

const OPEN_REPORTS = 'EXISTS (SELECT 1 FROM review_reports rr WHERE rr.review_id = r.id AND rr.resolved_at IS NULL)';
const HELPFUL_COUNT = '(SELECT COUNT(*)::int FROM review_helpful h WHERE h.review_id = r.id)';

/** Rebuilds the shop and/or product rating from the published reviews. */
async function refreshRatings(client, { vendorId, productId }) {
  if (vendorId) {
    await client.query(
      `INSERT INTO vendor_performance_metrics (vendor_id, rating_sum, rating_count)
       SELECT $1, COALESCE(SUM(rating), 0), COUNT(*)
       FROM vendor_reviews WHERE vendor_id = $1 AND target = 'vendor' AND status = 'published'
       ON CONFLICT (vendor_id) DO UPDATE SET
         rating_sum = EXCLUDED.rating_sum, rating_count = EXCLUDED.rating_count, updated_at = now()`,
      [vendorId]
    );
  }
  if (productId) {
    await client.query(
      `UPDATE products SET
         rating_count = (SELECT COUNT(*) FROM vendor_reviews
                         WHERE product_id = $1 AND target = 'product' AND status = 'published'),
         rating_average = (SELECT ROUND(AVG(rating), 2) FROM vendor_reviews
                           WHERE product_id = $1 AND target = 'product' AND status = 'published')
       WHERE id = $1`,
      [productId]
    );
  }
}

/** For the review the database just changed — the shop's rating, and the product's if it has one. */
const ratingsOf = (review) => ({
  vendorId: review.target === 'vendor' ? review.vendor_id : null,
  productId: review.product_id,
});

/** A review earned by an order links to that order (/orders/<id>); an unverified product review has none. */
async function notify(userId, type, title, body, orderId = null) {
  await pool.query('INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, $2, $3, $4, $5)', [
    userId,
    type,
    title,
    body,
    orderId ? `/orders/${orderId}` : null,
  ]);
}

/** Checks rating, title, comment and photos; returns an error message or the clean values. */
function readReviewBody(body) {
  const { rating, title, comment, photos = [] } = body || {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { error: 'rating must be a whole number from 1 to 5' };
  }
  if (title != null && (typeof title !== 'string' || title.length > 120)) {
    return { error: 'title must be text of at most 120 characters' };
  }
  if (comment != null && (typeof comment !== 'string' || comment.length > 2000)) {
    return { error: 'comment must be text of at most 2000 characters' };
  }
  // Only photos this server stored (POST /api/reviews/photos), so a review
  // can't hotlink an image from anywhere on the internet.
  if (!Array.isArray(photos) || photos.length > MAX_PHOTOS || !photos.every((p) => typeof p === 'string' && PHOTO_PATH.test(p))) {
    return { error: `photos must be up to ${MAX_PHOTOS} paths returned by POST /api/reviews/photos` };
  }
  return { rating, title: title?.trim() || null, comment: comment?.trim() || null, photos };
}

/**
 * Where an edited or new review lands. Anything a moderator took down goes
 * back to the queue when it's edited (the reason is kept until it's
 * published again, so the moderator sees the history).
 */
function nextStatus(existing, verified) {
  if (existing && (existing.status === 'rejected' || existing.rejection_reason)) return 'pending';
  return verified ? 'published' : 'pending';
}

// ---------------------------------------------------------------- customers

/**
 * Leaves or updates the shop review for one delivered order.
 *
 * An upsert rather than a create: changing your mind about a shop is normal,
 * and the unique index already scopes it to one review per order.
 */
async function upsertReview(req, res) {
  const input = readReviewBody(req.body);
  if (input.error) return res.status(400).json({ message: input.error });

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
      "SELECT * FROM vendor_reviews WHERE order_id = $1 AND target = 'vendor' FOR UPDATE",
      [order.id]
    );
    const existing = existingRows[0];
    const status = nextStatus(existing, true);

    const { rows: saved } = await client.query(
      `INSERT INTO vendor_reviews (order_id, vendor_id, user_id, target, rating, title, comment, photos, status)
       VALUES ($1, $2, $3, 'vendor', $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (order_id) WHERE target = 'vendor' DO UPDATE SET
         rating = EXCLUDED.rating, title = EXCLUDED.title, comment = EXCLUDED.comment,
         photos = EXCLUDED.photos, status = EXCLUDED.status, updated_at = now()
       RETURNING *`,
      [order.id, order.vendor_id, req.user.id, input.rating, input.title, input.comment, JSON.stringify(input.photos), status]
    );

    await refreshRatings(client, { vendorId: order.vendor_id });
    await client.query('COMMIT');
    res.status(existing ? 200 : 201).json(saved[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The caller's own shop review for one order, or null if they have not left one. */
async function getReviewForOrder(req, res) {
  const { rows: orderRows } = await pool.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  if (!orderRows[0]) return res.status(404).json({ message: 'Order not found' });

  const { rows } = await pool.query("SELECT * FROM vendor_reviews WHERE order_id = $1 AND target = 'vendor'", [
    req.params.id,
  ]);
  res.json(rows[0] ?? null);
}

/** Leaves or updates the caller's review of a product. */
async function upsertProductReview(req, res) {
  const input = readReviewBody(req.body);
  if (input.error) return res.status(400).json({ message: input.error });

  const { rows: productRows } = await pool.query(
    `SELECT p.id, p.vendor_id, vp.user_id AS vendor_user_id FROM products p
     JOIN vendor_profiles vp ON vp.id = p.vendor_id
     WHERE p.id = $1 AND p.is_active = true AND p.moderation_status = 'approved' AND vp.status = 'approved'`,
    [req.params.id]
  );
  const product = productRows[0];
  if (!product) return res.status(404).json({ message: 'Product not found' });
  if (product.vendor_user_id === req.user.id) {
    return res.status(403).json({ message: "You can't review your own product." });
  }

  // The latest delivered order with this product in it is what verifies the review.
  const { rows: orderRows } = await pool.query(
    `SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.user_id = $1 AND oi.product_id = $2 AND o.status = 'delivered'
     ORDER BY o.updated_at DESC LIMIT 1`,
    [req.user.id, product.id]
  );
  const orderId = orderRows[0]?.id ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      "SELECT * FROM vendor_reviews WHERE product_id = $1 AND user_id = $2 AND target = 'product' FOR UPDATE",
      [product.id, req.user.id]
    );
    const existing = existingRows[0];
    const status = nextStatus(existing, orderId != null);

    const { rows: saved } = await client.query(
      `INSERT INTO vendor_reviews (order_id, vendor_id, user_id, target, product_id, rating, title, comment, photos, status)
       VALUES ($1, $2, $3, 'product', $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (product_id, user_id) WHERE target = 'product' DO UPDATE SET
         order_id = EXCLUDED.order_id, rating = EXCLUDED.rating, title = EXCLUDED.title,
         comment = EXCLUDED.comment, photos = EXCLUDED.photos, status = EXCLUDED.status, updated_at = now()
       RETURNING *`,
      [orderId, product.vendor_id, req.user.id, product.id, input.rating, input.title, input.comment, JSON.stringify(input.photos), status]
    );

    await refreshRatings(client, { productId: product.id });
    await client.query('COMMIT');
    res.status(existing ? 200 : 201).json({ ...saved[0], verified_purchase: orderId != null });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The caller's own review of a product (any status, so they can see it's waiting), or null. */
async function getMyProductReview(req, res) {
  const { rows } = await pool.query(
    "SELECT *, order_id IS NOT NULL AS verified_purchase FROM vendor_reviews WHERE product_id = $1 AND user_id = $2 AND target = 'product'",
    [req.params.id, req.user.id]
  );
  res.json(rows[0] ?? null);
}

/** Deletes one of the caller's own reviews. */
async function deleteMyReview(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('DELETE FROM vendor_reviews WHERE id = $1 AND user_id = $2 RETURNING *', [
      req.params.id,
      req.user.id,
    ]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Review not found' });
    }
    await refreshRatings(client, ratingsOf(rows[0]));
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A published review someone else wrote, or a response explaining why not. */
async function loadOthersPublished(req, res) {
  const { rows } = await pool.query('SELECT id, user_id, status FROM vendor_reviews WHERE id = $1', [req.params.id]);
  const review = rows[0];
  if (!review || review.status !== 'published') {
    res.status(404).json({ message: 'Review not found' });
    return null;
  }
  if (review.user_id === req.user.id) {
    res.status(409).json({ message: 'That is your own review.' });
    return null;
  }
  return review;
}

/** A customer reporting a published review to the admins. */
async function reportReview(req, res) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) {
    return res.status(400).json({ message: 'Say what is wrong with the review (up to 500 characters).' });
  }
  const review = await loadOthersPublished(req, res);
  if (!review) return;

  const result = await pool.query(
    'INSERT INTO review_reports (review_id, user_id, reason) VALUES ($1, $2, $3) ON CONFLICT (review_id, user_id) DO NOTHING',
    [review.id, req.user.id, reason]
  );
  if (result.rowCount === 0) return res.status(409).json({ message: 'You have already reported this review.' });
  res.status(201).json({ reported: true });
}

async function helpfulCount(reviewId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM review_helpful WHERE review_id = $1', [reviewId]);
  return rows[0].count;
}

async function markHelpful(req, res) {
  const review = await loadOthersPublished(req, res);
  if (!review) return;
  await pool.query('INSERT INTO review_helpful (review_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    review.id,
    req.user.id,
  ]);
  res.json({ helpful: true, helpful_count: await helpfulCount(review.id) });
}

async function unmarkHelpful(req, res) {
  await pool.query('DELETE FROM review_helpful WHERE review_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ helpful: false, helpful_count: await helpfulCount(req.params.id) });
}

// ------------------------------------------------------------------- public

/** Star counts 1–5 over published reviews matching `where`. */
async function distributionOf(where, params) {
  const { rows } = await pool.query(
    `SELECT rating, COUNT(*)::int AS count FROM vendor_reviews r
     WHERE ${where} AND r.status = 'published' GROUP BY rating`,
    params
  );
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const b of rows) distribution[b.rating] = b.count;
  return distribution;
}

const PUBLIC_SORTS = {
  recent: 'r.created_at DESC',
  helpful: `${HELPFUL_COUNT} DESC, r.created_at DESC`,
  rating_high: 'r.rating DESC, r.created_at DESC',
  rating_low: 'r.rating ASC, r.created_at DESC',
};

/** Published reviews matching `where`, in the shape both public lists return. */
async function publicReviews(req, where, params) {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const order = PUBLIC_SORTS[req.query.sort] ?? PUBLIC_SORTS.recent;
  const viewer = req.user?.id ?? null;

  const { rows } = await pool.query(
    `SELECT r.id, r.rating, r.title, r.comment, r.photos, r.created_at, r.updated_at,
            r.order_id IS NOT NULL AS verified_purchase,
            r.vendor_reply, r.vendor_replied_at,
            u.full_name AS customer_name,
            ${HELPFUL_COUNT} AS helpful_count,
            EXISTS (SELECT 1 FROM review_helpful h WHERE h.review_id = r.id AND h.user_id = $${params.length + 1}) AS my_helpful
     FROM vendor_reviews r
     JOIN users u ON u.id = r.user_id
     WHERE ${where} AND r.status = 'published'
     ORDER BY ${order}
     LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
    [...params, viewer, limit, (page - 1) * limit]
  );
  return rows;
}

/**
 * A shop's reviews with its rating summary. Public: this is what a customer
 * reads before deciding to buy.
 */
async function listVendorReviews(req, res) {
  const { rows: summaryRows } = await pool.query(
    `SELECT COALESCE(rating_count, 0)::int AS count,
            CASE WHEN rating_count > 0 THEN ROUND(rating_sum / rating_count, 2)::float END AS average
     FROM vendor_performance_metrics WHERE vendor_id = $1`,
    [req.params.id]
  );
  // A shop with no metrics row has simply never been rated.
  const summary = summaryRows[0] ?? { count: 0, average: null };
  const where = "r.vendor_id = $1 AND r.target = 'vendor'";

  const [distribution, reviews] = await Promise.all([
    distributionOf(where, [req.params.id]),
    publicReviews(req, where, [req.params.id]),
  ]);
  res.json({ average: summary.average, count: summary.count, distribution, reviews });
}

/** A product's published reviews with its rating summary. Public. */
async function listProductReviews(req, res) {
  const { rows } = await pool.query('SELECT rating_count, rating_average FROM products WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Product not found' });
  const where = "r.product_id = $1 AND r.target = 'product'";

  const [distribution, reviews] = await Promise.all([
    distributionOf(where, [req.params.id]),
    publicReviews(req, where, [req.params.id]),
  ]);
  res.json({
    average: rows[0].rating_average == null ? null : Number(rows[0].rating_average),
    count: rows[0].rating_count,
    distribution,
    reviews,
  });
}

// ------------------------------------------------------------------ vendors

function vendorJson(r) {
  return {
    id: r.id,
    target: r.target,
    productId: r.product_id,
    productName: r.product_name,
    rating: r.rating,
    title: r.title,
    comment: r.comment,
    photos: r.photos,
    customerName: r.customer_name,
    verifiedPurchase: r.order_id != null,
    reply: r.vendor_reply,
    repliedAt: r.vendor_replied_at,
    createdAt: r.created_at,
  };
}

/** What customers say about the shop and its products — the published reviews only. */
async function vendorListReviews(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = 20;
  const params = [req.vendorId];
  let where = "r.vendor_id = $1 AND r.status = 'published'";
  if (req.query.target === 'product' || req.query.target === 'vendor') {
    params.push(req.query.target);
    where += ` AND r.target = $${params.length}`;
  }
  if (req.query.unanswered === 'true') where += ' AND r.vendor_reply IS NULL';

  const [{ rows }, { rows: countRows }, { rows: metrics }] = await Promise.all([
    pool.query(
      `SELECT r.*, p.name AS product_name, u.full_name AS customer_name
       FROM vendor_reviews r JOIN users u ON u.id = r.user_id LEFT JOIN products p ON p.id = r.product_id
       WHERE ${where} ORDER BY r.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM vendor_reviews r WHERE ${where}`, params),
    pool.query(
      `SELECT rating_count::int AS count,
              CASE WHEN rating_count > 0 THEN ROUND(rating_sum / rating_count, 2)::float END AS average
       FROM vendor_performance_metrics WHERE vendor_id = $1`,
      [req.vendorId]
    ),
  ]);
  res.json({
    items: rows.map(vendorJson),
    total: countRows[0].total,
    page,
    pageSize,
    shopRating: metrics[0] ?? { count: 0, average: null },
  });
}

/** The shop's public answer to a review about it or one of its products. */
async function vendorReply(req, res) {
  const reply = typeof req.body?.reply === 'string' ? req.body.reply.trim() : '';
  if (!reply || reply.length > 1000) {
    return res.status(400).json({ message: 'reply must be text of 1 to 1000 characters' });
  }
  const { rows } = await pool.query(
    `UPDATE vendor_reviews SET vendor_reply = $3, vendor_replied_at = now()
     WHERE id = $1 AND vendor_id = $2 AND status = 'published' RETURNING *`,
    [req.params.id, req.vendorId, reply]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Review not found' });
  res.json(vendorJson(rows[0]));
}

async function vendorDeleteReply(req, res) {
  const { rowCount } = await pool.query(
    'UPDATE vendor_reviews SET vendor_reply = NULL, vendor_replied_at = NULL WHERE id = $1 AND vendor_id = $2',
    [req.params.id, req.vendorId]
  );
  if (!rowCount) return res.status(404).json({ message: 'Review not found' });
  res.status(204).end();
}

// -------------------------------------------------------------------- admin

const ADMIN_SELECT = `
  SELECT r.*, p.name AS product_name, p.image_url AS product_image_url,
         vp.business_name AS vendor_name, COALESCE(u.full_name, u.email) AS author_name,
         mu.full_name AS moderated_by_name,
         COALESCE(cg.reference, CASE WHEN r.order_id IS NOT NULL THEN '#' || r.order_id END) AS order_reference,
         ${HELPFUL_COUNT} AS helpful_count,
         ${OPEN_REPORTS} AS has_open_reports
  FROM vendor_reviews r
  JOIN vendor_profiles vp ON vp.id = r.vendor_id
  JOIN users u ON u.id = r.user_id
  LEFT JOIN products p ON p.id = r.product_id
  LEFT JOIN users mu ON mu.id = r.moderated_by
  LEFT JOIN orders o ON o.id = r.order_id
  LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id`;

const STATUS_FILTERS = {
  pending: "r.status = 'pending'",
  rejected: "r.status = 'rejected'",
  published: `r.status = 'published' AND NOT ${OPEN_REPORTS}`,
  flagged: `r.status = 'published' AND ${OPEN_REPORTS}`,
};

function adminJson(r, reports) {
  return {
    id: r.id,
    target: r.target,
    productId: r.product_id,
    productName: r.product_name,
    productImageUrl: r.product_image_url,
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    rating: r.rating,
    title: r.title,
    body: r.comment,
    photos: r.photos ?? [],
    authorId: r.user_id,
    authorName: r.author_name,
    verifiedPurchase: r.order_id != null,
    orderReference: r.order_reference,
    status: r.status === 'published' && r.has_open_reports ? 'flagged' : r.status,
    rejectionReason: r.rejection_reason,
    reportCount: reports.length,
    reports,
    vendorReply: r.vendor_reply,
    vendorRepliedAt: r.vendor_replied_at,
    helpfulCount: r.helpful_count,
    createdAt: r.created_at,
    moderatedAt: r.moderated_at,
    moderatedByName: r.moderated_by_name,
  };
}

/** Open reports for the given reviews, grouped by review id. */
async function openReportsFor(reviewIds) {
  const byReview = new Map(reviewIds.map((id) => [id, []]));
  if (reviewIds.length === 0) return byReview;
  const { rows } = await pool.query(
    `SELECT rr.id, rr.review_id, rr.reason, rr.created_at, u.full_name AS reported_by_name
     FROM review_reports rr LEFT JOIN users u ON u.id = rr.user_id
     WHERE rr.review_id = ANY($1) AND rr.resolved_at IS NULL ORDER BY rr.created_at DESC`,
    [reviewIds]
  );
  for (const r of rows) {
    byReview.get(r.review_id).push({ id: r.id, reason: r.reason, reportedByName: r.reported_by_name, createdAt: r.created_at });
  }
  return byReview;
}

async function loadAdminReview(id) {
  const { rows } = await pool.query(`${ADMIN_SELECT} WHERE r.id = $1`, [Number(id)]);
  if (!rows[0]) return null;
  const reports = await openReportsFor([rows[0].id]);
  return adminJson(rows[0], reports.get(rows[0].id));
}

/** The moderation list: by status and target, searchable, 20 a page. */
async function adminListReviews(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const conditions = [];
  const params = [];

  if (req.query.status) {
    if (!STATUS_FILTERS[req.query.status]) return res.status(400).json({ message: 'Unknown status' });
    conditions.push(STATUS_FILTERS[req.query.status]);
  }
  if (req.query.target) {
    if (!['product', 'vendor'].includes(req.query.target)) return res.status(400).json({ message: 'Unknown target' });
    params.push(req.query.target);
    conditions.push(`r.target = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(r.title ILIKE ${p} OR r.comment ILIKE ${p} OR p.name ILIKE ${p} OR vp.business_name ILIKE ${p} OR u.full_name ILIKE ${p} OR u.email ILIKE ${p})`
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // The queue is worked oldest first — the longest wait is the most urgent.
  const order = req.query.status === 'pending' ? 'r.created_at ASC' : 'r.created_at DESC';

  const { rows } = await pool.query(
    `${ADMIN_SELECT} ${where} ORDER BY ${order}, r.id LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${(page - 1) * ADMIN_PAGE_SIZE}`,
    params
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM vendor_reviews r
     JOIN vendor_profiles vp ON vp.id = r.vendor_id JOIN users u ON u.id = r.user_id
     LEFT JOIN products p ON p.id = r.product_id ${where}`,
    params
  );
  const reports = await openReportsFor(rows.map((r) => r.id));
  res.json({
    items: rows.map((r) => adminJson(r, reports.get(r.id))),
    total: countRows[0].total,
    page,
    pageSize: ADMIN_PAGE_SIZE,
  });
}

async function adminSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE r.status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE r.status = 'published' AND ${OPEN_REPORTS})::int AS flagged,
       COUNT(*) FILTER (WHERE r.status = 'published'
                          AND COALESCE(r.moderated_at, r.created_at) >= date_trunc('month', now()))::int AS published_this_month,
       ROUND(AVG(r.rating) FILTER (WHERE r.status = 'published'), 2)::float AS average_rating,
       COUNT(*) FILTER (WHERE r.status = 'published')::int AS published,
       COUNT(*) FILTER (WHERE r.status = 'published' AND r.order_id IS NULL)::int AS unverified
     FROM vendor_reviews r`
  );
  const s = rows[0];
  const ratingCounts = await distributionOf('TRUE', []);
  res.json({
    pending: s.pending,
    flagged: s.flagged,
    publishedThisMonth: s.published_this_month,
    averageRating: s.average_rating,
    unverifiedShare: s.published > 0 ? s.unverified / s.published : null,
    ratingCounts: Object.fromEntries(Object.entries(ratingCounts).map(([k, v]) => [String(k), v])),
  });
}

/**
 * Publish or take down. Publishing keeps a reported review up and clears its
 * reports; taking down needs a reason, which the author is told, and upholds them.
 */
async function adminModerate(req, res) {
  const { status } = req.body || {};
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!['published', 'rejected'].includes(status)) {
    return res.status(400).json({ message: "status must be 'published' or 'rejected'" });
  }
  if (status === 'rejected' && (!reason || reason.length > 500)) {
    return res.status(400).json({ message: 'Give a reason (up to 500 characters) — the customer is told why.' });
  }

  const client = await pool.connect();
  let before;
  let after;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM vendor_reviews WHERE id = $1 FOR UPDATE', [req.params.id]);
    before = rows[0];
    if (!before) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Review not found' });
    }
    const { rows: updated } = await client.query(
      `UPDATE vendor_reviews SET status = $2, rejection_reason = $3, moderated_by = $4, moderated_at = now()
       WHERE id = $1 RETURNING *`,
      [before.id, status, status === 'rejected' ? reason : null, req.user.id]
    );
    after = updated[0];
    await client.query(
      `UPDATE review_reports SET resolution = $2, resolved_by = $3, resolved_at = now()
       WHERE review_id = $1 AND resolved_at IS NULL`,
      [before.id, status === 'rejected' ? 'upheld' : 'dismissed', req.user.id]
    );
    await refreshRatings(client, ratingsOf(after));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (before.status !== status) {
    if (status === 'rejected') {
      await notify(after.user_id, 'review_rejected', 'Your review was taken down', reason, after.order_id);
    } else if (before.status === 'pending') {
      await notify(after.user_id, 'review_published', 'Your review is live', 'Thanks — other customers can read it now.', after.order_id);
    }
  }
  await recordAudit({
    actorUserId: req.user.id,
    action: status === 'rejected' ? 'review.rejected' : 'review.published',
    module: MODULE,
    entityType: 'review',
    entityId: after.id,
    previousValue: { status: before.status },
    newValue: { status, reason: status === 'rejected' ? reason : null },
  });
  res.json(await loadAdminReview(after.id));
}

/** The reports were unfounded: the review stays up and stops showing as flagged. */
async function adminDismissReports(req, res) {
  const { rowCount } = await pool.query(
    `UPDATE review_reports SET resolution = 'dismissed', resolved_by = $2, resolved_at = now()
     WHERE review_id = $1 AND resolved_at IS NULL`,
    [req.params.id, req.user.id]
  );
  if (!rowCount) return res.status(409).json({ message: 'This review has no open reports.' });
  await recordAudit({
    actorUserId: req.user.id,
    action: 'review.reports_dismissed',
    module: MODULE,
    entityType: 'review',
    entityId: req.params.id,
    newValue: { dismissed: rowCount },
  });
  res.json(await loadAdminReview(req.params.id));
}

/** Removes the shop's reply, leaving the review itself alone. */
async function adminDeleteReply(req, res) {
  const { rows } = await pool.query(
    `UPDATE vendor_reviews r SET vendor_reply = NULL, vendor_replied_at = NULL
     FROM vendor_reviews old WHERE r.id = $1 AND old.id = r.id AND old.vendor_reply IS NOT NULL
     RETURNING old.vendor_reply AS removed`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'This review has no reply to remove.' });
  await recordAudit({
    actorUserId: req.user.id,
    action: 'review.reply_removed',
    module: MODULE,
    entityType: 'review',
    entityId: req.params.id,
    previousValue: { reply: rows[0].removed },
  });
  res.json(await loadAdminReview(req.params.id));
}

module.exports = {
  refreshRatings,
  upsertReview,
  getReviewForOrder,
  upsertProductReview,
  getMyProductReview,
  deleteMyReview,
  reportReview,
  markHelpful,
  unmarkHelpful,
  listVendorReviews,
  listProductReviews,
  vendorListReviews,
  vendorReply,
  vendorDeleteReply,
  adminListReviews,
  adminSummary,
  adminModerate,
  adminDismissReports,
  adminDeleteReply,
};
