const pool = require("../config/db");
const secretBox = require("../services/secretBox");
const { recordAudit } = require("../services/auditLog");
const { loadStaffContext } = require("../middleware/rbac");
const platformRegistry = require("./platformRegistry.controller");
const platformConnection = require("./platformConnection.controller");
const staff = require("./staff.controller");

/**
 * Approval rules and the queue of requests waiting on them.
 *
 * Super admins see every request and approve or reject them; anyone else sees
 * only their own and may cancel those. Rules are super admin only.
 *
 * Approving replays the stored request through the handler that received it,
 * as the person who asked, so the change is validated against the state of
 * things now and audited like any other edit. If it no longer applies, the
 * request is marked failed with the reason, and nothing changes.
 */

// The handlers a held request may be replayed through — nothing else can run.
const EXECUTORS = {
  "platform.update": platformRegistry.updatePlatform,
  "platform.save_connection": platformConnection.saveConnection,
  "role.create": staff.createRole,
  "role.update": staff.updateRole,
};

/** Calls an Express handler in-process and resolves with what it answered. */
function replay(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: null });
        return this;
      },
      send(body) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const SELECT_REQUEST = `
  SELECT ar.id, ar.action, r.label AS action_label, ar.entity_type, ar.entity_id, ar.summary, ar.payload,
         ar.status, ar.decision_note, ar.result_message, ar.created_at, ar.decided_at,
         ar.requested_by_user_id, rq.full_name AS requested_by_name, rq.email AS requested_by_email,
         ar.decided_by_user_id, dc.full_name AS decided_by_name
  FROM approval_requests ar
  JOIN approval_rules r ON r.action = ar.action
  LEFT JOIN users rq ON rq.id = ar.requested_by_user_id
  LEFT JOIN users dc ON dc.id = ar.decided_by_user_id`;

/** The visible copy only: the payload never carries secret values. */
const toJson = ({ payload, ...row }) => ({ ...row, details: payload?.body ?? {} });

async function listRequests(req, res) {
  const params = [];
  const where = [];
  if (req.query.status) {
    params.push(String(req.query.status));
    where.push(`ar.status = $${params.length}`);
  }
  if (!req.staff.isSuperAdmin) {
    params.push(req.user.id);
    where.push(`ar.requested_by_user_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `${SELECT_REQUEST} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ar.created_at DESC LIMIT 200`,
    params,
  );
  res.json(rows.map(toJson));
}

async function loadPending(id) {
  const { rows } = await pool.query("SELECT * FROM approval_requests WHERE id = $1", [id]);
  return rows[0] ?? null;
}

async function decide(req, row, { status, note, result }) {
  await pool.query(
    `UPDATE approval_requests SET status = $2, decided_by_user_id = $3, decided_at = NOW(),
       decision_note = $4, result_message = $5, payload_encrypted = NULL
     WHERE id = $1`,
    [row.id, status, req.user.id, note, result],
  );
  await recordAudit({
    actorUserId: req.user.id,
    action: `approval.${status}`,
    module: "system",
    entityType: "approval_request",
    entityId: row.id,
    newValue: { action: row.action, summary: row.summary, note, result },
  });
}

async function approve(req, res) {
  if (!req.staff.isSuperAdmin) return res.status(403).json({ message: "Only a super admin can approve requests." });
  const row = await loadPending(req.params.id);
  if (!row) return res.status(404).json({ message: "Request not found" });
  if (row.status !== "pending") return res.status(409).json({ message: `This request is already ${row.status}.` });

  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) || null : null;
  let stored;
  try {
    stored = row.payload_encrypted ? secretBox.open(row.payload_encrypted) : row.payload;
  } catch {
    await decide(req, row, { status: "failed", note, result: "The stored request could not be decrypted; ask for it again." });
    return res.status(409).json({ message: "The stored request could not be decrypted; it has been marked failed." });
  }
  const handler = EXECUTORS[stored.handler];
  if (!handler) return res.status(500).json({ message: "This request has no executor" });

  // Replayed as the requester (their audit trail, their identity), past the gate.
  const requester = await pool.query("SELECT id, email FROM users WHERE id = $1", [row.requested_by_user_id]);
  if (!requester.rows[0]) {
    await decide(req, row, { status: "failed", note, result: "The person who asked no longer exists." });
    return res.status(409).json({ message: "The person who asked no longer exists; the request has been marked failed." });
  }
  const outcome = await replay(handler, {
    params: stored.params ?? {},
    body: stored.body ?? {},
    query: {},
    headers: {},
    user: { id: requester.rows[0].id, email: requester.rows[0].email, role: "admin" },
    staff: await loadStaffContext(requester.rows[0].id),
    approvalId: row.id,
  });

  if (outcome.status >= 400) {
    const reason = outcome.body?.message ?? `It could not be applied (HTTP ${outcome.status}).`;
    await decide(req, row, { status: "failed", note, result: reason });
    return res.status(409).json({ message: `Not applied: ${reason}`, status: "failed" });
  }
  await decide(req, row, { status: "approved", note, result: "Applied." });
  res.json({ status: "approved", message: "Approved and applied." });
}

async function reject(req, res) {
  if (!req.staff.isSuperAdmin) return res.status(403).json({ message: "Only a super admin can reject requests." });
  const row = await loadPending(req.params.id);
  if (!row) return res.status(404).json({ message: "Request not found" });
  if (row.status !== "pending") return res.status(409).json({ message: `This request is already ${row.status}.` });
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) || null : null;
  await decide(req, row, { status: "rejected", note, result: null });
  res.json({ status: "rejected" });
}

async function cancel(req, res) {
  const row = await loadPending(req.params.id);
  if (!row) return res.status(404).json({ message: "Request not found" });
  if (row.requested_by_user_id !== req.user.id && !req.staff.isSuperAdmin) {
    return res.status(403).json({ message: "You can cancel only your own requests." });
  }
  if (row.status !== "pending") return res.status(409).json({ message: `This request is already ${row.status}.` });
  await decide(req, row, { status: "cancelled", note: null, result: null });
  res.json({ status: "cancelled" });
}

// ── Rules ──

async function listRules(req, res) {
  const { rows } = await pool.query(
    `SELECT r.*, (SELECT COUNT(*)::int FROM approval_requests q WHERE q.action = r.action AND q.status = 'pending') AS pending_count
     FROM approval_rules r ORDER BY r.action`,
  );
  res.json(rows);
}

async function updateRule(req, res) {
  if (!req.staff.isSuperAdmin) return res.status(403).json({ message: "Only a super admin can change approval rules." });
  if (typeof req.body?.requiresApproval !== "boolean") return res.status(400).json({ message: "requiresApproval must be true or false" });
  const { rows: before } = await pool.query("SELECT * FROM approval_rules WHERE action = $1", [req.params.action]);
  if (!before[0]) return res.status(404).json({ message: "Rule not found" });
  const { rows } = await pool.query(
    `UPDATE approval_rules SET requires_approval = $2, updated_by_user_id = $3, updated_at = NOW()
     WHERE action = $1 RETURNING *`,
    [req.params.action, req.body.requiresApproval, req.user.id],
  );
  await recordAudit({
    actorUserId: req.user.id,
    action: "approval.rule_changed",
    module: "system",
    entityType: "approval_rule",
    entityId: rows[0].action,
    previousValue: { requires_approval: before[0].requires_approval },
    newValue: { requires_approval: rows[0].requires_approval },
  });
  res.json(rows[0]);
}

module.exports = { listRequests, approve, reject, cancel, listRules, updateRule };
