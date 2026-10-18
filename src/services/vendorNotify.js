/**
 * Tells shops they have a new order — an in-app notification (type
 * 'new_order', link /vendor/orders/<id>), so the vendor app needn't poll.
 * Sent when the sale is committed: at checkout for COD / credit, when the
 * payment is captured for online orders, and when an order is re-routed to
 * another shop. Each order is announced once.
 */

const rupees = (c) => `₹${(c / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function notifyNewOrders(db, { groupId = null, orderId = null }) {
  const { rows } = await db.query(
    `SELECT o.id, o.total_cents, vp.user_id, COALESCE(cg.reference, 'Order #' || o.id) AS ref,
            (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items WHERE order_id = o.id) AS items
     FROM orders o JOIN vendor_profiles vp ON vp.id = o.vendor_id LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
     WHERE o.status = 'pending' AND (($1::int IS NOT NULL AND o.checkout_group_id = $1) OR ($2::int IS NOT NULL AND o.id = $2))
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type = 'new_order' AND n.deep_link = '/vendor/orders/' || o.id)`,
    [groupId, orderId]
  );
  for (const o of rows) {
    await db.query(
      "INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'new_order', 'New order', $2, $3)",
      [o.user_id, `${o.ref}: ${o.items} item${o.items === 1 ? '' : 's'}, ${rupees(o.total_cents)}. Accept it in the app.`, `/vendor/orders/${o.id}`]
    );
  }
  return rows.length;
}

module.exports = { notifyNewOrders };
