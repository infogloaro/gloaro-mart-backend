/**
 * Reports of wrong shop details (SB7, schema "SHOP REPORTS"). A signed-in
 * customer reports a shop; admins resolve (the details were fixed) or dismiss
 * (they were right) each report from the Vendors queue. The reporter hears
 * the outcome, never the admin's note.
 */
const pool = require('../config/db');

const REASONS = [
  { code: 'closed_permanently', label: 'Shop has closed for good' },
  { code: 'wrong_hours', label: 'Opening hours are wrong' },
  { code: 'wrong_address', label: 'Address is wrong' },
  { code: 'wrong_phone', label: 'Phone number is wrong' },
  { code: 'wrong_location', label: 'Map location is wrong' },
  { code: 'wrong_category', label: "Doesn't sell what it's listed under" },
  { code: 'not_real', label: "Not a real shop" },
  { code: 'other', label: 'Something else' },
];
const REASON_CODES = REASONS.map((r) => r.code);
const LABEL = Object.fromEntries(REASONS.map((r) => [r.code, r.label]));
const MAX_NOTE = 500;
const MIN_OTHER_NOTE = 10;
const MAX_PER_DAY = 10;
const STATUSES = ['open', 'resolved', 'dismissed'];
const PAGE_SIZE = 20;

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readVendorId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ReportError(404, 'Shop not found');
  return id;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** What the customer sees of their own report. */
