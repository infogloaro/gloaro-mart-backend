/**
 * Shop trust & place (SB2, schema "SHOP TRUST & PLACE"): the Verified badge,
 * the shop's district, and the delivery facts a customer checks before
 * ordering. "Verified" is worked out when read so it always matches the KYC
 * documents; an admin can hold it back with a reason.
 */
const { REQUIRED_TYPES } = require('../controllers/vendorKyc.controller');

class TrustError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The required types are fixed words from code, never user input.
const REQUIRED_SQL = REQUIRED_TYPES.map((t) => `'${t}'`).join(', ');

/** SQL true when the shop [alias] shows the Verified badge. */
function verifiedSql(alias = 'vp') {
  return `(${alias}.status = 'approved' AND NOT ${alias}.verification_hold AND (
    SELECT COUNT(DISTINCT d.doc_type) FROM vendor_documents d
    WHERE d.vendor_id = ${alias}.id AND d.status = 'approved' AND d.doc_type IN (${REQUIRED_SQL})
  ) = ${REQUIRED_TYPES.length})`;
}

/** The place fields present in a body, checked: { district? } ('' clears). */
function readPlace(body = {}) {
  const out = {};
  if (body.district !== undefined) {
    if (body.district !== null && typeof body.district !== 'string') throw new TrustError(400, 'district must be text.');
    const d = (body.district ?? '').trim();
    if (d.length > 80) throw new TrustError(400, 'The district is at most 80 characters.');
    out.district = d || null;
  }
  return out;
}

/** Admin: hold the Verified badge back (with the reason the shop sees) or release it. */
function readHold(body = {}) {
  if (typeof body.hold !== 'boolean') throw new TrustError(400, 'hold must be true or false.');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (body.hold && !reason) throw new TrustError(400, 'Say why the badge is held back; the shop sees it.');
  if (reason.length > 300) throw new TrustError(400, 'The reason is at most 300 characters.');
  return { hold: body.hold, reason: body.hold ? reason : null };
}

module.exports = { TrustError, REQUIRED_TYPES, verifiedSql, readPlace, readHold };
