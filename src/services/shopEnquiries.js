/**
 * "Ask the shop" (SB9, schema "SHOP ENQUIRIES"): a customer's question to a
 * shop and the thread that follows. Customers and the shop each see their
 * own unread count; whoever writes, the other side is notified in the app.
 * An enquiry started from the shop's own running ad counts as that ad's
 * 'enquiry'.
 */
const pool = require('../config/db');
const adServing = require('./adServing');

const TOPICS = [
  { code: 'stock', label: 'Is it in stock?' },
  { code: 'variant', label: 'Size, colour or other option' },
  { code: 'wholesale', label: 'Wholesale / bulk quantity' },
  { code: 'delivery', label: 'Delivery or pickup' },
  { code: 'other', label: 'Something else' },
];
const TOPIC_CODES = TOPICS.map((t) => t.code);
// NS7: a request for one of the shop's services, sent from its service page
// (not offered in the "Ask the shop" topic list).
const SERVICE_TOPIC = { code: 'service', label: 'Service request' };
const SLOTS = ['morning', 'afternoon', 'evening', 'any'];
const MAX_PHOTOS = 4;
const MAX_DAYS_AHEAD = 60;
const PHOTO_PATH = /^\/uploads\/enquiries\/[\w.-]+\.(jpg|jpeg|png|webp)$/;
const topicLabel = (code) => (code === SERVICE_TOPIC.code ? SERVICE_TOPIC : TOPICS.find((t) => t.code === code))?.label;

/**
 * A DATE column as YYYY-MM-DD. pg hands DATEs over as local midnight, so
 * the local parts are the day; toISOString() would roll east-of-UTC days back.
 */
