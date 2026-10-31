const pool = require('../config/db');

/**
 * VD20: who bought from the shop over a range of days (India time) — new vs
 * repeat, the full customer list (spend, orders, last order) and where they
 * live (top pincodes from the delivery address snapshot).
 *
 * Only counted sales: not cancelled, not a free replacement, and cash / credit
 * or paid online (the SHOP_ORDERS rule in vendorPortal.controller.js).
 * A customer is "new" when their first counted order at THIS shop falls in
 * the range; everyone else who bought in the range is "repeat".
 * Phone numbers leave the server masked to the last 4 digits.
 *
 * GET /api/vendor/reports/customers?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

const MAX_DAYS = 366;
const MAX_LIST = 2000;
const TOP_PINCODES = 10;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** "••••••1234"; null when there are fewer than 4 digits. */
function maskPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length < 4 ? null : `••••••${digits.slice(-4)}`;
}

async function customersReport(req, res) {
  const { from, to } = req.query;
  if (!isDay(from) || !isDay(to)) return res.status(400).json({ message: 'from and to are dates like 2026-10-31' });
  if (from > to) return res.status(400).json({ message: 'from is after to' });
  if (daysBetween(from, to) + 1 > MAX_DAYS) return res.status(400).json({ message: `At most ${MAX_DAYS} days` });

  const W = `$2::date::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const E = `($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const args = [req.vendorId, from, to];
  const COUNTED = `
    SELECT o.id, o.user_id, o.total_cents, o.created_at, o.delivery_address_snapshot AS addr
    FROM orders o
    LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
    WHERE o.vendor_id = $1 AND o.replacement_of_order_id IS NULL AND o.status <> 'cancelled'
      AND (o.payment_method IN ('cod', 'credit') OR p.status IN ('successful', 'refunded', 'partially_refunded'))`;

  const [people, places] = await Promise.all([
    pool.query(
      `WITH o AS (${COUNTED}),
       first_buy AS (SELECT user_id, MIN(created_at) AS at FROM o GROUP BY user_id),
       r AS (SELECT * FROM o WHERE created_at >= ${W} AND created_at < ${E})
       SELECT r.user_id,
              COUNT(*)::int AS orders,
              SUM(r.total_cents)::bigint AS spend,
              MAX(r.created_at) AS last_at,
              f.at AS first_at,
              f.at >= ${W} AS is_new,
              MAX(u.full_name) AS full_name,
              MAX(u.phone_number) AS phone,
              (array_agg(NULLIF(trim(r.addr->>'receiverName'), '') ORDER BY r.created_at DESC) FILTER (WHERE NULLIF(trim(r.addr->>'receiverName'), '') IS NOT NULL))[1] AS receiver,
              (array_agg(r.addr->>'mobileNumber' ORDER BY r.created_at DESC) FILTER (WHERE r.addr->>'mobileNumber' IS NOT NULL))[1] AS mobile,
              (array_agg(NULLIF(trim(r.addr->>'pincode'), '') ORDER BY r.created_at DESC) FILTER (WHERE NULLIF(trim(r.addr->>'pincode'), '') IS NOT NULL))[1] AS pincode
       FROM r JOIN first_buy f ON f.user_id = r.user_id LEFT JOIN users u ON u.id = r.user_id
       GROUP BY r.user_id, f.at
       ORDER BY spend DESC, last_at DESC, r.user_id`,
      args
    ),
    pool.query(
      `WITH o AS (${COUNTED})
       SELECT NULLIF(trim(addr->>'pincode'), '') AS pincode,
              mode() WITHIN GROUP (ORDER BY initcap(lower(NULLIF(trim(COALESCE(addr->>'area', addr->>'city')), '')))) AS place,
              COUNT(DISTINCT user_id)::int AS customers,
              COUNT(*)::int AS orders,
              SUM(total_cents)::bigint AS spend
       FROM o WHERE created_at >= ${W} AND created_at < ${E}
       GROUP BY 1
       ORDER BY customers DESC, orders DESC, 1`,
      args
    ),
  ]);

  const rows = people.rows;
  const newCount = rows.filter((x) => x.is_new).length;
  const orders = rows.reduce((s, x) => s + x.orders, 0);
  const sales = rows.reduce((s, x) => s + Number(x.spend), 0);
  const known = places.rows.filter((x) => x.pincode);
  const unknown = places.rows.find((x) => !x.pincode);

  res.json({
    from,
    to,
    customers: rows.length,
    newCustomers: newCount,
    repeatCustomers: rows.length - newCount,
    orders,
    salesCents: sales,
    // Highest spend first; the app sorts and searches this itself.
    list: rows.slice(0, MAX_LIST).map((x) => ({
      name: x.full_name || x.receiver || 'Customer',
      phone: maskPhone(x.phone || x.mobile),
      orders: x.orders,
      spendCents: Number(x.spend),
      lastOrderAt: x.last_at,
      firstOrderAt: x.first_at,
      isNew: x.is_new,
      pincode: x.pincode || null,
    })),
    listTruncated: rows.length > MAX_LIST,
    pincodes: known.slice(0, TOP_PINCODES).map((x) => ({ pincode: x.pincode, place: x.place, customers: x.customers, orders: x.orders, spendCents: Number(x.spend) })),
    noPincodeOrders: unknown ? unknown.orders : 0,
  });
}

module.exports = { customersReport, maskPhone };
