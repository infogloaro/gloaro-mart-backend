/**
 * SV11 — live location while a provider is on the way. The shop switches
 * sharing on for one booking (its consent, recorded with the time); points
 * are only accepted while that booking is "on the way" and sharing is on.
 * The customer sees the last point while it is fresh. When the booking moves
 * on (arrived, started, cancelled…) or the shop switches sharing off, the
 * point is deleted, so no trail is kept.
 *
 *   POST /api/vendor/bookings/:id/tracking { share: true|false }
 *   PUT  /api/vendor/bookings/:id/location { latitude, longitude, accuracyM? }
 *   GET  /api/bookings/:id/location
 */
const pool = require('../config/db');
const { EnquiryError: BookingError } = require('./shopEnquiries');

/** A point older than this is not shown as live. */
const FRESH_MINUTES = 10;
/** Points closer together than this are not written (a phone may send fast). */
const MIN_SECONDS = 5;

const readId = (raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new BookingError(404, 'Booking not found');
  return id;
};

/** The shop's booking, locked; throws unless it is on the way. */
async function onTheWay(client, rawId, vendorId) {
  const { rows } = await client.query('SELECT id, user_id, status, tracking_on, service_title, reference FROM service_bookings WHERE id = $1 AND vendor_id = $2 FOR UPDATE', [readId(rawId), vendorId]);
  const b = rows[0];
  if (!b) throw new BookingError(404, 'Booking not found');
  if (b.status !== 'on_the_way') throw new BookingError(409, 'Live location is shared only while you are on the way. Tap "On my way" first.');
  return b;
}

/** The shop turns sharing on (its consent for this trip) or off (the point is deleted). */
async function setSharing(rawId, vendorId, share) {
  if (typeof share !== 'boolean') throw new BookingError(400, 'share is true or false.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await onTheWay(client, rawId, vendorId);
    await client.query('UPDATE service_bookings SET tracking_on = $2, tracking_started_at = CASE WHEN $2 THEN now() ELSE tracking_started_at END, updated_at = now() WHERE id = $1', [b.id, share]);
    if (!share) await client.query('DELETE FROM service_booking_locations WHERE booking_id = $1', [b.id]);
    if (share && !b.tracking_on) {
      await client.query(
        "INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'service_booking', $2, $3, $4)",
        [b.user_id, `Track your provider: ${b.service_title} (${b.reference})`, 'The shop is sharing its live location while on the way.', `/bookings/${b.id}`]
      );
    }
    await client.query('COMMIT');
    return { sharing: share };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** One point from the shop's phone. */
async function update(rawId, vendorId, body = {}) {
  const lat = Number(body.latitude);
  const lng = Number(body.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) throw new BookingError(400, 'latitude and longitude are a point on the map.');
  const acc = body.accuracyM == null ? null : Number(body.accuracyM);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await onTheWay(client, rawId, vendorId);
    if (!b.tracking_on) throw new BookingError(409, 'Switch on live location for this booking first.');
    const { rows } = await client.query(
      `INSERT INTO service_booking_locations (booking_id, latitude, longitude, accuracy_m, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (booking_id) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, accuracy_m = EXCLUDED.accuracy_m, updated_at = now()
         WHERE service_booking_locations.updated_at < now() - make_interval(secs => $5)
       RETURNING updated_at`,
      [b.id, lat, lng, Number.isFinite(acc) && acc >= 0 ? Math.min(acc, 100000) : null, MIN_SECONDS]
    );
    await client.query('COMMIT');
    return { saved: rows.length > 0, updatedAt: rows[0]?.updated_at ?? null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** What the customer sees: whether the shop is sharing, and its last point while fresh. */
async function forCustomer(rawId, userId) {
  const { rows } = await pool.query(
    `SELECT b.status, b.tracking_on, l.latitude, l.longitude, l.accuracy_m, l.updated_at
     FROM service_bookings b LEFT JOIN service_booking_locations l ON l.booking_id = b.id
     WHERE b.id = $1 AND b.user_id = $2`,
    [readId(rawId), userId]
  );
  const r = rows[0];
  if (!r) throw new BookingError(404, 'Booking not found');
  const sharing = r.status === 'on_the_way' && r.tracking_on === true;
  const fresh = sharing && r.updated_at && Date.now() - new Date(r.updated_at).getTime() < FRESH_MINUTES * 60000;
  return {
    sharing,
    point: fresh ? { latitude: Number(r.latitude), longitude: Number(r.longitude), accuracyM: r.accuracy_m == null ? null : Number(r.accuracy_m), updatedAt: r.updated_at } : null,
    freshMinutes: FRESH_MINUTES,
  };
}

/** Stops sharing and forgets the point (the booking left "on the way"). Inside the caller's transaction. */
async function clear(db, bookingId) {
  await db.query('UPDATE service_bookings SET tracking_on = FALSE WHERE id = $1 AND tracking_on', [bookingId]);
  await db.query('DELETE FROM service_booking_locations WHERE booking_id = $1', [bookingId]);
}

module.exports = { FRESH_MINUTES, setSharing, update, forCustomer, clear };
