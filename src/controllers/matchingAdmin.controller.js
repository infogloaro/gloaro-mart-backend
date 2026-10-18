const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const { loadWeights } = require('../services/matching');
const { settleCodForOrder } = require('./payment.controller');
const { completeWaitingReroute } = require('./reassignment.controller');

/**
 * Admin → Vendor Matching & Re-routing: the rules (schema VENDOR MATCHING
 * RULES, PHASE 39), what the engine did, and re-routes waiting for an admin.
 */

const MODULE = 'vendors';

const FACTORS = [
  { key: 'stock', label: 'Stock on hand', higherIsBetter: true, description: 'Full marks once a shop holds three times the quantity ordered.' },
  { key: 'distance', label: 'Distance', higherIsBetter: false, description: 'Nearer shops score higher.' },
  { key: 'delivery', label: 'Delivery time', higherIsBetter: false, description: 'The shop’s estimated time to the door.' },
  { key: 'price', label: 'Price', higherIsBetter: false, description: 'The cheaper line total wins.' },
  { key: 'rating', label: 'Customer rating', higherIsBetter: true, description: 'Published shop reviews; unrated shops score neutral.' },
  { key: 'performance', label: 'Reliability', higherIsBetter: true, description: 'Acceptance and cancellation record, with current workload as a tiebreak.' },
];

function configJson(w) {
  const off = new Set(w.disabled_factors ?? []);
  return {
    weights: FACTORS.map((f) => ({ ...f, weight: Number(w[`${f.key}_weight`]), enabled: !off.has(f.key) })),
    maxRadiusKm: Number(w.max_radius_km),
    acceptWindowMinutes: w.accept_window_minutes,
    autoReassign: w.auto_reassign,
    maxReassignAttempts: w.max_reassign_attempts,
    // Shown on the page as the price limit for a re-route that goes ahead without the customer.
    reassignPriceTolerancePercent: Number(w.reassign_price_tolerance_percent),
    updatedAt: w.updated_at,
  };
}

async function getConfig(req, res) {
  res.json(configJson(await loadWeights()));
}

