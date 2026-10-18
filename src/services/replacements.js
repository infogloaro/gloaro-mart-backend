const pool = require('../config/db');
const { lockStockForLines, reserveForOrder, confirmReservations } = require('./inventory');
const { bumpMetrics } = require('./matching');

/**
 * Replacements (schema RETURNS LIFECYCLE & REPLACEMENTS, PHASE 43).
 *
 * Raised when a replacement-return is approved. Approving the replacement
 * checks stock at the shop set to fulfil it and creates a ₹0 order for the
 * customer with the stock held; another shop can be chosen when the original
 * is short. Once the order exists, the replacement's status follows it.
 */

class ReplacementError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function addEvent(db, replacementId, status, { note = null, actorRole = 'system', userId = null } = {}) {
  await db.query(
    'INSERT INTO replacement_events (replacement_id, status, note, actor_role, actor_user_id) VALUES ($1, $2, $3, $4, $5)',
    [replacementId, status, note, actorRole, userId]
  );
}

/** `orderId` becomes the deep link the app opens (/orders/<id>). */
async function notify(db, userId, title, body, orderId = null) {
  if (userId) {
    await db.query("INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'replacement', $2, $3, $4)", [
      userId,
      title,
      body,
      orderId ? `/orders/${orderId}` : null,
    ]);
  }
}

/** Creates the replacement for an approved replacement-return, inside the caller's transaction. */
async function raiseForReturn(client, ret, userId) {
  const { rows: order } = await client.query('SELECT * FROM orders WHERE id = $1', [ret.order_id]);
  const { rows: items } = await client.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [ret.order_id]);
  const value = items.reduce((s, i) => s + i.unit_price_cents * i.quantity, 0);
  const { rows: seq } = await client.query("SELECT nextval('replacement_ref_seq') AS n");
  const { rows } = await client.query(
    `INSERT INTO replacements (reference, return_id, original_order_id, vendor_id, value_cents)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (return_id) DO NOTHING RETURNING *`,
    [`RPL-${new Date().getFullYear()}-${String(seq[0].n).padStart(5, '0')}`, ret.id, ret.order_id, order[0].vendor_id, value]
  );
  if (!rows[0]) return null;
  for (const i of items) {
    await client.query(
      'INSERT INTO replacement_items (replacement_id, order_item_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4, $5)',
      [rows[0].id, i.id, i.product_id, i.quantity, i.unit_price_cents]
    );
  }
  await addEvent(client, rows[0].id, 'requested', { note: `From return RET-${String(ret.id).padStart(5, '0')}`, actorRole: 'admin', userId });
  return rows[0];
}

/** Stock on hand for each product, summed over its variants. */
async function stockFor(db, productIds) {
  const { rows } = await db.query(
    'SELECT product_id, COALESCE(SUM(available_qty), 0)::int AS qty FROM inventory WHERE product_id = ANY($1) GROUP BY product_id',
    [productIds]
  );
  return new Map(rows.map((r) => [r.product_id, r.qty]));
}

/** Lines short at the shop set to fulfil, in words. */
async function shortfall(db, replacementId) {
  const { rows: items } = await db.query(
    `SELECT ri.*, p.name FROM replacement_items ri JOIN products p ON p.id = ri.product_id WHERE ri.replacement_id = $1`,
    [replacementId]
  );
  const stock = await stockFor(db, items.map((i) => i.product_id));
  return items
    .filter((i) => (stock.get(i.product_id) ?? 0) < i.quantity)
    .map((i) => `${i.name}: need ${i.quantity}, ${stock.get(i.product_id) ?? 0} in stock`);
}

/**
 * Other shops that have every line in stock — the same item by match key,
 * active and approved. Priced at their own prices; nearest first when the
 * delivery address has coordinates.
 */
async function alternatesFor(db, replacement) {
  const { rows: items } = await db.query(
    `SELECT ri.quantity, p.match_key FROM replacement_items ri JOIN products p ON p.id = ri.product_id WHERE ri.replacement_id = $1`,
    [replacement.id]
  );
  if (!items.length) return [];
  const current = replacement.fulfil_vendor_id ?? replacement.vendor_id;
  const { rows: addr } = await db.query(
    `SELECT a.latitude, a.longitude FROM orders o LEFT JOIN addresses a ON a.id = o.address_id WHERE o.id = $1`,
    [replacement.original_order_id]
  );
  let shared = null;
  const byVendor = new Map();
  for (const it of items) {
    const { rows } = await db.query(
      `SELECT p.id, p.vendor_id, p.price_cents, v.business_name, v.latitude, v.longitude,
              COALESCE((SELECT SUM(i.available_qty) FROM inventory i WHERE i.product_id = p.id), 0)::int AS qty
       FROM products p JOIN vendor_profiles v ON v.id = p.vendor_id
       WHERE p.match_key = $1 AND p.is_active AND p.moderation_status = 'approved' AND v.status = 'approved' AND p.vendor_id <> $2`,
      [it.match_key, current]
    );
    const ok = rows.filter((r) => r.qty >= it.quantity);
    const ids = new Set(ok.map((r) => r.vendor_id));
    shared = shared === null ? ids : new Set([...shared].filter((id) => ids.has(id)));
    for (const r of ok) {
      const e = byVendor.get(r.vendor_id) ?? { vendorId: r.vendor_id, vendorName: r.business_name, lat: r.latitude, lng: r.longitude, priceCents: 0, availableQty: Infinity };
      e.priceCents += r.price_cents * it.quantity;
      e.availableQty = Math.min(e.availableQty, r.qty);
      byVendor.set(r.vendor_id, e);
    }
  }
  const lat = addr[0]?.latitude;
  const lng = addr[0]?.longitude;
  const km = (a, b) => {
    if (lat == null || lng == null || a == null || b == null) return null;
    const rad = Math.PI / 180;
    const d = Math.sin(((a - lat) * rad) / 2) ** 2 + Math.cos(lat * rad) * Math.cos(a * rad) * Math.sin(((b - lng) * rad) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(d));
  };
  return [...(shared ?? [])]
    .map((id) => byVendor.get(id))
    .map((e) => ({ vendorId: e.vendorId, vendorName: e.vendorName, availableQty: e.availableQty, distanceKm: km(e.lat, e.lng), priceCents: e.priceCents }))
    .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || a.priceCents - b.priceCents);
}

