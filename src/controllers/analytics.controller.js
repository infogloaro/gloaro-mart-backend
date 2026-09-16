const pool = require('../config/db');

async function getVendorProfileId(userId) {
  const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [userId]);
  return rows[0]?.id || null;
}

async function getVendorSummary(req, res) {
  const vendorId = await getVendorProfileId(req.user.id);
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const [{ rows: totalRow }, { rows: dailyRows }, { rows: volumeRow }, { rows: topByRevenue }, { rows: topByQty }] =
    await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(total_cents), 0) AS total_revenue_cents, COUNT(*) AS delivered_order_count
         FROM orders WHERE vendor_id = $1 AND status = 'delivered'`,
        [vendorId]
      ),
      pool.query(
        `SELECT date_trunc('day', updated_at) AS day, SUM(total_cents) AS revenue_cents
         FROM orders
         WHERE vendor_id = $1 AND status = 'delivered' AND updated_at >= now() - interval '30 days'
         GROUP BY 1 ORDER BY 1`,
        [vendorId]
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS orders_last_30_days,
                COUNT(*) AS total_orders_all_time
         FROM orders WHERE vendor_id = $1`,
        [vendorId]
      ),
      pool.query(
        `SELECT oi.product_id, oi.product_name_snapshot,
                SUM(oi.unit_price_cents * oi.quantity) AS revenue_cents
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.vendor_id = $1 AND o.status = 'delivered'
         GROUP BY oi.product_id, oi.product_name_snapshot
         ORDER BY revenue_cents DESC LIMIT 5`,
        [vendorId]
      ),
      pool.query(
        `SELECT oi.product_id, oi.product_name_snapshot, SUM(oi.quantity) AS total_quantity
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.vendor_id = $1 AND o.status = 'delivered'
         GROUP BY oi.product_id, oi.product_name_snapshot
         ORDER BY total_quantity DESC LIMIT 5`,
        [vendorId]
      ),
    ]);

  const revenueByDay = new Map(dailyRows.map((r) => [r.day.toISOString().slice(0, 10), Number(r.revenue_cents)]));
  const dailyRevenue = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyRevenue.push({ date: key, revenueCents: revenueByDay.get(key) || 0 });
  }

  res.json({
    totalRevenueCents: Number(totalRow[0].total_revenue_cents),
    deliveredOrderCount: Number(totalRow[0].delivered_order_count),
    ordersLast30Days: Number(volumeRow[0].orders_last_30_days),
    totalOrdersAllTime: Number(volumeRow[0].total_orders_all_time),
    dailyRevenue,
    topProductsByRevenue: topByRevenue.map((r) => ({
      productId: r.product_id,
      name: r.product_name_snapshot,
      revenueCents: Number(r.revenue_cents),
    })),
    topProductsByQuantity: topByQty.map((r) => ({
      productId: r.product_id,
      name: r.product_name_snapshot,
      quantity: Number(r.total_quantity),
    })),
  });
}

module.exports = { getVendorSummary };
