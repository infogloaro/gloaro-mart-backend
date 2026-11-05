/**
 * SV7 — paying for a service booking online, through the same Razorpay set-up
 * as shopping (RZ1–RZ7), when Admin → Payment settings allows it.
 *
 * One `service_payments` row per booking (UNIQUE booking_id): opening the
 * payment again hands back the same Razorpay order, so a double tap can never
 * charge twice. Money is counted only by the two signed paths shopping uses
 * (the app's verified callback and the webhook), both of which land in
 * applyEvent with the same event ids. A cancelled or rejected paid booking is
 * refunded in full: always when the shop ends it, and when the customer does
 * if admin's rule says so.
 */
const pool = require('../config/db');
const razorpay = require('./payments/razorpay');
const paymentSettings = require('./paymentSettings');
const { EnquiryError: BookingError } = require('./shopEnquiries');

const PAY_NOW = ['off', 'optional', 'required'];

/** What bookings may offer: pay now off / optional / required, and the refund rule. */
async function rules(db = pool) {
  const [s, o] = await Promise.all([paymentSettings.getSettings(db), paymentSettings.options(db)]);
  const payNow = PAY_NOW.includes(s.booking_pay_now) ? s.booking_pay_now : 'off';
  return {
    // Pay now needs Razorpay to be on and ready, whatever the booking switch says.
    payNow: o.online.enabled ? payNow : 'off',
    refundOnCancel: s.booking_refund_on_cancel !== false,
    environment: o.online.environment,
  };
}

async function logEvent(db, paymentId, event, { amountCents = 0, providerEventId = null, note = null } = {}) {
  await db.query(
    `INSERT INTO service_payment_events (payment_id, event, amount_cents, provider_event_id, note) VALUES ($1, $2, $3, $4, $5)`,
    [paymentId, event, amountCents, providerEventId, note]
  );
}

/**
 * Opens (or re-opens) the payment of a booking inside the caller's
 * transaction; the booking row must be locked. Returns what the app opens
 * Razorpay's checkout with. Throws 409 when it is already paid.
 */
async function open(client, booking, userId) {
  if (booking.total_cents == null || booking.total_cents <= 0) throw new BookingError(400, 'This booking has no fixed total to pay online. Pay the shop after the work.');
  const { rows } = await client.query('SELECT * FROM service_payments WHERE booking_id = $1 FOR UPDATE', [booking.id]);
  let payment = rows[0];
  if (payment && !['created', 'failed'].includes(payment.status)) throw new BookingError(409, 'This booking is already paid.');
  if (payment && payment.amount_cents !== booking.total_cents) {
    // The total changed (it cannot today, but a stale order must never be paid).
    await client.query("UPDATE service_payments SET status = 'failed', failure_reason = 'Superseded', updated_at = now() WHERE id = $1", [payment.id]);
    payment = null;
  }
  let conn;
  if (!payment || !payment.provider_order_id) {
    if (!payment) {
      const { rows: created } = await client.query(
        `INSERT INTO service_payments (booking_id, user_id, amount_cents) VALUES ($1, $2, $3) RETURNING *`,
        [booking.id, userId, booking.total_cents]
      );
      payment = created[0];
      await logEvent(client, payment.id, 'created', { amountCents: payment.amount_cents });
    }
    let opened;
    try {
      opened = await razorpay.createAttempt({ payment: null, attempt: { id: `bkg_${booking.id}_${payment.id}` }, amountCents: payment.amount_cents });
    } catch (err) {
      throw new BookingError(err.status ?? 502, err.message);
    }
    await client.query("UPDATE service_payments SET provider_order_id = $2, status = 'created', failure_reason = NULL, updated_at = now() WHERE id = $1", [
      payment.id, opened.providerOrderId,
    ]);
    payment = { ...payment, provider_order_id: opened.providerOrderId };
    conn = opened.checkout;
  } else {
    // The same Razorpay order again: a second tap pays the first order or nothing.
    const c = await razorpay.loadConnection(client);
    conn = { keyId: c?.keyId, orderId: payment.provider_order_id, amountCents: payment.amount_cents, currency: 'INR', environment: c?.environment ?? null };
  }
  const { rows: who } = await client.query('SELECT full_name, email, phone_number FROM users WHERE id = $1', [userId]);
  return {
    ...conn,
    description: `Booking ${booking.reference}`,
    prefill: { name: who[0]?.full_name ?? null, email: who[0]?.email ?? null, contact: who[0]?.phone_number ?? null },
  };
}

/** The Razorpay order of a service payment the caller owns, for POST /api/payments/razorpay/verify. */
async function findByOrder(db, providerOrderId, userId) {
  const { rows } = await db.query('SELECT id, booking_id FROM service_payments WHERE provider_order_id = $1 AND user_id = $2', [providerOrderId, userId]);
  return rows[0] ?? null;
}

/**
 * Applies one verified gateway event to a service payment, inside the
 * caller's transaction. Returns null when the event is not about a service
 * payment, else { status: 'applied' | 'ignored' }.
 */
