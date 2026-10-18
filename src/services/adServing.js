const pool = require('../config/db');

/**
 * Ads in the app (schema PHASE 54): which live campaigns a viewer sees in a
 * slot, counting what was shown and tapped, and crediting orders to the ad
 * that brought them. Plan: docs/ad-promotions-plan.md §5.
 */

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EVENTS = ['impression', 'click', 'enquiry'];
const MAX_BATCH = 50;
// Compared without case, spaces or punctuation: "Tamil Nadu" = "TAMILNADU".
const NORM = (sql) => `lower(regexp_replace(${sql}, '[^A-Za-z]', '', 'g'))`;

class ServeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * Live ads for one slot and one viewer. The viewer is described by what the
 * app knows — map point and/or the city, district, state and country of the
 * delivery address — and an ad shows when any of its regions covers them:
 * a locality by distance, a city / district / state by name, a country by code.
 * At most the slot's "ads at once", in a random order so each gets its turn.
 */
async function serve(query) {
  const placement = clean(query.placement);
  if (!placement) throw new ServeError(400, 'placement is required.');
  const { rows: slot } = await pool.query('SELECT * FROM ad_placements WHERE key = $1', [placement]);
  if (!slot[0] || !slot[0].active) return { placement, items: [] };
  const { rows: cfg } = await pool.query('SELECT home_country FROM ad_settings WHERE id = 1');
  const lat = num(query.lat);
  const lng = num(query.lng);
  const point = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const country = (clean(query.country) ?? cfg[0]?.home_country ?? 'IN').toUpperCase().slice(0, 2);
  const limit = Math.min(slot[0].max_live_per_region, Math.max(1, Number(query.limit) || slot[0].max_live_per_region));
  const categoryId = num(query.categoryId);

  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.offer_text, c.description, c.cta_label, c.cta_kind, c.cta_target, c.vendor_id,
            vp.business_name, vp.city AS shop_city,
            (SELECT row_to_json(a) FROM (SELECT url, width, height FROM ad_assets WHERE campaign_id = c.id ORDER BY sort_order, id LIMIT 1) a) AS image
     FROM ad_campaigns c JOIN vendor_profiles vp ON vp.id = c.vendor_id
     WHERE c.status = 'live' AND c.starts_at <= now() AND c.ends_at > now() AND c.placements ? $1
       AND ($1 <> 'category_banner' OR c.category_id = $8::int)
       AND EXISTS (
         SELECT 1 FROM ad_campaign_regions cr JOIN ad_regions r ON r.id = cr.region_id
         WHERE cr.campaign_id = c.id AND r.active AND (
              (r.level = 'country' AND r.country_code = $2)
           OR (r.level = 'state' AND $3::text IS NOT NULL AND ${NORM('r.name')} = ${NORM('$3::text')})
           OR (r.level = 'district' AND (($4::text IS NOT NULL AND ${NORM('r.name')} = ${NORM('$4::text')})
                                      OR ($5::text IS NOT NULL AND ${NORM('r.name')} = ${NORM('$5::text')})))
           OR (r.level = 'city' AND $5::text IS NOT NULL AND ${NORM('r.name')} = ${NORM('$5::text')})
           OR (r.level = 'locality' AND $6::float8 IS NOT NULL
               AND earth_distance(ll_to_earth($6::float8, $7::float8), ll_to_earth(r.latitude, r.longitude)) <= r.radius_km * 1000)
         ))
       AND EXISTS (SELECT 1 FROM ad_assets a WHERE a.campaign_id = c.id)
     ORDER BY random()
     LIMIT ${limit}`,
    [placement, country, clean(query.state), clean(query.district), clean(query.city), point ? lat : null, point ? lng : null, categoryId]
  );
  return {
    placement,
    sponsoredLabel: slot[0].sponsored_label,
    items: rows.map((c) => ({
      campaignId: c.id,
      placement,
      title: c.title,
      offerText: c.offer_text,
      description: c.description,
      ctaLabel: c.cta_label,
      ctaKind: c.cta_kind,
      ctaTarget: c.cta_kind === 'shop' ? String(c.vendor_id) : c.cta_target,
      image: c.image,
      shop: { id: c.vendor_id, name: c.business_name, city: c.shop_city },
      sponsored: slot[0].sponsored_label,
    })),
  };
}

/**
 * What the app showed and what was tapped. Counted once per session, campaign
 * and slot per hour (impressions) or per minute (taps), and only while the
 * campaign was running. Returns how many were counted.
 */
async function recordEvents({ sessionId, events, userId }) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new ServeError(400, 'sessionId is 8–64 letters, digits, - or _.');
  if (!Array.isArray(events) || events.length === 0) throw new ServeError(400, 'Send at least one event.');
  if (events.length > MAX_BATCH) throw new ServeError(400, `At most ${MAX_BATCH} events per request.`);
  const now = Date.now();
  const list = events.map((e) => {
    if (!EVENTS.includes(e?.type)) throw new ServeError(400, `type is one of ${EVENTS.join(', ')}.`);
    const campaignId = Number(e.campaignId);
    if (!Number.isInteger(campaignId)) throw new ServeError(400, 'campaignId must be an id.');
    const placement = clean(e.placement);
    if (!placement) throw new ServeError(400, 'placement is required.');
    let at = e.at ? Date.parse(e.at) : NaN;
    if (Number.isNaN(at) || at > now || at < now - 86400000) at = now;
    return { campaignId, placement, type: e.type, at: new Date(at) };
  });
  const ids = [...new Set(list.map((e) => e.campaignId))];
  const { rows: camps } = await pool.query(
    `SELECT id, placements, starts_at, ends_at FROM ad_campaigns WHERE id = ANY($1) AND status IN ('live', 'paused', 'completed')`,
    [ids]
  );
  const byId = new Map(camps.map((c) => [c.id, c]));
  let counted = 0;
  for (const e of list) {
    const c = byId.get(e.campaignId);
    // Only while it ran (with an hour's grace for queued reports), in a slot it booked.
    if (!c || !(c.placements ?? []).includes(e.placement)) continue;
    if (e.at < new Date(c.starts_at) || e.at > new Date(new Date(c.ends_at).getTime() + 3600000)) continue;
    const unit = e.type === 'impression' ? 'hour' : 'minute';
    const { rows } = await pool.query(
      `INSERT INTO ad_events (campaign_id, event, placement, session_id, user_id, bucket, occurred_at)
       VALUES ($1, $2, $3, $4, $5, date_trunc('${unit}', $6::timestamptz), $6)
       ON CONFLICT (campaign_id, placement, session_id, event, bucket) DO NOTHING RETURNING id`,
      [e.campaignId, e.type, e.placement, sessionId, userId ?? null, e.at]
    );
    if (!rows[0]) continue;
    const col = { impression: 'impressions', click: 'clicks', enquiry: 'enquiries' }[e.type];
    await pool.query(
      `INSERT INTO ad_stats_daily (campaign_id, day, placement, ${col}) VALUES ($1, ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, $3, 1)
       ON CONFLICT (campaign_id, day, placement) DO UPDATE SET ${col} = ad_stats_daily.${col} + 1`,
      [e.campaignId, e.at, e.placement]
    );
    counted += 1;
  }
  return counted;
}

/**
 * Credits delivered orders to the ad that brought them: the signed-in
 * customer's latest tap on one of that shop's ads before ordering, within the
 * campaign's attribution window. On the commission models the shop owes
 * GLOARO the campaign's % of the order's goods value (after discounts), taken
 * from its next payout. Each order once.
 */
async function attributeOrders({ limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT o.id, o.user_id, o.vendor_id, o.subtotal_cents, o.discount_cents, o.created_at,
            k.event_id, k.campaign_id, k.placement, k.model, k.commission_percent, k.reference
     FROM orders o
     JOIN LATERAL (
       SELECT e.id AS event_id, e.campaign_id, e.placement, c.model, c.commission_percent, c.reference
       FROM ad_events e JOIN ad_campaigns c ON c.id = e.campaign_id
       WHERE e.event = 'click' AND e.user_id = o.user_id AND c.vendor_id = o.vendor_id
         AND e.occurred_at <= o.created_at
         AND e.occurred_at >= o.created_at - make_interval(days => COALESCE((c.price_snapshot->'settings'->>'attributionDays')::int, 7))
       ORDER BY e.occurred_at DESC LIMIT 1
     ) k ON TRUE
     WHERE o.status = 'delivered' AND o.replacement_of_order_id IS NULL
       AND o.created_at > now() - interval '120 days'
       AND NOT EXISTS (SELECT 1 FROM ad_attributions a WHERE a.order_id = o.id)
     ORDER BY o.id LIMIT $1`,
    [limit]
  );
  let credited = 0;
  for (const o of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = Math.max(0, o.subtotal_cents - o.discount_cents);
      const pct = ['commission', 'fixed_commission'].includes(o.model) ? Number(o.commission_percent) : 0;
      const commission = Math.round((value * pct) / 100);
      const { rows: ins } = await client.query(
        `INSERT INTO ad_attributions (order_id, campaign_id, click_event_id, placement, order_value_cents, commission_percent, commission_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (order_id) DO NOTHING RETURNING order_id`,
        [o.id, o.campaign_id, o.event_id, o.placement, value, pct, commission]
      );
      if (!ins[0]) {
        await client.query('ROLLBACK');
        continue;
      }
      await client.query('UPDATE orders SET ad_campaign_id = $2 WHERE id = $1', [o.id, o.campaign_id]);
      if (commission > 0) {
        const { rows: ch } = await client.query(
          "INSERT INTO vendor_charges (vendor_id, kind, label, amount_cents) VALUES ($1, 'ad_commission', $2, $3) RETURNING id",
          [o.vendor_id, `Ad commission ${pct}% on order #${o.id} (${o.reference})`, commission]
        );
        await client.query('UPDATE ad_attributions SET vendor_charge_id = $2 WHERE order_id = $1', [o.id, ch[0].id]);
        await client.query(
          "INSERT INTO ad_ledger (campaign_id, vendor_id, entry, amount_cents, note) VALUES ($1, $2, 'ad_commission', $3, $4)",
          [o.campaign_id, o.vendor_id, commission, `Order #${o.id}`]
        );
      }
      await client.query(
        `INSERT INTO ad_stats_daily (campaign_id, day, placement, orders, order_value_cents, commission_cents)
         VALUES ($1, ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, $3, 1, $4, $5)
         ON CONFLICT (campaign_id, day, placement) DO UPDATE SET orders = ad_stats_daily.orders + 1,
           order_value_cents = ad_stats_daily.order_value_cents + EXCLUDED.order_value_cents,
           commission_cents = ad_stats_daily.commission_cents + EXCLUDED.commission_cents`,
        [o.campaign_id, o.created_at, o.placement, value, commission]
      );
      await client.query('COMMIT');
      credited += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return credited;
}

module.exports = { ServeError, serve, recordEvents, attributeOrders };
