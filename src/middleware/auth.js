const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

/**
 * A JWT's signature proves it was issued by this server, not that it is
 * still meant to work — a password change or a staff revocation has to be
 * able to kill an already-issued token before it expires on its own. The
 * token carries the tokenVersion it was signed with; this rejects it the
 * moment that no longer matches the account's current one, so a revocation
 * takes effect on the very next request rather than up to 7 days later.
 */
async function currentVersionMatches(payload) {
  if (payload.tokenVersion === undefined) return true; // token predates this check
  const { rows } = await pool.query('SELECT token_version FROM users WHERE id = $1', [payload.id]);
  return rows[0] !== undefined && rows[0].token_version === payload.tokenVersion;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing token' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    if (!(await currentVersionMatches(payload))) {
      return res.status(401).json({ message: 'This session is no longer valid. Please log in again.' });
    }
    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    next(err);
  }
}

/**
 * Attaches req.user when a valid token is present and moves on regardless.
 *
 * For endpoints that are public but answer better when they know who is asking
 * — the product screen's 'also available at' works signed out, and adds a
 * serviceability check when it can.
 */
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET);
      if (await currentVersionMatches(payload)) req.user = payload;
    } catch {
      // A bad or revoked token on a public route is not an error, just no identity.
    }
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRole, JWT_SECRET };
