const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('./auth');

/**
 * VD27: what a shop's staff may do. Owners (and everyone else) pass straight
 * through; this only narrows a signed-in vendor-role user who is a manager or
 * packer of a shop. Mounted once in app.js ahead of every router, so no route
 * has to remember it. The token itself is still checked by requireAuth later;
 * a token that doesn't verify here is simply let through to be refused there.
 *
 * Manager: everything except money, bank, plan, KYC, staff and the shop's
 * identity. Packer: reads, plus orders, stock and returns.
 */
const OWNER_ONLY = [
  /^\/api\/vendor\/staff/,
  /^\/api\/vendor\/bank-account/,
  /^\/api\/vendor\/settlements/,
  /^\/api\/vendor\/service-earnings/,
  /^\/api\/vendor\/ads\/campaigns\/[^/]+\/pay/,
  /^\/api\/wallet/,
  /^\/api\/vendors\/kyc/,
];
const OWNER_WRITES = [/^\/api\/vendor\/plan/, /^\/api\/vendors\/profile/];
const PACKER_WRITES = [
  /^\/api\/orders\/[^/]+\/(status|reject)$/,
  /^\/api\/vendor\/inventory/,
  /^\/api\/vendor\/orders\//,
  /^\/api\/vendor\/returns/,
  /^\/api\/auth\//,
  /^\/api\/notifications/,
];
const PACKER_HIDDEN = [/^\/api\/vendor\/reports/, /^\/api\/vendor\/insights/, /^\/api\/vendor\/plan/, /^\/api\/analytics/];

const CACHE_MS = 15_000;
const cache = new Map();

async function staffRole(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.role;
  const { rows } = await pool.query('SELECT role FROM vendor_staff WHERE user_id = $1 AND disabled_at IS NULL', [userId]);
  const role = rows[0]?.role ?? null;
  cache.set(userId, { role, at: Date.now() });
  return role;
}

/** Forget a user's cached role (after the owner changes it). */
function forget(userId) {
  cache.delete(userId);
}

/** Why [role] may not make this request, or null when it may. */
function refusal(role, method, path) {
  const write = method !== 'GET' && method !== 'HEAD';
  if (OWNER_ONLY.some((r) => r.test(path))) return 'Only the shop owner can do this.';
  if (write && OWNER_WRITES.some((r) => r.test(path))) return 'Only the shop owner can change this.';
  if (role === 'packer') {
    if (!write && PACKER_HIDDEN.some((r) => r.test(path))) return 'Packers can\'t see this.';
    if (write && !PACKER_WRITES.some((r) => r.test(path))) return 'Packers can only work on orders and stock.';
  }
  return null;
}

async function shopStaffGate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  let payload;
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET);
  } catch {
    return next();
  }
  if (payload?.role !== 'vendor' || !payload.id) return next();
  try {
    const role = await staffRole(payload.id);
    if (!role) return next();
    const why = refusal(role, req.method, req.path);
    if (why) return res.status(403).json({ message: why, code: 'STAFF_ROLE', staffRole: role });
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { shopStaffGate, refusal, forget };