async function putConfig(req, res) {
  const b = req.body || {};
  const sets = [];
  const params = [];
  const set = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if ('weights' in b) {
    if (!Array.isArray(b.weights)) return res.status(400).json({ message: 'weights must be a list' });
    const disabled = [];
    for (const w of b.weights) {
      const factor = FACTORS.find((f) => f.key === w?.key);
      if (!factor) return res.status(400).json({ message: `Unknown factor '${w?.key}'` });
      if (typeof w.weight !== 'number' || !Number.isFinite(w.weight) || w.weight < 0 || w.weight > 100) {
        return res.status(400).json({ message: `${factor.label}: weight must be from 0 to 100` });
      }
      if (typeof w.enabled !== 'boolean') return res.status(400).json({ message: `${factor.label}: enabled must be true or false` });
      set(`${factor.key}_weight`, w.weight);
      if (!w.enabled) disabled.push(factor.key);
    }
    // Only factors that were sent can change state; the rest keep theirs.
    const current = await loadWeights();
    const sent = new Set(b.weights.map((w) => w.key));
    const kept = (current.disabled_factors ?? []).filter((k) => !sent.has(k));
    const allOff = [...kept, ...disabled];
    const enabledTotal = FACTORS.filter((f) => !allOff.includes(f.key)).reduce((sum, f) => {
      const sentWeight = b.weights.find((w) => w.key === f.key)?.weight;
      return sum + (sentWeight ?? Number(current[`${f.key}_weight`]));
    }, 0);
    if (enabledTotal <= 0) return res.status(400).json({ message: 'At least one factor must be on with a weight above zero.' });
    set('disabled_factors', allOff);
  }
  const limits = [
    ['maxRadiusKm', 'max_radius_km', 1, 500, false],
    ['acceptWindowMinutes', 'accept_window_minutes', 1, 1440, true],
    ['maxReassignAttempts', 'max_reassign_attempts', 0, 10, true],
    ['reassignPriceTolerancePercent', 'reassign_price_tolerance_percent', 0, 100, false],
  ];
  for (const [key, column, min, max, whole] of limits) {
    if (!(key in b)) continue;
    const v = b[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) {
      return res.status(400).json({ message: `${key} must be ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}` });
    }
    set(column, v);
  }
  if ('autoReassign' in b) {
    if (typeof b.autoReassign !== 'boolean') return res.status(400).json({ message: 'autoReassign must be true or false' });
    set('auto_reassign', b.autoReassign);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to change' });

  const before = configJson(await loadWeights());
  const { rows } = await pool.query(
    `UPDATE vendor_matching_weights SET ${sets.join(', ')}, updated_at = now() WHERE id = 1 RETURNING *`,
    params
  );
  await recordAudit({
    actorUserId: req.user.id,
    action: 'matching.config_updated',
    module: MODULE,
    entityType: 'vendor_matching_weights',
    entityId: 1,
    previousValue: before,
    newValue: b,
  });
  res.json(configJson(rows[0]));
}

async function matchingSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM orders WHERE created_at >= date_trunc('day', now())) AS placed_today,
       (SELECT COUNT(*)::int FROM order_assignment_history
          WHERE status IN ('assigned', 'accepted') AND COALESCE(resolved_at, created_at) >= date_trunc('day', now())) AS rerouted_today,
       (SELECT COUNT(*)::int FROM order_assignment_history WHERE status = 'no_alternative' AND created_at >= now() - interval '30 days') AS unmatched,
       (SELECT COUNT(*)::int FROM order_assignment_history WHERE status = 'pending_admin') AS pending,
       (SELECT AVG(candidate_count)::float FROM vendor_matching_logs WHERE created_at >= now() - interval '7 days') AS avg_candidates,
       (SELECT AVG(duration_ms)::float / 1000 FROM vendor_matching_logs
          WHERE duration_ms IS NOT NULL AND created_at >= now() - interval '7 days') AS avg_seconds`
  );
  const s = rows[0];
  res.json({
    // Every order placed today went to a shop, plus the ones moved to another shop today.
    matchedToday: s.placed_today + s.rerouted_today,
    unmatched: s.unmatched,
    pendingReassignments: s.pending,
    avgCandidates: s.avg_candidates,
    avgMatchSeconds: s.avg_seconds,
  });
}

const SKIP_REASONS = {
  OUT_OF_STOCK: 'Not enough stock',
  BEYOND_MAX_RADIUS: 'Beyond the maximum radius',
};
const skipLabel = (reason) => (reason ? SKIP_REASONS[reason] ?? reason.toLowerCase().replace(/_/g, ' ') : 'Cannot deliver');

function logJson(l) {
  const candidates = (l.candidates ?? []).map((c, i) => ({
    vendorId: c.vendorId,
    vendorName: c.businessName,
    rank: i + 1,
    score: Number(c.score ?? 0),
    distanceKm: c.distanceKm,
    chosen: c.vendorId === l.selected_vendor_id,
    skippedReason: c.deliverable ? null : skipLabel(c.reason),
  }));
  const chosen = candidates.find((c) => c.chosen);
  return {
    id: l.id,
    orderId: l.order_id,
    // Runs for an order name it; runs while a customer browsed name the product.
    orderReference: l.order_id ? `${l.group_reference ?? 'Order'} · #${l.order_id}` : `${l.product_name ?? 'Product'} · browsing`,
    context: l.context,
    productName: l.product_name,
    createdAt: l.created_at,
    outcome: l.outcome ?? (l.selected_vendor_id ? 'matched' : 'no_vendor'),
    attempt: l.attempt ?? 1,
    candidatesConsidered: l.candidate_count,
    chosenVendorId: l.selected_vendor_id,
    chosenVendorName: l.selected_vendor_name,
    chosenScore: chosen ? chosen.score : null,
    reason: l.reason,
    candidates,
  };
}

