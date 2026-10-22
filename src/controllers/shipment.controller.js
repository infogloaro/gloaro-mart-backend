const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const shipments = require('../services/shipments');
const cancellations = require('../services/cancellations');
const { bumpMetrics, metricsForTransition } = require('../services/matching');

/**
 * Admin → Shipments, plus the customer's tracking view. The rules for how
 * shipments follow orders are in services/shipments.js; this is where staff
 * record scans, and where a scan moves the order on.
 */

const MODULE = 'orders';
const PAGE_SIZE = 25;
const RECORDABLE = ['picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled'];

const SELECT = `
  SELECT s.*, o.status AS order_status, o.user_id AS customer_id,
         COALESCE(cg.reference, '#' || o.id) AS order_reference,
         vp.business_name AS vendor_name,
         COALESCE(u.full_name, u.email) AS customer_name,
         COALESCE(o.delivery_address_snapshot->>'mobile_number', u.phone_number) AS customer_phone,
         o.delivery_address_snapshot->>'city' AS delivery_city
  FROM shipments s
  JOIN orders o ON o.id = s.order_id
  JOIN vendor_profiles vp ON vp.id = s.vendor_id
  JOIN users u ON u.id = o.user_id
  LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id`;

function toJson(s) {
  return {
    id: s.id,
    trackingNumber: s.tracking_number,
    orderId: s.order_id,
    orderReference: s.order_reference,
    vendorId: s.vendor_id,
    vendorName: s.vendor_name,
    customerName: s.customer_name,
    customerPhone: s.customer_phone,
    deliveryCity: s.delivery_city,
    status: s.status,
    // A registered partner, or only a free-text name (set on the order before partners existed).
    partnerId: s.partner_id,
    partnerName: s.partner_name,
    partnerPhone: s.partner_phone,
    externalTrackingId: s.external_tracking_id,
    trackingUrl: s.tracking_url,
    packageCount: s.package_count,
    weightGrams: s.weight_grams,
    codAmountCents: s.cod_amount_cents,
    dispatchedAt: s.dispatched_at,
    estimatedDeliveryAt: s.estimated_delivery_at,
    deliveredAt: s.delivered_at,
    attemptCount: s.attempt_count,
    failureReason: s.failure_reason,
    createdAt: s.created_at,
  };
}

async function eventsFor(shipmentId) {
  const { rows } = await pool.query(
    `SELECT e.*, u.full_name AS actor_name FROM shipment_events e LEFT JOIN users u ON u.id = e.actor_user_id
     WHERE e.shipment_id = $1 ORDER BY e.occurred_at DESC, e.id DESC`,
    [shipmentId]
  );
  return rows.map((e) => ({
    id: e.id,
    status: e.status,
    description: e.description,
    location: e.location,
    actorRole: e.actor_role,
    actorName: e.actor_name,
    occurredAt: e.occurred_at,
  }));
}

async function loadDetail(id) {
  const { rows } = await pool.query(`${SELECT} WHERE s.id = $1`, [Number(id)]);
  if (!rows[0]) return null;
  return { ...toJson(rows[0]), events: await eventsFor(rows[0].id) };
}

const STATUS_FILTERS = {
  in_transit: "s.status IN ('created', 'picked_up', 'in_transit')",
  out_for_delivery: "s.status = 'out_for_delivery'",
  delivered: "s.status = 'delivered'",
  failed: "s.status IN ('failed', 'returned')",
};

async function listShipments(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const conditions = [];
  const params = [];
  if (req.query.status) {
    if (!STATUS_FILTERS[req.query.status]) return res.status(400).json({ message: 'Unknown status' });
    conditions.push(STATUS_FILTERS[req.query.status]);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(s.tracking_number ILIKE ${p} OR s.external_tracking_id ILIKE ${p} OR cg.reference ILIKE ${p} OR ('#' || o.id) ILIKE ${p}
        OR u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR vp.business_name ILIKE ${p})`
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM shipments s JOIN orders o ON o.id = s.order_id
       JOIN vendor_profiles vp ON vp.id = s.vendor_id JOIN users u ON u.id = o.user_id
       LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id ${where}`,
      params
    ),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

async function shipmentSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status IN ('created', 'picked_up', 'in_transit'))::int AS in_transit,
       COUNT(*) FILTER (WHERE status = 'out_for_delivery')::int AS out_for_delivery,
       COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
       -- A failure only counts while its order is still waiting on the next attempt.
       COUNT(*) FILTER (WHERE status = 'failed' AND EXISTS (
         SELECT 1 FROM shipments n WHERE n.previous_shipment_id = shipments.id AND n.status IN ('created', 'picked_up', 'in_transit', 'out_for_delivery')))::int AS failed,
       COUNT(*) FILTER (WHERE status IN ('created', 'picked_up', 'in_transit', 'out_for_delivery') AND estimated_delivery_at < now())::int AS late,
       COUNT(*) FILTER (WHERE status IN ('created', 'picked_up', 'in_transit', 'out_for_delivery') AND partner_name IS NULL)::int AS unassigned,
       AVG(EXTRACT(EPOCH FROM (delivered_at - dispatched_at)) / 3600)
         FILTER (WHERE status = 'delivered' AND dispatched_at IS NOT NULL AND delivered_at > dispatched_at)::float AS avg_hours
     FROM shipments`
  );
  const s = rows[0];
  res.json({
    total: s.total,
    inTransit: s.in_transit,
    outForDelivery: s.out_for_delivery,
    delivered: s.delivered,
    failed: s.failed,
    late: s.late,
    unassigned: s.unassigned,
    avgDeliveryHours: s.avg_hours,
  });
}

async function getShipment(req, res) {
  const detail = await loadDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'Shipment not found' });
  res.json(detail);
}

/** Moves the order with its history row and the vendor's metrics, inside the caller's transaction. */
async function moveOrder(client, order, toStatus, userId, note) {
  const { rows } = await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [order.id, toStatus]);
  await client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, actor_role, note)
     VALUES ($1, $2, $3, $4, 'admin', $5)`,
    [order.id, order.status, toStatus, userId, note]
  );
  const deltas = metricsForTransition(order.status, toStatus, (Date.now() - new Date(order.created_at).getTime()) / 60000);
  if (deltas) await bumpMetrics(client, order.vendor_id, deltas);
  return rows[0];
}

