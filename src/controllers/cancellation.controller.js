const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const cancellations = require('../services/cancellations');

/**
 * Admin → Cancellations: the per-stage rules, and the queue of requests they
 * didn't settle on their own. The work itself is in services/cancellations.js.
 */

const MODULE = 'orders';
const PAGE_SIZE = 25;
const STATUSES = ['requested', 'approved', 'auto_approved', 'rejected', 'withdrawn'];

const SELECT = `
  SELECT c.*, o.status AS current_order_status, o.total_cents AS order_total_cents, o.vendor_id,
         o.checkout_group_id, o.user_id AS customer_id,
         COALESCE(cg.reference, '#' || o.id) AS order_reference,
         vp.business_name AS vendor_name,
         COALESCE(cu.full_name, cu.email) AS customer_name,
         ru.full_name AS requested_by_name,
         du.full_name AS decided_by_name,
         p.method AS payment_method, p.status AS payment_status,
         rf.status AS refund_status
  FROM order_cancellations c
  JOIN orders o ON o.id = c.order_id
  JOIN vendor_profiles vp ON vp.id = o.vendor_id
  JOIN users cu ON cu.id = o.user_id
  LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
  LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
  LEFT JOIN users ru ON ru.id = c.requested_by_user_id
  LEFT JOIN users du ON du.id = c.decided_by
  LEFT JOIN refunds rf ON rf.id = c.refund_id`;

const fail = (res, err) => {
  if (err instanceof cancellations.CancellationError) return res.status(err.status).json({ message: err.message });
  throw err;
};

/**
 * One row for the page. A request still waiting is priced on the fly — the
 * payment can change while it waits — at the fee it was raised under; a
 * decided one shows what was actually settled.
 */
async function toJson(r) {
  let feeCents = r.fee_cents;
  let refundCents = r.refund_cents;
  let refundableCents = r.fee_cents + r.refund_cents;
  if (r.status === 'requested') {
    const order = { id: r.order_id, total_cents: r.order_total_cents, checkout_group_id: r.checkout_group_id };
    const paid = await cancellations.refundableFor(pool, order);
    ({ feeCents, refundCents } = cancellations.quote(order, r.fee_percent, paid.cents));
    refundableCents = paid.cents;
  }
  return {
    id: r.id,
    reference: r.reference,
    orderId: r.order_id,
    orderReference: r.order_reference,
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    customerName: r.customer_name,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    orderStatusAtRequest: r.order_status_at_request,
    currentOrderStatus: r.current_order_status,
    status: r.status,
    reason: cancellations.reasonLabel(r.reason_code),
    reasonNote: r.reason_note,
    orderTotalCents: r.order_total_cents,
    feeCents,
    refundCents,
    // What was paid and can come back — the refund is this less the fee. Zero for COD.
    refundableCents,
    feePercent: Number(r.fee_percent),
    paymentStatus: r.payment_method ? `${r.payment_method === 'cod' ? 'COD' : r.payment_method} · ${r.payment_status}` : null,
    refundId: r.refund_id,
    refundStatus: r.refund_status,
    eligible: r.eligible,
    requestedAt: r.created_at,
    decidedAt: r.decided_at,
    decidedByName: r.decided_by_name,
    decisionNote: r.decision_note,
  };
}

async function loadOne(id) {
  const { rows } = await pool.query(`${SELECT} WHERE c.id = $1`, [Number(id)]);
  return rows[0] ? toJson(rows[0]) : null;
}

async function listCancellations(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const conditions = [];
  const params = [];
  if (req.query.status) {
    // 'approved' on the page covers both kinds of yes.
    const wanted = req.query.status === 'approved' ? ['approved', 'auto_approved'] : [req.query.status];
    if (!wanted.every((s) => STATUSES.includes(s))) return res.status(400).json({ message: 'Unknown status' });
    params.push(wanted);
    conditions.push(`c.status = ANY($${params.length})`);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(c.reference ILIKE ${p} OR cg.reference ILIKE ${p} OR ('#' || o.id) ILIKE ${p} OR cu.full_name ILIKE ${p} OR cu.email ILIKE ${p} OR vp.business_name ILIKE ${p})`
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // Waiting requests oldest first — the longest wait is the most urgent.
  const order = req.query.status === 'requested' ? 'c.created_at ASC' : 'c.created_at DESC';

  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY ${order}, c.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM order_cancellations c
       JOIN orders o ON o.id = c.order_id JOIN vendor_profiles vp ON vp.id = o.vendor_id JOIN users cu ON cu.id = o.user_id
       LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id ${where}`,
      params
    ),
  ]);
  res.json({ items: await Promise.all(rows.map(toJson)), total: count[0].total, page, pageSize: PAGE_SIZE });
}

