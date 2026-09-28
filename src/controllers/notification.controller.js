const pool = require("../config/db");

async function listMine(req, res) {
  const { rows } = await pool.query(
    `SELECT id, type, title, body, deep_link, read_at, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.user.id],
  );
  const { rows: unread } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [req.user.id],
  );
  res.json({ items: rows, unreadCount: unread[0].count });
}

async function markRead(req, res) {
  const { rows } = await pool.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND user_id = $2
     RETURNING id, read_at`,
    [req.params.id, req.user.id],
  );
  if (!rows[0])
    return res.status(404).json({ message: "Notification not found" });
  res.json(rows[0]);
}

async function markAllRead(req, res) {
  const result = await pool.query(
    "UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL",
    [req.user.id],
  );
  res.json({ updated: result.rowCount });
}

const PLATFORMS = ["android", "ios", "web"];

/**
 * Registers this device's push token. The token is unique across users, so a
 * phone that switches accounts moves to the new owner instead of leaving the
 * old account receiving the new user's notifications.
 */
async function registerDeviceToken(req, res) {
  const { token, platform } = req.body || {};
  if (typeof token !== "string" || !token.trim() || token.length > 4096) {
    return res.status(400).json({ message: "Invalid device token" });
  }
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ message: "platform must be android, ios or web" });
  }
  await pool.query(
    `INSERT INTO device_tokens (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (token)
     DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = NOW()`,
    [req.user.id, token.trim(), platform],
  );
  res.status(201).json({ message: "Device registered" });
}

/** Call before logout so a signed-out phone stops receiving this account's pushes. */
async function removeDeviceToken(req, res) {
  const { token } = req.body || {};
  if (typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ message: "Invalid device token" });
  }
  await pool.query("DELETE FROM device_tokens WHERE token = $1 AND user_id = $2", [
    token.trim(),
    req.user.id,
  ]);
  res.json({ message: "Device removed" });
}

module.exports = {
  listMine,
  markRead,
  markAllRead,
  registerDeviceToken,
  removeDeviceToken,
};