/**
 * Adds a scan to the trail. Forward only while it's on the road (a repeat
 * in-transit scan at another hub is fine). Out for delivery and delivered move
 * the order too; a failure opens the next attempt; a return cancels the order.
 */
async function recordEvent(req, res) {
  const { status } = req.body || {};
  const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 500) || null : null;
  const location = typeof req.body?.location === 'string' ? req.body.location.trim().slice(0, 120) || null : null;
  if (!RECORDABLE.includes(status)) return res.status(400).json({ message: `status must be one of ${RECORDABLE.join(', ')}` });
  if (['failed', 'returned'].includes(status) && !description) {
    return res.status(400).json({ message: 'Say why — the next attempt or the shop depends on it.' });
  }

  const by = { actorRole: 'admin', userId: req.user.id };
  let order;
  let movedTo = null;
  let retry = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [req.params.id]);
    const shipment = rows[0];
    if (!shipment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Shipment not found' });
    }
    if (!shipments.OPEN.includes(shipment.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This shipment is ${shipment.status.replace(/_/g, ' ')} and closed.` });
    }
    const target = shipments.RANK[status];
    if (target != null && target < shipments.RANK[shipment.status]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `It is already ${shipment.status.replace(/_/g, ' ')} — scans can't go backwards.` });
    }
    const { rows: orderRows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [shipment.order_id]);
    order = orderRows[0];
    if (['delivered', 'out_for_delivery'].includes(status) && order.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The order was cancelled — record the parcel as returned or cancelled instead.' });
    }

    await shipments.setStatus(client, shipment, status, { description, location, ...by });

    if (status === 'out_for_delivery' && ['confirmed', 'packed'].includes(order.status)) {
      order = await moveOrder(client, order, 'out_for_delivery', req.user.id, `Shipment ${shipment.tracking_number} out for delivery`);
      movedTo = 'out_for_delivery';
    }
    if (status === 'delivered' && !['delivered', 'cancelled'].includes(order.status)) {
      order = await moveOrder(client, order, 'delivered', req.user.id, `Shipment ${shipment.tracking_number} delivered`);
      movedTo = 'delivered';
    }
    if (status === 'failed' && order.status !== 'cancelled') {
      retry = await shipments.createShipment(client, order, {
        attempt: shipment.attempt_count + 1,
        previous: shipment,
        ...by,
        description: `Attempt ${shipment.attempt_count + 1} after a failed delivery: ${description}`,
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // After the commit, the same follow-ups the order paths run.
  if (movedTo === 'delivered') {
    const { creditWalletForOrder } = require('./wallet.controller');
    const { settleCodForOrder } = require('./payment.controller');
    await creditWalletForOrder(order);
    await require('../services/invoices').issueAfterDelivery(order.id);
    await settleCodForOrder(order.id);
    await require('../services/rewards').creditForOrder(order.id);
  }
  if (status === 'returned' && !['cancelled', 'delivered'].includes(order.status)) {
    await cancellations.adminCancel({
      orderId: order.id,
      userId: req.user.id,
      body: { reasonCode: 'customer_unreachable', note: `Returned to the shop: ${description}` },
    });
  }
  await recordAudit({
    actorUserId: req.user.id,
    action: `shipment.${status}`,
    module: MODULE,
    entityType: 'shipment',
    entityId: req.params.id,
    newValue: { description, location, orderMovedTo: movedTo, retryShipmentId: retry?.id ?? null },
  });
  res.status(201).json({ ...(await loadDetail(req.params.id)), nextAttemptId: retry?.id ?? null });
}

/** Courier details, parcels and weight on a shipment still on the road. */
async function updateShipment(req, res) {
  const b = req.body || {};
  const fields = {
    partnerName: 'partner_name',
    partnerPhone: 'partner_phone',
    externalTrackingId: 'external_tracking_id',
    trackingUrl: 'tracking_url',
    packageCount: 'package_count',
    weightGrams: 'weight_grams',
    estimatedDeliveryAt: 'estimated_delivery_at',
  };
  const sets = [];
  const params = [Number(req.params.id)];
  for (const [key, column] of Object.entries(fields)) {
    if (!(key in b)) continue;
    let value = b[key];
    if (['packageCount', 'weightGrams'].includes(key) && value !== null && !(Number.isInteger(value) && value > 0)) {
      return res.status(400).json({ message: `${key} must be a positive whole number` });
    }
    if (key === 'packageCount' && value === null) return res.status(400).json({ message: 'packageCount is required' });
    if (key === 'trackingUrl' && value && !/^https:\/\//.test(value)) return res.status(400).json({ message: 'trackingUrl must start with https://' });
    if (key === 'estimatedDeliveryAt' && value && Number.isNaN(Date.parse(value))) return res.status(400).json({ message: 'estimatedDeliveryAt must be a date' });
    if (typeof value === 'string') value = value.trim() || null;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to change' });
  const { rows } = await pool.query(
    `UPDATE shipments SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $1 AND status IN ('created', 'picked_up', 'in_transit', 'out_for_delivery') RETURNING id`,
    params
  );
  if (!rows[0]) return res.status(409).json({ message: 'Only a shipment still on the road can be changed.' });
  await recordAudit({ actorUserId: req.user.id, action: 'shipment.updated', module: MODULE, entityType: 'shipment', entityId: rows[0].id, newValue: b });
  res.json(await loadDetail(rows[0].id));
}

/**
 * Gives an open shipment to a delivery partner (or takes it off them with
 * partnerId null). The partner must be active, online, with paperwork in date
 * and capacity left; the order's courier fields follow so the customer sees who.
 */
async function assignPartner(req, res) {
  const partnerId = req.body?.partnerId ?? null;
  if (partnerId !== null && !Number.isInteger(partnerId)) return res.status(400).json({ message: 'partnerId must be a partner id or null' });
  const { canTakeWork } = require('./deliveryPartner.controller');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [req.params.id]);
    const shipment = rows[0];
    if (!shipment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Shipment not found' });
    }
    if (!shipments.OPEN.includes(shipment.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Only a shipment still on the road can be assigned.' });
    }
    if (partnerId === shipment.partner_id) {
      await client.query('ROLLBACK');
      return res.json(await loadDetail(shipment.id));
    }
    let partner = null;
    if (partnerId !== null) {
      // Locks the partner so two assignments can't both take the last slot.
      await client.query('SELECT id FROM delivery_partners WHERE id = $1 FOR UPDATE', [partnerId]);
      const check = await canTakeWork(client, partnerId);
      if (!check.ok) {
        await client.query('ROLLBACK');
        return res.status(check.partner ? 409 : 404).json({ message: check.message });
      }
      partner = check.partner;
    }
    await client.query(
      `UPDATE shipments SET partner_id = $2, partner_name = $3, partner_phone = $4, assigned_at = $5, updated_at = now() WHERE id = $1`,
      [shipment.id, partner?.id ?? null, partner?.name ?? null, partner?.phone ?? null, partner ? new Date() : null]
    );
    await client.query(
      'UPDATE orders SET delivery_partner_name = $2, delivery_partner_phone = $3, updated_at = now() WHERE id = $1',
      [shipment.order_id, partner?.name ?? null, partner?.phone ?? null]
    );
    await shipments.addEvent(client, shipment.id, {
      status: shipment.status,
      description: partner ? `Assigned to ${partner.name}` : `Taken off ${shipment.partner_name ?? 'the partner'}`,
      actorRole: 'admin',
      userId: req.user.id,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await recordAudit({ actorUserId: req.user.id, action: 'shipment.assigned', module: MODULE, entityType: 'shipment', entityId: req.params.id, newValue: { partnerId } });
  res.json(await loadDetail(req.params.id));
}

/** The customer's view of their order's parcels, newest attempt first. No internal names. */
async function listForOrder(req, res) {
  const { rows: orderRows } = await pool.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!orderRows[0]) return res.status(404).json({ message: 'Order not found' });
  const { rows } = await pool.query('SELECT * FROM shipments WHERE order_id = $1 ORDER BY created_at DESC, id DESC', [req.params.id]);
  const out = [];
  for (const s of rows) {
    const { rows: events } = await pool.query(
      'SELECT status, description, location, occurred_at FROM shipment_events WHERE shipment_id = $1 ORDER BY occurred_at DESC, id DESC',
      [s.id]
    );
    out.push({
      tracking_number: s.tracking_number,
      status: s.status,
      attempt: s.attempt_count,
      partner_name: s.partner_name,
      partner_phone: s.status === 'out_for_delivery' ? s.partner_phone : null,
      courier_tracking_url: s.tracking_url,
      cod_amount_cents: s.cod_amount_cents,
      estimated_delivery_at: s.estimated_delivery_at,
      delivered_at: s.delivered_at,
      failure_reason: s.failure_reason,
      events,
    });
  }
  res.json({ shipments: out });
}

module.exports = { listShipments, shipmentSummary, getShipment, recordEvent, updateShipment, assignPartner, listForOrder };