const dayText = (d) => {
  if (!d) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Today's date in India as YYYY-MM-DD (shops and customers both keep Indian time). */
const todayInIndia = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * The service part of a request: an active service of this shop in an
 * active category, a day from today to 60 days ahead, a part of the day,
 * the visit address when the service is only done at home, and up to 4
 * photos uploaded first under /uploads/enquiries.
 */
async function readServiceRequest(body, vendorId, now = new Date()) {
  const serviceId = readId(body.serviceId, 'Service');
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.at_home, s.at_shop FROM vendor_services s
     JOIN service_categories c ON c.id = s.category_id
     WHERE s.id = $1 AND s.vendor_id = $2 AND s.status = 'active' AND c.is_active`,
    [serviceId, vendorId]
  );
  if (!rows[0]) throw new EnquiryError(400, "This shop isn't offering that service right now.");
  const service = rows[0];

  const date = text(body.preferredDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new EnquiryError(400, 'Pick the day you would like it.');
  }
  const today = todayInIndia(now);
  const last = new Date(Date.parse(`${today}T00:00:00Z`) + MAX_DAYS_AHEAD * 86400000).toISOString().slice(0, 10);
  if (date < today) throw new EnquiryError(400, 'Pick today or a later day.');
  if (date > last) throw new EnquiryError(400, `Pick a day within the next ${MAX_DAYS_AHEAD} days.`);

  const slot = text(body.preferredSlot) || 'any';
  if (!SLOTS.includes(slot)) throw new EnquiryError(400, `preferredSlot is one of ${SLOTS.join(', ')}.`);

  const address = text(body.visitAddress);
  if (address.length > 400) throw new EnquiryError(400, 'Keep the address under 400 characters.');
  if (service.at_home && !service.at_shop && address.length < 10) {
    throw new EnquiryError(400, 'Add the address where the work is to be done.');
  }

  if (body.photos != null && !Array.isArray(body.photos)) throw new EnquiryError(400, 'photos must be a list.');
  const photos = [...new Set((body.photos ?? []).map((p) => text(p)).filter(Boolean))];
  if (photos.length > MAX_PHOTOS) throw new EnquiryError(400, `Add at most ${MAX_PHOTOS} photos.`);
  if (!photos.every((p) => PHOTO_PATH.test(p))) throw new EnquiryError(400, 'Upload each photo first.');

  return { service, date, slot, address: address || null, photos };
}
const MAX_BODY = 2000;
const MAX_QTY = 1000000;
const MAX_NEW_PER_DAY = 20;
const MAX_OPEN_PER_SHOP = 3;
const PAGE_SIZE = 30;

class EnquiryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function readBody(raw) {
  const body = text(raw);
  if (!body) throw new EnquiryError(400, 'Write your message.');
  if (body.length > MAX_BODY) throw new EnquiryError(400, `Keep the message under ${MAX_BODY} characters.`);
  return body;
}

function readId(raw, what) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new EnquiryError(404, `${what} not found`);
  return id;
}

async function notify(db, userId, title, body, link) {
  await db.query(
    "INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'shop_enquiry', $2, $3, $4)",
    [userId, title.slice(0, 160), body.length > 200 ? `${body.slice(0, 197)}…` : body, link]
  );
}

// What both sides see of an enquiry in a list. [side] is whose unread count.
function listSql(side) {
  const readCol = side === 'customer' ? 'e.customer_read_at' : 'e.vendor_read_at';
  const other = side === 'customer' ? 'vendor' : 'customer';
  return `
    SELECT e.*, vp.business_name, vp.logo_url, u.full_name AS customer_name,
           -- NS9: the customer's review of a service request, if any.
           (SELECT json_build_object('rating', sr.rating, 'comment', sr.comment) FROM service_reviews sr WHERE sr.enquiry_id = e.id) AS service_review,
           (SELECT m.body FROM shop_enquiry_messages m WHERE m.enquiry_id = e.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
           (SELECT COUNT(*)::int FROM shop_enquiry_messages m
             WHERE m.enquiry_id = e.id AND m.author_role = '${other}'
               AND (${readCol} IS NULL OR m.created_at > ${readCol})) AS unread
    FROM shop_enquiries e
    JOIN vendor_profiles vp ON vp.id = e.vendor_id
    JOIN users u ON u.id = e.user_id`;
}

function summary(r, side) {
  return {
    id: r.id,
    reference: r.reference,
    shop: { id: r.vendor_id, name: r.business_name, logoUrl: r.logo_url },
    ...(side === 'vendor' ? { customer: { name: r.customer_name } } : {}),
    topic: r.topic,
    topicLabel: topicLabel(r.topic),
    product: r.product_id || r.product_name ? { id: r.product_id, name: r.product_name } : null,
    quantity: r.quantity,
    // NS7: what a service request asked for.
    service: r.service_id || r.service_title ? { id: r.service_id, title: r.service_title } : null,
    preferredDate: dayText(r.preferred_date),
    preferredSlot: r.preferred_slot ?? null,
    visitAddress: r.visit_address ?? null,
    photos: r.photos ?? [],
    serviceDoneAt: r.service_done_at ?? null,
    review: r.service_review ?? null,
    status: r.status,
    lastMessage: r.last_message,
    lastMessageFrom: r.last_message_from,
    lastMessageAt: r.last_message_at,
    unread: r.unread,
    fromAd: r.ad_campaign_id != null,
    closedBy: r.closed_by,
    closedAt: r.closed_at,
    createdAt: r.created_at,
  };
}

async function thread(id, side) {
  const { rows } = await pool.query(`${listSql(side)} WHERE e.id = $1`, [id]);
  const { rows: messages } = await pool.query(
    'SELECT id, author_role, body, created_at FROM shop_enquiry_messages WHERE enquiry_id = $1 ORDER BY created_at, id',
    [id]
  );
  return {
    ...summary(rows[0], side),
    messages: messages.map((m) => ({ id: m.id, from: m.author_role, body: m.body, createdAt: m.created_at })),
  };
}

/**
 * A customer asks a shop. Approved shops only, not their own, the product
 * (if any) must be the shop's live product, wholesale needs a quantity. At
 * most 3 open enquiries per shop and 20 new a day. fromAd = { campaignId,
 * placement, sessionId } credits the shop's running ad with an enquiry.
 */
async function create(userId, body = {}) {
  const vendorId = readId(body.vendorId, 'Shop');
  const topic = text(body.topic);
  const isService = topic === SERVICE_TOPIC.code;
  if (!TOPIC_CODES.includes(topic) && !isService) throw new EnquiryError(400, `topic is one of ${TOPIC_CODES.join(', ')}.`);
  // A service request may come without a note: the request itself says what is wanted.
  const message = isService && !text(body.message) ? null : readBody(body.message);
  let quantity = null;
  if (body.quantity != null && body.quantity !== '') {
    quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_QTY) throw new EnquiryError(400, 'quantity must be a whole number above 0.');
  }
  if (topic === 'wholesale' && !quantity) throw new EnquiryError(400, 'Say how many you need.');

  const { rows: shop } = await pool.query("SELECT id, user_id, business_name FROM vendor_profiles WHERE id = $1 AND status = 'approved'", [vendorId]);
  if (!shop[0]) throw new EnquiryError(404, 'Shop not found');
  if (shop[0].user_id === userId) throw new EnquiryError(400, "You can't send an enquiry to your own shop.");
  const request = isService ? await readServiceRequest(body, vendorId) : null;
  if (request) {
    const { rows: same } = await pool.query(
      "SELECT reference FROM shop_enquiries WHERE user_id = $1 AND service_id = $2 AND status <> 'closed' LIMIT 1",
      [userId, request.service.id]
    );
    if (same[0]) {
      throw new EnquiryError(409, `You already asked for this service (${same[0].reference}). Reply there, or close it to ask again.`);
    }
  }
  let product = null;
  if (!isService && body.productId != null) {
    const productId = readId(body.productId, 'Product');
    const { rows } = await pool.query(
      "SELECT id, name FROM products WHERE id = $1 AND vendor_id = $2 AND is_active = true AND moderation_status = 'approved'",
      [productId, vendorId]
    );
    if (!rows[0]) throw new EnquiryError(400, "That product isn't sold by this shop.");
    product = rows[0];
  }
  const { rows: counts } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '1 day')::int AS today,
            COUNT(*) FILTER (WHERE vendor_id = $2 AND status <> 'closed')::int AS open_here
     FROM shop_enquiries WHERE user_id = $1`,
    [userId, vendorId]
  );
  if (counts[0].today >= MAX_NEW_PER_DAY) throw new EnquiryError(429, "You've asked a lot of questions today. Please try again tomorrow.");
  if (counts[0].open_here >= MAX_OPEN_PER_SHOP) {
    throw new EnquiryError(409, `You already have ${MAX_OPEN_PER_SHOP} open questions with this shop. Reply in one of them or close one first.`);
  }

  // Only the shop's own running ad is credited (adServing checks it ran in that slot then).
  let adCampaignId = null;
  const ad = body.fromAd;
  if (ad && Number.isInteger(Number(ad.campaignId))) {
    const { rows } = await pool.query('SELECT id FROM ad_campaigns WHERE id = $1 AND vendor_id = $2', [Number(ad.campaignId), vendorId]);
    if (rows[0]) {
      try {
        const counted = await adServing.recordEvents({
          sessionId: ad.sessionId,
          events: [{ type: 'enquiry', campaignId: rows[0].id, placement: ad.placement }],
          userId,
        });
        if (counted) adCampaignId = rows[0].id;
      } catch (err) {
        if (!(err instanceof adServing.ServeError)) throw err; // a bad ad reference never blocks the question
      }
    }
  }

  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const { rows: seq } = await client.query("SELECT nextval('shop_enquiry_ref_seq') AS n");
    const reference = `ENQ-${new Date().getFullYear()}-${String(seq[0].n).padStart(5, '0')}`;
    const { rows } = await client.query(
      `INSERT INTO shop_enquiries (reference, vendor_id, user_id, topic, product_id, product_name, quantity, ad_campaign_id, customer_read_at,
                                   service_id, service_title, preferred_date, preferred_slot, visit_address, photos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10, $11, $12, $13, $14) RETURNING id`,
      [reference, vendorId, userId, topic, product?.id ?? null, product?.name ?? null, quantity, adCampaignId,
        request?.service.id ?? null, request?.service.title ?? null, request?.date ?? null, request?.slot ?? null,
        request?.address ?? null, request?.photos ?? []]
    );
    id = rows[0].id;
    // The first message: the note, or for a bare service request what was asked for.
    const first = message ?? `Service request: ${request.service.title} on ${request.date}${request.slot === 'any' ? '' : ` (${request.slot})`}.`;
    await client.query("INSERT INTO shop_enquiry_messages (enquiry_id, author_role, author_user_id, body) VALUES ($1, 'customer', $2, $3)", [id, userId, first]);
    const title = request
      ? `New service request: ${request.service.title} (${reference})`
      : `New question${product ? ` about ${product.name}` : ''} (${reference})`;
    await notify(client, shop[0].user_id, title, first, `/vendor/enquiries/${id}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return thread(id, 'customer');
}

/** Loads an enquiry the caller may see: the customer's own, or one sent to the caller's shop. */
async function load(rawId, side, ownerId) {
  const id = readId(rawId, 'Enquiry');
  const col = side === 'customer' ? 'user_id' : 'vendor_id';
  const { rows } = await pool.query(`SELECT e.*, vp.user_id AS shop_owner, vp.business_name FROM shop_enquiries e
    JOIN vendor_profiles vp ON vp.id = e.vendor_id WHERE e.id = $1 AND e.${col} = $2`, [id, ownerId]);
  if (!rows[0]) throw new EnquiryError(404, 'Enquiry not found');
  return rows[0];
}

/** Opening a thread marks the other side's messages read. */
async function open(rawId, side, ownerId) {
  const e = await load(rawId, side, ownerId);
  await pool.query(`UPDATE shop_enquiries SET ${side}_read_at = now() WHERE id = $1`, [e.id]);
  return thread(e.id, side);
}

async function list(side, ownerId, query = {}) {
  const col = side === 'customer' ? 'user_id' : 'vendor_id';
  const params = [ownerId];
  let where = `e.${col} = $1`;
  if (['open', 'answered', 'closed'].includes(query.status)) {
    params.push(query.status);
    where += ` AND e.status = $2`;
  }
  const page = Math.max(1, Number(query.page) || 1);
  const [{ rows }, { rows: total }, { rows: unread }] = await Promise.all([
    pool.query(`${listSql(side)} WHERE ${where} ORDER BY e.last_message_at DESC, e.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(`SELECT COUNT(*)::int AS n FROM shop_enquiries e WHERE ${where}`, params),
    pool.query(`SELECT COALESCE(SUM(x.unread), 0)::int AS n FROM (${listSql(side)} WHERE e.${col} = $1) x`, [ownerId]),
  ]);
  return { items: rows.map((r) => summary(r, side)), total: total[0].n, page, pageSize: PAGE_SIZE, unread: unread[0].n, topics: TOPICS };
}

