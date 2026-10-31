/**
 * Shop hours (SB3, schema "SHOP HOURS"): a weekly timetable, holidays and the
 * shop's timezone. Whether a shop is open is decided by one SQL function,
 * shop_open_at(), so the shop list, the shop page and checkout always agree,
 * and it reads the shop's own clock rather than the server's.
 */
const pool = require('../config/db');

const MAX_UPCOMING_HOLIDAYS = 60;
const HOLIDAY_DAYS_AHEAD = 366;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HoursError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** SQL: true / false for the shop [alias] right now, NULL when it never gave hours. */
function openNowSql(alias = 'vp') {
  return `shop_open_at(${alias}.id, now())`;
}

/**
 * SQL: today's hours on the shop's clock as JSON
 * { closed_all_day, holiday, note, opens_at, closes_at }, or NULL when the
 * shop has no weekly hours and no holiday today (its daily window applies).
 */
function todaySql(alias = 'vp') {
  return `(SELECT CASE WHEN h.vendor_id IS NULL AND x.id IS NULL THEN NULL ELSE json_build_object(
      'closed_all_day', x.id IS NOT NULL OR COALESCE(h.is_closed, false),
      'holiday', x.id IS NOT NULL,
      'note', x.note,
      'opens_at', CASE WHEN x.id IS NULL AND NOT h.is_closed THEN h.opens_at END,
      'closes_at', CASE WHEN x.id IS NULL AND NOT h.is_closed THEN h.closes_at END) END
    FROM (SELECT now() AT TIME ZONE ${alias}.timezone AS ts) l
    LEFT JOIN vendor_hours h ON h.vendor_id = ${alias}.id AND h.day_of_week = EXTRACT(DOW FROM l.ts)
    LEFT JOIN vendor_holidays x ON x.vendor_id = ${alias}.id AND x.holiday_date = l.ts::date)`;
}

/**
 * The hours fields in a body, checked: { timezone?, week? }. week is all 7
 * days ({ day 0 = Sunday … 6, closed } or { day, opensAt, closesAt }), or []
 * to go back to the daily window.
 */
function readWeek(body = {}) {
  const out = {};
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || !body.timezone.trim() || body.timezone.length > 64) {
      throw new HoursError(400, 'timezone must be a name like Asia/Kolkata.');
    }
    out.timezone = body.timezone.trim();
  }
  if (body.week !== undefined) {
    if (!Array.isArray(body.week) || (body.week.length !== 0 && body.week.length !== 7)) {
      throw new HoursError(400, 'week must list all 7 days (0 = Sunday … 6 = Saturday), or be empty to use the daily hours.');
    }
    const seen = new Set();
    out.week = body.week.map((d) => {
      const day = Number(d?.day);
      if (!Number.isInteger(day) || day < 0 || day > 6 || seen.has(day)) {
        throw new HoursError(400, 'Each day 0–6 must appear exactly once.');
      }
      seen.add(day);
      if (d.closed === true) return { day, closed: true, opensAt: null, closesAt: null };
      if (!TIME_RE.test(String(d.opensAt ?? '')) || !TIME_RE.test(String(d.closesAt ?? ''))) {
        throw new HoursError(400, `Day ${day}: opensAt and closesAt must be HH:MM, or mark the day closed.`);
      }
      return { day, closed: false, opensAt: d.opensAt, closesAt: d.closesAt };
    });
  }
  if (out.timezone === undefined && out.week === undefined) {
    throw new HoursError(400, 'Send week, timezone or both.');
  }
  return out;
}

/** A holiday in a body, checked: { date: YYYY-MM-DD, note? ≤80 }. */
function readHoliday(body = {}) {
  const date = typeof body.date === 'string' ? body.date.trim() : '';
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!DATE_RE.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new HoursError(400, 'date must be YYYY-MM-DD.');
  }
  if (body.note != null && typeof body.note !== 'string') throw new HoursError(400, 'note must be text.');
  const note = (body.note ?? '').trim();
  if (note.length > 80) throw new HoursError(400, 'The note is at most 80 characters.');
  return { date, note: note || null };
}

async function upcomingHolidays(vendorId, db = pool) {
  const { rows } = await db.query(
    `SELECT x.id, x.holiday_date::text AS date, x.note
     FROM vendor_holidays x JOIN vendor_profiles vp ON vp.id = x.vendor_id
     WHERE x.vendor_id = $1 AND x.holiday_date >= (now() AT TIME ZONE vp.timezone)::date
     ORDER BY x.holiday_date LIMIT ${MAX_UPCOMING_HOLIDAYS}`,
    [vendorId]
  );
  return rows;
}

async function weekOf(vendorId, db = pool) {
  const { rows } = await db.query(
    'SELECT day_of_week, is_closed, opens_at, closes_at FROM vendor_hours WHERE vendor_id = $1 ORDER BY day_of_week',
    [vendorId]
  );
  return rows;
}

/** Everything about a shop's hours, for the shop itself and the admin. */
async function getHours(vendorId) {
  const [{ rows }, week, holidays] = await Promise.all([
    pool.query(
      `SELECT vp.timezone, ${openNowSql('vp')} AS open_now, ${todaySql('vp')} AS hours_today,
              dr.opens_at, dr.closes_at
       FROM vendor_profiles vp LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = vp.id
       WHERE vp.id = $1`,
      [vendorId]
    ),
    weekOf(vendorId),
    upcomingHolidays(vendorId),
  ]);
  if (!rows[0]) throw new HoursError(404, 'Vendor not found');
  const v = rows[0];
  return {
    timezone: v.timezone,
    week,
    holidays,
    open_now: v.open_now,
    hours_today: v.hours_today,
    daily_hours: { opens_at: v.opens_at, closes_at: v.closes_at },
  };
}

