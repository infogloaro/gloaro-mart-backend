const pool = require("../config/db");

async function recordAudit({
  actorUserId,
  action,
  module,
  entityType = null,
  entityId = null,
  previousValue = null,
  newValue = null,
}) {
  await pool.query(
    `INSERT INTO audit_logs
      (actor_user_id, action, module, entity_type, entity_id, previous_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      actorUserId,
      action,
      module,
      entityType,
      entityId == null ? null : String(entityId),
      previousValue == null ? null : JSON.stringify(previousValue),
      newValue == null ? null : JSON.stringify(newValue),
    ],
  );
}

module.exports = { recordAudit };