function mine(r) {
  return {
    id: r.id,
    reason: r.reason,
    reasonLabel: LABEL[r.reason],
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/**
 * A customer reports an approved shop. One open report per shop each (409),
 * not their own shop (400), at most 10 a day (429); 'other' needs a note.
 */
async function report(userId, rawVendorId, body = {}) {
  const vendorId = readVendorId(rawVendorId);
  const reason = text(body.reason);
  const note = text(body.note);
  if (!REASON_CODES.includes(reason)) throw new ReportError(400, `reason is one of ${REASON_CODES.join(', ')}.`);
  if (note.length > MAX_NOTE) throw new ReportError(400, `Keep the note under ${MAX_NOTE} characters.`);
  if (reason === 'other' && note.length < MIN_OTHER_NOTE) {
    throw new ReportError(400, `Tell us what is wrong (at least ${MIN_OTHER_NOTE} characters).`);
  }
  const { rows: shop } = await pool.query("SELECT id, user_id FROM vendor_profiles WHERE id = $1 AND status = 'approved'", [vendorId]);
  if (!shop[0]) throw new ReportError(404, 'Shop not found');
  if (shop[0].user_id === userId) throw new ReportError(400, "You can't report your own shop. Edit its details instead.");
  const { rows: today } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM shop_reports WHERE user_id = $1 AND created_at >= now() - interval '1 day'",
    [userId]
  );
  if (today[0].n >= MAX_PER_DAY) throw new ReportError(429, "You've sent a lot of reports today. Please try again tomorrow.");
  const { rows } = await pool.query(
    `INSERT INTO shop_reports (vendor_id, user_id, reason, note) VALUES ($1, $2, $3, $4)
     ON CONFLICT (vendor_id, user_id) WHERE status = 'open' DO NOTHING
     RETURNING *`,
    [vendorId, userId, reason, note || null]
  );
  if (!rows[0]) throw new ReportError(409, "You've already reported this shop. We're checking it.");
  return mine(rows[0]);
}

/** The caller's latest report on a shop (open or closed), or null. */
async function myLatest(userId, rawVendorId) {
  const vendorId = readVendorId(rawVendorId);
  const { rows } = await pool.query(
    'SELECT * FROM shop_reports WHERE vendor_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1',
    [vendorId, userId]
  );
  return rows[0] ? mine(rows[0]) : null;
}

const ADMIN_SELECT = `
  SELECT r.*, vp.business_name, vp.status AS shop_status, vp.city AS shop_city,
         u.full_name AS reporter_name, u.email AS reporter_email,
         rb.full_name AS resolved_by_name,
         (SELECT COUNT(*)::int FROM shop_reports o WHERE o.vendor_id = r.vendor_id AND o.status = 'open') AS shop_open_reports
  FROM shop_reports r
  JOIN vendor_profiles vp ON vp.id = r.vendor_id
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN users rb ON rb.id = r.resolved_by`;

function adminJson(r) {
  return {
    id: r.id,
    shop: { id: r.vendor_id, name: r.business_name, status: r.shop_status, city: r.shop_city, openReports: r.shop_open_reports },
    reporter: r.user_id ? { id: r.user_id, name: r.reporter_name, email: r.reporter_email } : null,
    reason: r.reason,
    reasonLabel: LABEL[r.reason],
    note: r.note,
    status: r.status,
    resolutionNote: r.resolution_note,
    resolvedBy: r.resolved_by ? { id: r.resolved_by, name: r.resolved_by_name } : null,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
}

/** The admin queue: newest first, filtered by status (default open), shop and reason; with counts per status. */
async function adminList(query = {}) {
  const status = query.status === 'all' ? null : STATUSES.includes(query.status) ? query.status : 'open';
  const page = Math.max(1, Number(query.page) || 1);
  const params = [];
  const where = [];
  const push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (status) where.push(`r.status = ${push(status)}`);
  const vendorId = Number(query.vendorId);
  if (Number.isInteger(vendorId) && vendorId > 0) where.push(`r.vendor_id = ${push(vendorId)}`);
  if (REASON_CODES.includes(query.reason)) where.push(`r.reason = ${push(query.reason)}`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ rows }, { rows: total }, { rows: counts }] = await Promise.all([
    pool.query(`${ADMIN_SELECT} ${clause} ORDER BY r.created_at DESC, r.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(`SELECT COUNT(*)::int AS n FROM shop_reports r ${clause}`, params),
    pool.query('SELECT status, COUNT(*)::int AS n FROM shop_reports GROUP BY status'),
  ]);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const c of counts) byStatus[c.status] = c.n;
  return { items: rows.map(adminJson), total: total[0].n, page, pageSize: PAGE_SIZE, counts: byStatus, reasons: REASONS };
}

async function adminGet(id) {
  const { rows } = await pool.query(`${ADMIN_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] ? adminJson(rows[0]) : null;
}

/**
 * Closes an open report as resolved or dismissed. A dismissal needs a note
 * (why the details are right). With alsoSimilar, the shop's other open
 * reports for the same reason close the same way. Returns the closed rows
 * (for notifications and the audit) and the report as the admin now sees it.
 */
async function adminClose(rawId, body = {}, adminId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new ReportError(404, 'Report not found');
  const status = body.status;
  const note = text(body.note);
  if (!['resolved', 'dismissed'].includes(status)) throw new ReportError(400, "status must be 'resolved' or 'dismissed'.");
  if (note.length > MAX_NOTE) throw new ReportError(400, `Keep the note under ${MAX_NOTE} characters.`);
  if (status === 'dismissed' && !note) throw new ReportError(400, 'Say why the details are right (kept internal).');
  if (body.alsoSimilar !== undefined && typeof body.alsoSimilar !== 'boolean') {
    throw new ReportError(400, 'alsoSimilar must be true or false.');
  }
  const { rows: found } = await pool.query('SELECT id, vendor_id, reason, status FROM shop_reports WHERE id = $1', [id]);
  if (!found[0]) throw new ReportError(404, 'Report not found');
  if (found[0].status !== 'open') throw new ReportError(409, `This report is already ${found[0].status}.`);
  const { rows: closed } = await pool.query(
    `UPDATE shop_reports SET status = $2, resolution_note = $3, resolved_by = $4, resolved_at = now()
     WHERE status = 'open' AND (id = $1 OR ($5::boolean AND vendor_id = $6 AND reason = $7))
     RETURNING id, user_id, vendor_id, reason`,
    [id, status, note || null, adminId, body.alsoSimilar === true, found[0].vendor_id, found[0].reason]
  );
  if (!closed.some((r) => r.id === id)) throw new ReportError(409, 'This report was just closed by someone else.');
  return { closed, status, report: await adminGet(id) };
}

/** Tells each reporter how their report ended. */
async function notifyReporters(closed, status) {
  const users = closed.filter((r) => r.user_id);
  if (!users.length) return;
  const { rows } = await pool.query('SELECT business_name FROM vendor_profiles WHERE id = $1', [users[0].vendor_id]);
  const shop = rows[0]?.business_name ?? 'the shop';
  const title = status === 'resolved' ? `Thanks, we've fixed ${shop}` : `We checked ${shop}`;
  const body = status === 'resolved'
    ? `Your report ("${LABEL[users[0].reason]}") helped: the shop's details are now corrected.`
    : `Thanks for your report ("${LABEL[users[0].reason]}"). We checked and the shop's details look right, so nothing was changed.`;
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body)
     SELECT u, 'shop_report', $2, $3 FROM unnest($1::int[]) AS u`,
    [[...new Set(users.map((r) => r.user_id))], title.slice(0, 160), body]
  );
}

module.exports = { ReportError, REASONS, report, myLatest, adminList, adminGet, adminClose, notifyReporters };
