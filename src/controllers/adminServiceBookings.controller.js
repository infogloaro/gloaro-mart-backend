const pool = require('../config/db');
const payments = require('../services/serviceBookingPayments');
const { EnquiryError: BookingError } = require('../services/shopEnquiries');

/**
 * SV10 — Admin → Service bookings: every booking with its payment and
 * commission, one booking in full (timeline, payment events, commission,
 * support tickets about it), cancelling one on behalf of either side (with
 * the refund that implies), retrying a refund Razorpay refused, and the
 * service payouts (commission rows) by month.
 *
 *   GET  /api/admin/service-bookings?status&paid&shop&q&from&to&page&pageSize
 *   GET  /api/admin/service-bookings/summary
 *   GET  /api/admin/service-bookings/:id
 *   POST /api/admin/service-bookings/:id/cancel { reason }
 *   POST /api/admin/service-bookings/:id/refund
 *   GET  /api/admin/service-commissions?month=YYYY-MM&shop&settled
 */

const ACTIVE = ['pending', 'accepted', 'on_the_way', 'arrived', 'in_progress'];
const PAGE_MAX = 100;

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof BookingError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

const LIST = `
  SELECT b.id, b.reference, b.status, b.service_title, b.starts_at, b.ends_at, b.created_at, b.updated_at, b.at_home,
         b.price_type, b.price_cents, b.visit_fee_cents, b.total_cents, b.pay_online, b.coupon_code, b.discount_cents, b.cancelled_by,
         vp.id AS vendor_id, vp.business_name AS vendor_name, vp.city AS vendor_city,
         u.id AS customer_id, COALESCE(NULLIF(TRIM(u.full_name), ''), u.email) AS customer_name, u.phone_number AS customer_phone,
         sp.status AS pay_status, sp.amount_cents AS pay_cents, sp.instrument AS pay_instrument, sp.refund_cents AS pay_refund_cents,
         sp.provider_payment_id, sp.failure_reason AS pay_failure,
         sc.commission_cents, sc.commission_percent::float AS commission_percent, sc.shop_cents,
         (SELECT COUNT(*)::int FROM support_tickets t WHERE t.booking_id = b.id) AS ticket_count
  FROM service_bookings b
  JOIN vendor_profiles vp ON vp.id = b.vendor_id
  JOIN users u ON u.id = b.user_id
  LEFT JOIN service_payments sp ON sp.booking_id = b.id
  LEFT JOIN service_commissions sc ON sc.booking_id = b.id`;

function row(r) {
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    serviceTitle: r.service_title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    atHome: r.at_home,
    shop: { id: r.vendor_id, name: r.vendor_name, city: r.vendor_city },
    customer: { id: r.customer_id, name: r.customer_name, phone: r.customer_phone },
    price: { type: r.price_type, cents: r.price_cents, visitFeeCents: r.visit_fee_cents, totalCents: r.total_cents },
    coupon: r.coupon_code ? { code: r.coupon_code, discountCents: r.discount_cents } : null,
    payOnline: r.pay_online === true,
    payment: r.pay_status
      ? { status: r.pay_status, amountCents: r.pay_cents, instrument: r.pay_instrument, refundCents: r.pay_refund_cents, providerPaymentId: r.provider_payment_id, failureReason: r.pay_failure }
      : null,
    commission: r.commission_cents == null ? null : { cents: r.commission_cents, percent: r.commission_percent, shopCents: r.shop_cents },
    cancelledBy: r.cancelled_by,
    ticketCount: r.ticket_count,
  };
}

const list = handle(async (req, res) => {
  const params = [];
  const push = (v) => `$${params.push(v)}`;
  const where = [];
  const q = req.query;
  if (q.status === 'active') where.push(`b.status = ANY(${push(ACTIVE)})`);
  else if (q.status) where.push(`b.status = ${push(String(q.status))}`);
  if (q.paid === 'online') where.push(`sp.status IN ('successful', 'refund_pending', 'refunded', 'refund_failed')`);
  if (q.paid === 'pending') where.push(`b.pay_online AND (sp.status IS NULL OR sp.status IN ('created', 'failed')) AND b.status = ANY(${push(ACTIVE)})`);
  if (q.paid === 'refund_failed') where.push(`sp.status = 'refund_failed'`);
  if (q.paid === 'shop') where.push(`NOT b.pay_online`);
  if (q.shop) where.push(`b.vendor_id = ${push(Number(q.shop) || 0)}`);
  if (q.from) where.push(`b.starts_at >= ${push(new Date(q.from))}`);
  if (q.to) where.push(`b.starts_at < ${push(new Date(new Date(q.to).getTime() + 86400000))}`);
  const text = String(q.q ?? '').trim().slice(0, 80);
  if (text) {
    const like = push(`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(b.reference ILIKE ${like} OR b.service_title ILIKE ${like} OR vp.business_name ILIKE ${like} OR u.full_name ILIKE ${like} OR u.phone_number ILIKE ${like})`);
  }
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(PAGE_MAX, Math.max(1, Number(q.pageSize) || 25));
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${LIST} ${w} ORDER BY b.starts_at DESC, b.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
    pool.query(`SELECT COUNT(*)::int AS total FROM service_bookings b JOIN vendor_profiles vp ON vp.id = b.vendor_id JOIN users u ON u.id = b.user_id LEFT JOIN service_payments sp ON sp.booking_id = b.id ${w}`, params),
  ]);
  res.json({ items: rows.map(row), total: count[0].total, page, pageSize });
});

