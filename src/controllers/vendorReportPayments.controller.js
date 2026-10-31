const pool = require('../config/db');
const { DELIVERED_AT } = require('../services/settlements');

/**
 * Payment report for the shop (VD17): how the range's sales were paid, the
 * refunds that went back to customers, and the cash-on-delivery money still
 * waiting for a weekly settlement.
 *
 * GET /api/vendor/reports/payments?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

const MAX_REPORT_DAYS = 366;

// The four ways a customer pays, in the order the app shows them. Razorpay
// orders are 'online'; 'upi' / 'card' / 'netbanking' are older online orders.
const METHODS = ['cod', 'online', 'wallet', 'credit'];
const METHOD_OF = `CASE WHEN o.payment_method IN ('upi', 'card', 'netbanking', 'online') THEN 'online' ELSE o.payment_method END`;

// Same as vendorReports.controller (not exported there).
const isDay = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

async function reportRange(query) {
  const { rows } = await pool.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today`);
  const today = rows[0].today;
  const from = query.from ?? today;
  let to = query.to ?? today;
  if (!isDay(from) || !isDay(to)) return { error: 'from and to are dates like 2026-10-31' };
  if (from > to) return { error: 'from is after to' };
  if (from > today) return { error: 'from is in the future' };
  if (to > today) to = today;
  const days = daysBetween(from, to) + 1;
  if (days > MAX_REPORT_DAYS) return { error: `At most ${MAX_REPORT_DAYS} days` };
  return { from, to, days };
}

/**
 * The shop's sales — the "counted sale" rule of the Sales report and Home
 * insights: not cancelled, not a free replacement, and an online order only
 * once paid. $1 = vendor id.
 */
const SALES = `
  SELECT o.id, o.total_cents, o.created_at, ${METHOD_OF} AS method
  FROM orders o
  LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
  WHERE o.vendor_id = $1 AND o.replacement_of_order_id IS NULL AND o.status <> 'cancelled'
    AND (o.payment_method IN ('cod', 'credit') OR p.status IN ('successful', 'refunded', 'partially_refunded'))`;

/**
 * Sales split by how they were paid, refunds, a day-by-day table, and COD
 * cash not yet settled.
 *
 * Sales are dated by when the order was placed (as on the Sales report);
 * a refund by when it completed (as settlements date it). The COD figures are
 * as of now, whatever the range: delivered COD orders no settlement has taken
 * yet, and those in a settlement that isn't paid out yet.
 */
