const pool = require("../config/db");
const { recordAudit } = require("../services/auditLog");

const KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,99}$/;

async function listFlags(req, res) {
  const { rows } = await pool.query(
    `SELECT id, flag_key, description, enabled, updated_by_user_id, created_at, updated_at
     FROM feature_flags ORDER BY flag_key`,
  );
  res.json(rows);
}

async function listEnabledFlags(req, res) {
  const { rows } = await pool.query(
    "SELECT flag_key FROM feature_flags WHERE enabled = true ORDER BY flag_key",
  );
  res.json(rows.map((row) => row.flag_key));
}

async function createFlag(req, res) {
  const { key, description, enabled = false } = req.body || {};
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    return res
      .status(400)
      .json({
        message:
          "key must use lowercase letters, numbers, dots, hyphens, or underscores",
      });
  }
  if (typeof enabled !== "boolean")
    return res.status(400).json({ message: "enabled must be a boolean" });
  try {
    const { rows } = await pool.query(
      `INSERT INTO feature_flags (flag_key, description, enabled, updated_by_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        key,
        typeof description === "string" ? description.trim() || null : null,
        enabled,
        req.user.id,
      ],
    );
    await recordAudit({
      actorUserId: req.user.id,
      action: "feature_flag.created",
      module: "system",
      entityType: "feature_flag",
      entityId: rows[0].id,
      newValue: { key: rows[0].flag_key, enabled: rows[0].enabled },
    });
    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === "23505")
      return res
        .status(409)
        .json({ message: "A feature flag with this key already exists" });
    throw error;
  }
}

async function updateFlag(req, res) {
  const { enabled, description } = req.body || {};
  if (typeof enabled !== "boolean" && typeof description !== "string") {
    return res
      .status(400)
      .json({ message: "enabled or description is required" });
  }
  const { rows: beforeRows } = await pool.query(
    "SELECT * FROM feature_flags WHERE id = $1",
    [req.params.id],
  );
  if (!beforeRows[0])
    return res.status(404).json({ message: "Feature flag not found" });
  const { rows } = await pool.query(
    `UPDATE feature_flags SET
       enabled = COALESCE($2, enabled),
       description = COALESCE($3, description),
       updated_by_user_id = $4,
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      req.params.id,
      typeof enabled === "boolean" ? enabled : null,
      typeof description === "string" ? description.trim() : null,
      req.user.id,
    ],
  );
  await recordAudit({
    actorUserId: req.user.id,
    action: "feature_flag.updated",
    module: "system",
    entityType: "feature_flag",
    entityId: rows[0].id,
    previousValue: {
      key: beforeRows[0].flag_key,
      enabled: beforeRows[0].enabled,
      description: beforeRows[0].description,
    },
    newValue: {
      key: rows[0].flag_key,
      enabled: rows[0].enabled,
      description: rows[0].description,
    },
  });
  res.json(rows[0]);
}

async function deleteFlag(req, res) {
  const { rows } = await pool.query("SELECT * FROM feature_flags WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: "Feature flag not found" });
  await pool.query("DELETE FROM feature_flags WHERE id = $1", [req.params.id]);
  await recordAudit({
    actorUserId: req.user.id,
    action: "feature_flag.deleted",
    module: "system",
    entityType: "feature_flag",
    entityId: rows[0].id,
    previousValue: { key: rows[0].flag_key, enabled: rows[0].enabled },
  });
  res.status(204).end();
}

module.exports = { listFlags, listEnabledFlags, createFlag, updateFlag, deleteFlag };
