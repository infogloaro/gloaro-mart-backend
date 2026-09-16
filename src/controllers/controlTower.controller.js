const pool = require('../config/db');
const { deriveGroupStatus } = require('./order.controller');

/**
 * One console for what is happening to orders right now.
 *
 * Deliberately group-first. The Orders module already lists vendor orders one
 * per row; a customer who bought from three shops appears there as three
 * unrelated lines, and nobody handling a complaint about "my order" can see the
 * purchase that way. This reads the purchase, with its vendor orders under it.
 *
 * Everything here is derived on read. There is no 'exception' column to fall out
 * of step with the orders it describes — an order is late because of when it was
 * last touched, and that is a fact about the timestamps, not a flag someone has
 * to remember to set.
 */

// How long an order may sit in a status before the tower calls it late.
// Deliberately generous: a tower that cries wolf gets ignored, and these are the
// points where a human actually needs to intervene.
const SLA_MINUTES = {
  pending: 30, // nobody has accepted it
  confirmed: 120, // accepted but not packed
  packed: 180, // packed but not collected
  out_for_delivery: 240, // on the road too long
};

const OPEN_STATUSES = ['pending', 'confirmed', 'packed', 'out_for_delivery'];

/**
 * Why this purchase needs attention. Ordered most urgent first, because the UI
 * shows the leading reason when space is tight.
 */
function exceptionsFor(group, orders, reassignments) {
  const list = [];

  // A group with no orders is a purchase with nothing behind it: checkout wrote
  // the header and then never wrote the vendor orders. It is reported first
  // because deriveGroupStatus calls an empty group 'pending', so it otherwise
  // sits on the board looking like live work forever.
  if (orders.length === 0) {
    list.push({
      code: 'NO_ORDERS',
      severity: 'high',
      message: 'No vendor orders were created for this purchase',
    });
    return list;
  }

  const pendingReassign = reassignments.filter((r) => r.status === 'pending_customer').length;
  if (pendingReassign > 0) {
    list.push({
      code: 'AWAITING_CUSTOMER',
      severity: 'high',
      message: `Waiting on the customer to approve a dearer replacement`,
    });
  }

  const late = orders.filter((o) => o.isLate);
  if (late.length > 0) {
    list.push({
      code: 'SLA_BREACH',
      severity: 'high',
      message:
        late.length === 1
          ? `${late[0].vendorName} is ${late[0].minutesInStatus} min into ${late[0].status.replace(/_/g, ' ')}`
          : `${late.length} shops are past their target time`,
    });
  }

  if (group.payment_status === 'failed') {
    list.push({ code: 'PAYMENT_FAILED', severity: 'high', message: 'Payment failed' });
  } else if (group.payment_status === 'pending' && group.payment_method !== 'cod') {
    list.push({
      code: 'PAYMENT_INCOMPLETE',
      severity: 'medium',
      message: 'Online payment never completed',
    });
  }

  const rejected = reassignments.filter((r) => r.status === 'declined').length;
  if (rejected > 0) {
    list.push({ code: 'REPLACEMENT_DECLINED', severity: 'medium', message: 'Customer declined a replacement' });
  }

  // A purchase where every shop cancelled is not "cancelled and fine" — it is a
  // customer who ordered and got nothing, which someone should see.
  if (orders.length > 0 && orders.every((o) => o.status === 'cancelled')) {
    list.push({ code: 'FULLY_CANCELLED', severity: 'medium', message: 'Every shop cancelled' });
  }

  return list;
}

function minutesSince(timestamp) {
  if (!timestamp) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
}

