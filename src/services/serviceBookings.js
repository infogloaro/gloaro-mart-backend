/**
 * Service bookings (NS10, schema "SERVICE BOOKINGS"). The customer picks a
 * free time made from the shop's own hours, the shop accepts or rejects it,
 * starts and completes the work; the customer pays the shop after (Gloaro
 * takes no payment). Either side may cancel while it is still to come.
 */
const pool = require('../config/db');
const { EnquiryError: BookingError } = require('./shopEnquiries');

const STEP_MINUTES = 30;
const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 8 * 60;
const LEAD_MINUTES = 60;
const DAYS_AHEAD = 30;
const MAX_ACTIVE_PER_CUSTOMER = 5;
const ACTIVE = ['pending', 'accepted', 'in_progress'];

/** Who may move a booking from which status to which, and whether a reason is needed. */
const MOVES = {
  vendor: {
    accept: { from: ['pending'], to: 'accepted' },
    reject: { from: ['pending'], to: 'rejected', reason: true },
    start: { from: ['accepted'], to: 'in_progress' },
    complete: { from: ['in_progress'], to: 'completed' },
    cancel: { from: ['accepted'], to: 'cancelled', reason: true },
  },
  customer: {
    cancel: { from: ['pending', 'accepted'], to: 'cancelled', upcomingOnly: true },
  },
};

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const readId = (raw, what) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new BookingError(404, `${what} not found`);
  return id;
};

/** A service's slot length: its duration rounded up to 30 minutes (1 hour when not set). */
function slotMinutes(durationMinutes) {
  const d = Number(durationMinutes) || DEFAULT_MINUTES;
  return Math.ceil(d / STEP_MINUTES) * STEP_MINUTES;
}

/** Today in India, and the last day a booking can be for. */
function bookableDays(now = new Date()) {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const last = new Date(Date.parse(`${today}T00:00:00Z`) + DAYS_AHEAD * 86400000).toISOString().slice(0, 10);
  return { today, last };
}

/** A bookable service: active, of an approved shop, in an active category, short enough for a slot. */
async function bookableService(serviceId, db = pool, lock = false) {
  const { rows } = await db.query(
    `SELECT s.id, s.vendor_id, s.title, s.price_type, s.price_cents, s.price_max_cents, s.visit_fee_cents,
            s.duration_minutes, s.at_home, s.at_shop, vp.user_id AS shop_user_id, vp.business_name
     FROM vendor_services s
     JOIN service_categories c ON c.id = s.category_id
     JOIN vendor_profiles vp ON vp.id = s.vendor_id
     WHERE s.id = $1 AND s.status = 'active' AND c.is_active AND vp.status = 'approved'
     ${lock ? 'FOR UPDATE OF s' : ''}`,
    [serviceId]
  );
  if (!rows[0]) throw new BookingError(404, "This service isn't available to book.");
  return rows[0];
}

/**
 * The free times of [service] on [date] (YYYY-MM-DD, the shop's own day):
 * every 30 minutes the shop is open from start to end, at least an hour
 * from now, not overlapping an active booking of this service or a time the
 * shop blocked. `hours` is false when the shop never set its hours.
 */
async function freeSlots(service, date, db = pool) {
  const minutes = slotMinutes(service.duration_minutes);
  if (minutes > MAX_MINUTES) return { minutes, hours: true, slots: [] };
  const { rows: known } = await db.query('SELECT shop_open_at($1, now()) IS NOT NULL AS known', [service.vendor_id]);
  if (!known[0].known) return { minutes, hours: false, slots: [] };
  const { rows } = await db.query(
    `SELECT g AS starts_at, g + make_interval(mins => $3) AS ends_at
     FROM vendor_profiles vp,
          generate_series(($2::date)::timestamp AT TIME ZONE vp.timezone,
                          (($2::date + 1)::timestamp AT TIME ZONE vp.timezone) - make_interval(mins => $3),
                          make_interval(mins => ${STEP_MINUTES})) g
     WHERE vp.id = $1
       AND g >= now() + make_interval(mins => ${LEAD_MINUTES})
       AND shop_open_at(vp.id, g) IS TRUE
       AND shop_open_at(vp.id, g + make_interval(mins => $3) - interval '1 minute') IS TRUE
       AND NOT EXISTS (
         SELECT 1 FROM service_bookings b
         WHERE b.service_id = $4 AND b.status IN ('pending', 'accepted', 'in_progress')
           AND tstzrange(b.starts_at, b.ends_at) && tstzrange(g, g + make_interval(mins => $3)))
       AND NOT EXISTS (
         SELECT 1 FROM service_booking_blocks k
         WHERE k.vendor_id = vp.id AND (k.service_id IS NULL OR k.service_id = $4)
           AND tstzrange(k.starts_at, k.ends_at) && tstzrange(g, g + make_interval(mins => $3)))
     ORDER BY g`,
    [service.vendor_id, date, minutes, service.id]
  );
  return { minutes, hours: true, slots: rows.map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at })) };
}