async function cancellationSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'requested')::int AS requested,
       COUNT(*) FILTER (WHERE status = 'requested' AND NOT eligible)::int AS ineligible_pending,
       COUNT(*) FILTER (WHERE status IN ('approved', 'auto_approved') AND decided_at >= date_trunc('month', now()))::int AS approved_this_month,
       COUNT(*) FILTER (WHERE status = 'rejected' AND decided_at >= date_trunc('month', now()))::int AS rejected_this_month,
       COALESCE(SUM(refund_cents) FILTER (WHERE status IN ('approved', 'auto_approved')), 0)::int AS refunded_cents,
       COALESCE(SUM(fee_cents) FILTER (WHERE status IN ('approved', 'auto_approved')), 0)::int AS fee_cents
     FROM order_cancellations`
  );
  const s = rows[0];
  res.json({
    requested: s.requested,
    ineligiblePending: s.ineligible_pending,
    approvedThisMonth: s.approved_this_month,
    rejectedThisMonth: s.rejected_this_month,
    refundedCents: s.refunded_cents,
    feeCents: s.fee_cents,
  });
}

const ruleJson = (r) => ({
  orderStatus: r.order_status,
  customerAllowed: r.customer_allowed,
  vendorAllowed: r.vendor_allowed,
  autoApprove: r.auto_approve,
  feePercent: Number(r.fee_percent),
  restock: r.restock,
});

async function getRules(req, res) {
  const rules = await cancellations.loadRules();
  const updated = rules.map((r) => r.updated_at).filter(Boolean).sort().pop() ?? null;
  res.json({ rules: rules.map(ruleJson), updatedAt: updated });
}

/** Replaces all four stage rules at once. Requests already waiting keep their terms. */
async function putRules(req, res) {
  const incoming = req.body?.rules;
  if (!Array.isArray(incoming)) return res.status(400).json({ message: 'Send { rules: [...] } with one rule per stage.' });
  const byStage = new Map(incoming.map((r) => [r?.orderStatus, r]));
  if (byStage.size !== cancellations.RULE_STAGES.length || !cancellations.RULE_STAGES.every((s) => byStage.has(s))) {
    return res.status(400).json({ message: `Send exactly one rule for each stage: ${cancellations.RULE_STAGES.join(', ')}.` });
  }
  for (const [stage, r] of byStage) {
    const bools = ['customerAllowed', 'vendorAllowed', 'autoApprove', 'restock'];
    if (!bools.every((k) => typeof r[k] === 'boolean')) {
      return res.status(400).json({ message: `${stage}: ${bools.join(', ')} must be true or false.` });
    }
    if (typeof r.feePercent !== 'number' || !Number.isFinite(r.feePercent) || r.feePercent < 0 || r.feePercent > 100) {
      return res.status(400).json({ message: `${stage}: feePercent must be from 0 to 100.` });
    }
  }

  const before = (await cancellations.loadRules()).map(ruleJson);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [stage, r] of byStage) {
      await client.query(
        `UPDATE cancellation_rules SET customer_allowed = $2, vendor_allowed = $3, auto_approve = $4,
           fee_percent = $5, restock = $6, updated_by = $7, updated_at = now()
         WHERE order_status = $1`,
        [stage, r.customerAllowed, r.vendorAllowed, r.autoApprove, Math.round(r.feePercent * 100) / 100, r.restock, req.user.id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await recordAudit({
    actorUserId: req.user.id,
    action: 'cancellation_rules.updated',
    module: MODULE,
    entityType: 'cancellation_rules',
    previousValue: before,
    newValue: cancellations.RULE_STAGES.map((s) => byStage.get(s)),
  });
  return getRules(req, res);
}

async function approveCancellation(req, res) {
  const feeCents = req.body?.feeCents ?? null;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
  let result;
  try {
    result = await cancellations.approve({ id: req.params.id, userId: req.user.id, feeCents, note });
  } catch (err) {
    return fail(res, err);
  }
  await recordAudit({
    actorUserId: req.user.id,
    action: result.cancellation.eligible ? 'cancellation.approved' : 'cancellation.approved_override',
    module: MODULE,
    entityType: 'order_cancellation',
    entityId: result.cancellation.id,
    newValue: { orderId: result.order.id, feeCents: result.feeCents, refundCents: result.refundCents, note },
  });
  res.json(await loadOne(result.cancellation.id));
}

async function rejectCancellation(req, res) {
  let cancellation;
  try {
    cancellation = await cancellations.reject({ id: req.params.id, userId: req.user.id, reason: req.body?.reason });
  } catch (err) {
    return fail(res, err);
  }
  await recordAudit({
    actorUserId: req.user.id,
    action: 'cancellation.rejected',
    module: MODULE,
    entityType: 'order_cancellation',
    entityId: cancellation.id,
    newValue: { orderId: cancellation.order_id, reason: cancellation.decision_note },
  });
  res.json(await loadOne(cancellation.id));
}

module.exports = {
  listCancellations,
  cancellationSummary,
  getRules,
  putRules,
  approveCancellation,
  rejectCancellation,
};
