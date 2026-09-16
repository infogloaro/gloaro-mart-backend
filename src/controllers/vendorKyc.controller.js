const pool = require('../config/db');

const DOC_TYPES = ['gstin', 'pan', 'bank', 'fssai', 'other'];
const REVIEW_STATUSES = ['approved', 'rejected'];

// The types that decide whether a vendor counts as verified. 'fssai' and
// 'other' are recorded but not required — not every vendor sells food.
const REQUIRED_TYPES = ['gstin', 'pan', 'bank'];

const SELECT_DOC = `
  SELECT d.*, vp.business_name, u.full_name AS reviewed_by_name
  FROM vendor_documents d
  JOIN vendor_profiles vp ON vp.id = d.vendor_id
  LEFT JOIN users u ON u.id = d.reviewed_by`;

function parsePaging(req, defaultPageSize = 25) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** The review queue. Oldest pending first — the longest wait is the most urgent. */
async function listDocuments(req, res) {
  const { status, vendorId, docType } = req.query;
  const { page, pageSize, offset } = parsePaging(req);

  const conditions = [];
  const params = [];

  if (status) {
    if (!['pending', ...REVIEW_STATUSES].includes(status)) {
      return res.status(400).json({ message: 'status must be pending, approved or rejected' });
    }
    params.push(status);
    conditions.push(`d.status = $${params.length}`);
  }
  if (vendorId) {
    params.push(Number(vendorId));
    conditions.push(`d.vendor_id = $${params.length}`);
  }
  if (docType) {
    if (!DOC_TYPES.includes(docType)) {
      return res.status(400).json({ message: `docType must be one of ${DOC_TYPES.join(', ')}` });
    }
    params.push(docType);
    conditions.push(`d.doc_type = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM vendor_documents d ${where}`,
    params
  );
  const { rows } = await pool.query(
    `${SELECT_DOC} ${where}
     ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END, d.submitted_at ASC, d.id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );

  res.json({ items: rows, total: countRows[0].total, page, pageSize });
}

/**
 * Per-vendor verification rollup for the summary table.
 *
 * LEFT JOIN from vendor_profiles so vendors who have submitted nothing still
 * appear — those are precisely the ones an admin needs to chase, and an inner
 * join would hide them.
 */
async function listKycSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT vp.id AS vendor_id, vp.business_name, vp.status AS vendor_status,
            COUNT(d.id)::int AS documents_total,
            COUNT(*) FILTER (WHERE d.status = 'pending')::int  AS pending_count,
            COUNT(*) FILTER (WHERE d.status = 'rejected')::int AS rejected_count,
            COUNT(DISTINCT d.doc_type) FILTER (WHERE d.status = 'approved' AND d.doc_type = ANY($1))::int
              AS approved_required_count,
            MAX(d.submitted_at) AS last_submitted_at
     FROM vendor_profiles vp
     LEFT JOIN vendor_documents d ON d.vendor_id = vp.id
     GROUP BY vp.id, vp.business_name, vp.status
     ORDER BY COUNT(*) FILTER (WHERE d.status = 'pending') DESC, vp.business_name ASC`,
    [REQUIRED_TYPES]
  );

  res.json(rows.map((r) => ({ ...r, required_total: REQUIRED_TYPES.length })));
}

async function listVendorDocuments(req, res) {
  const { rows } = await pool.query(`${SELECT_DOC} WHERE d.vendor_id = $1 ORDER BY d.submitted_at DESC, d.id DESC`, [
    req.params.id,
  ]);
  res.json(rows);
}

/** Records a submission. Always lands as pending — recording is not approving. */
async function createDocument(req, res) {
  const { docType, docNumber, fileUrl } = req.body || {};

  if (!DOC_TYPES.includes(docType)) {
    return res.status(400).json({ message: `docType must be one of ${DOC_TYPES.join(', ')}` });
  }
  if (!docNumber && !fileUrl) {
    return res.status(400).json({ message: 'Provide a document number or a file link — there is nothing to review otherwise.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO vendor_documents (vendor_id, doc_type, doc_number, file_url)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.params.id, docType, docNumber?.trim() || null, fileUrl?.trim() || null]
    );
    const { rows: created } = await pool.query(`${SELECT_DOC} WHERE d.id = $1`, [rows[0].id]);
    res.status(201).json(created[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ message: 'Vendor not found' });
    throw err;
  }
}

/** Approve or reject. Who decided and when is recorded with the decision. */
async function reviewDocument(req, res) {
  const { status, rejectionReason } = req.body || {};

  if (!REVIEW_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'status must be approved or rejected' });
  }
  if (status === 'rejected' && !rejectionReason?.trim()) {
    return res.status(400).json({ message: 'A rejection needs a reason the vendor can act on.' });
  }

  const { rows } = await pool.query(
    `UPDATE vendor_documents
     SET status = $2,
         -- Cleared on approval: a stale reason beside an approved document
         -- reads as though it were rejected.
         rejection_reason = CASE WHEN $2 = 'rejected' THEN $3 ELSE NULL END,
         reviewed_by = $4,
         reviewed_at = now()
     WHERE id = $1
     RETURNING id`,
    [req.params.docId, status, rejectionReason?.trim() ?? null, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Document not found' });

  const { rows: updated } = await pool.query(`${SELECT_DOC} WHERE d.id = $1`, [req.params.docId]);
  res.json(updated[0]);
}

module.exports = { listDocuments, listKycSummary, listVendorDocuments, createDocument, reviewDocument };