function readDate(raw) {
  const date = text(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new BookingError(400, 'date must be YYYY-MM-DD.');
  }
  const { today, last } = bookableDays();
  if (date < today || date > last) throw new BookingError(400, `Pick a day from today to ${DAYS_AHEAD} days ahead.`);
  return date;
}

/** GET /api/services/:id/slots?date= */
async function slots(rawServiceId, rawDate) {
  const service = await bookableService(readId(rawServiceId, 'Service'));
  const date = readDate(rawDate);
  const { minutes, hours, slots: list } = await freeSlots(service, date);
  return { date, slotMinutes: minutes, hoursSet: hours, slots: list };
}

/** GET /api/services/:id/availability?days= — free-slot counts for the next days (max 14). */
async function availability(rawServiceId, rawDays) {
  const service = await bookableService(readId(rawServiceId, 'Service'));
  const days = Math.min(14, Math.max(1, Number.parseInt(rawDays, 10) || 7));
  const { today } = bookableDays();
  const out = [];
  let hoursSet = true;
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    const r = await freeSlots(service, date);
    hoursSet = r.hours;
    if (!r.hours) break;
    out.push({ date, free: r.slots.length });
  }
  return { slotMinutes: slotMinutes(service.duration_minutes), hoursSet, days: out };
}

async function notify(db, userId, title, body, link) {
  await db.query(
    "INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'service_booking', $2, $3, $4)",
    [userId, title.slice(0, 160), body.slice(0, 200), link]
  );
}

const when = (d) =>
  new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** POST /api/bookings { serviceId, startsAt, visitAddress?, note? } */
async function create(userId, body = {}) {
  const serviceId = readId(body.serviceId, 'Service');
  const startsAt = new Date(text(body.startsAt));
  if (Number.isNaN(startsAt.getTime())) throw new BookingError(400, 'Pick a time.');
  const address = text(body.visitAddress);
  const note = text(body.note);
  if (address.length > 400) throw new BookingError(400, 'Keep the address under 400 characters.');
  if (note.length > 1000) throw new BookingError(400, 'Keep the note under 1000 characters.');

  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    // One booking at a time per service, so two people can't take the same time.
    const service = await bookableService(serviceId, client, true);
    if (service.shop_user_id === userId) throw new BookingError(400, "You can't book your own shop's service.");
    if (service.at_home && !service.at_shop && address.length < 10) {
      throw new BookingError(400, 'Add the address where the work is to be done.');
    }
    const date = startsAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    readDate(date);
    const { slots: free } = await freeSlots(service, date, client);
    const slot = free.find((s) => new Date(s.startsAt).getTime() === startsAt.getTime());
    if (!slot) throw new BookingError(409, 'That time was just taken or is no longer free. Pick another.');

    const { rows: mine } = await client.query(
      `SELECT COUNT(*)::int AS active, COUNT(*) FILTER (WHERE service_id = $2)::int AS here
       FROM service_bookings WHERE user_id = $1 AND status = ANY($3)`,
      [userId, serviceId, ACTIVE]
    );
    if (mine[0].here > 0) throw new BookingError(409, 'You already have a booking for this service. Cancel it to book another time.');
    if (mine[0].active >= MAX_ACTIVE_PER_CUSTOMER) throw new BookingError(429, `You can hold up to ${MAX_ACTIVE_PER_CUSTOMER} bookings at a time.`);

    const { rows: seq } = await client.query("SELECT nextval('service_booking_ref_seq') AS n");
    const reference = `BKG-${new Date().getFullYear()}-${String(seq[0].n).padStart(5, '0')}`;
    const { rows } = await client.query(
      `INSERT INTO service_bookings (reference, service_id, vendor_id, user_id, service_title, starts_at, ends_at,
                                     price_type, price_cents, price_max_cents, visit_fee_cents, at_home, visit_address, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [reference, service.id, service.vendor_id, userId, service.title, slot.startsAt, slot.endsAt, service.price_type,
        service.price_cents, service.price_max_cents, service.visit_fee_cents, service.at_home && (address.length > 0 || !service.at_shop),
        service.at_home ? address || null : null, note || null]
    );
    id = rows[0].id;
    await client.query("INSERT INTO service_booking_events (booking_id, status, by_role, by_user_id) VALUES ($1, 'pending', 'customer', $2)", [id, userId]);
    await notify(client, service.shop_user_id, `New booking: ${service.title} (${reference})`, `For ${when(slot.startsAt)}. Accept or reject it.`, `/vendor/bookings/${id}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // The unique index caught a race the lock didn't (same start, another session).
    if (err.code === '23505') throw new BookingError(409, 'That time was just taken. Pick another.');
    throw err;
  } finally {
    client.release();
  }
  return get(id, 'customer', userId);
}

