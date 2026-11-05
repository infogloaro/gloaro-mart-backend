/**
 * SV8 — commission on service bookings and how it reaches the shop's payout.
 *
 * Rate: the service category's own commission_percent, else the global
 * commission plan (Admin → Commission). Recorded once per completed booking
 * (service_commissions, UNIQUE booking_id) on the basis that was fixed when
 * it was booked: the total (package + add-ons + visit fee, net of a coupon),
 * else the price plus visit fee; nothing on an on-request price.
 *
 * Money: a booking paid online (SV7) is Gloaro's to pass on — the shop is
 * credited gross − commission; a booking paid to the shop after the work
 * owes Gloaro the commission. Both go through vendor_charges, which the
 * weekly settlement (services/settlements.js) already picks up, so a shop's
 * service earnings land in the same payout as its orders.
 *
 * Also here: the unpaid-hold sweep SV7 left out — a pay-now booking nobody
 * paid within its deadline is cancelled and its time freed.
 */
const pool = require('../config/db');

const HOLD_MINUTES = 15;

/** The commission % for a category (its own, else the global plan's). */
async function rateFor(db, categoryId) {
  const { rows } = await db.query(
    `SELECT COALESCE((SELECT commission_percent FROM service_categories WHERE id = $1),
                     (SELECT commission_percent FROM commission_plans WHERE scope = 'global' AND is_active ORDER BY id LIMIT 1),
                     0)::float AS pct`,
    [categoryId ?? null]
  );
  return rows[0].pct;
}

/** What the global plan says, for the admin form's placeholder and the shop's page. */
async function defaultRate(db = pool) {
  return rateFor(db, null);
}

/**
 * Records the commission of a booking that just completed, inside the
 * caller's transaction. A second call for the same booking does nothing.
 */
