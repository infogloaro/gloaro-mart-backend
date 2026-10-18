const pool = require('../config/db');

/**
 * App events for Admin → Analytics (schema PHASE 48): sessions and how far each
 * got towards buying. The app sends them in batches; checkout records
 * 'order_placed' itself, so the end of the funnel doesn't depend on the app
 * remembering to report it.
 */

const CLIENT_EVENTS = ['session_start', 'product_view', 'add_to_cart', 'checkout_start'];
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BATCH = 50;
const PLATFORMS = ['android', 'ios', 'web'];

class AnalyticsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Stores a batch. Times are the app's (events are often sent late, from a
 * queue), but kept within the last day and never in the future.
 */
async function recordBatch({ sessionId, platform, events, userId }) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    throw new AnalyticsError(400, 'sessionId is 8–64 letters, digits, - or _.');
  }
  if (!Array.isArray(events) || events.length === 0) throw new AnalyticsError(400, 'Send at least one event.');
  if (events.length > MAX_BATCH) throw new AnalyticsError(400, `At most ${MAX_BATCH} events per request.`);
  const plat = PLATFORMS.includes(platform) ? platform : null;
  const now = Date.now();
  const rows = events.map((e) => {
    if (!CLIENT_EVENTS.includes(e?.type)) throw new AnalyticsError(400, `type is one of ${CLIENT_EVENTS.join(', ')}.`);
    const productId = e.productId == null ? null : Number(e.productId);
    if (productId != null && !Number.isInteger(productId)) throw new AnalyticsError(400, 'productId must be an id.');
    let at = e.at ? Date.parse(e.at) : NaN;
    if (Number.isNaN(at) || at > now || at < now - 86400000) at = now;
    return { type: e.type, productId, at: new Date(at) };
  });
  // Product ids that don't exist are dropped to null rather than failing the batch.
  const ids = [...new Set(rows.map((r) => r.productId).filter((x) => x != null))];
  const known = new Set();
  if (ids.length) {
    const { rows: found } = await pool.query('SELECT id FROM products WHERE id = ANY($1)', [ids]);
    for (const f of found) known.add(f.id);
  }
  await pool.query(
    `INSERT INTO analytics_events (session_id, user_id, event, product_id, platform, occurred_at)
     SELECT $1, $2, t.event, t.product_id, $3, t.at
     FROM unnest($4::text[], $5::int[], $6::timestamptz[]) AS t(event, product_id, at)`,
    [sessionId, userId ?? null, plat,
      rows.map((r) => r.type), rows.map((r) => (known.has(r.productId) ? r.productId : null)), rows.map((r) => r.at)]
  );
  return rows.length;
}

/** An event the server sees for itself, for the session named in X-Session-Id. No header, nothing recorded. */
async function recordServerEvent(req, event) {
  const sessionId = req.get('x-session-id');
  if (!sessionId || !SESSION_ID.test(sessionId)) return;
  const platform = PLATFORMS.includes(req.get('x-platform')) ? req.get('x-platform') : null;
  await pool.query('INSERT INTO analytics_events (session_id, user_id, event, platform) VALUES ($1, $2, $3, $4)', [
    sessionId, req.user?.id ?? null, event, platform,
  ]);
}

module.exports = { AnalyticsError, CLIENT_EVENTS, recordBatch, recordServerEvent };
