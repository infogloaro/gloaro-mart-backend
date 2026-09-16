const pool = require('../config/db');
const { applyMovement } = require('../services/inventory');

/**
 * The admin's view of stock.
 * Contracts per documents/SPRINT_4_CATALOGUE_INVENTORY_SPEC.md §6.
 *
 * Reads only, plus one adjustment. Reservations are never touched from here:
 * they belong to a checkout, and an admin cutting into one would leave an order
 * holding stock the ledger says was never held.
 */

function parsePaging(req, defaultPageSize = 25) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

async function listInventory(req, res) {
  const { lowStock, outOfStock, q } = req.query;
  const { page, pageSize, offset } = parsePaging(req);
  const conditions = [];
  const params = [];

  // req.vendorId is set by the ownership middleware on the vendor router and is
  // never present on the admin one. It wins over the query parameter so a
  // vendor cannot widen their own scope by asking for another vendor's id.
  const vendorId = req.vendorId ?? req.query.vendorId;
  if (vendorId) {
    params.push(Number(vendorId));
    conditions.push(`i.vendor_id = $${params.length}`);
  }
  if (outOfStock === 'true') {
    conditions.push('i.available_qty = 0');
  } else if (lowStock === 'true') {
    // At or below the threshold, but not yet gone — 'low' and 'out' are two
    // different things to act on, so the filters do not overlap.
    conditions.push('i.available_qty > 0 AND i.available_qty <= i.low_stock_threshold');
  }
  if (q) {
    params.push(`%${q}%`);
    const like = `$${params.length}`;
    conditions.push(`(p.name ILIKE ${like} OR p.sku ILIKE ${like} OR v.sku ILIKE ${like})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const joins = `JOIN products p ON p.id = i.product_id
     LEFT JOIN product_variants v ON v.id = i.variant_id
     JOIN vendor_profiles vp ON vp.id = i.vendor_id`;

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM inventory i ${joins} ${where}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT i.*, p.name AS product_name, p.sku AS product_sku, v.sku AS variant_sku,
            vp.business_name AS vendor_name,
            (SELECT string_agg(av.value, ' / ' ORDER BY a.sort_order, av.sort_order)
             FROM variant_attribute_values vav
             JOIN attribute_values av ON av.id = vav.attribute_value_id
             JOIN product_attributes a ON a.id = av.attribute_id
             WHERE vav.variant_id = i.variant_id) AS variant_label
     FROM inventory i ${joins} ${where}
     ORDER BY i.available_qty ASC, p.name ASC, i.id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );

  res.json({
    items: rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      productName: r.product_name,
      variantId: r.variant_id,
      variantLabel: r.variant_label,
      sku: r.variant_sku || r.product_sku,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      availableQty: r.available_qty,
      reservedQty: r.reserved_qty,
      soldQty: r.sold_qty,
      lowStockThreshold: r.low_stock_threshold,
      updatedAt: r.updated_at,
    })),
    total: countRows[0].total,
    page,
    pageSize,
  });
}

/**
 * Adjusts stock.
 *
 * Takes either a target (`availableQty`) or a delta (`deltaAvailable`), and
 * turns both into a delta before applying — the counters are never set, only
 * moved, so the movement log stays the whole story. A reason is mandatory for
 * the same reason: an unexplained change to a stock figure is the thing this
 * table exists to prevent.
 */
async function adjustInventory(req, res) {
  const { availableQty, deltaAvailable, reason, note, lowStockThreshold } = req.body || {};
  const hasTarget = availableQty != null;
  const hasDelta = deltaAvailable != null;

  if (hasTarget && hasDelta) {
    return res.status(400).json({ message: 'Send either availableQty or deltaAvailable, not both' });
  }
  if (hasTarget && (!Number.isInteger(availableQty) || availableQty < 0)) {
    return res.status(400).json({ message: 'availableQty must be a non-negative integer' });
  }
  if (hasDelta && !Number.isInteger(deltaAvailable)) {
    return res.status(400).json({ message: 'deltaAvailable must be an integer' });
  }
  if ((hasTarget || hasDelta) && !note) {
    return res.status(400).json({ message: 'A note is required to explain a stock change' });
  }
  if (reason && !['restocked', 'adjusted'].includes(reason)) {
    return res.status(400).json({ message: "reason must be 'restocked' or 'adjusted'" });
  }

  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM inventory WHERE id = $1 FOR UPDATE', [req.params.id]);
    row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Inventory row not found' });
    }

    if (lowStockThreshold != null) {
      if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'lowStockThreshold must be a non-negative integer' });
      }
      await client.query('UPDATE inventory SET low_stock_threshold = $2, updated_at = now() WHERE id = $1', [
        row.id,
        lowStockThreshold,
      ]);
    }

    const delta = hasTarget ? availableQty - row.available_qty : hasDelta ? deltaAvailable : 0;
    if (delta !== 0) {
      row = await applyMovement(client, {
        inventoryId: row.id,
        deltaAvailable: delta,
        reason: reason || (delta > 0 ? 'restocked' : 'adjusted'),
        // This handler serves both the admin route and the vendor one, so the
        // movement records who actually made the change rather than assuming.
        actorRole: req.user.role === 'vendor' ? 'vendor' : 'admin',
        userId: req.user.id,
        note,
      });
    }

    const { rows: fresh } = await client.query('SELECT * FROM inventory WHERE id = $1', [row.id]);
    row = fresh[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

  res.json(row);
}

async function getMovements(req, res) {
  const { page, pageSize, offset } = parsePaging(req, 50);
  const { rows: inv } = await pool.query('SELECT 1 FROM inventory WHERE id = $1', [req.params.id]);
  if (!inv[0]) return res.status(404).json({ message: 'Inventory row not found' });

  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*)::int AS total FROM inventory_movements WHERE inventory_id = $1',
    [req.params.id]
  );
  const { rows } = await pool.query(
    `SELECT m.*, u.full_name AS actor_name
     FROM inventory_movements m
     LEFT JOIN users u ON u.id = m.changed_by_user_id
     WHERE m.inventory_id = $1
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $2 OFFSET $3`,
    [req.params.id, pageSize, offset]
  );

  res.json({
    items: rows.map((m) => ({
      id: m.id,
      deltaAvailable: m.delta_available,
      deltaReserved: m.delta_reserved,
      deltaSold: m.delta_sold,
      reason: m.reason,
      orderId: m.order_id,
      actorRole: m.actor_role,
      actorName: m.actor_name,
      note: m.note,
      createdAt: m.created_at,
    })),
    total: countRows[0].total,
    page,
    pageSize,
  });
}

module.exports = { listInventory, adjustInventory, getMovements };
