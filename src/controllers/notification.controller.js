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

module.exports = { listMine, markRead, markAllRead };
