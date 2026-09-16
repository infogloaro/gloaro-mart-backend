/**
 * The stock engine.
 *
 * Contracts per documents/SPRINT_4_CATALOGUE_INVENTORY_SPEC.md §4.
 *
 * One rule holds this together: the three counters on an inventory row are
 * never set directly. Every change goes through applyMovement, which writes the
 * movement that explains it in the same statement pair, so the log and the
 * totals cannot disagree — `SUM(delta_available)` over a row's movements always
 * equals its `available_qty`.
 *
 * A reservation moves units from available to reserved, not out of existence:
 *
 *   reserve   available -= q, reserved += q     (checkout, under a row lock)
 *   confirm   reserved  -= q, sold     += q     (COD placed, or payment captured)
 *   release   reserved  -= q, available += q    (payment failed, or cancelled)
 *
 * Every function here takes a client rather than the pool. Reserving in one
 * transaction and creating the order in another is how a customer ends up
 * holding stock for an order that was rolled back.
 */
const pool = require('../config/db');

const HOLD_MINUTES = 30;

/** The key an inventory row is looked up by. A simple product has no variant. */
function stockKey(productId, variantId) {
  return `${productId}:${variantId ?? ''}`;
}

/**
 * Mirrors the variant and media truth back onto the product row.
 *
 * price_cents, stock_quantity and image_url are what every app build already in
 * the field reads. Once variants and media exist they stop being authored and
 * become derived: the lowest active variant price, the summed stock, the
 * primary image. COALESCE is what keeps a simple product's own values intact —
 * no variants means nothing to derive from, so nothing is overwritten.
 */
async function refreshProductMirrors(client, productId) {
  await client.query(
    `UPDATE products p SET
       price_cents = COALESCE(
         (SELECT MIN(price_cents) FROM product_variants
          WHERE product_id = p.id AND is_active = true),
         p.price_cents),
       stock_quantity = COALESCE(
         (SELECT SUM(available_qty)::int FROM inventory WHERE product_id = p.id),
         p.stock_quantity),
       image_url = COALESCE(
         (SELECT url FROM product_media
          WHERE product_id = p.id AND is_primary LIMIT 1),
         p.image_url),
       updated_at = now()
     WHERE p.id = $1`,
    [productId]
  );
}

/**
 * Applies a counter change and writes the movement explaining it.
 *
 * The UPDATE carries the CHECK constraints' conditions in its WHERE clause, so
 * an over-release returns no row and throws here rather than aborting the whole
 * transaction with a constraint violation further down.
 */
