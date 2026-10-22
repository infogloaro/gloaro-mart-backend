/**
 * Shop visits and popularity (SB5, schema "SHOP VISITS"). The app reports
 * shop-page views; each visitor counts once per shop per India day, and the
 * daily roll-up feeds the shop list's visited / trending sorts and the shop's
 * own dashboard. "Ordered" ranks by delivered orders that stayed sold.
 * Paid placement never moves any of these: views that came from an ad tap
 * aren't counted.
 */
const pool = require('../config/db');

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BATCH = 50;
// A visitor counts towards at most this many shops a day: past it they're
// scraping, not shopping.
const MAX_SHOPS_PER_DAY = 60;
// Trending needs this many visitors in the last 7 days, and more than the 7 before.
const TREND_MIN_VISITORS = 5;
// Visitor rows are only for de-duplication; the daily totals are kept.
const KEEP_VIEW_DAYS = 35;
// Returns that undo a sale (a request still being decided doesn't).
const RETURNED = ['approved', 'pickup_scheduled', 'picked_up', 'received', 'refunded'];
const BOT_AGENT = /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|curl\/|wget|python-requests|go-http-client|scrapy/i;

const TODAY_SQL = "(now() AT TIME ZONE 'Asia/Kolkata')::date";

class VisitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isBot(userAgent) {
  return !userAgent || BOT_AGENT.test(userAgent);
}

/**
 * Stores a batch of shop views. Returns { accepted, counted }: accepted is how
 * many were read, counted how many were new visits. Unknown or unapproved
 * shops, repeats and the filtered cases above are accepted but not counted.
 */
async function recordViews({ sessionId, events, userId, role, userAgent }) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    throw new VisitError(400, 'sessionId is 8–64 letters, digits, - or _.');
  }
  if (!Array.isArray(events) || events.length === 0) throw new VisitError(400, 'Send at least one view.');
  if (events.length > MAX_BATCH) throw new VisitError(400, `At most ${MAX_BATCH} views per request.`);
  const now = Date.now();
  const views = events.map((e) => {
    const vendorId = Number(e?.vendorId);
    if (!Number.isInteger(vendorId) || vendorId <= 0) throw new VisitError(400, 'vendorId must be a shop id.');
    if (e.source != null && typeof e.source !== 'string') throw new VisitError(400, 'source must be text.');
    // App times (views are often sent late, from a queue), kept within the last day.
    let at = e.at ? Date.parse(e.at) : NaN;
    if (Number.isNaN(at) || at > now || at < now - 86400000) at = now;
    return { vendorId, fromAd: e.source === 'ad', at: new Date(at) };
  });
  const accepted = views.length;
  if (isBot(userAgent) || role === 'admin') return { accepted, counted: 0 };

  const visitor = userId ? `u:${userId}` : `s:${sessionId}`;
  // Signed in: the guest row from earlier in the same session is the same person.
  const aliases = userId ? [visitor, `s:${sessionId}`] : [visitor];
  let counted = 0;
  for (const v of views) {
    if (v.fromAd) continue;
    if (userId) {
      // This session's guest visit becomes the user's, so the same person on
      // another device later that day isn't counted again. Not a new visit.
      await pool.query(
        `UPDATE shop_views s SET visitor = $3, user_id = $4
         WHERE s.vendor_id = $1 AND s.day = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AND s.visitor = $5
           AND NOT EXISTS (SELECT 1 FROM shop_views u WHERE u.vendor_id = s.vendor_id AND u.day = s.day AND u.visitor = $3)`,
        [v.vendorId, v.at, visitor, userId, `s:${sessionId}`]
      );
    }
    const { rows } = await pool.query(
      `WITH p AS (SELECT ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AS day),
       ins AS (
         INSERT INTO shop_views (vendor_id, day, visitor, user_id, first_seen_at)
         SELECT vp.id, p.day, $3, $4, $2
         FROM vendor_profiles vp, p
         WHERE vp.id = $1 AND vp.status = 'approved'
           AND vp.user_id IS DISTINCT FROM $4::int
           AND NOT EXISTS (SELECT 1 FROM shop_views s WHERE s.vendor_id = vp.id AND s.day = p.day AND s.visitor = ANY($5::text[]))
           AND (SELECT COUNT(*) FROM shop_views s WHERE s.visitor = ANY($5::text[]) AND s.day = p.day) < ${MAX_SHOPS_PER_DAY}
         ON CONFLICT DO NOTHING
         RETURNING vendor_id, day)
       INSERT INTO shop_visit_daily (vendor_id, day, visitors)
       SELECT vendor_id, day, 1 FROM ins
       ON CONFLICT (vendor_id, day) DO UPDATE SET visitors = shop_visit_daily.visitors + 1
       RETURNING vendor_id`,
      [v.vendorId, v.at, visitor, userId ?? null, aliases]
    );
    if (rows[0]) counted += 1;
  }
  return { accepted, counted };
}

