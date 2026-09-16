const pool = require('../config/db');

/**
 * The vendor's own operating view.
 * Contracts per documents/SPRINT_8_VENDOR_PORTAL_SPEC.md §5.
 *
 * Deliberately not a second analytics screen — analytics.controller already
 * answers "how is the shop doing". This answers "what needs doing right now",
 * which is a different question with a different shelf life.
 */

/**
 * What the vendor's home screen can answer truthfully today.
 *
 * No settlement or rating tiles: commission arrives in Phase 9 and reviews in
 * Phase 13, and a tile that always reads zero because the feature behind it does
 * not exist is worse than no tile at all.
 */
async function getDashboard(req, res) {
  const vendorId = req.vendorId;

  const [{ rows: today }, { rows: orders }, { rows: stock }, { rows: lowRows }] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM(total_cents), 0)::int AS revenue_cents
       FROM orders
       WHERE vendor_id = $1 AND status <> 'cancelled' AND created_at >= date_trunc('day', now())`,
      [vendorId]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS new_orders,
              COUNT(*) FILTER (WHERE status IN ('confirmed', 'packed'))::int AS preparing,
              COUNT(*) FILTER (WHERE status = 'out_for_delivery')::int AS out_for_delivery,
              COUNT(*) FILTER (WHERE status NOT IN ('delivered', 'cancelled'))::int AS open_orders
       FROM orders WHERE vendor_id = $1`,
      [vendorId]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE available_qty = 0)::int AS out_of_stock,
              COUNT(*) FILTER (WHERE available_qty > 0 AND available_qty <= low_stock_threshold)::int AS low_stock,
              COALESCE(SUM(reserved_qty), 0)::int AS held_for_orders,
              COUNT(*)::int AS tracked_items
       FROM inventory WHERE vendor_id = $1`,
      [vendorId]
    ),
    // Named, not just counted: 'four items are low' is not something a vendor
    // can act on without knowing which four.
    pool.query(
      `SELECT i.id, i.available_qty, i.low_stock_threshold, p.name AS product_name,
              (SELECT string_agg(av.value, ' / ' ORDER BY a.sort_order, av.sort_order)
               FROM variant_attribute_values vav
               JOIN attribute_values av ON av.id = vav.attribute_value_id
               JOIN product_attributes a ON a.id = av.attribute_id
               WHERE vav.variant_id = i.variant_id) AS variant_label
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       WHERE i.vendor_id = $1
         AND (i.available_qty = 0 OR i.available_qty <= i.low_stock_threshold)
       ORDER BY i.available_qty ASC, p.name ASC
       LIMIT 10`,
      [vendorId]
    ),
  ]);

  res.json({
    today: {
      orderCount: today[0].order_count,
      revenueCents: today[0].revenue_cents,
    },
    orders: {
      newOrders: orders[0].new_orders,
      preparing: orders[0].preparing,
      outForDelivery: orders[0].out_for_delivery,
      openOrders: orders[0].open_orders,
    },
    stock: {
      outOfStock: stock[0].out_of_stock,
      lowStock: stock[0].low_stock,
      heldForOrders: stock[0].held_for_orders,
      trackedItems: stock[0].tracked_items,
    },
    needsRestocking: lowRows.map((r) => ({
      inventoryId: r.id,
      productName: r.product_name,
      variantLabel: r.variant_label,
      availableQty: r.available_qty,
      lowStockThreshold: r.low_stock_threshold,
    })),
  });
}

/**
 * The attribute definitions a vendor may build variants from.
 *
 * Read-only on purpose. A shop inventing its own 'Size' would fragment the
 * filter facets every other shop shares, so attributes stay platform-owned.
 */
async function listAttributes(req, res) {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.code, a.input_type, a.is_variant_defining, c.name AS category_name,
            COALESCE(
              json_agg(json_build_object('id', av.id, 'value', av.value)
                       ORDER BY av.sort_order, av.id)
              FILTER (WHERE av.id IS NOT NULL),
              '[]'
            ) AS values
     FROM product_attributes a
     LEFT JOIN categories c ON c.id = a.category_id
     LEFT JOIN attribute_values av ON av.attribute_id = a.id
     WHERE a.is_active = true
       AND ($1::text IS NULL OR c.name = $1 OR a.category_id IS NULL)
     GROUP BY a.id, c.name
     ORDER BY a.sort_order ASC, a.id ASC`,
    [req.query.category || null]
  );
  res.json(rows);
}

module.exports = { getDashboard, listAttributes };
