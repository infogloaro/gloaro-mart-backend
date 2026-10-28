/**
 * Service reviews (NS9, schema "SERVICE REVIEWS"): the shop marks a service
 * request done, then that request's customer rates the service — once per
 * request; sending again edits their review. The service page shows the
 * service's own average, 5→1 counts and the reviews, names as "Priya S.".
 */
const pool = require('../config/db');
const { EnquiryError } = require('./shopEnquiries');

const MAX_COMMENT = 1000;

const readId = (raw, what) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new EnquiryError(404, `${what} not found`);
  return id;
};

/** "Priya Sundaram" → "Priya S."; nothing → a neutral name. */
function shortName(full) {
  const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A Gloaro Mart customer';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** The shop says the work is done; the customer is asked to rate it. */
async function markDone(rawId, vendorId) {
  const id = readId(rawId, 'Enquiry');
  const { rows } = await pool.query('SELECT id, user_id, topic, service_title, service_done_at, reference FROM shop_enquiries WHERE id = $1 AND vendor_id = $2', [id, vendorId]);
  const e = rows[0];
  if (!e) throw new EnquiryError(404, 'Enquiry not found');
  if (e.topic !== 'service') throw new EnquiryError(400, 'Only a service request can be marked done.');
  if (e.service_done_at) return { id, serviceDoneAt: e.service_done_at };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: done } = await client.query('UPDATE shop_enquiries SET service_done_at = now() WHERE id = $1 RETURNING service_done_at', [id]);
    await client.query(
      "INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'shop_enquiry', $2, $3, $4)",
      [e.user_id, `How was ${e.service_title ?? 'the service'}? (${e.reference})`.slice(0, 160), 'The shop marked the work done. Rate the service to help others nearby.', `/enquiries/${id}`]
    );
    await client.query('COMMIT');
    return { id, serviceDoneAt: done[0].service_done_at };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The customer rates (or re-rates) the service of their own request once the shop marked it done. */
async function rate(rawId, userId, body = {}) {
  const id = readId(rawId, 'Enquiry');
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new EnquiryError(400, 'Pick 1 to 5 stars.');
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (comment.length > MAX_COMMENT) throw new EnquiryError(400, `Keep the review under ${MAX_COMMENT} characters.`);
  const { rows } = await pool.query(
    'SELECT id, vendor_id, service_id, topic, service_done_at FROM shop_enquiries WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  const e = rows[0];
  if (!e) throw new EnquiryError(404, 'Enquiry not found');
  if (e.topic !== 'service') throw new EnquiryError(400, 'Only a service request can be reviewed.');
  if (!e.service_done_at) throw new EnquiryError(409, 'You can rate the service once the shop marks the work done.');
  const { rows: saved } = await pool.query(
    `INSERT INTO service_reviews (enquiry_id, service_id, vendor_id, user_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (enquiry_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()
     RETURNING rating, comment, created_at, updated_at`,
    [id, e.service_id, e.vendor_id, userId, rating, comment || null]
  );
  return saved[0];
}

/** A service's reviews, in the product-reviews shape the app already reads. */
async function forService(rawId, query = {}) {
  const id = readId(rawId, 'Service');
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const [{ rows: sum }, { rows: dist }, { rows }] = await Promise.all([
    pool.query('SELECT ROUND(AVG(rating)::numeric, 2) AS average, COUNT(*)::int AS count FROM service_reviews WHERE service_id = $1', [id]),
    pool.query('SELECT rating, COUNT(*)::int AS count FROM service_reviews WHERE service_id = $1 GROUP BY rating', [id]),
    pool.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, u.full_name
       FROM service_reviews r JOIN users u ON u.id = r.user_id
       WHERE r.service_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT $2 OFFSET $3`,
      [id, limit, (page - 1) * limit]
    ),
  ]);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const d of dist) distribution[d.rating] = d.count;
  return {
    average: sum[0].count ? sum[0].average : null,
    count: sum[0].count,
    distribution,
    // Every one comes from a request the shop marked done (not a purchase).
    reviews: rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      created_at: r.created_at,
      customer_name: shortName(r.full_name),
    })),
  };
}

module.exports = { markDone, rate, forService, shortName };