async function applyEvent(client, parsed) {
  if (parsed.providerEventId) {
    const { rows: seen } = await client.query('SELECT 1 FROM service_payment_events WHERE provider_event_id = $1', [parsed.providerEventId]);
    if (seen.length) return { status: 'ignored' };
  }
  if (parsed.event === 'refund.completed' || parsed.event === 'refund.failed') {
    const { rows } = await client.query('SELECT * FROM service_payments WHERE provider_refund_id = $1 FOR UPDATE', [parsed.providerRefundId]);
    const p = rows[0];
    if (!p) return null;
    if (p.status !== 'refund_pending') return { status: 'ignored' };
    const done = parsed.event === 'refund.completed';
    await client.query('UPDATE service_payments SET status = $2, refund_cents = $3, updated_at = now() WHERE id = $1', [
      p.id, done ? 'refunded' : 'refund_failed', done ? p.amount_cents : 0,
    ]);
    await logEvent(client, p.id, parsed.event, { amountCents: p.amount_cents, providerEventId: parsed.providerEventId });
    return { status: 'applied' };
  }
  const ref = parsed.providerOrderId ?? parsed.providerPaymentId;
  const { rows } = await client.query(
    'SELECT * FROM service_payments WHERE provider_order_id = $1 OR (provider_payment_id IS NOT NULL AND provider_payment_id = $2) FOR UPDATE',
    [ref, parsed.providerPaymentId ?? null]
  );
  const p = rows[0];
  if (!p) return null;
  if (parsed.event === 'attempt.failed') {
    // One try inside Razorpay's form failed; the order stays open for another.
    await logEvent(client, p.id, 'attempt.failed', { amountCents: parsed.amountCents, providerEventId: parsed.providerEventId, note: parsed.failureReason });
    return { status: 'applied' };
  }
  if (parsed.event !== 'captured') return { status: 'ignored' };
  if (p.status !== 'created' && p.status !== 'failed') return { status: 'ignored' };
  if (parsed.amountCents && parsed.amountCents !== p.amount_cents) {
    await logEvent(client, p.id, 'capture.mismatch', { amountCents: parsed.amountCents, providerEventId: parsed.providerEventId, note: `Expected ${p.amount_cents} paise` });
    console.error(`[bookings] payment ${p.id}: captured ${parsed.amountCents}, owed ${p.amount_cents}`);
    return { status: 'applied' };
  }
  await client.query(
    `UPDATE service_payments SET status = 'successful', provider_payment_id = $2, instrument = $3, paid_at = now(), updated_at = now() WHERE id = $1`,
    [p.id, parsed.providerPaymentId, parsed.instrument ?? null]
  );
  await logEvent(client, p.id, 'captured', { amountCents: parsed.amountCents, providerEventId: parsed.providerEventId });
  // SV8: paid — the hold no longer applies.
  await client.query('UPDATE service_bookings SET pay_deadline = NULL WHERE id = $1 AND pay_deadline IS NOT NULL', [p.booking_id]);
  // The shop hears the booking is paid; the customer's booking page shows it.
  const { rows: b } = await client.query(
    `SELECT b.reference, b.service_title, b.status, vp.user_id AS shop_user_id FROM service_bookings b JOIN vendor_profiles vp ON vp.id = b.vendor_id WHERE b.id = $1`,
    [p.booking_id]
  );
  if (b[0]) {
    await client.query(
      `INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'service_booking', $2, $3, $4)`,
      [b[0].shop_user_id, `Paid online: ${b[0].service_title} (${b[0].reference})`, `₹${(p.amount_cents / 100).toLocaleString('en-IN')} received through Gloaro Mart. Do not collect it again.`, `/vendor/bookings/${p.booking_id}`]
    ).catch(() => {});
    // A booking paid after it was already over goes straight back.
    if (['cancelled', 'rejected'].includes(b[0].status)) setImmediate(() => refund(p.booking_id, { by: 'vendor', reason: 'Paid after the booking had ended' }));
  }
  return { status: 'applied' };
}

/**
 * Sends a paid booking's money back after it was cancelled or rejected. Runs
 * on its own connection after the status change committed: a gateway that is
 * down must not undo a cancellation. [by] = who ended it; the customer's own
 * cancellation is refunded only when admin's rule says so.
 */
async function refund(bookingId, { by, reason }) {
  if (by === 'customer' && !(await rules()).refundOnCancel) return null;
  const client = await pool.connect();
  let p;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query("SELECT * FROM service_payments WHERE booking_id = $1 AND status = 'successful' FOR UPDATE", [bookingId]);
    p = rows[0];
    if (!p) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query("UPDATE service_payments SET status = 'refund_pending', refund_reason = $2, updated_at = now() WHERE id = $1", [p.id, reason]);
    await logEvent(client, p.id, 'refund.raised', { amountCents: p.amount_cents, note: reason });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  try {
    const r = await razorpay.createRefund({ payment: p, refund: { id: `bkg_${p.id}`, amount_cents: p.amount_cents, order_id: null } });
    await pool.query('UPDATE service_payments SET provider_refund_id = $2, status = $3, refund_cents = $4, updated_at = now() WHERE id = $1', [
      p.id, r.providerRefundId, r.status === 'completed' ? 'refunded' : 'refund_pending', r.status === 'completed' ? p.amount_cents : 0,
    ]);
    await logEvent(pool, p.id, r.status === 'completed' ? 'refund.completed' : 'refund.processing', { amountCents: p.amount_cents });
    return r;
  } catch (err) {
    // Left for admin: the booking is ended, the money is still to go back.
    console.error(`[bookings] refund for booking ${bookingId} failed: ${err.message}`);
    await pool.query("UPDATE service_payments SET status = 'refund_failed', failure_reason = $2, updated_at = now() WHERE id = $1", [p.id, err.message]).catch(() => {});
    await logEvent(pool, p.id, 'refund.failed', { amountCents: p.amount_cents, note: err.message }).catch(() => {});
    return null;
  }
}

/** The payment as the booking shows it; null when the booking is paid after the work. */
function shape(r) {
  if (!r.pay_status) return null;
  return {
    status: r.pay_status,
    amountCents: r.pay_cents,
    instrument: r.pay_instrument ?? null,
    refundCents: r.pay_refund_cents ?? 0,
    paidAt: r.pay_paid_at ?? null,
  };
}

module.exports = { PAY_NOW, rules, open, findByOrder, applyEvent, refund, shape };