async function applyMovement(client, {
  inventoryId,
  deltaAvailable = 0,
  deltaReserved = 0,
  deltaSold = 0,
  reason,
  orderId = null,
  actorRole = 'system',
  userId = null,
  note = null,
}) {
  const { rows } = await client.query(
    `UPDATE inventory SET
       available_qty = available_qty + $2,
       reserved_qty  = reserved_qty  + $3,
       sold_qty      = sold_qty      + $4,
       updated_at = now()
     WHERE id = $1
       AND available_qty + $2 >= 0
       AND reserved_qty  + $3 >= 0
       AND sold_qty      + $4 >= 0
     RETURNING *`,
    [inventoryId, deltaAvailable, deltaReserved, deltaSold]
  );
  const row = rows[0];
  if (!row) {
    const err = new Error('That stock movement would take a counter below zero.');
    err.status = 409;
    throw err;
  }

  await client.query(
    `INSERT INTO inventory_movements
       (inventory_id, delta_available, delta_reserved, delta_sold, reason, order_id,
        actor_role, changed_by_user_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [inventoryId, deltaAvailable, deltaReserved, deltaSold, reason, orderId, actorRole, userId, note]
  );

  await refreshProductMirrors(client, row.product_id);
  return row;
}

/**
 * The stock row for a sellable thing, created if this is the first time anyone
 * has asked. A product that predates Sprint 4 was backfilled a row by the
 * migration; a variant created afterwards gets one here.
 */
async function ensureInventoryRow(client, { productId, variantId = null, vendorId }) {
  const { rows } = await client.query(
    `SELECT * FROM inventory
     WHERE product_id = $1 AND variant_id IS NOT DISTINCT FROM $2`,
    [productId, variantId]
  );
  if (rows[0]) return rows[0];

  const { rows: created } = await client.query(
    `INSERT INTO inventory (product_id, variant_id, vendor_id) VALUES ($1, $2, $3) RETURNING *`,
    [productId, variantId, vendorId]
  );
  return created[0];
}

/**
 * Points a simple product's stock at a target figure.
 *
 * This is what the pre-Sprint-4 `stockQuantity` field on the product endpoints
 * now means. The column itself is a mirror, so writing it directly would be
 * overwritten by the next refresh and would leave no movement explaining the
 * change; the difference is applied to the stock row instead.
 *
 * Refuses on a product that sells by variant, where a single figure has no
 * meaning — that stock belongs to a variant and is adjusted there.
 */
async function setSimpleStock(client, { productId, vendorId, targetQty, actorRole = 'vendor', userId = null, note = null }) {
  const { rows: variants } = await client.query(
    'SELECT COUNT(*)::int AS n FROM product_variants WHERE product_id = $1',
    [productId]
  );
  if (variants[0].n > 0) {
    const err = new Error('This product sells by variant — set the stock on the variant instead.');
    err.status = 400;
    throw err;
  }

  const row = await ensureInventoryRow(client, { productId, variantId: null, vendorId });
  const { rows: locked } = await client.query('SELECT * FROM inventory WHERE id = $1 FOR UPDATE', [row.id]);
  const delta = targetQty - locked[0].available_qty;
  if (delta === 0) return locked[0];

  return applyMovement(client, {
    inventoryId: row.id,
    deltaAvailable: delta,
    reason: delta > 0 ? 'restocked' : 'adjusted',
    actorRole,
    userId,
    note: note ?? `Stock set to ${targetQty}`,
  });
}

/**
 * Locks every stock row a checkout will touch, in id order.
 *
 * Two things are happening here. The lock is what makes the availability check
 * below meaningful — without it two simultaneous checkouts both read the last
 * unit and both pass. The id ordering is what stops those two checkouts
 * deadlocking when they share items across different vendors: everyone grabs
 * the same rows in the same sequence, so one always waits rather than both
 * holding half of what the other needs.
 *
 * Taken once for the whole cart before any order is written, because a lock
 * acquired per vendor order would reintroduce exactly that ordering problem.
 */
async function lockStockForLines(client, lines) {
  if (lines.length === 0) return new Map();

  const productIds = lines.map((l) => l.productId);
  const variantIds = lines.map((l) => l.variantId ?? null).filter((v) => v !== null);

  const { rows } = await client.query(
    `SELECT * FROM inventory
     WHERE (variant_id IS NULL AND product_id = ANY($1))
        OR (variant_id = ANY($2))
     ORDER BY id
     FOR UPDATE`,
    [productIds, variantIds]
  );

  const byKey = new Map();
  for (const row of rows) byKey.set(stockKey(row.product_id, row.variant_id), row);
  return byKey;
}

/**
 * Holds stock for one vendor order.
 *
 * Insufficient stock throws rather than skipping the line: a partially reserved
 * basket is worse than none, and the caller runs inside the checkout
 * transaction, so the throw un-reserves everything already held.
 */
async function reserveForOrder(client, { stock, lines, orderId, groupId, userId = null }) {
  for (const line of lines) {
    const row = stock.get(stockKey(line.productId, line.variantId));
    if (!row) {
      const err = new Error(`${line.name} is no longer stocked.`);
      err.status = 409;
      throw err;
    }

    // Guarded in the WHERE rather than checked in JS: the same inventory row can
    // appear on two lines of one cart, and only the database knows what is left
    // after the first of them.
    const { rows: updated } = await client.query(
      `UPDATE inventory SET
         available_qty = available_qty - $2,
         reserved_qty  = reserved_qty  + $2,
         updated_at = now()
       WHERE id = $1 AND available_qty >= $2
       RETURNING available_qty`,
      [row.id, line.quantity]
    );
    if (!updated[0]) {
      const err = new Error(`${line.name} does not have enough stock left.`);
      err.status = 409;
      throw err;
    }

    await client.query(
      `INSERT INTO inventory_movements
         (inventory_id, delta_available, delta_reserved, reason, order_id, actor_role, changed_by_user_id, note)
       VALUES ($1, $2, $3, 'reserved', $4, 'customer', $5, $6)`,
      [row.id, -line.quantity, line.quantity, orderId, userId, `Held for order ${orderId}`]
    );
    await client.query(
      `INSERT INTO inventory_reservations
         (inventory_id, order_id, checkout_group_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, $4, 'held', now() + ($5 || ' minutes')::interval)`,
      [row.id, orderId, groupId, line.quantity, String(HOLD_MINUTES)]
    );
    await refreshProductMirrors(client, row.product_id);
  }
}

/**
 * Turns held stock into sold stock.
 *
 * Idempotent by construction: it only ever sees reservations still marked
 * 'held', so a replayed webhook or a second delivery event finds nothing to do.
 */
async function confirmReservations(client, { orderId = null, groupId = null, userId = null, note = null }) {
  const { rows } = await client.query(
    `SELECT * FROM inventory_reservations
     WHERE status = 'held'
       AND ($1::int IS NULL OR order_id = $1)
       AND ($2::int IS NULL OR checkout_group_id = $2)
     ORDER BY inventory_id
     FOR UPDATE`,
    [orderId, groupId]
  );

  for (const reservation of rows) {
    await applyMovement(client, {
      inventoryId: reservation.inventory_id,
      deltaReserved: -reservation.quantity,
      deltaSold: reservation.quantity,
      reason: 'sold',
      orderId: reservation.order_id,
      note: note ?? 'Sale committed',
    });
    await client.query(
      `UPDATE inventory_reservations SET status = 'confirmed', updated_at = now() WHERE id = $1`,
      [reservation.id]
    );
  }
  return rows.length;
}

/**
 * Puts stock back.
 *
 * Handles both halves of rule 3: units still held go back from reserved, units
 * already confirmed go back from sold. A cancellation after delivery-time
 * confirmation must return the stock just as a cancellation before it does.
 */
async function releaseReservations(client, { orderId = null, groupId = null, userId = null, note = null }) {
  const { rows } = await client.query(
    `SELECT * FROM inventory_reservations
     WHERE status IN ('held', 'confirmed')
       AND ($1::int IS NULL OR order_id = $1)
       AND ($2::int IS NULL OR checkout_group_id = $2)
     ORDER BY inventory_id
     FOR UPDATE`,
    [orderId, groupId]
  );

  for (const reservation of rows) {
    const fromHeld = reservation.status === 'held';
    await applyMovement(client, {
      inventoryId: reservation.inventory_id,
      deltaAvailable: reservation.quantity,
      deltaReserved: fromHeld ? -reservation.quantity : 0,
      deltaSold: fromHeld ? 0 : -reservation.quantity,
      reason: 'released',
      orderId: reservation.order_id,
      userId,
      note: note ?? (fromHeld ? 'Hold released' : 'Sale reversed'),
    });
    await client.query(
      `UPDATE inventory_reservations SET status = 'released', updated_at = now() WHERE id = $1`,
      [reservation.id]
    );
  }
  return rows.length;
}

/**
 * Releases holds that have died of old age.
 *
 * An online order that is never paid would otherwise hold its stock forever.
 * Sprint 4 gave reservations an expires_at; nothing read it while every order
 * was COD and confirmed on the spot.
 *
 * Runs opportunistically at checkout — the moment the answer matters — rather
 * than on a scheduler this project does not have. It runs *before* the new
 * checkout takes its locks, so a customer is never refused stock that a dead
 * hold was sitting on.
 *
 * The order that owned the hold is cancelled with it: an order whose stock has
 * gone back on the shelf cannot still be waiting to be fulfilled.
 */
async function releaseExpiredHolds(client, { now = null } = {}) {
  const { rows: expired } = await client.query(
    `SELECT * FROM inventory_reservations
     WHERE status = 'held'
       AND expires_at IS NOT NULL
       AND expires_at < COALESCE($1::timestamptz, now())
     ORDER BY inventory_id
     FOR UPDATE SKIP LOCKED`,
    [now]
  );
  if (expired.length === 0) return { released: 0, cancelledOrders: [] };

  const orderIds = new Set();
  for (const reservation of expired) {
    await applyMovement(client, {
      inventoryId: reservation.inventory_id,
      deltaAvailable: reservation.quantity,
      deltaReserved: -reservation.quantity,
      reason: 'released',
      orderId: reservation.order_id,
      note: 'Hold expired before payment',
    });
    await client.query(
      `UPDATE inventory_reservations SET status = 'expired', updated_at = now() WHERE id = $1`,
      [reservation.id]
    );
    if (reservation.order_id) orderIds.add(reservation.order_id);
  }

  // Only orders still waiting to be paid for. One that has moved on since —
  // paid late, or already cancelled — is left exactly as it is.
  const cancelled = [];
  for (const orderId of orderIds) {
    const { rows } = await client.query(
      `UPDATE orders SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING id, vendor_id`,
      [orderId]
    );
    if (rows[0]) cancelled.push(rows[0]);
  }

  return { released: expired.length, cancelledOrders: cancelled };
}

/**
 * Confirm or release on a connection of this module's own.
 *
 * Used by callers that have already committed the thing the stock change
 * follows — an order marked delivered, say. A failure here leaves the
 * reservation as it was for the next event to pick up, rather than rolling back
 * a delivery that really happened.
 */
async function settleStockForOrder(orderId, action, { userId = null, note = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const settle = action === 'confirm' ? confirmReservations : releaseReservations;
    const count = await settle(client, { orderId, userId, note });
    await client.query('COMMIT');
    return count;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  HOLD_MINUTES,
  stockKey,
  refreshProductMirrors,
  applyMovement,
  ensureInventoryRow,
  setSimpleStock,
  lockStockForLines,
  reserveForOrder,
  confirmReservations,
  releaseReservations,
  releaseExpiredHolds,
  settleStockForOrder,
};
