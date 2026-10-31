const pool = require('../config/db');

/**
 * Inventory report for the shop (VD19): what the stock on the shelf is worth,
 * what has run out or is running low, what isn't selling, and what sells
 * fastest with how many days of stock are left.
 *
 * GET /api/vendor/reports/inventory
 *
 * One row per inventory row, so each variant counts on its own. The app picks
 * the dead-stock window (30 / 60 / 90 days) from the per-row sales here, so
 * switching it needs no second call.
 *
 * Value is at the selling price (the variant's price, or the product's for a
 * simple product): the schema has no cost / purchase price.
 */

const DEAD_WINDOWS = [30, 60, 90];
const FAST_WINDOW = 30;
const MAX_ROWS = 5000;

/**
 * Units of each of the shop's inventory rows sold in the last 30 / 60 / 90 IST
 * days (today included), and when it last sold. A sale follows the same rule as
 * the Sales report and Home insights: not cancelled, not a free replacement,
 * and an online order only once paid. $1 = vendor id.
 */
const ROWS = `
  WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
  w AS (
    SELECT ((d - ${DEAD_WINDOWS[0] - 1})::timestamp AT TIME ZONE 'Asia/Kolkata') AS s30,
           ((d - ${DEAD_WINDOWS[1] - 1})::timestamp AT TIME ZONE 'Asia/Kolkata') AS s60,
           ((d - ${DEAD_WINDOWS[2] - 1})::timestamp AT TIME ZONE 'Asia/Kolkata') AS s90
    FROM today
  ),
  sold AS (
    SELECT oi.product_id, oi.variant_id,
           COALESCE(SUM(oi.quantity) FILTER (WHERE o.created_at >= w.s30), 0)::int AS u30,
           COALESCE(SUM(oi.quantity) FILTER (WHERE o.created_at >= w.s60), 0)::int AS u60,
           COALESCE(SUM(oi.quantity) FILTER (WHERE o.created_at >= w.s90), 0)::int AS u90,
           MAX(o.created_at) AS last_sold
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    CROSS JOIN w
    WHERE o.vendor_id = $1 AND o.replacement_of_order_id IS NULL AND o.status <> 'cancelled'
      AND (o.payment_method IN ('cod', 'credit') OR EXISTS (
        SELECT 1 FROM payments p WHERE p.checkout_group_id = o.checkout_group_id
          AND p.status IN ('successful', 'refunded', 'partially_refunded')))
    GROUP BY oi.product_id, oi.variant_id
  )
  SELECT i.id, i.product_id, i.variant_id, i.available_qty, i.low_stock_threshold,
         p.name, COALESCE(NULLIF(TRIM(p.category), ''), 'Other') AS category, p.is_active,
         COALESCE(v.sku, p.sku) AS sku,
         CASE WHEN i.variant_id IS NULL THEN p.price_cents ELSE COALESCE(v.price_cents, p.price_cents) END AS price_cents,
         (SELECT string_agg(av.value, ' / ' ORDER BY a.sort_order, av.sort_order)
          FROM variant_attribute_values vav
          JOIN attribute_values av ON av.id = vav.attribute_value_id
          JOIN product_attributes a ON a.id = av.attribute_id
          WHERE vav.variant_id = i.variant_id) AS variant_label,
         COALESCE(s.u30, 0) AS u30, COALESCE(s.u60, 0) AS u60, COALESCE(s.u90, 0) AS u90,
         to_char((s.last_sold AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS last_sold,
         to_char((SELECT d FROM today), 'YYYY-MM-DD') AS today
  FROM inventory i
  JOIN products p ON p.id = i.product_id
  LEFT JOIN product_variants v ON v.id = i.variant_id
  LEFT JOIN sold s ON s.product_id = i.product_id AND s.variant_id IS NOT DISTINCT FROM i.variant_id
  WHERE i.vendor_id = $1
  ORDER BY p.name, i.variant_id NULLS FIRST, i.id
  LIMIT ${MAX_ROWS}`;

/** Days the stock lasts at the last 30 days' pace; null when nothing sold. */
function daysLeft(available, sold30) {
  if (sold30 <= 0) return null;
  return Math.floor(available / (sold30 / FAST_WINDOW));
}

async function inventoryReport(req, res) {
  const { rows } = await pool.query(ROWS, [req.vendorId]);
  let today = rows[0]?.today;
  if (!today) {
    const t = await pool.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today`);
    today = t.rows[0].today;
  }

  const items = rows.map((r) => {
    const available = r.available_qty;
    const price = Number(r.price_cents) || 0;
    return {
      inventoryId: r.id,
      productId: r.product_id,
      variantId: r.variant_id,
      name: r.name,
      variantLabel: r.variant_label,
      sku: r.sku,
      category: r.category,
      onSale: r.is_active,
      available,
      lowStockThreshold: r.low_stock_threshold,
      priceCents: price,
      valueCents: available * price,
      sold30: r.u30,
      sold60: r.u60,
      sold90: r.u90,
      lastSold: r.last_sold,
      daysLeft: available > 0 ? daysLeft(available, r.u30) : 0,
    };
  });

  const inStock = items.filter((i) => i.available > 0);
  const dead = Object.fromEntries(
    DEAD_WINDOWS.map((n) => {
      const d = inStock.filter((i) => i[`sold${n}`] === 0);
      return [n, { items: d.length, units: d.reduce((s, i) => s + i.available, 0), valueCents: d.reduce((s, i) => s + i.valueCents, 0) }];
    })
  );

  res.json({
    asOf: today,
    priceBasis: 'selling',
    deadWindows: DEAD_WINDOWS,
    fastWindow: FAST_WINDOW,
    totals: {
      items: items.length,
      inStock: inStock.length,
      units: inStock.reduce((s, i) => s + i.available, 0),
      valueCents: inStock.reduce((s, i) => s + i.valueCents, 0),
      outOfStock: items.filter((i) => i.available === 0).length,
      low: items.filter((i) => i.available > 0 && i.available <= i.lowStockThreshold).length,
      dead,
    },
    items,
  });
}

module.exports = { inventoryReport };