/** What a customer sees on the shop page: the week and the coming holidays. */
async function publicHours(vendorId) {
  const [week, holidays] = await Promise.all([weekOf(vendorId), upcomingHolidays(vendorId)]);
  return { hours: week, holidays };
}

/** Saves the timezone and/or replaces the whole week, in one transaction. */
async function saveHours(vendorId, input) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One writer per shop at a time, so two saves can't interleave the week.
    const { rows } = await client.query('SELECT id FROM vendor_profiles WHERE id = $1 FOR UPDATE', [vendorId]);
    if (!rows[0]) throw new HoursError(404, 'Vendor not found');
    if (input.timezone !== undefined) {
      const { rows: tz } = await client.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [input.timezone]);
      if (!tz[0]) throw new HoursError(400, 'Unknown timezone; use a name like Asia/Kolkata.');
      await client.query('UPDATE vendor_profiles SET timezone = $2 WHERE id = $1', [vendorId, input.timezone]);
    }
    if (input.week !== undefined) {
      await client.query('DELETE FROM vendor_hours WHERE vendor_id = $1', [vendorId]);
      for (const d of input.week) {
        await client.query(
          'INSERT INTO vendor_hours (vendor_id, day_of_week, is_closed, opens_at, closes_at) VALUES ($1, $2, $3, $4, $5)',
          [vendorId, d.day, d.closed, d.opensAt, d.closesAt]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getHours(vendorId);
}

/** Adds a holiday: today to a year ahead on the shop's clock, at most 60 upcoming. */
async function addHoliday(vendorId, body) {
  const h = readHoliday(body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT $2::date < (now() AT TIME ZONE timezone)::date AS past,
              $2::date > (now() AT TIME ZONE timezone)::date + ${HOLIDAY_DAYS_AHEAD} AS too_far
       FROM vendor_profiles WHERE id = $1 FOR UPDATE`,
      [vendorId, h.date]
    );
    if (!rows[0]) throw new HoursError(404, 'Vendor not found');
    if (rows[0].past) throw new HoursError(400, 'That date has passed.');
    if (rows[0].too_far) throw new HoursError(400, 'Holidays can be set up to a year ahead.');
    if ((await upcomingHolidays(vendorId, client)).length >= MAX_UPCOMING_HOLIDAYS) {
      throw new HoursError(409, `At most ${MAX_UPCOMING_HOLIDAYS} upcoming holidays.`);
    }
    const { rows: added } = await client.query(
      `INSERT INTO vendor_holidays (vendor_id, holiday_date, note) VALUES ($1, $2, $3)
       ON CONFLICT (vendor_id, holiday_date) DO NOTHING
       RETURNING id, holiday_date::text AS date, note`,
      [vendorId, h.date, h.note]
    );
    if (!added[0]) throw new HoursError(409, 'That date is already a holiday.');
    await client.query('COMMIT');
    return added[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function removeHoliday(vendorId, holidayId) {
  const id = Number(holidayId);
  if (!Number.isInteger(id)) throw new HoursError(404, 'Holiday not found');
  const { rowCount } = await pool.query('DELETE FROM vendor_holidays WHERE id = $1 AND vendor_id = $2', [id, vendorId]);
  if (rowCount === 0) throw new HoursError(404, 'Holiday not found');
}

/**
 * Open right now, per shop (true / false / null = never said), for checkout
 * and "also available at". Read outside any caller transaction. Before
 * `npm run migrate:shop-hours` the function doesn't exist yet: the map comes
 * back empty and checkout keeps its old daily-window check.
 */
async function openNowFor(vendorIds) {
  if (vendorIds.length === 0) return new Map();
  try {
    const { rows } = await pool.query(
      'SELECT id, shop_open_at(id, now()) AS open_now FROM vendor_profiles WHERE id = ANY($1)',
      [vendorIds]
    );
    return new Map(rows.map((r) => [r.id, r.open_now]));
  } catch (err) {
    if (err.code === '42883' || err.code === '42P01' || err.code === '42703') return new Map();
    throw err;
  }
}

/**
 * VD2: extra preparation minutes each shop asked for while busy (0 when not
 * busy). Empty before the migration, so ETAs stay as they were.
 */
async function busyMinutesFor(vendorIds) {
  if (vendorIds.length === 0) return new Map();
  try {
    const { rows } = await pool.query(
      'SELECT id, shop_busy_minutes(id, now()) AS busy FROM vendor_profiles WHERE id = ANY($1)',
      [vendorIds]
    );
    return new Map(rows.map((r) => [r.id, r.busy]));
  } catch (err) {
    if (err.code === '42883' || err.code === '42P01' || err.code === '42703') return new Map();
    throw err;
  }
}

module.exports = {
  HoursError,
  busyMinutesFor,
  MAX_UPCOMING_HOLIDAYS,
  openNowSql,
  todaySql,
  readWeek,
  readHoliday,
  getHours,
  publicHours,
  saveHours,
  addHoliday,
  removeHoliday,
  openNowFor,
};
