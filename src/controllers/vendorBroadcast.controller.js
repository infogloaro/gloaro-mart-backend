/**
 * A shop's message to its followers (VD23, schema "SHOP BROADCASTS").
 *
 * Goes the same way as SB8's offer alerts (services/shopOfferAlerts.js): an
 * in-app notification of type 'shop_offer' that opens the shop, sent only to
 * followers who opted in to offer alerts and haven't switched shop offers
 * off, and never past SB8's per-follower limits — one notification from a
 * shop a day, MAX_PER_DAY from all shops. So a broadcast can't be used to get
 * around them, and "Will reach N" counts exactly who it would reach.
 *
 * Against spam on the shop's side: approved shops only, one broadcast per
 * 24 hours, a message is required, and every send is in the audit log.
 */
const pool = require('../config/db');
const prefs = require('../services/notificationPrefs');
const { MAX_PER_DAY, couponText } = require('../services/shopOfferAlerts');

const TITLE_MAX = 60;
const MESSAGE_MAX = 160;
const GAP_HOURS = 24;
const HISTORY = 20;
/** First key of the per-shop advisory lock taken while sending. */
const LOCK_SPACE = 2323;

/** "SAVE10 …" text squeezed to one line. */
const oneLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** What the follower sees as the notification's title. */
function notificationTitle(shopName, title) {
  return (title ? `${shopName}: ${title}` : `${shopName} has a message for you`).slice(0, 160);
}

/** What the follower reads: the message, then the linked offer if there is one. */
function notificationBody(message, offerText) {
  return offerText ? `${message}\n${offerText}` : message;
}

/**
 * WHERE for the followers a broadcast from shop $1 (owner $2) reaches right
 * now, with deep link $3. Same rules as shopOfferAlerts.notify.
 */
function reachWhere() {
  return `f.vendor_id = $1 AND f.notify_offers AND f.user_id <> $2
    AND ${prefs.wantsSql('f.user_id', 'shop_offers', 'in_app')}
    AND NOT EXISTS (SELECT 1 FROM notifications n
                    WHERE n.user_id = f.user_id AND n.type = 'shop_offer' AND n.deep_link = $3::text
                      AND n.created_at >= now() - interval '1 day')
    AND (SELECT COUNT(*) FROM notifications n
         WHERE n.user_id = f.user_id AND n.type = 'shop_offer'
           AND n.created_at >= now() - interval '1 day') < ${MAX_PER_DAY}`;
}

const shopLink = (vendorId) => `/shops/${vendorId}`;

/** The shop's offers running now, as { key, text } — what a broadcast may point to. */
async function runningOffers(vendorId, db = pool) {
  const { rows: coupons } = await db.query(
    `SELECT * FROM coupons
     WHERE vendor_id = $1 AND is_active AND hidden_at IS NULL
       AND (starts_at IS NULL OR starts_at <= now())
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC LIMIT 20`,
    [vendorId]
  );
  const offers = coupons.map((c) => ({ key: `coupon:${c.id}`, kind: 'coupon', text: couponText(c), endsAt: c.expires_at }));
  // Required here, like shopOfferAlerts does: campaign.controller is a big module.
  const { runningCampaigns } = require('./campaign.controller');
  for (const c of await runningCampaigns()) {
    if (!c.vendorIds.includes(vendorId)) continue;
    const what = c.discountType === 'percentage' ? `: ${Number(c.discountValue)}% off` : '';
    offers.push({ key: `campaign:${c.id}`, kind: 'campaign', text: `Part of "${c.name}"${what}`, endsAt: c.endsAt });
  }
  return offers;
}

/** The shop, its follower numbers and when it last sent. */
async function readState(vendorId, db = pool) {
  const { rows } = await db.query('SELECT user_id FROM vendor_profiles WHERE id = $1', [vendorId]);
  if (!rows[0]) return null;
  const { rows: s } = await db.query(
    `SELECT vp.id, vp.user_id, vp.business_name, vp.status,
            (SELECT COUNT(*)::int FROM shop_follows f WHERE f.vendor_id = vp.id) AS followers,
            (SELECT COUNT(*)::int FROM shop_follows f WHERE f.vendor_id = vp.id AND f.notify_offers) AS opted_in,
            (SELECT COUNT(*)::int FROM shop_follows f WHERE ${reachWhere()}) AS reach,
            (SELECT MAX(b.created_at) FROM shop_broadcasts b WHERE b.vendor_id = vp.id) AS last_sent_at
     FROM vendor_profiles vp WHERE vp.id = $1`,
    [vendorId, rows[0].user_id, shopLink(vendorId)]
  );
  return s[0];
}

/** Why the shop can't send now, or null; and when it next can. */
function blocker(s) {
  if (s.status !== 'approved') return { reason: 'not_approved', message: 'Your shop must be approved before you can message followers.' };
  if (s.last_sent_at) {
    const next = new Date(new Date(s.last_sent_at).getTime() + GAP_HOURS * 3600 * 1000);
    if (next.getTime() > Date.now()) {
      return { reason: 'wait', nextAt: next.toISOString(), message: 'You can send one message every 24 hours.' };
    }
  }
  if (s.reach === 0) {
    return {
      reason: 'no_reach',
      message: s.opted_in === 0
        ? 'None of your followers have offer alerts on yet.'
        : 'Your followers have already had a message from you or enough offers today. Try again tomorrow.',
    };
  }
  return null;
}

