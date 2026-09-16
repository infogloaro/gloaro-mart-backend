const pool = require('../config/db');

/**
 * The review queue between a vendor listing a product and customers seeing it.
 * Contracts per the PRODUCT MODERATION block in schema.sql.
 *
 * These columns are admin-owned. Nothing on the vendor routes writes them, which
 * is the whole point: is_active is the vendor's switch, moderation_status is not.
 */

const REVIEW_STATUSES = ['approved', 'rejected'];
const ALL_STATUSES = ['pending', ...REVIEW_STATUSES];

const SELECT_PRODUCT = `
  SELECT p.id, p.name, p.description, p.price_cents, p.mrp_cents, p.currency,
         p.image_url, p.category, p.sku, p.stock_quantity, p.is_active,
         p.moderation_status, p.moderation_reason, p.moderated_at, p.submitted_at,
         p.created_at,
         vp.id AS vendor_id, vp.business_name AS vendor_name, vp.status AS vendor_status,
         b.name AS brand_name,
         u.full_name AS moderated_by_name
  FROM products p
  JOIN vendor_profiles vp ON vp.id = p.vendor_id
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN users u ON u.id = p.moderated_by`;

function parsePaging(req, defaultPageSize = 25) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** The queue. Pending first, oldest first — the longest wait is the most urgent. */
async function listQueue(req, res) {
  const { status, vendorId, q } = req.query;
  const { page, pageSize, offset } = parsePaging(req);

  const conditions = [];
  const params = [];

  if (status) {
    if (!ALL_STATUSES.includes(status)) {
      return res.status(400).json({ message: `status must be one of ${ALL_STATUSES.join(', ')}` });
    }
    params.push(status);
    conditions.push(`p.moderation_status = $${params.length}`);
  }
  if (vendorId) {
    params.push(Number(vendorId));
    conditions.push(`p.vendor_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM products p JOIN vendor_profiles vp ON vp.id = p.vendor_id ${where}`,
    params
  );
  const { rows } = await pool.query(
    `${SELECT_PRODUCT} ${where}
     ORDER BY CASE p.moderation_status WHEN 'pending' THEN 0 ELSE 1 END,
              p.submitted_at ASC, p.id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );

  res.json({ items: rows, total: countRows[0].total, page, pageSize });
}

/** How much is waiting, for the tab counts. */
async function getCounts(req, res) {
  const { rows } = await pool.query(
    `SELECT moderation_status, COUNT(*)::int AS n FROM products GROUP BY moderation_status`
  );
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const row of rows) counts[row.moderation_status] = row.n;
  res.json(counts);
}

/**
 * Approve or reject. Who decided and when is recorded with the decision.
 *
 * is_active is deliberately left alone. Approval means "this listing is allowed
 * to be sold", not "put it on sale" — whether it is currently for sale stays the
 * vendor's call, and overwriting their switch here would silently re-publish a
 * product they had taken down.
 */
async function review(req, res) {
  const { status, reason } = req.body || {};

  if (!REVIEW_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'status must be approved or rejected' });
  }
  if (status === 'rejected' && !reason?.trim()) {
    return res.status(400).json({ message: 'A rejection needs a reason the vendor can act on.' });
  }

  const { rows } = await pool.query(
    `UPDATE products
     SET moderation_status = $2,
         -- Cleared on approval: a stale reason beside an approved product reads
         -- as though it were rejected.
         moderation_reason = CASE WHEN $2 = 'rejected' THEN $3 ELSE NULL END,
         moderated_by = $4,
         moderated_at = now(),
         updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [req.params.id, status, reason?.trim() ?? null, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Product not found' });

  const { rows: updated } = await pool.query(`${SELECT_PRODUCT} WHERE p.id = $1`, [req.params.id]);
  res.json(updated[0]);
}

/** Send an already-decided listing back to the queue, e.g. after a bad call. */
async function resetToPending(req, res) {
  const { rows } = await pool.query(
    `UPDATE products
     SET moderation_status = 'pending', moderation_reason = NULL,
         moderated_by = NULL, moderated_at = NULL, updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Product not found' });

  const { rows: updated } = await pool.query(`${SELECT_PRODUCT} WHERE p.id = $1`, [req.params.id]);
  res.json(updated[0]);
}

module.exports = { listQueue, getCounts, review, resetToPending };
