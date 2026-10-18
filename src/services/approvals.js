const pool = require("../config/db");
const secretBox = require("./secretBox");
const { recordAudit } = require("./auditLog");

/**
 * The approval gate. A controller about to apply a sensitive change calls
 * holdForApproval(); when the action's rule is on and the requester is not a
 * super admin, the request is stored and answered 202 instead of applied.
 *
 * Approving replays the stored request through the same handler (see
 * approval.controller.js), with req.approvalId set so it passes this gate.
 */

/**
 * @param handler  name of the executor that will replay it, e.g. "platform.update"
 * @param request  { params, body } as received; secretBody=true stores the body encrypted
 * @returns true when the response has been sent (held), false to carry on
 */
async function holdForApproval(req, res, { action, entityType, entityId, summary, handler, secretBody = false, safeBody }) {
  if (req.approvalId || req.staff?.isSuperAdmin) return false;
  const { rows } = await pool.query("SELECT requires_approval FROM approval_rules WHERE action = $1", [action]);
  if (!rows[0]?.requires_approval) return false;

  const request = { handler, params: req.params, body: req.body ?? {} };
  let sealed = null;
  if (secretBody) {
    try {
      sealed = secretBox.seal(request);
    } catch (e) {
      if (e instanceof secretBox.SecretKeyMissingError) {
        res.status(503).json({ message: e.message });
        return true;
      }
      throw e;
    }
  }
  try {
    const { rows: created } = await pool.query(
      `INSERT INTO approval_requests
         (action, entity_type, entity_id, summary, payload, payload_encrypted, requested_by_user_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
      [
        action,
        entityType,
        entityId == null ? null : String(entityId),
        summary,
        // With secretBody the plain copy keeps only what is safe to show.
        JSON.stringify(secretBody ? { handler, params: req.params, body: safeBody ?? {} } : request),
        sealed,
        req.user.id,
      ],
    );
    await recordAudit({
      actorUserId: req.user.id,
      action: "approval.requested",
      module: "system",
      entityType: "approval_request",
      entityId: created[0].id,
      newValue: { action, summary },
    });
    res.status(202).json({
      pendingApproval: true,
      requestId: created[0].id,
      message: "Sent for approval. A super admin has to approve it before it takes effect.",
    });
  } catch (error) {
    if (error.code !== "23505") throw error;
    res.status(409).json({ message: "This is already waiting for approval. Ask a super admin, or cancel that request first." });
  }
  return true;
}

module.exports = { holdForApproval };