const shapeBroadcast = (b) => ({
  id: b.id,
  title: b.title,
  message: b.message,
  offerKey: b.offer_key,
  offerText: b.offer_text,
  recipients: b.recipients,
  createdAt: b.created_at,
});

/**
 * GET /api/vendor/broadcasts — who a message would reach now, whether one may
 * be sent, the offers it may point to and the last 20 sent.
 */
async function getBroadcasts(req, res) {
  const s = await readState(req.vendorId);
  if (!s) return res.status(404).json({ message: 'Shop not found' });
  const [{ rows: history }, offers] = await Promise.all([
    pool.query(
      `SELECT * FROM shop_broadcasts WHERE vendor_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${HISTORY}`,
      [req.vendorId]
    ),
    runningOffers(req.vendorId),
  ]);
  const block = blocker(s);
  res.json({
    shopName: s.business_name,
    followers: s.followers,
    optedIn: s.opted_in,
    reach: s.reach,
    canSend: !block,
    blockedReason: block?.reason ?? null,
    blockedMessage: block?.message ?? null,
    nextAt: block?.nextAt ?? null,
    limits: { titleMax: TITLE_MAX, messageMax: MESSAGE_MAX, gapHours: GAP_HOURS },
    offers: offers.map((o) => ({ key: o.key, kind: o.kind, text: o.text, endsAt: o.endsAt })),
    history: history.map(shapeBroadcast),
  });
}

/**
 * POST /api/vendor/broadcasts { title?, message, offerKey? }
 * 201 { broadcast, reach } · 400 bad body · 403 not approved · 429 too soon /
 * nobody to reach.
 */
async function sendBroadcast(req, res) {
  const body = req.body || {};
  const title = oneLine(body.title);
  const message = oneLine(body.message);
  if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
    return res.status(400).json({ message: 'Title must be text.' });
  }
  if (!message) return res.status(400).json({ message: 'Write a message for your followers.' });
  if (message.length > MESSAGE_MAX) return res.status(400).json({ message: `Keep the message to ${MESSAGE_MAX} characters.` });
  if (title.length > TITLE_MAX) return res.status(400).json({ message: `Keep the title to ${TITLE_MAX} characters.` });
  const offerKey = body.offerKey == null || body.offerKey === '' ? null : body.offerKey;
  if (offerKey !== null && typeof offerKey !== 'string') return res.status(400).json({ message: 'Pick one of your running offers.' });

  const vendorId = req.vendorId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One send at a time per shop, so two quick taps can't both pass the 24-hour check.
    // An advisory lock, not FOR UPDATE, so it never holds up edits to the shop's profile.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_SPACE, vendorId]);
    const s = await readState(vendorId, client);
    if (!s) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Shop not found' });
    }
    const block = blocker(s);
    if (block) {
      await client.query('ROLLBACK');
      return res.status(block.reason === 'not_approved' ? 403 : 429).json({ message: block.message, reason: block.reason, nextAt: block.nextAt ?? null });
    }
    let offer = null;
    if (offerKey) {
      offer = (await runningOffers(vendorId, client)).find((o) => o.key === offerKey);
      if (!offer) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'That offer has ended or is not yours. Pick one that is running.' });
      }
    }
    const offerText = offer ? offer.text.slice(0, 300) : null;
    const link = shopLink(vendorId);
    const { rowCount } = await client.query(
      `INSERT INTO notifications (user_id, type, title, body, deep_link)
       SELECT f.user_id, 'shop_offer', $4::text, $5::text, $3::text
       FROM shop_follows f WHERE ${reachWhere()}`,
      [vendorId, s.user_id, link, notificationTitle(s.business_name, title), notificationBody(message, offerText)]
    );
    const { rows } = await client.query(
      `INSERT INTO shop_broadcasts (vendor_id, sent_by, title, message, offer_key, offer_text, recipients)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [vendorId, req.user?.id ?? null, title || null, message, offer ? offer.key : null, offerText, rowCount]
    );
    // The admin's log of what shops sent (Audit log, module 'shop_broadcast').
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, module, entity_type, entity_id, new_value)
       VALUES ($1, 'shop_broadcast.sent', 'shop_broadcast', 'vendor', $2, $3::jsonb)`,
      [req.user?.id ?? null, String(vendorId), JSON.stringify({
        broadcastId: rows[0].id, shop: s.business_name, title: title || null, message, offerKey: offer ? offer.key : null, recipients: rowCount,
      })]
    );
    await client.query('COMMIT');
    res.status(201).json({ broadcast: shapeBroadcast(rows[0]), reach: rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  TITLE_MAX, MESSAGE_MAX, GAP_HOURS,
  getBroadcasts, sendBroadcast, notificationTitle, notificationBody,
};
