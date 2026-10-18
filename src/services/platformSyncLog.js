const pool = require("../config/db");

/** One row in platform_sync_logs. Callers pass only credential-free summaries. */
async function recordSyncLog({ platformId, environment, kind, status, event = null, message = null, detail = null }) {
  await pool.query(
    `INSERT INTO platform_sync_logs (platform_id, environment, kind, status, event, message, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [platformId, environment, kind, status, event, message ? String(message).slice(0, 500) : null, detail ? JSON.stringify(detail) : null],
  );
}

module.exports = { recordSyncLog };
