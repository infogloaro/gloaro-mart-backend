/**
 * Ad fixes (SB10, schema "AD FIXES"):
 *
 * 1. Returned orders give the ad commission back. An order credited to an ad
 *    (services/adServing.js attributeOrders) that is later refunded on a return
 *    is reversed: the shop is credited the commission it paid on it (a negative
 *    vendor_charges row, paid in its next settlement), the ad ledger gets an
 *    'ad_reversal' line, and the campaign's daily results drop the order. A
 *    partial refund reverses that share; later refunds on the same order top
 *    it up. Only refund returns that reached 'refunded' count (a replacement
 *    keeps the sale).
 * 2. Repeated taps. Taps on one ad from one session, or one network address,
 *    many times in a day are listed for the admin, who can mark them invalid
 *    ("don't bill"): they leave the shop's click count, can't credit an order
 *    to the ad, and an order they already credited is reversed as above.
 *    Restoring them brings the clicks back but not a reversed order.
 */
const crypto = require('crypto');
const pool = require('../config/db');
const { JWT_SECRET } = require('../middleware/auth');

// A day's taps on one ad at or above these is listed for review.
const SESSION_CLICKS = 5;
const ADDRESS_CLICKS = 10;
const MAX_DAYS = 90;
const IST_DAY = (col) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;
const SALT = process.env.AD_IP_SALT || JWT_SECRET;

class AdFixError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The shopper's address: the first X-Forwarded-For hop when a proxy (Render)
 * sends one, else the socket's. Only ever stored hashed.
 */
function clientIp(req) {
  const forwarded = req.get?.('x-forwarded-for');
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return first || req.ip || '';
}

function ipHash(ip) {
  if (!ip) return null;
  return crypto.createHmac('sha256', SALT).update(String(ip)).digest('hex').slice(0, 16);
}

/**
 * Reverses attribution [a] (row of ad_attributions + vendor_id, order_created_at,
 * reference, reversals) up to [target] cents of its goods value, inside the
 * caller's transaction. Returns { valueCents, commissionCents } reversed now, or
 * null when nothing was left to reverse.
 */
async function reverse(client, a, { reason, target, returnId = null, actorId = null }) {
  const value = Number(a.order_value_cents);
  const commission = Number(a.commission_cents);
  const doneValue = Number(a.reversed_value_cents);
  const doneCommission = Number(a.reversed_commission_cents);
  const wasFull = value > 0 ? doneValue >= value : Number(a.reversals) > 0;
  const targetValue = Math.min(value, Math.max(0, Math.round(target)));
  const full = targetValue >= value;
  const deltaValue = targetValue - doneValue;
  if (wasFull || (deltaValue <= 0 && !(full && value === 0))) return null;
  const targetCommission = full || value === 0 ? commission : Math.round((commission * targetValue) / value);
  const deltaCommission = Math.max(0, targetCommission - doneCommission);
  const why = reason === 'returned' ? 'returned' : 'invalid ad tap';

  let chargeId = null;
  if (deltaCommission > 0) {
    const { rows } = await client.query(
      "INSERT INTO vendor_charges (vendor_id, kind, label, amount_cents) VALUES ($1, 'ad_reversal', $2, $3) RETURNING id",
      [a.vendor_id, `Ad commission back on order #${a.order_id} (${a.reference}, ${why})`, -deltaCommission]
    );
    chargeId = rows[0].id;
    await client.query(
      "INSERT INTO ad_ledger (campaign_id, vendor_id, entry, amount_cents, note) VALUES ($1, $2, 'ad_reversal', $3, $4)",
      [a.campaign_id, a.vendor_id, -deltaCommission, `Order #${a.order_id} ${why}`]
    );
  }
  await client.query(
    `INSERT INTO ad_attribution_reversals (order_id, campaign_id, reason, return_id, value_cents, commission_cents, vendor_charge_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [a.order_id, a.campaign_id, reason, returnId, Math.max(0, deltaValue), deltaCommission, chargeId, actorId]
  );
  await client.query(
    `UPDATE ad_attributions SET reversed_value_cents = reversed_value_cents + $2, reversed_commission_cents = reversed_commission_cents + $3
     WHERE order_id = $1`,
    [a.order_id, Math.max(0, deltaValue), deltaCommission]
  );
  // The campaign's results: the day and slot the order was credited to.
  await client.query(
    `UPDATE ad_stats_daily SET orders = GREATEST(0, orders - $4),
       order_value_cents = GREATEST(0, order_value_cents - $5), commission_cents = GREATEST(0, commission_cents - $6)
     WHERE campaign_id = $1 AND day = ${IST_DAY('$2::timestamptz')} AND placement = $3`,
    [a.campaign_id, a.order_created_at, a.placement, full ? 1 : 0, Math.max(0, deltaValue), deltaCommission]
  );
  return { valueCents: Math.max(0, deltaValue), commissionCents: deltaCommission };
}

const ATTRIBUTION_SQL = `
  SELECT a.*, o.vendor_id, o.created_at AS order_created_at, c.reference,
         (SELECT COUNT(*)::int FROM ad_attribution_reversals x WHERE x.order_id = a.order_id) AS reversals
  FROM ad_attributions a JOIN orders o ON o.id = a.order_id JOIN ad_campaigns c ON c.id = a.campaign_id`;

/**
 * Sweep: reverses credited orders refunded on a return since. Returns how
 * many orders were reversed (wholly or in part) this time.
 */
async function reverseReturnedOrders({ limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.order_id,
            LEAST(a.order_value_cents, SUM(COALESCE(r.approved_refund_cents, rf.amount_cents, a.order_value_cents)))::int AS refunded,
            MAX(r.id) AS return_id
     FROM ad_attributions a
     JOIN order_returns r ON r.order_id = a.order_id AND r.status = 'refunded' AND r.resolution = 'refund'
     LEFT JOIN refunds rf ON rf.id = r.refund_id
     GROUP BY a.order_id, a.order_value_cents, a.reversed_value_cents
     HAVING LEAST(a.order_value_cents, SUM(COALESCE(r.approved_refund_cents, rf.amount_cents, a.order_value_cents))) > a.reversed_value_cents
        OR (a.order_value_cents = 0 AND NOT EXISTS (SELECT 1 FROM ad_attribution_reversals x WHERE x.order_id = a.order_id))
     ORDER BY a.order_id LIMIT $1`,
    [limit]
  );
  let reversed = 0;
  for (const due of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: found } = await client.query(`${ATTRIBUTION_SQL} WHERE a.order_id = $1 FOR UPDATE OF a`, [due.order_id]);
      const done = found[0] && (await reverse(client, found[0], { reason: 'returned', target: due.refunded, returnId: due.return_id }));
      await client.query('COMMIT');
      if (done) reversed += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return reversed;
}