/**
 * Joins for the popularity sorts on the shop list [alias]: `sv` has
 * visits_30d, visits_7d and visits_prev_7d (visitors, India days, today
 * included), `so` has orders_30d (delivered orders placed in the last 30 days,
 * not replacements, not returned).
 */
function popularityJoinSql(alias = 'vp') {
  return `
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(d.visitors), 0)::int AS visits_30d,
             COALESCE(SUM(d.visitors) FILTER (WHERE d.day > ${TODAY_SQL} - 7), 0)::int AS visits_7d,
             COALESCE(SUM(d.visitors) FILTER (WHERE d.day <= ${TODAY_SQL} - 7 AND d.day > ${TODAY_SQL} - 14), 0)::int AS visits_prev_7d
      FROM shop_visit_daily d
      WHERE d.vendor_id = ${alias}.id AND d.day > ${TODAY_SQL} - 30
    ) sv ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS orders_30d
      FROM orders o
      WHERE o.vendor_id = ${alias}.id AND o.status = 'delivered'
        AND o.created_at >= now() - interval '30 days'
        AND o.replacement_of_order_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM order_returns r
                        WHERE r.order_id = o.id AND r.status IN (${RETURNED.map((s) => `'${s}'`).join(', ')}))
    ) so ON true`;
}

const POPULARITY_FIELDS = 'sv.visits_30d, sv.visits_7d, sv.visits_prev_7d, so.orders_30d';

/** Only shops whose visits are growing, from a real base. */
const TRENDING_CONDITION = `(sv.visits_7d >= ${TREND_MIN_VISITORS} AND sv.visits_7d > sv.visits_prev_7d)`;

/** Growth over the previous week, damped so 1 → 5 visitors doesn't beat 40 → 80. */
const TREND_SCORE_SQL = '((sv.visits_7d - sv.visits_prev_7d)::float8 / GREATEST(sv.visits_prev_7d, 3))';

/** What the shop sees: visitors today, in the last 7 and the last 30 days. */
async function visitStats(vendorId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(visitors) FILTER (WHERE day = ${TODAY_SQL}), 0)::int AS today,
            COALESCE(SUM(visitors) FILTER (WHERE day > ${TODAY_SQL} - 7), 0)::int AS last7,
            COALESCE(SUM(visitors), 0)::int AS last30
     FROM shop_visit_daily WHERE vendor_id = $1 AND day > ${TODAY_SQL} - 30`,
    [vendorId]
  );
  return { today: rows[0].today, last7Days: rows[0].last7, last30Days: rows[0].last30 };
}

/** Drops visitor rows nobody needs for de-duplication any more. Returns how many. */
async function pruneViews() {
  const { rowCount } = await pool.query(`DELETE FROM shop_views WHERE day < ${TODAY_SQL} - ${KEEP_VIEW_DAYS}`);
  return rowCount;
}

module.exports = {
  VisitError,
  MAX_SHOPS_PER_DAY,
  TREND_MIN_VISITORS,
  isBot,
  recordViews,
  popularityJoinSql,
  POPULARITY_FIELDS,
  TRENDING_CONDITION,
  TREND_SCORE_SQL,
  visitStats,
  pruneViews,
};
