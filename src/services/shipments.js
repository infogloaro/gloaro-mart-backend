/**
 * Shipments follow orders, and scans move orders (schema SHIPMENTS, PHASE 37).
 *
 * Every function takes the caller's transaction client, so a shipment can never
 * disagree with the order change that caused it.
 */

const OPEN = ['created', 'picked_up', 'in_transit', 'out_for_delivery'];
const CLOSED = ['delivered', 'failed', 'returned', 'cancelled'];
// How far along a shipment still on the road is; scans may not go backwards.
const RANK = { created: 0, picked_up: 1, in_transit: 2, out_for_delivery: 3 };

async function nextTrackingNumber(client) {
  const { rows } = await client.query("SELECT nextval('shipment_tracking_seq') AS n");
  return `GMS-${new Date().getFullYear()}-${String(rows[0].n).padStart(6, '0')}`;
}

async function addEvent(client, shipmentId, { status, description = null, location = null, actorRole = 'system', userId = null }) {
  await client.query(
    `INSERT INTO shipment_events (shipment_id, status, description, location, actor_role, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [shipmentId, status, description, location, actorRole, userId]
  );
}

async function openShipmentFor(client, orderId) {
  const { rows } = await client.query(
    `SELECT * FROM shipments WHERE order_id = $1 AND status = ANY($2) FOR UPDATE`,
    [orderId, OPEN]
  );
  return rows[0] ?? null;
}

/** Cash to collect at the door: the order total when it was COD, else none. */
async function codAmountFor(client, order) {
  const { rows } = await client.query('SELECT method FROM payments WHERE checkout_group_id = $1', [order.checkout_group_id]);
  return (rows[0]?.method ?? 'cod') === 'cod' ? order.total_cents : null;
}

/**
 * DR3: the partner checkout chose rides on the shipment. A courier shipment
 * still has to be booked with the courier (DR4); a re-attempt keeps the
 * previous shipment's partner and its booking.
 */
function providerFor(order, previous) {
  const provider = previous ? previous.provider ?? null : order.fulfilment_partner ?? null;
  if (previous?.booking_status === 'booked') return { provider, bookingStatus: 'booked' };
  return { provider, bookingStatus: provider === 'shiprocket' ? 'needs_booking' : 'not_needed' };
}

async function createShipment(client, order, { attempt = 1, previous = null, actorRole = 'system', userId = null, description }) {
  const { provider, bookingStatus } = providerFor(order, previous);
  const { rows } = await client.query(
    `INSERT INTO shipments (tracking_number, order_id, vendor_id, partner_name, partner_phone, external_tracking_id,
       tracking_url, package_count, weight_grams, cod_amount_cents, estimated_delivery_at, attempt_count, previous_shipment_id,
       provider, booking_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [
      attempt > 1 && previous ? `${previous.tracking_number.replace(/-A\d+$/, '')}-A${attempt}` : await nextTrackingNumber(client),
      order.id,
      order.vendor_id,
      previous?.partner_name ?? order.delivery_partner_name ?? null,
      previous?.partner_phone ?? order.delivery_partner_phone ?? null,
      previous?.external_tracking_id ?? null,
      previous?.tracking_url ?? null,
      previous?.package_count ?? 1,
      previous?.weight_grams ?? null,
      await codAmountFor(client, order),
      order.estimated_delivery_at ?? null,
      attempt,
      previous?.id ?? null,
      provider,
      bookingStatus,
    ]
  );
  await addEvent(client, rows[0].id, { status: 'created', description, actorRole, userId });
  return rows[0];
}

/** Moves a shipment to `status` with its event, stamping the times that status implies. */
async function setStatus(client, shipment, status, { description = null, location = null, actorRole, userId }) {
  const { rows } = await client.query(
    `UPDATE shipments SET status = $2::varchar,
       dispatched_at = CASE WHEN $2::varchar IN ('picked_up', 'in_transit', 'out_for_delivery') THEN COALESCE(dispatched_at, now()) ELSE dispatched_at END,
       delivered_at = CASE WHEN $2::varchar = 'delivered' THEN now() ELSE delivered_at END,
       failure_reason = CASE WHEN $2::varchar IN ('failed', 'returned') THEN $3::text ELSE failure_reason END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [shipment.id, status, description]
  );
  await addEvent(client, shipment.id, { status, description, location, actorRole, userId });
  return rows[0];
}

/**
 * The order changed status (vendor, admin or a cancellation): bring its
 * shipment along. `order` is the row after the change.
 */
async function onOrderStatusChanged(client, order, toStatus, { actorRole = 'system', userId = null } = {}) {
  let open = await openShipmentFor(client, order.id);

  // The courier details live on the order today; keep the open shipment's copy current.
  if (open && (order.delivery_partner_name || order.delivery_partner_phone || order.estimated_delivery_at)) {
    const { rows } = await client.query(
      `UPDATE shipments SET partner_name = COALESCE($2, partner_name), partner_phone = COALESCE($3, partner_phone),
         estimated_delivery_at = COALESCE($4, estimated_delivery_at), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [open.id, order.delivery_partner_name, order.delivery_partner_phone, order.estimated_delivery_at]
    );
    open = rows[0];
  }

  const by = { actorRole, userId };
  if (toStatus === 'packed' && !open) {
    await createShipment(client, order, { ...by, description: 'Packed and ready for pickup' });
  } else if (toStatus === 'out_for_delivery') {
    open ??= await createShipment(client, order, { ...by, description: 'Shipment opened at dispatch' });
    if (RANK[open.status] < RANK.out_for_delivery) await setStatus(client, open, 'out_for_delivery', by);
  } else if (toStatus === 'delivered') {
    open ??= await createShipment(client, order, { ...by, description: 'Shipment opened at delivery' });
    await setStatus(client, open, 'delivered', by);
  } else if (toStatus === 'cancelled' && open) {
    await setStatus(client, open, 'cancelled', { ...by, description: 'The order was cancelled' });
  }
}

module.exports = { OPEN, CLOSED, RANK, providerFor, addEvent, openShipmentFor, createShipment, setStatus, onOrderStatusChanged };