async function paymentsReport(req, res) {
  const r = await reportRange(req.query);
  if (r.error) return res.status(400).json({ message: r.error });
  const { from, to, days } = r;

  const W = `
    WITH w AS (
      SELECT ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AS s,
             (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') AS e
    )`;
  const args = [req.vendorId, from, to];
  const DAY = (col) => `to_char((${col} AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')`;
  const REFUNDS = `
    SELECT rf.amount_cents, rf.status, rf.created_at, rf.updated_at, ${METHOD_OF} AS method
    FROM refunds rf JOIN orders o ON o.id = rf.order_id
    WHERE o.vendor_id = $1`;

  const [sales, refunds, pending, cod] = await Promise.all([
    pool.query(
      `${W}, o AS (${SALES})
       SELECT ${DAY('o.created_at')} AS day, o.method, COUNT(*)::int AS orders, SUM(o.total_cents)::bigint AS cents
       FROM o, w WHERE o.created_at >= w.s AND o.created_at < w.e
       GROUP BY 1, 2`,
      args
    ),
    pool.query(
      `${W}, rf AS (${REFUNDS})
       SELECT ${DAY('rf.updated_at')} AS day, rf.method, COUNT(*)::int AS n, SUM(rf.amount_cents)::bigint AS cents
       FROM rf, w WHERE rf.status = 'completed' AND rf.updated_at >= w.s AND rf.updated_at < w.e
       GROUP BY 1, 2`,
      args
    ),
    // Refunds asked for in the range that haven't gone through yet.
    pool.query(
      `${W}, rf AS (${REFUNDS})
       SELECT COUNT(*)::int AS n, COALESCE(SUM(rf.amount_cents), 0)::bigint AS cents
       FROM rf, w WHERE rf.status IN ('pending', 'processing') AND rf.created_at >= w.s AND rf.created_at < w.e`,
      args
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE so.order_id IS NULL)::int AS unsettled_orders,
         COALESCE(SUM(o.total_cents) FILTER (WHERE so.order_id IS NULL), 0)::bigint AS unsettled_cents,
         COUNT(*) FILTER (WHERE so.order_id IS NULL AND o.delivery_method = 'pickup')::int AS unsettled_pickup,
         to_char(MIN((${DELIVERED_AT} AT TIME ZONE 'Asia/Kolkata')::date) FILTER (WHERE so.order_id IS NULL), 'YYYY-MM-DD') AS oldest,
         COUNT(*) FILTER (WHERE s.status IS NOT NULL AND s.status <> 'paid')::int AS unpaid_orders,
         COALESCE(SUM(so.gross_cents) FILTER (WHERE s.status IS NOT NULL AND s.status <> 'paid'), 0)::bigint AS unpaid_cents
       FROM orders o
       LEFT JOIN settlement_orders so ON so.order_id = o.id
       LEFT JOIN settlements s ON s.id = so.settlement_id
       WHERE o.vendor_id = $1 AND o.payment_method = 'cod' AND o.status = 'delivered' AND o.replacement_of_order_id IS NULL`,
      [req.vendorId]
    ),
  ]);

  // Every day of the range, zeros included, newest last.
  const blank = () => Object.fromEntries(METHODS.map((m) => [m, { orders: 0, cents: 0 }]));
  const byDay = new Map();
  for (let i = 0; i < days; i++) byDay.set(addDays(from, i), { sales: blank(), refunds: 0, refundCents: 0 });
  for (const s of sales.rows) {
    const d = byDay.get(s.day)?.sales[s.method];
    if (!d) continue;
    d.orders += s.orders;
    d.cents += Number(s.cents);
  }
  const refundTotals = { online: { count: 0, cents: 0 }, wallet: { count: 0, cents: 0 }, other: { count: 0, cents: 0 } };
  for (const f of refunds.rows) {
    const d = byDay.get(f.day);
    if (!d) continue;
    d.refunds += f.n;
    d.refundCents += Number(f.cents);
    const t = refundTotals[f.method] ?? refundTotals.other;
    t.count += f.n;
    t.cents += Number(f.cents);
  }

  const dayRows = [...byDay].map(([day, d]) => ({
    day,
    ...Object.fromEntries(METHODS.map((m) => [m, { orders: d.sales[m].orders, amountCents: d.sales[m].cents }])),
    refunds: d.refunds,
    refundCents: d.refundCents,
  }));
  const methods = METHODS.map((m) => ({
    method: m,
    orders: dayRows.reduce((n, d) => n + d[m].orders, 0),
    amountCents: dayRows.reduce((n, d) => n + d[m].amountCents, 0),
  }));
  const c = cod.rows[0];

  res.json({
    range: { from, to, days },
    totals: {
      orders: methods.reduce((n, m) => n + m.orders, 0),
      amountCents: methods.reduce((n, m) => n + m.amountCents, 0),
    },
    methods,
    refunds: {
      count: dayRows.reduce((n, d) => n + d.refunds, 0),
      amountCents: dayRows.reduce((n, d) => n + d.refundCents, 0),
      byMethod: Object.entries(refundTotals)
        .filter(([, t]) => t.count > 0)
        .map(([method, t]) => ({ method, count: t.count, amountCents: t.cents })),
      pendingCount: pending.rows[0].n,
      pendingCents: Number(pending.rows[0].cents),
    },
    cod: {
      unsettledOrders: c.unsettled_orders,
      unsettledCents: Number(c.unsettled_cents),
      unsettledPickupOrders: c.unsettled_pickup,
      oldestUnsettledDay: c.oldest,
      inUnpaidSettlementOrders: c.unpaid_orders,
      inUnpaidSettlementCents: Number(c.unpaid_cents),
    },
    days: dayRows,
  });
}

module.exports = { paymentsReport };