const SELECT = `
  SELECT b.*, vp.business_name, vp.logo_url, vp.contact AS shop_contact, vp.address_line, vp.city, vp.pincode,
         u.full_name AS customer_name, u.phone_number AS customer_phone
  FROM service_bookings b
  JOIN vendor_profiles vp ON vp.id = b.vendor_id
  JOIN users u ON u.id = b.user_id`;

function shape(r, side, events) {
  // The shop sees the customer's phone once it has accepted (it needs it to come).
  const showPhone = side === 'vendor' && ['accepted', 'in_progress', 'completed'].includes(r.status);
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    service: { id: r.service_id, title: r.service_title },
    shop: { id: r.vendor_id, name: r.business_name, logoUrl: r.logo_url, contact: r.shop_contact ?? {}, address: [r.address_line, r.city, r.pincode].filter(Boolean).join(', ') },
    ...(side === 'vendor' ? { customer: { name: r.customer_name, phone: showPhone ? r.customer_phone : null } } : {}),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    price: { type: r.price_type, cents: r.price_cents, maxCents: r.price_max_cents, visitFeeCents: r.visit_fee_cents },
    atHome: r.at_home,
    visitAddress: r.visit_address,
    note: r.note,
    statusNote: r.status_note,
    cancelledBy: r.cancelled_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(events ? { events: events.map((e) => ({ status: e.status, by: e.by_role, note: e.note, at: e.created_at })) } : {}),
  };
}

/** One booking the caller may see: the customer's own, or one at the caller's shop. */
async function get(rawId, side, ownerId) {
  const id = readId(rawId, 'Booking');
  const col = side === 'customer' ? 'b.user_id' : 'b.vendor_id';
  const { rows } = await pool.query(`${SELECT} WHERE b.id = $1 AND ${col} = $2`, [id, ownerId]);
  if (!rows[0]) throw new BookingError(404, 'Booking not found');
  const { rows: events } = await pool.query('SELECT * FROM service_booking_events WHERE booking_id = $1 ORDER BY created_at, id', [id]);
  return shape(rows[0], side, events);
}