/** A reply. A customer reply sets the enquiry open (waiting for the shop); the shop's, answered. Closed: 409. */
async function reply(rawId, side, ownerId, authorUserId, rawBody) {
  const message = readBody(rawBody);
  const e = await load(rawId, side, ownerId);
  if (e.status === 'closed') throw new EnquiryError(409, 'This enquiry is closed. Start a new one to ask again.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO shop_enquiry_messages (enquiry_id, author_role, author_user_id, body) VALUES ($1, $2, $3, $4)', [e.id, side, authorUserId, message]);
    await client.query(
      `UPDATE shop_enquiries SET status = $2, last_message_at = now(), last_message_from = $3, ${side}_read_at = now() WHERE id = $1`,
      [e.id, side === 'customer' ? 'open' : 'answered', side]
    );
    if (side === 'vendor') {
      await notify(client, e.user_id, `${e.business_name} replied (${e.reference})`, message, `/enquiries/${e.id}`);
    } else {
      await notify(client, e.shop_owner, `New reply (${e.reference})`, message, `/vendor/enquiries/${e.id}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return thread(e.id, side);
}

/** Either side closes the enquiry; a repeat close is fine. */
async function close(rawId, side, ownerId) {
  const e = await load(rawId, side, ownerId);
  if (e.status !== 'closed') {
    await pool.query("UPDATE shop_enquiries SET status = 'closed', closed_at = now(), closed_by = $2 WHERE id = $1", [e.id, side]);
  }
  return thread(e.id, side);
}

module.exports = { EnquiryError, TOPICS, SERVICE_TOPIC, create, open, list, reply, close, readServiceRequest, todayInIndia };