async function listGroups(req, res) {
  const { status, exceptionsOnly, q } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));

  const conditions = [];
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(cg.reference ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`);
  }
  if (status === 'open') {
    // At least one shop still has work to do.
    conditions.push(
      `EXISTS (SELECT 1 FROM orders o2 WHERE o2.checkout_group_id = cg.id AND o2.status <> 'delivered' AND o2.status <> 'cancelled')`
    );
  } else if (status === 'delivered') {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM orders o2 WHERE o2.checkout_group_id = cg.id AND o2.status <> 'delivered' AND o2.status <> 'cancelled')`
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM checkout_groups cg JOIN users u ON u.id = cg.user_id ${where}`,
    params
  );

  const { rows: groups } = await pool.query(
    `SELECT cg.*, u.full_name AS customer_name, u.phone_number AS customer_phone
     FROM checkout_groups cg
     JOIN users u ON u.id = cg.user_id
     ${where}
     ORDER BY cg.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]
  );

  if (groups.length === 0) {
    return res.json({ items: [], total: countRows[0].total, page, pageSize });
  }

  const groupIds = groups.map((g) => g.id);

  // Orders and reassignments fetched once for the whole page rather than per
  // group: a 25-row page would otherwise be 50 extra round trips.
  const { rows: orderRows } = await pool.query(
    `SELECT o.*, vp.business_name AS vendor_name,
            (SELECT MAX(h.created_at) FROM order_status_history h
             WHERE h.order_id = o.id AND h.to_status = o.status) AS status_since
     FROM orders o
     JOIN vendor_profiles vp ON vp.id = o.vendor_id
     WHERE o.checkout_group_id = ANY($1)
     ORDER BY o.id`,
    [groupIds]
  );

  const { rows: reassignRows } = await pool.query(
    `SELECT h.*, vp.business_name AS proposed_vendor_name
     FROM order_assignment_history h
     LEFT JOIN vendor_profiles vp ON vp.id = h.to_vendor_id
     WHERE h.checkout_group_id = ANY($1)
     ORDER BY h.created_at DESC`,
    [groupIds]
  );

  const ordersByGroup = new Map();
  for (const row of orderRows) {
    // A status with no history row predates Sprint 2's timeline, so fall back to
    // when the order was last touched rather than reporting it as brand new.
    const since = row.status_since ?? row.updated_at ?? row.created_at;
    const minutesInStatus = minutesSince(since);
    const target = SLA_MINUTES[row.status] ?? null;

    const order = {
      id: row.id,
      vendorId: row.vendor_id,
      vendorName: row.vendor_name,
      status: row.status,
      totalCents: row.total_cents,
      deliveryPartnerName: row.delivery_partner_name,
      estimatedDeliveryAt: row.estimated_delivery_at,
      statusSince: since,
      minutesInStatus,
      slaMinutes: target,
      isLate: target != null && OPEN_STATUSES.includes(row.status) && minutesInStatus > target,
    };

    if (!ordersByGroup.has(row.checkout_group_id)) ordersByGroup.set(row.checkout_group_id, []);
    ordersByGroup.get(row.checkout_group_id).push(order);
  }

  const reassignByGroup = new Map();
  for (const row of reassignRows) {
    if (!reassignByGroup.has(row.checkout_group_id)) reassignByGroup.set(row.checkout_group_id, []);
    reassignByGroup.get(row.checkout_group_id).push({
      id: row.id,
      status: row.status,
      reason: row.reason,
      proposedVendorName: row.proposed_vendor_name,
      originalTotalCents: row.original_total_cents,
      proposedTotalCents: row.proposed_total_cents,
      createdAt: row.created_at,
    });
  }

  let items = groups.map((g) => {
    const orders = ordersByGroup.get(g.id) ?? [];
    const reassignments = reassignByGroup.get(g.id) ?? [];
    return {
      id: g.id,
      reference: g.reference,
      customerName: g.customer_name,
      customerPhone: g.customer_phone,
      derivedStatus: deriveGroupStatus(orders.map((o) => o.status)),
      totalCents: g.total_cents,
      paymentMethod: g.payment_method,
      paymentStatus: g.payment_status,
      deliveryMethod: g.delivery_method,
      createdAt: g.created_at,
      ageMinutes: minutesSince(g.created_at),
      orders,
      reassignments,
      exceptions: exceptionsFor(g, orders, reassignments),
    };
  });

  // Filtered after assembly because exceptions are derived, not stored — there
  // is nothing in SQL to filter on.
  if (exceptionsOnly === 'true') {
    items = items.filter((g) => g.exceptions.length > 0);
  }

  res.json({ items, total: countRows[0].total, page, pageSize });
}

/** The headline counters above the board. */
async function getSummary(req, res) {
  const { rows: statusRows } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status`
  );
  const byStatus = {};
  for (const row of statusRows) byStatus[row.status] = row.n;

  // One query per SLA bucket would be four round trips; a single pass with
  // FILTER gives the same answer once.
  const { rows: lateRows } = await pool.query(
    `SELECT COUNT(*)::int AS late
     FROM orders o
     LEFT JOIN LATERAL (
       SELECT MAX(h.created_at) AS since FROM order_status_history h
       WHERE h.order_id = o.id AND h.to_status = o.status
     ) s ON true
     WHERE o.status IN ('pending', 'confirmed', 'packed', 'out_for_delivery')
       AND COALESCE(s.since, o.updated_at, o.created_at) <
           now() - (CASE o.status
                      WHEN 'pending' THEN interval '30 minutes'
                      WHEN 'confirmed' THEN interval '120 minutes'
                      WHEN 'packed' THEN interval '180 minutes'
                      ELSE interval '240 minutes'
                    END)`
  );

  const { rows: awaiting } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM order_assignment_history WHERE status = 'pending_customer'`
  );

  const { rows: payment } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE payment_status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE payment_status = 'pending' AND payment_method <> 'cod')::int AS incomplete
     FROM checkout_groups`
  );

  res.json({
    openOrders: OPEN_STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0),
    byStatus,
    lateOrders: lateRows[0].late,
    awaitingCustomer: awaiting[0].n,
    paymentFailed: payment[0].failed,
    paymentIncomplete: payment[0].incomplete,
    slaMinutes: SLA_MINUTES,
  });
}

module.exports = { listGroups, getSummary };