const summary = handle(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE b.status = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE b.status = ANY($1) AND (b.starts_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today,
           COUNT(*) FILTER (WHERE b.status = 'completed' AND b.updated_at > now() - interval '7 days')::int AS completed_week,
           COUNT(*) FILTER (WHERE b.pay_online AND b.status = ANY($1) AND (sp.status IS NULL OR sp.status IN ('created', 'failed')))::int AS unpaid,
           COUNT(*) FILTER (WHERE sp.status = 'refund_failed')::int AS refund_failed,
           COALESCE(SUM(sp.amount_cents) FILTER (WHERE sp.status = 'successful' AND sp.paid_at > now() - interval '30 days'), 0)::bigint AS online_30d,
           COALESCE((SELECT SUM(commission_cents) FROM service_commissions WHERE created_at > now() - interval '30 days'), 0)::bigint AS commission_30d
    FROM service_bookings b LEFT JOIN service_payments sp ON sp.booking_id = b.id`, [ACTIVE]);
  const s = rows[0];
  res.json({
    pending: s.pending, today: s.today, completedWeek: s.completed_week, unpaid: s.unpaid, refundFailed: s.refund_failed,
    onlineCents30d: Number(s.online_30d), commissionCents30d: Number(s.commission_30d),
  });
});

const get = handle(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query(`${LIST} WHERE b.id = $1`, [Number.isInteger(id) ? id : 0]);
  if (!rows[0]) throw new BookingError(404, 'Booking not found');
  const r = rows[0];
  const [{ rows: full }, { rows: events }, { rows: payEvents }, { rows: tickets }] = await Promise.all([
    pool.query('SELECT visit_address, note, status_note, package_name, package_cents, addons, list_price_cents, pay_deadline FROM service_bookings WHERE id = $1', [id]),
    pool.query('SELECT status, by_role, note, created_at FROM service_booking_events WHERE booking_id = $1 ORDER BY created_at, id', [id]),
    pool.query('SELECT e.event, e.amount_cents, e.note, e.created_at FROM service_payment_events e JOIN service_payments p ON p.id = e.payment_id WHERE p.booking_id = $1 ORDER BY e.created_at, e.id', [id]),
    pool.query('SELECT id, reference, subject, status, category, created_at FROM support_tickets WHERE booking_id = $1 ORDER BY created_at DESC', [id]),
  ]);
  const f = full[0];
  res.json({
    ...row(r),
    visitAddress: f.visit_address,
    note: f.note,
    statusNote: f.status_note,
    package: f.package_name ? { name: f.package_name, cents: f.package_cents } : null,
    addons: Array.isArray(f.addons) ? f.addons : [],
    listPriceCents: f.list_price_cents,
    payDeadline: f.pay_deadline,
    events: events.map((e) => ({ status: e.status, by: e.by_role, note: e.note, at: e.created_at })),
    paymentEvents: payEvents.map((e) => ({ event: e.event, amountCents: e.amount_cents, note: e.note, at: e.created_at })),
    tickets: tickets.map((t) => ({ id: t.id, reference: t.reference, subject: t.subject, status: t.status, category: t.category, createdAt: t.created_at })),
  });
});

/** Cancels an active booking on the shop's behalf (so the customer is refunded in full). */
const cancel = handle(async (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason ?? '').trim();
  if (reason.length < 5) throw new BookingError(400, 'Say why (at least 5 characters). Both sides see this.');
  if (reason.length > 300) throw new BookingError(400, 'Keep the reason under 300 characters.');
  const client = await pool.connect();
  let b;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT b.*, vp.user_id AS shop_user_id FROM service_bookings b JOIN vendor_profiles vp ON vp.id = b.vendor_id WHERE b.id = $1 FOR UPDATE OF b`,
      [Number.isInteger(id) ? id : 0]
    );
    b = rows[0];
    if (!b) throw new BookingError(404, 'Booking not found');
    if (!ACTIVE.includes(b.status)) throw new BookingError(409, `This booking is ${b.status.replace('_', ' ')}.`);
    await client.query(
      `UPDATE service_bookings SET status = 'cancelled', status_note = $2, cancelled_by = 'admin', pay_deadline = NULL, updated_at = now() WHERE id = $1`,
      [b.id, `Gloaro Mart: ${reason}`]
    );
    await client.query("INSERT INTO service_booking_events (booking_id, status, by_role, by_user_id, note) VALUES ($1, 'cancelled', 'admin', $2, $3)", [b.id, req.user.id, reason]);
    // SV11: no live location on a cancelled booking.
    await require('../services/serviceBookingTracking').clear(client, b.id);
    for (const [userId, link] of [[b.user_id, `/bookings/${b.id}`], [b.shop_user_id, `/vendor/bookings/${b.id}`]]) {
      await client.query(
        "INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'service_booking', $2, $3, $4)",
        [userId, `Booking cancelled by Gloaro Mart: ${b.service_title} (${b.reference})`, reason.slice(0, 200), link]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Gloaro ended it, so the customer gets everything back whatever the customer-cancel rule says.
  await payments.refund(b.id, { by: 'vendor', reason: `Cancelled by Gloaro Mart: ${reason}` }).catch((err) => console.error(`[bookings] admin refund ${b.id}: ${err.message}`));
  const { rows } = await pool.query(`${LIST} WHERE b.id = $1`, [b.id]);
  res.json(row(rows[0]));
});

/** Tries a refund again after Razorpay refused it (status refund_failed). */
const retryRefund = handle(async (req, res) => {
  const id = Number(req.params.id);
  const { rowCount } = await pool.query(
    "UPDATE service_payments SET status = 'successful', failure_reason = NULL, updated_at = now() WHERE booking_id = $1 AND status = 'refund_failed'",
    [Number.isInteger(id) ? id : 0]
  );
  if (!rowCount) throw new BookingError(409, 'This booking has no failed refund to retry.');
  const r = await payments.refund(id, { by: 'vendor', reason: 'Refund retried by Gloaro Mart' });
  const { rows } = await pool.query(`${LIST} WHERE b.id = $1`, [id]);
  res.json({ ...row(rows[0]), retried: Boolean(r) });
});

/** The service payouts: commission rows of a month, with what each shop is owed or owes. */
const commissions = handle(async (req, res) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month ?? ''));
  const month = m ? `${m[1]}-${m[2]}` : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
  const params = [month];
  const where = [`to_char(c.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $1`];
  if (req.query.shop) where.push(`c.vendor_id = $${params.push(Number(req.query.shop) || 0)}`);
  if (req.query.settled === 'yes') where.push('ch.settlement_id IS NOT NULL');
  if (req.query.settled === 'no') where.push('ch.settlement_id IS NULL');
  const { rows } = await pool.query(
    `SELECT c.*, b.reference, b.service_title, vp.business_name, s.reference AS settlement_reference, s.status AS settlement_status
     FROM service_commissions c
     JOIN service_bookings b ON b.id = c.booking_id
     JOIN vendor_profiles vp ON vp.id = c.vendor_id
     LEFT JOIN vendor_charges ch ON ch.id = c.vendor_charge_id
     LEFT JOIN settlements s ON s.id = ch.settlement_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.created_at DESC LIMIT 500`,
    params
  );
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  res.json({
    month,
    totals: {
      bookings: rows.length,
      grossCents: sum((r) => r.gross_cents),
      commissionCents: sum((r) => r.commission_cents),
      onlineCents: sum((r) => (r.paid_online ? r.gross_cents : 0)),
      owedToShopsCents: sum((r) => Math.max(0, r.shop_cents)),
      owedByShopsCents: sum((r) => Math.max(0, -r.shop_cents)),
      unsettledCents: sum((r) => (r.settlement_reference ? 0 : r.shop_cents)),
    },
    items: rows.map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      reference: r.reference,
      serviceTitle: r.service_title,
      shop: { id: r.vendor_id, name: r.business_name },
      completedAt: r.created_at,
      grossCents: r.gross_cents,
      commissionPercent: Number(r.commission_percent),
      commissionCents: r.commission_cents,
      paidOnline: r.paid_online,
      shopCents: r.shop_cents,
      settlement: r.settlement_reference ? { reference: r.settlement_reference, status: r.settlement_status } : null,
    })),
  });
});

module.exports = { list, summary, get, cancel, retryRefund, commissions };