async function listLogs(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const conditions = [];
  const params = [];
  if (req.query.context === 'orders') conditions.push('l.order_id IS NOT NULL');
  else if (req.query.context) {
    params.push(req.query.context);
    conditions.push(`l.context = $${params.length}`);
  }
  if (req.query.orderId) {
    params.push(Number(req.query.orderId));
    conditions.push(`l.order_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [{ rows: count }, { rows }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM vendor_matching_logs l ${where}`, params),
    pool.query(
      `SELECT l.*, vp.business_name AS selected_vendor_name, p.name AS product_name, cg.reference AS group_reference
       FROM vendor_matching_logs l
       LEFT JOIN vendor_profiles vp ON vp.id = l.selected_vendor_id
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN orders o ON o.id = l.order_id
       LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
       ${where}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    ),
  ]);
  res.json({ items: rows.map(logJson), total: count[0].total, page, pageSize });
}

// The page's four states, from the history row's own.
const PAGE_STATUS = {
  pending_admin: 'pending',
  pending_customer: 'pending',
  admin_rejected: 'rejected',
  declined: 'rejected',
  accepted: 'approved',
  no_alternative: 'auto',
};
const DB_STATUSES = {
  pending: ['pending_admin', 'pending_customer'],
  approved: ['assigned', 'accepted'],
  rejected: ['admin_rejected', 'declined'],
};

function reassignmentJson(h) {
  const status = h.status === 'assigned' ? (h.resolved_by ? 'approved' : 'auto') : PAGE_STATUS[h.status];
  const closed = !['pending_admin', 'pending_customer'].includes(h.status);
  return {
    id: h.id,
    orderId: h.from_order_id,
    orderReference: `${h.group_reference} · #${h.from_order_id}`,
    status,
    // Pending ones say who has to act: an admin can only decide the ones waiting for an admin.
    waitingOn: h.status === 'pending_admin' ? 'admin' : h.status === 'pending_customer' ? 'customer' : null,
    trigger: h.trigger,
    // Still open when the shop let the window run out: turning the re-route down leaves the order with them.
    originalStillOpen: h.from_order_status === 'pending',
    reason: h.status === 'no_alternative' ? `${h.reason ?? ''} — no other shop could fill it`.replace(/^ — /, '') : h.reason,
    fromVendorId: h.from_vendor_id,
    fromVendorName: h.from_vendor_name,
    toVendorId: h.status === 'no_alternative' ? null : h.to_vendor_id,
    toVendorName: h.status === 'no_alternative' ? null : h.to_vendor_name,
    originalTotalCents: h.original_total_cents ?? 0,
    proposedTotalCents: h.proposed_total_cents ?? h.original_total_cents ?? 0,
    newOrderId: h.to_order_id,
    createdAt: h.created_at,
    resolvedAt: closed ? h.resolved_at ?? h.updated_at : null,
    resolvedByName: h.resolved_by_name ?? (['accepted', 'declined'].includes(h.status) ? 'the customer' : null),
  };
}

const REASSIGN_SELECT = `
  SELECT h.*, cg.reference AS group_reference, fo.status AS from_order_status,
         fv.business_name AS from_vendor_name, tv.business_name AS to_vendor_name, ru.full_name AS resolved_by_name
  FROM order_assignment_history h
  JOIN checkout_groups cg ON cg.id = h.checkout_group_id
  LEFT JOIN orders fo ON fo.id = h.from_order_id
  LEFT JOIN vendor_profiles fv ON fv.id = h.from_vendor_id
  LEFT JOIN vendor_profiles tv ON tv.id = h.to_vendor_id
  LEFT JOIN users ru ON ru.id = h.resolved_by`;

async function listReassignments(req, res) {
  const params = [];
  let where = '';
  if (req.query.status) {
    if (!DB_STATUSES[req.query.status]) return res.status(400).json({ message: 'Unknown status' });
    params.push(DB_STATUSES[req.query.status]);
    where = 'WHERE h.status = ANY($1)';
  }
  const order = req.query.status === 'pending' ? 'h.created_at ASC' : 'h.created_at DESC';
  const { rows } = await pool.query(`${REASSIGN_SELECT} ${where} ORDER BY ${order}, h.id LIMIT 200`, params);
  res.json(rows.map(reassignmentJson));
}

async function loadReassignment(id) {
  const { rows } = await pool.query(`${REASSIGN_SELECT} WHERE h.id = $1`, [Number(id)]);
  return rows[0] ? reassignmentJson(rows[0]) : null;
}

/** Locks a re-route that is waiting for an admin, or explains why it can't be decided. */
async function lockForAdmin(client, id) {
  const { rows } = await client.query('SELECT * FROM order_assignment_history WHERE id = $1 FOR UPDATE', [id]);
  const h = rows[0];
  if (!h) return { error: [404, 'Re-route not found'] };
  if (h.status === 'pending_customer') return { error: [409, 'This one is waiting for the customer to accept the higher price.'] };
  if (h.status !== 'pending_admin') return { error: [409, 'This re-route has already been decided.'] };
  const { rows: orderRows } = await client.query('SELECT status FROM orders WHERE id = $1', [h.from_order_id]);
  const status = orderRows[0]?.status;
  if (status && !['pending', 'cancelled'].includes(status)) {
    return { h, moved: `The shop accepted the order meanwhile (it is ${status.replace(/_/g, ' ')}), so it stays with them.` };
  }
  return { h };
}

/** Goes ahead with a waiting re-route, re-matched now; a dearer result goes to the customer instead. */
async function approveReassignment(req, res) {
  const client = await pool.connect();
  let done;
  try {
    await client.query('BEGIN');
    const lock = await lockForAdmin(client, req.params.id);
    if (lock.error) {
      await client.query('ROLLBACK');
      return res.status(lock.error[0]).json({ message: lock.error[1] });
    }
    if (lock.moved) {
      await client.query(
        `UPDATE order_assignment_history SET status = 'admin_rejected', resolved_at = now(), updated_at = now() WHERE id = $1`,
        [lock.h.id]
      );
      await client.query('COMMIT');
      return res.status(409).json({ message: lock.moved });
    }
    done = await completeWaitingReroute(client, lock.h, { userId: req.user.id, actorRole: 'admin', resolvedBy: req.user.id, checkPrice: true });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }
  if (done.cancelledOrderId) await settleCodForOrder(done.cancelledOrderId);
  await recordAudit({
    actorUserId: req.user.id,
    action: 'matching.reroute_approved',
    module: MODULE,
    entityType: 'order_assignment',
    entityId: req.params.id,
    newValue: done.outcome,
  });
  res.json({ ...(await loadReassignment(req.params.id)), outcome: done.outcome });
}

/**
 * Turns a waiting re-route down. If the shop let the window run out, the order
 * stays with it (and isn't swept again). If the shop rejected it, the order was
 * already over, so the customer is told it won't be moved.
 */
async function rejectReassignment(req, res) {
  const client = await pool.connect();
  let h;
  try {
    await client.query('BEGIN');
    const lock = await lockForAdmin(client, req.params.id);
    if (lock.error) {
      await client.query('ROLLBACK');
      return res.status(lock.error[0]).json({ message: lock.error[1] });
    }
    h = lock.h;
    await client.query(
      `UPDATE order_assignment_history SET status = 'admin_rejected', resolved_by = $2, resolved_at = now(), updated_at = now() WHERE id = $1`,
      [h.id, req.user.id]
    );
    const { rows } = await client.query('SELECT user_id, status FROM orders WHERE id = $1', [h.from_order_id]);
    if (rows[0]?.status === 'cancelled') {
      await client.query('INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, $2, $3, $4, $5)', [
        rows[0].user_id,
        'order_cancelled',
        'Your order was cancelled',
        `The shop couldn't fill order #${h.from_order_id}, and it won't be moved to another shop. Please order again.`,
        `/orders/${h.from_order_id}`,
      ]);
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
    action: 'matching.reroute_rejected',
    module: MODULE,
    entityType: 'order_assignment',
    entityId: h.id,
    newValue: { orderId: h.from_order_id },
  });
  res.json(await loadReassignment(h.id));
}

module.exports = {
  getConfig,
  putConfig,
  matchingSummary,
  listLogs,
  listReassignments,
  approveReassignment,
  rejectReassignment,
};
