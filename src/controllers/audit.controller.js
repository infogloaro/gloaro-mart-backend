const pool = require("../config/db");

async function listAuditLogs(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const params = [];
  const conditions = [];

  if (req.query.module) {
    params.push(req.query.module);
    conditions.push(`a.module = $${params.length}`);
  }
  if (req.query.action) {
    params.push(req.query.action);
    conditions.push(`a.action = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM audit_logs a ${where}`,
    params,
  );
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.module, a.entity_type, a.entity_id,
            a.previous_value, a.new_value, a.created_at,
            a.actor_user_id, u.full_name AS actor_name, u.email AS actor_email
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_user_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );
  res.json({ items: rows, total: countRows[0].total, page, pageSize });
}

module.exports = { listAuditLogs };
