const pool = require('../config/db');

/**
 * Invalidates every token already issued to this user. Called on a password
 * change and on revoking staff access — the two moments where an old token
 * staying valid would be a real problem, not just a staleness annoyance.
 *
 * Bumping the counter rather than deleting rows means there is nothing to
 * clean up and no session store to run — the next request carrying an old
 * token simply fails the version check in requireAuth.
 */
async function revokeSessions(userId) {
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
}

module.exports = { revokeSessions };