async function record(client, bookingId) {
  const { rows } = await client.query(
    `SELECT b.id, b.reference, b.vendor_id, b.service_title, b.price_type, b.price_cents, b.visit_fee_cents, b.total_cents,
            s.category_id, sp.status AS pay_status, sp.amount_cents AS paid_cents
     FROM service_bookings b
     LEFT JOIN vendor_services s ON s.id = b.service_id
     LEFT JOIN service_payments sp ON sp.booking_id = b.id
     WHERE b.id = $1 FOR UPDATE OF b`,
    [bookingId]
  );
  const b = rows[0];
  if (!b) return null;
  const { rows: done } = await client.query('SELECT id FROM service_commissions WHERE booking_id = $1', [bookingId]);
  if (done.length) return null;

  const paidOnline = ['successful', 'refund_pending', 'refunded', 'refund_failed'].includes(b.pay_status);
  // The basis: what was paid online, else the fixed total, else price + visit fee; on-request has none.
  let gross = 0;
  if (paidOnline) gross = b.paid_cents;
  else if (b.total_cents != null) gross = b.total_cents;
  else if (b.price_cents != null && b.price_type !== 'on_request') gross = b.price_cents + (b.visit_fee_cents ?? 0);
  const pct = await rateFor(client, b.category_id);
  const commission = Math.round((gross * pct) / 100);
  // The shop's side of it: paid online → Gloaro owes gross − commission; paid to the shop → the shop owes the commission.
  const shopCents = paidOnline ? gross - commission : -commission;

  let chargeId = null;
  if (shopCents !== 0) {
    const label = paidOnline
      ? `Booking ${b.reference} paid online: ${rupees(gross)} − ${pct}% commission ${rupees(commission)}`
      : `${pct}% commission on booking ${b.reference} (${rupees(gross)}, paid to you)`;
    const { rows: ch } = await client.query(
      `INSERT INTO vendor_charges (vendor_id, kind, label, amount_cents) VALUES ($1, $2, $3, $4) RETURNING id`,
      // vendor_charges: positive = taken off the payout, negative = paid to the shop.
      [b.vendor_id, paidOnline ? 'service_payout' : 'service_commission', label, -shopCents]
    );
    chargeId = ch[0].id;
  }
  const { rows: rec } = await client.query(
    `INSERT INTO service_commissions (booking_id, vendor_id, category_id, gross_cents, commission_percent, commission_cents, paid_online, shop_cents, vendor_charge_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [b.id, b.vendor_id, b.category_id, gross, pct, commission, paidOnline, shopCents, chargeId]
  );
  return rec[0];
}

const rupees = (c) => `₹${(c / 100).toLocaleString('en-IN')}`;

/**
 * GET /api/vendor/service-earnings?month=YYYY-MM — the shop's completed
 * bookings of a month: what they came to, Gloaro's commission, the shop's
 * share, and whether each has gone into a payout yet.
 */
async function vendorEarnings(vendorId, query = {}) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(query.month ?? ''));
  const now = new Date();
  const month = m ? `${m[1]}-${m[2]}` : now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
  const { rows } = await pool.query(
    `SELECT c.*, b.reference, b.service_title, b.starts_at, b.updated_at AS completed_at,
            s.reference AS settlement_reference, s.status AS settlement_status
     FROM service_commissions c
     JOIN service_bookings b ON b.id = c.booking_id
     LEFT JOIN vendor_charges ch ON ch.id = c.vendor_charge_id
     LEFT JOIN settlements s ON s.id = ch.settlement_id
     WHERE c.vendor_id = $1 AND to_char(c.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $2
     ORDER BY c.created_at DESC`,
    [vendorId, month]
  );
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  return {
    month,
    defaultPercent: await defaultRate(),
    summary: {
      completed: rows.length,
      grossCents: sum((r) => r.gross_cents),
      commissionCents: sum((r) => r.commission_cents),
      // What the shop keeps: the gross less commission, whichever way it was paid.
      earnedCents: sum((r) => r.gross_cents - r.commission_cents),
      onlineCents: sum((r) => (r.paid_online ? r.gross_cents : 0)),
      // Net of the shop's payouts: credits for online bookings, commission owed on the rest.
      payoutCents: sum((r) => r.shop_cents),
      pendingPayoutCents: sum((r) => (r.settlement_reference ? 0 : r.shop_cents)),
    },
    items: rows.map((r) => ({
      bookingId: r.booking_id,
      reference: r.reference,
      serviceTitle: r.service_title,
      startsAt: r.starts_at,
      completedAt: r.completed_at,
      grossCents: r.gross_cents,
      commissionPercent: Number(r.commission_percent),
      commissionCents: r.commission_cents,
      paidOnline: r.paid_online,
      shopCents: r.shop_cents,
      settlement: r.settlement_reference ? { reference: r.settlement_reference, status: r.settlement_status } : null,
    })),
  };
}

/**
 * SV7's hold: a pay-now booking not paid by its deadline is cancelled and the
 * time freed (server.js timer). The open Razorpay order is marked failed; a
 * payment that still lands later is refunded by applyEvent.
 */
async function expireUnpaid() {
  const client = await pool.connect();
  const cancelled = [];
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT b.id, b.reference, b.user_id, b.service_title FROM service_bookings b
       WHERE b.status = 'pending' AND b.pay_deadline IS NOT NULL AND b.pay_deadline < now()
         AND NOT EXISTS (SELECT 1 FROM service_payments sp WHERE sp.booking_id = b.id AND sp.status <> 'created' AND sp.status <> 'failed')
       FOR UPDATE OF b SKIP LOCKED`
    );
    for (const b of rows) {
      await client.query(
        `UPDATE service_bookings SET status = 'cancelled', cancelled_by = 'customer', status_note = 'Not paid in time', pay_deadline = NULL, updated_at = now() WHERE id = $1`,
        [b.id]
      );
      await client.query(
        "INSERT INTO service_booking_events (booking_id, status, by_role, note) VALUES ($1, 'cancelled', 'customer', 'Not paid in time — the booking was released')",
        [b.id]
      );
      await client.query("UPDATE service_payments SET status = 'failed', failure_reason = 'Not paid in time', updated_at = now() WHERE booking_id = $1 AND status = 'created'", [b.id]);
      await client.query(
        "INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'service_booking', $2, $3, $4)",
        [b.user_id, `Booking released: ${b.service_title} (${b.reference})`, `It was not paid within ${HOLD_MINUTES} minutes, so the time was freed. Book again any time.`, `/bookings/${b.id}`]
      );
      cancelled.push(b.id);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { cancelled };
}

module.exports = { HOLD_MINUTES, rateFor, defaultRate, record, vendorEarnings, expireUnpaid };