/** ?status=pending|upcoming|past (upcoming = accepted/in progress; past = done, rejected, cancelled). */
async function list(side, ownerId, query = {}) {
  const col = side === 'customer' ? 'b.user_id' : 'b.vendor_id';
  const groups = {
    pending: ['pending'],
    upcoming: ['accepted', 'in_progress'],
    active: ACTIVE,
    past: ['completed', 'rejected', 'cancelled'],
  };
  const statuses = groups[query.status] ?? null;
  const params = [ownerId];
  const filter = statuses ? `AND b.status = ANY($${params.push(statuses)})` : '';
  const order = query.status === 'past' ? 'b.starts_at DESC' : 'b.starts_at ASC';
  const { rows } = await pool.query(`${SELECT} WHERE ${col} = $1 ${filter} ORDER BY ${order}, b.id LIMIT 100`, params);
  const { rows: counts } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status IN ('accepted', 'in_progress'))::int AS upcoming
     FROM service_bookings b WHERE ${col} = $1`,
    [ownerId]
  );
  return { items: rows.map((r) => shape(r, side)), counts: counts[0] };
}

/** A status change by the customer (cancel) or the shop (accept, reject, start, complete, cancel). */
async function move(rawId, side, ownerId, actorUserId, action, rawNote) {
  const id = readId(rawId, 'Booking');
  const rule = MOVES[side][action];
  if (!rule) throw new BookingError(400, `Unknown action: ${action}`);
  const note = text(rawNote);
  if (rule.reason && note.length < 5) throw new BookingError(400, 'Say why (at least 5 characters). The customer sees this.');
  if (note.length > 300) throw new BookingError(400, 'Keep the reason under 300 characters.');
  const col = side === 'customer' ? 'user_id' : 'vendor_id';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT b.*, vp.user_id AS shop_user_id FROM service_bookings b JOIN vendor_profiles vp ON vp.id = b.vendor_id
       WHERE b.id = $1 AND b.${col} = $2 FOR UPDATE OF b`,
      [id, ownerId]
    );
    const b = rows[0];
    if (!b) throw new BookingError(404, 'Booking not found');
    if (!rule.from.includes(b.status)) throw new BookingError(409, `This booking is ${b.status.replace('_', ' ')}, so it can't be changed that way.`);
    if (rule.upcomingOnly && new Date(b.starts_at) <= new Date()) throw new BookingError(409, 'The time has started. Ask the shop to cancel it.');
    await client.query(
      `UPDATE service_bookings SET status = $2, status_note = COALESCE($3, status_note), cancelled_by = $4, updated_at = now() WHERE id = $1`,
      [id, rule.to, note || null, rule.to === 'cancelled' ? side : null]
    );
    await client.query('INSERT INTO service_booking_events (booking_id, status, by_role, by_user_id, note) VALUES ($1, $2, $3, $4, $5)', [
      id, rule.to, side, actorUserId, note || null,
    ]);
    const words = {
      accepted: 'accepted your booking',
      rejected: "can't take your booking",
      in_progress: 'started the work',
      completed: 'marked the work done — pay the shop as agreed',
      cancelled: side === 'vendor' ? 'cancelled your booking' : 'The customer cancelled the booking',
    };
    if (side === 'vendor') {
      await notify(client, b.user_id, `${b.service_title}: the shop ${words[rule.to]} (${b.reference})`, note || `For ${when(b.starts_at)}.`, `/bookings/${id}`);
    } else {
      await notify(client, b.shop_user_id, `${words.cancelled}: ${b.service_title} (${b.reference})`, note || `It was for ${when(b.starts_at)}.`, `/vendor/bookings/${id}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return get(id, side, ownerId);
}

// ── Times the shop blocks (a day off for one worker, a big job …) ──

async function listBlocks(vendorId) {
  const { rows } = await pool.query(
    `SELECT k.id, k.service_id, s.title AS service_title, k.starts_at, k.ends_at, k.note
     FROM service_booking_blocks k LEFT JOIN vendor_services s ON s.id = k.service_id
     WHERE k.vendor_id = $1 AND k.ends_at > now() ORDER BY k.starts_at`,
    [vendorId]
  );
  return { items: rows.map((r) => ({ id: r.id, service: r.service_id ? { id: r.service_id, title: r.service_title } : null, startsAt: r.starts_at, endsAt: r.ends_at, note: r.note })) };
}

async function addBlock(vendorId, body = {}) {
  const startsAt = new Date(text(body.startsAt));
  const endsAt = new Date(text(body.endsAt));
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new BookingError(400, 'Pick when the block starts and ends.');
  if (endsAt <= startsAt) throw new BookingError(400, 'The end must be after the start.');
  if (endsAt <= new Date()) throw new BookingError(400, 'That time has already passed.');
  if (endsAt - startsAt > 31 * 86400000) throw new BookingError(400, 'Block at most 31 days at once.');
  let serviceId = null;
  if (body.serviceId != null) {
    serviceId = readId(body.serviceId, 'Service');
    const { rows } = await pool.query('SELECT 1 FROM vendor_services WHERE id = $1 AND vendor_id = $2', [serviceId, vendorId]);
    if (!rows[0]) throw new BookingError(404, 'Service not found');
  }
  const note = text(body.note).slice(0, 140);
  const { rows } = await pool.query(
    'INSERT INTO service_booking_blocks (vendor_id, service_id, starts_at, ends_at, note) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [vendorId, serviceId, startsAt, endsAt, note || null]
  );
  return { id: rows[0].id };
}

async function removeBlock(vendorId, rawId) {
  const id = readId(rawId, 'Block');
  const { rowCount } = await pool.query('DELETE FROM service_booking_blocks WHERE id = $1 AND vendor_id = $2', [id, vendorId]);
  if (!rowCount) throw new BookingError(404, 'Block not found');
}

module.exports = {
  BookingError,
  slotMinutes,
  bookableDays,
  slots,
  availability,
  create,
  get,
  list,
  move,
  listBlocks,
  addBlock,
  removeBlock,
};