async function lockOpen(client, id) {
  const { rows } = await client.query('SELECT * FROM replacements WHERE id = $1 FOR UPDATE', [id]);
  const r = rows[0];
  if (!r) throw new ReplacementError(404, 'Replacement not found');
  if (!['requested', 'awaiting_stock'].includes(r.status)) throw new ReplacementError(409, `This replacement is already ${r.status.replace('_', ' ')}.`);
  return r;
}

/**
 * Approves: every line must be in stock at the shop fulfilling it. Short →
 * awaiting_stock with the reason. Otherwise a ₹0 order, stock held and sold.
 */
async function approve({ id, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await lockOpen(client, id);
    const { rows: items } = await client.query(
      `SELECT ri.*, oi.product_name_snapshot, oi.variant_label_snapshot,
              -- The same product keeps the variant that was ordered; another shop's equivalent has none.
              CASE WHEN ri.product_id = oi.product_id THEN oi.variant_id END AS variant_id
       FROM replacement_items ri JOIN order_items oi ON oi.id = ri.order_item_id WHERE ri.replacement_id = $1 ORDER BY ri.id`,
      [r.id]
    );
    const stockLines = items.map((i) => ({ productId: i.product_id, variantId: i.variant_id, quantity: i.quantity, name: i.product_name_snapshot }));
    // Locked first, then checked, so the stock can't go between the check and the hold.
    const stock = await lockStockForLines(client, stockLines);
    const short = await shortfall(client, r.id);
    if (short.length) {
      const reason = `Out of stock — ${short.join('; ')}`;
      await client.query(
        "UPDATE replacements SET status = 'awaiting_stock', blocked_reason = $2, updated_at = now() WHERE id = $1",
        [r.id, reason]
      );
      if (r.status !== 'awaiting_stock') await addEvent(client, r.id, 'awaiting_stock', { note: reason, actorRole: 'admin', userId });
      // Kept, not rolled back: the page should show it's blocked on stock.
      await client.query('COMMIT');
      return { blocked: `${reason}. Pick a shop that has it, or cancel for a refund.` };
    }

    const { rows: original } = await client.query('SELECT * FROM orders WHERE id = $1', [r.original_order_id]);
    const o = original[0];
    const vendorId = r.fulfil_vendor_id ?? r.vendor_id;
    const subtotal = items.reduce((s, i) => s + i.unit_price_cents * i.quantity, 0);
    const { rows: created } = await client.query(
      `INSERT INTO orders (user_id, vendor_id, status, payment_method, subtotal_cents, gst_cents, discount_cents, total_cents,
         delivery_address, address_id, delivery_address_snapshot, delivery_charge_cents, delivery_method, checkout_group_id,
         replacement_of_order_id, platform_paid_cents)
       VALUES ($1, $2, 'pending', 'cod', $3, 0, $3, 0, $4, $5, $6, 0, $7, $8, $9, $10) RETURNING *`,
      [o.user_id, vendorId, subtotal, o.delivery_address, o.address_id, o.delivery_address_snapshot, o.delivery_method,
        o.checkout_group_id, o.id, vendorId === r.vendor_id ? 0 : subtotal]
    );
    const order = created[0];
    await client.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, actor_role, note)
       VALUES ($1, NULL, 'pending', $2, 'admin', $3)`,
      [order.id, userId, `Replacement ${r.reference} for order ${o.id}`]
    );
    for (const i of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, product_name_snapshot, variant_label_snapshot,
           unit_price_cents, quantity, gst_rate_percent_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
        [order.id, i.product_id, i.variant_id, i.product_name_snapshot, i.variant_label_snapshot, i.unit_price_cents, i.quantity]
      );
    }
    await reserveForOrder(client, { stock, lines: stockLines, orderId: order.id, groupId: o.checkout_group_id, userId });
    await confirmReservations(client, { orderId: order.id, note: `Replacement ${r.reference}` });
    await bumpMetrics(client, vendorId, { ordersTotal: 1, openOrders: 1 });

    await client.query(
      `UPDATE replacements SET status = 'approved', replacement_order_id = $2, blocked_reason = NULL,
         approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1`,
      [r.id, order.id, userId]
    );
    await addEvent(client, r.id, 'order_created', { note: `Order #${order.id} placed (₹0 to the customer)`, actorRole: 'admin', userId });
    await notify(client, o.user_id, 'Your replacement is on its way', `Replacement ${r.reference} is order #${order.id}. There is nothing to pay.`, order.id);
    const { rows: shop } = await client.query('SELECT user_id FROM vendor_profiles WHERE id = $1', [vendorId]);
    await notify(client, shop[0]?.user_id, 'Replacement order to fulfil', `Order #${order.id} is a free replacement (${r.reference}). Please pack it as usual.`, order.id);
    await client.query('COMMIT');
    return { replacement: r, order };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Moves it to another shop that has every line, at that shop's prices; the difference is the platform's. */
async function reassign({ id, vendorId, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await lockOpen(client, id);
    if (!Number.isInteger(vendorId)) throw new ReplacementError(400, 'vendorId is required');
    const { rows: items } = await client.query(
      `SELECT ri.*, p.match_key, oi.product_id AS original_product_id, oi.unit_price_cents AS original_price
       FROM replacement_items ri JOIN products p ON p.id = ri.product_id JOIN order_items oi ON oi.id = ri.order_item_id
       WHERE ri.replacement_id = $1`,
      [r.id]
    );
    let value = 0;
    const updates = [];
    for (const it of items) {
      const { rows } = await client.query(
        `SELECT p.id, p.price_cents, COALESCE((SELECT SUM(i.available_qty) FROM inventory i WHERE i.product_id = p.id), 0)::int AS qty
         FROM products p JOIN vendor_profiles v ON v.id = p.vendor_id
         WHERE p.match_key = $1 AND p.vendor_id = $2 AND p.is_active AND p.moderation_status = 'approved' AND v.status = 'approved'
         ORDER BY qty DESC LIMIT 1`,
        [it.match_key, vendorId]
      );
      if (!rows[0] || rows[0].qty < it.quantity) throw new ReplacementError(409, 'That shop does not have every item in stock.');
      // Back to the original shop means its original product and price.
      const product = vendorId === r.vendor_id ? { id: it.original_product_id, price_cents: it.original_price } : rows[0];
      value += product.price_cents * it.quantity;
      updates.push([it.id, product.id, product.price_cents]);
    }
    for (const [itemId, productId, price] of updates) {
      await client.query('UPDATE replacement_items SET product_id = $2, unit_price_cents = $3 WHERE id = $1', [itemId, productId, price]);
    }
    await client.query(
      `UPDATE replacements SET fulfil_vendor_id = $2, price_difference_cents = $3, status = 'requested', blocked_reason = NULL, updated_at = now()
       WHERE id = $1`,
      [r.id, vendorId === r.vendor_id ? null : vendorId, value - r.value_cents]
    );
    const { rows: shop } = await client.query('SELECT business_name FROM vendor_profiles WHERE id = $1', [vendorId]);
    await addEvent(client, r.id, 'requested', { note: `To be fulfilled by ${shop[0]?.business_name ?? 'another shop'}`, actorRole: 'admin', userId });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancels before an order exists. The return switches to a refund of what
 * was paid, released on the Returns page once the goods are received.
 */
async function cancel({ id, reason, userId }) {
  const { addEvent: returnEvent } = require('../controllers/returns.controller');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await lockOpen(client, id);
    await client.query(
      "UPDATE replacements SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1",
      [r.id, reason]
    );
    await addEvent(client, r.id, 'cancelled', { note: reason, actorRole: 'admin', userId });
    const { rows: ret } = await client.query(
      `UPDATE order_returns rt SET resolution = 'refund', approved_refund_cents = o.total_cents, updated_at = now()
       FROM orders o WHERE rt.id = $1 AND o.id = rt.order_id RETURNING rt.*`,
      [r.return_id]
    );
    await returnEvent(client, r.return_id, ret[0].status, { note: `Replacement cancelled (${reason}) — switched to a full refund`, actorRole: 'admin', userId });
    await notify(client, ret[0].user_id, 'Replacement not possible', `${reason} You'll get a refund instead once the item is collected.`, ret[0].order_id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The status shown: stored until there's an order, then the order's. */
const STATUS_SQL = `CASE
  WHEN rp.replacement_order_id IS NULL THEN rp.status
  WHEN ro.status = 'delivered' THEN 'delivered'
  WHEN ro.status = 'cancelled' THEN 'failed'
  WHEN ro.status = 'out_for_delivery' THEN 'shipped'
  ELSE 'order_created' END`;

module.exports = { ReplacementError, STATUS_SQL, raiseForReturn, shortfall, stockFor, alternatesFor, approve, reassign, cancel };
