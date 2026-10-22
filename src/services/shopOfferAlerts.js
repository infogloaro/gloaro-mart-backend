/**
 * "New offer" alerts to a shop's followers (SB8). Called when a shop starts a
 * public offer (its coupon goes live, or it joins a platform campaign). Sent
 * in the app to followers who asked to hear from that shop (SB4's
 * notify_offers) and haven't switched shop offers off. Each offer is
 * announced once; a follower hears from one shop at most once a day and from
 * all shops at most MAX_PER_DAY times a day.
 */
const pool = require('../config/db');
const prefs = require('./notificationPrefs');

const MAX_PER_DAY = 5;
const OFFER_KEY = /^[a-z_]+:[A-Za-z0-9_-]{1,40}$/;

/**
 * notify(vendorId, { key, text }) — key names the offer ('coupon:12',
 * 'campaign:5'), text is what it is ("10% off orders over ₹500, code
 * SAVE10"). Returns { sent, alreadySent }. Never throws for a shop that
 * isn't approved (nothing is sent or remembered).
 */
async function notify(vendorId, { key, text } = {}) {
  if (!Number.isInteger(vendorId) || vendorId <= 0) throw new Error('shopOfferAlerts.notify: vendorId must be an id');
  if (typeof key !== 'string' || !OFFER_KEY.test(key)) throw new Error("shopOfferAlerts.notify: key like 'coupon:12'");
  const offer = typeof text === 'string' ? text.trim().slice(0, 300) : '';
  if (!offer) throw new Error('shopOfferAlerts.notify: text is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: shop } = await client.query("SELECT id, user_id, business_name FROM vendor_profiles WHERE id = $1 AND status = 'approved'", [vendorId]);
    if (!shop[0]) {
      await client.query('ROLLBACK');
      return { sent: 0, alreadySent: false };
    }
    const title = `${shop[0].business_name} has a new offer`.slice(0, 160);
    const { rows: alert } = await client.query(
      `INSERT INTO shop_offer_alerts (vendor_id, offer_key, title) VALUES ($1, $2, $3)
       ON CONFLICT (vendor_id, offer_key) DO NOTHING RETURNING id`,
      [vendorId, key, title]
    );
    if (!alert[0]) {
      await client.query('ROLLBACK');
      return { sent: 0, alreadySent: true };
    }
    const link = `/shops/${vendorId}`;
    const { rowCount } = await client.query(
      `INSERT INTO notifications (user_id, type, title, body, deep_link)
       SELECT f.user_id, 'shop_offer', $2::text, $3::text, $4::text
       FROM shop_follows f
       WHERE f.vendor_id = $1 AND f.notify_offers AND f.user_id <> $5
         AND ${prefs.wantsSql('f.user_id', 'shop_offers', 'in_app')}
         AND NOT EXISTS (SELECT 1 FROM notifications n
                         WHERE n.user_id = f.user_id AND n.type = 'shop_offer' AND n.deep_link = $4::text
                           AND n.created_at >= now() - interval '1 day')
         AND (SELECT COUNT(*) FROM notifications n
              WHERE n.user_id = f.user_id AND n.type = 'shop_offer'
                AND n.created_at >= now() - interval '1 day') < ${MAX_PER_DAY}`,
      [vendorId, title, offer, link, shop[0].user_id]
    );
    await client.query('UPDATE shop_offer_alerts SET recipients = $2 WHERE id = $1', [alert[0].id, rowCount]);
    await client.query('COMMIT');
    return { sent: rowCount, alreadySent: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const rupees = (cents) => `₹${(cents / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** "20% off orders over ₹500, code SAVE20" from a coupon row (flat values are rupees). */
function couponText(c) {
  const what = c.discount_type === 'percentage' ? `${Number(c.discount_value)}% off`
    : c.discount_type === 'free_delivery' ? 'Free delivery'
      : `₹${Number(c.discount_value)} off`;
  const head = c.title ? `${c.title}: ${what}` : what;
  const min = c.min_order_value_cents > 0 ? ` on orders over ${rupees(c.min_order_value_cents)}` : '';
  return `${head}${min}, code ${c.code}`;
}

/** Announces a shop coupon if it is public and live right now; anything else is left alone. */
async function announceCoupon(c) {
  if (!c?.vendor_id || !c.is_public || !c.is_active) return { sent: 0, alreadySent: false };
  const now = Date.now();
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return { sent: 0, alreadySent: false };
  if (c.expires_at && new Date(c.expires_at).getTime() <= now) return { sent: 0, alreadySent: false };
  return notify(c.vendor_id, { key: `coupon:${c.id}`, text: couponText(c) });
}

/** Announces a platform campaign a shop has joined, once it is running for that shop. */
async function announceCampaign(campaignId, vendorId) {
  // Required here: campaign.controller calls this module from its opt-in.
  const { runningCampaigns } = require('../controllers/campaign.controller');
  const c = (await runningCampaigns()).find((x) => x.id === campaignId);
  if (!c || !c.vendorIds.includes(vendorId)) return { sent: 0, alreadySent: false };
  const what = c.discountType === 'percentage' ? `: ${Number(c.discountValue)}% off` : '';
  return notify(vendorId, { key: `campaign:${c.id}`, text: `Now part of "${c.name}"${what}` });
}

/**
 * Offers that started on their own since the shop set them up: public
 * coupons whose start time passed in the last day, and campaigns that began
 * in the last day for the shops that joined. Run by the server's sweep;
 * each offer is still announced only once.
 */
async function announceDue() {
  let sent = 0;
  const { rows: coupons } = await pool.query(
    `SELECT c.* FROM coupons c
     WHERE c.vendor_id IS NOT NULL AND c.is_public AND c.is_active
       AND c.starts_at > now() - interval '1 day' AND c.starts_at <= now()
       AND (c.expires_at IS NULL OR c.expires_at > now())
       AND NOT EXISTS (SELECT 1 FROM shop_offer_alerts a WHERE a.vendor_id = c.vendor_id AND a.offer_key = 'coupon:' || c.id)`
  );
  for (const c of coupons) sent += (await announceCoupon(c)).sent;
  const { rows: started } = await pool.query(
    `SELECT DISTINCT c.id, p.ref_id AS vendor_id FROM campaigns c
     JOIN campaign_participants p ON p.campaign_id = c.id AND p.type = 'vendor' AND p.opted_in
     WHERE c.starts_at > now() - interval '1 day' AND c.starts_at <= now()
       AND NOT EXISTS (SELECT 1 FROM shop_offer_alerts a WHERE a.vendor_id = p.ref_id AND a.offer_key = 'campaign:' || c.id)`
  );
  for (const s of started) sent += (await announceCampaign(s.id, s.vendor_id)).sent;
  return sent;
}

/** For the request paths: announcing never fails or slows the shop's own action. */
function later(promise, what) {
  promise.catch((err) => console.error(`[offer alerts] ${what} failed: ${err.message}`));
}

module.exports = { MAX_PER_DAY, notify, couponText, announceCoupon, announceCampaign, announceDue, later };