const int = (v) => (v == null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

/**
 * Groups of repeated taps for review: per ad, India day, and session or
 * address, at or above the thresholds, newest day first.
 */
async function listRepeatedTaps(query = {}) {
  const days = int(query.days) ?? 7;
  const campaignId = int(query.campaignId);
  const minSession = int(query.minSession) ?? SESSION_CLICKS;
  const minAddress = int(query.minAddress) ?? ADDRESS_CLICKS;
  if (!(days >= 1 && days <= MAX_DAYS)) throw new AdFixError(400, `days is 1–${MAX_DAYS}.`);
  if (Number.isNaN(campaignId)) throw new AdFixError(400, 'campaignId must be an id.');
  if (!(minSession >= 2 && minAddress >= 2)) throw new AdFixError(400, 'minSession and minAddress are at least 2.');
  const status = ['open', 'marked', 'all'].includes(query.status) ? query.status : 'all';
  const { rows } = await pool.query(
    `WITH taps AS (
       SELECT e.id, e.campaign_id, e.session_id, e.ip_hash, e.user_id, e.invalid_at, e.occurred_at, ${IST_DAY('e.occurred_at')} AS day
       FROM ad_events e
       WHERE e.event = 'click' AND e.occurred_at >= now() - make_interval(days => $1) AND ($2::int IS NULL OR e.campaign_id = $2)
     ), groups AS (
       SELECT campaign_id, day, 'session' AS by, session_id AS key, array_agg(id) AS ids, COUNT(*)::int AS taps,
              COUNT(*) FILTER (WHERE invalid_at IS NOT NULL)::int AS invalid, COUNT(DISTINCT session_id)::int AS sessions,
              COUNT(DISTINCT user_id)::int AS signed_in, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
       FROM taps GROUP BY campaign_id, day, session_id HAVING COUNT(*) >= $3
       UNION ALL
       SELECT campaign_id, day, 'address', ip_hash, array_agg(id), COUNT(*)::int,
              COUNT(*) FILTER (WHERE invalid_at IS NOT NULL)::int, COUNT(DISTINCT session_id)::int,
              COUNT(DISTINCT user_id)::int, MIN(occurred_at), MAX(occurred_at)
       FROM taps WHERE ip_hash IS NOT NULL GROUP BY campaign_id, day, ip_hash HAVING COUNT(*) >= $4
     )
     SELECT g.campaign_id, to_char(g.day, 'YYYY-MM-DD') AS day, g.by, g.key, g.taps, g.invalid, g.sessions, g.signed_in,
            g.first_at, g.last_at, c.reference, c.title, c.vendor_id, vp.business_name,
            (SELECT COUNT(*)::int FROM ad_attributions a WHERE a.click_event_id = ANY(g.ids)) AS credited_orders
     FROM groups g JOIN ad_campaigns c ON c.id = g.campaign_id JOIN vendor_profiles vp ON vp.id = c.vendor_id
     WHERE $5 = 'all' OR ($5 = 'open' AND g.invalid < g.taps) OR ($5 = 'marked' AND g.invalid > 0)
     ORDER BY g.day DESC, g.taps DESC, g.campaign_id
     LIMIT 200`,
    [days, campaignId, minSession, minAddress, status]
  );
  return {
    items: rows.map((r) => ({
      campaignId: r.campaign_id,
      reference: r.reference,
      title: r.title,
      shop: { id: r.vendor_id, name: r.business_name },
      day: r.day,
      by: r.by,
      key: r.key,
      taps: r.taps,
      invalid: r.invalid,
      sessions: r.sessions,
      signedIn: r.signed_in,
      firstAt: r.first_at,
      lastAt: r.last_at,
      creditedOrders: r.credited_orders,
    })),
    thresholds: { session: minSession, address: minAddress, days },
  };
}

/**
 * Marks one group's taps invalid ({invalid: true}, "don't bill") or valid
 * again. Returns { changed, reversedOrders, commissionBackCents }.
 */
async function markTaps(body = {}, actorId) {
  const campaignId = int(body.campaignId);
  if (!Number.isInteger(campaignId) || campaignId <= 0) throw new AdFixError(400, 'campaignId must be an id.');
  if (typeof body.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) throw new AdFixError(400, 'day is YYYY-MM-DD.');
  if (!['session', 'address'].includes(body.by)) throw new AdFixError(400, "by is 'session' or 'address'.");
  if (typeof body.key !== 'string' || !body.key.trim() || body.key.length > 64) throw new AdFixError(400, 'key is the session or address shown in the list.');
  if (typeof body.invalid !== 'boolean') throw new AdFixError(400, 'invalid must be true or false.');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  const column = body.by === 'session' ? 'session_id' : 'ip_hash';
  const match = `event = 'click' AND campaign_id = $1 AND ${IST_DAY('occurred_at')} = $2::date AND ${column} = $3`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: all } = await client.query(`SELECT COUNT(*)::int AS n FROM ad_events WHERE ${match}`, [campaignId, body.day, body.key]);
    if (!all[0].n) throw new AdFixError(404, 'No taps match that ad, day and session or address.');
    const { rows: changed } = body.invalid
      ? await client.query(
          `UPDATE ad_events SET invalid_at = now(), invalid_by = $4, invalid_note = $5 WHERE ${match} AND invalid_at IS NULL
           RETURNING id, placement, occurred_at`,
          [campaignId, body.day, body.key, actorId ?? null, note || null]
        )
      : await client.query(
          `UPDATE ad_events SET invalid_at = NULL, invalid_by = NULL, invalid_note = NULL WHERE ${match} AND invalid_at IS NOT NULL
           RETURNING id, placement, occurred_at`,
          [campaignId, body.day, body.key]
        );
    // The shop's click count, per slot (every tap here is on the same day).
    const perSlot = new Map();
    for (const e of changed) {
      const slot = perSlot.get(e.placement) ?? { n: 0, at: e.occurred_at };
      slot.n += 1;
      perSlot.set(e.placement, slot);
    }
    for (const [placement, { n, at }] of perSlot) {
      await client.query(
        `UPDATE ad_stats_daily SET clicks = GREATEST(0, clicks ${body.invalid ? '-' : '+'} $4)
         WHERE campaign_id = $1 AND day = ${IST_DAY('$2::timestamptz')} AND placement = $3`,
        [campaignId, at, placement, n]
      );
    }
    let reversedOrders = 0;
    let commissionBackCents = 0;
    if (body.invalid && changed.length) {
      const { rows: credited } = await client.query(
        `${ATTRIBUTION_SQL} WHERE a.click_event_id = ANY($1::bigint[]) FOR UPDATE OF a`,
        [changed.map((e) => e.id)]
      );
      for (const a of credited) {
        const done = await reverse(client, a, { reason: 'invalid_click', target: Number(a.order_value_cents), actorId });
        if (done) {
          reversedOrders += 1;
          commissionBackCents += done.commissionCents;
        }
      }
    }
    await client.query('COMMIT');
    return { changed: changed.length, reversedOrders, commissionBackCents };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  AdFixError,
  SESSION_CLICKS,
  ADDRESS_CLICKS,
  clientIp,
  ipHash,
  reverseReturnedOrders,
  listRepeatedTaps,
  markTaps,
};
