const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const sms = require('../services/sms');

const DOC_TYPES = ['gstin', 'pan', 'bank', 'fssai', 'other', 'aadhaar', 'voter_id', 'driving_licence', 'shop_photo', 'signature'];
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
      [req.params.id, docType, maskedNumber(docType, docNumber), fileUrl?.trim() || null]
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

// ── The vendor's own submission from the app (VK1) ──

// The government IDs a vendor can send, and what a whole number looks like
// once spaces and dashes are taken out.
const ID_FORMATS = {
  aadhaar: /^[2-9]\d{11}$/,
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  voter_id: /^[A-Z]{3}\d{7}$/,
  driving_licence: /^[A-Z]{2}\d{2}[A-Z0-9]{7,16}$/,
};
const ID_LABELS = { aadhaar: 'Aadhaar', pan: 'PAN', voter_id: 'Voter ID', driving_licence: 'driving licence' };
// The slots a submission fills: one ID (any of ID_FORMATS), the shop, the signature.
const ID_TYPES = Object.keys(ID_FORMATS);
const KYC_SLOTS = [ID_TYPES, ['shop_photo'], ['signature']];

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const WIDGET_PREFIX = 'msg91w:';

/** "XXXXXXXX1234": all but the last four characters hidden. */
function maskIdNumber(n) {
  return `${'X'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;
}

/** A government ID number is only ever kept masked; other numbers as typed. */
function maskedNumber(docType, docNumber) {
  const n = docNumber?.trim();
  if (!n) return null;
  return ID_TYPES.includes(docType) ? maskIdNumber(n.toUpperCase().replace(/[\s-]/g, '')) : n;
}

/** Only pictures uploaded through /api/vendors/kyc/uploads. */
const KYC_PATH = /^\/uploads\/kyc\/[\w.-]+$/;

async function vendorOf(userId) {
  const { rows } = await pool.query(
    `SELECT vp.id, vp.kyc_submitted_at, u.phone_number
     FROM vendor_profiles vp JOIN users u ON u.id = vp.user_id
     WHERE vp.user_id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

const tenDigits = (phone) => {
  const d = String(phone ?? '').replace(/\D/g, '').slice(-10);
  return /^\d{10}$/.test(d) ? d : null;
};

/**
 * not_submitted | pending | approved | rejected, from the newest document in
 * each slot: any rejected means the vendor has something to send again.
 */
function kycState(vendor, docs) {
  if (!vendor.kyc_submitted_at) return 'not_submitted';
  const latest = KYC_SLOTS.map((types) => docs.find((d) => types.includes(d.doc_type)));
  if (latest.some((d) => !d)) return 'not_submitted';
  if (latest.some((d) => d.status === 'rejected')) return 'rejected';
  return latest.every((d) => d.status === 'approved') ? 'approved' : 'pending';
}

/** GET /api/vendors/kyc — where the vendor's documents stand. */
async function getMyKyc(req, res) {
  const vendor = await vendorOf(req.user.id);
  if (!vendor) return res.status(404).json({ message: 'Vendor profile not found' });
  const { rows: docs } = await pool.query(
    `SELECT id, doc_type, doc_number, file_url, status, rejection_reason, submitted_at, reviewed_at
     FROM vendor_documents WHERE vendor_id = $1 ORDER BY submitted_at DESC, id DESC`,
    [vendor.id]
  );
  const phone = tenDigits(vendor.phone_number);
  res.json({
    status: kycState(vendor, docs),
    submittedAt: vendor.kyc_submitted_at,
    // Where the confirmation code goes, shown as "+91 XXXXXX1234".
    phoneMasked: phone ? `+91 ${maskIdNumber(phone)}` : null,
    documents: docs,
  });
}

/** POST /api/vendors/kyc/otp — texts a code to the vendor's registered number. */
async function sendKycOtp(req, res) {
  if (!sms.isAvailable()) {
    return res.status(503).json({ message: "OTP isn't available right now. Please try again later." });
  }
  const vendor = await vendorOf(req.user.id);
  if (!vendor) return res.status(404).json({ message: 'Set up your shop first' });
  const phone = tenDigits(vendor.phone_number);
  if (!phone) return res.status(400).json({ message: 'Add a mobile number to your account first' });

  const { rows: recent } = await pool.query('SELECT 1 FROM kyc_otps WHERE user_id = $1 AND created_at > $2', [
    req.user.id,
    new Date(Date.now() - OTP_RESEND_MS),
  ]);
  if (recent[0]) return res.status(429).json({ message: 'Please wait a minute before requesting another OTP' });

  let otpHash;
  try {
    if (sms.usesWidget()) {
      otpHash = `${WIDGET_PREFIX}${await sms.sendWidgetOtp(`+91${phone}`)}`;
    } else {
      const otp = crypto.randomInt(100000, 1000000).toString();
      otpHash = await bcrypt.hash(otp, 10);
      await sms.sendSms({
        to: `+91${phone}`,
        otp,
        expiryMinutes: OTP_TTL_MS / 60000,
        text: `${otp} is your Gloaro Mart OTP to submit your shop documents. It expires in 10 minutes. Do not share it with anyone.`,
      });
    }
  } catch (err) {
    console.error('[kyc-otp] send failed:', err.message);
    return res.status(502).json({ message: 'Could not send the OTP. Please try again.' });
  }
  await pool.query('UPDATE kyc_otps SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [req.user.id]);
  await pool.query('INSERT INTO kyc_otps (user_id, otp_hash, expires_at) VALUES ($1, $2, $3)', [
    req.user.id,
    otpHash,
    new Date(Date.now() + OTP_TTL_MS),
  ]);
  res.json({ message: 'OTP sent', otp_length: sms.otpLength(), phoneMasked: `+91 ${maskIdNumber(phone)}` });
}

/** True when [otp] is the vendor's latest unused code; spends it if so. */
async function spendKycOtp(userId, otp) {
  const { rows } = await pool.query(
    `SELECT id, otp_hash, attempts FROM kyc_otps
     WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const pending = rows[0];
  if (!pending || pending.attempts >= OTP_MAX_ATTEMPTS) return false;
  const matches = pending.otp_hash.startsWith(WIDGET_PREFIX)
    ? await sms.verifyWidgetOtp(pending.otp_hash.slice(WIDGET_PREFIX.length), otp)
    : await bcrypt.compare(String(otp), pending.otp_hash);
  if (!matches) {
    await pool.query('UPDATE kyc_otps SET attempts = attempts + 1 WHERE id = $1', [pending.id]);
    return false;
  }
  const claimed = await pool.query('UPDATE kyc_otps SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id', [
    pending.id,
  ]);
  return Boolean(claimed.rows[0]);
}

/**
 * POST /api/vendors/kyc — the ID, its photo, the shop photo and the signature,
 * confirmed with the OTP. Each lands as a pending document for review.
 */
async function submitMyKyc(req, res) {
  const { otp, idType, idNumber, idProofUrl, shopPhotoUrl, signatureUrl } = req.body || {};
  const vendor = await vendorOf(req.user.id);
  if (!vendor) return res.status(404).json({ message: 'Set up your shop first' });

  if (!ID_TYPES.includes(idType)) {
    return res.status(400).json({ field: 'idType', message: 'Choose Aadhaar, PAN, Voter ID or driving licence' });
  }
  const number = String(idNumber ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!ID_FORMATS[idType].test(number)) {
    return res.status(400).json({ field: 'idNumber', message: `Enter a valid ${ID_LABELS[idType]} number` });
  }
  const files = { idProofUrl, shopPhotoUrl, signatureUrl };
  for (const [field, url] of Object.entries(files)) {
    if (typeof url !== 'string' || !KYC_PATH.test(url)) {
      return res.status(400).json({ field, message: 'Upload this picture again' });
    }
  }
  const { rows: found } = await pool.query('SELECT path FROM media_files WHERE path = ANY($1)', [Object.values(files)]);
  if (found.length !== new Set(Object.values(files)).size) {
    return res.status(400).json({ message: 'A picture was not found. Upload it again.' });
  }
  if (!otp) return res.status(400).json({ field: 'otp', message: 'Enter the OTP' });

  let ok;
  try {
    ok = await spendKycOtp(req.user.id, otp);
  } catch (err) {
    console.error('[kyc-otp] verify failed:', err.message);
    return res.status(502).json({ message: 'Could not check the OTP. Please try again.' });
  }
  if (!ok) return res.status(401).json({ field: 'otp', message: 'That OTP is wrong or has expired' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insert = (type, num, url) =>
      client.query('INSERT INTO vendor_documents (vendor_id, doc_type, doc_number, file_url) VALUES ($1, $2, $3, $4)', [
        vendor.id,
        type,
        num,
        url,
      ]);
    await insert(idType, maskIdNumber(number), idProofUrl);
    await insert('shop_photo', null, shopPhotoUrl);
    await insert('signature', null, signatureUrl);
    await client.query('UPDATE vendor_profiles SET kyc_submitted_at = now() WHERE id = $1', [vendor.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getMyKyc(req, res.status(201));
}

module.exports = {
  REQUIRED_TYPES,
  listDocuments,
  listKycSummary,
  listVendorDocuments,
  createDocument,
  reviewDocument,
  maskIdNumber,
  getMyKyc,
  sendKycOtp,
  submitMyKyc,
};
