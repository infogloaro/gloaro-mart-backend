const pool = require('../config/db');
const pricing = require('./adPricing');
const { financialYear } = require('./invoices');

/**
 * Ad campaigns (schema PHASE 53): booking, paying, approval, the schedule and
 * the money — used by Admin → Ad Promotions now and the shop's own booking
 * later, so both follow one set of rules. Plan: docs/ad-promotions-plan.md.
 *
 * Money:
 *  - The price is quoted again at payment and that quote is stored; if it
 *    differs from what was shown, payment stops and shows the new price.
 *  - Paying from the next payout records a vendor charge the weekly
 *    settlement deducts; paying offline waits for the admin's confirmation.
 *  - Every paid amount is an ADV tax invoice and ledger entries (revenue and
 *    tax apart); every refund is ledger entries the other way.
 *  - Rejected → full refund. Cancelled before it starts → refund less the
 *    cancellation fee. Cancelled while running → the unserved share, if the
 *    policy allows.
 */

const HOUR = 3600000;
const EDITABLE = ['draft'];
const RUNNING = ['scheduled', 'live', 'paused'];
const CTA_KINDS = ['shop', 'product', 'url', 'call', 'whatsapp'];

class CampaignError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

async function inTxn(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function lockCampaign(db, id) {
  const { rows } = await db.query('SELECT * FROM ad_campaigns WHERE id = $1 FOR UPDATE', [Number(id)]);
  if (!rows[0]) throw new CampaignError(404, 'Campaign not found');
  const { rows: regions } = await db.query('SELECT region_id FROM ad_campaign_regions WHERE campaign_id = $1 ORDER BY region_id', [rows[0].id]);
  rows[0].region_ids = regions.map((r) => r.region_id);
  return rows[0];
}

async function history(db, c, to, { userId = null, role = 'system', note = null } = {}) {
  await db.query(
    'INSERT INTO ad_campaign_history (campaign_id, from_status, to_status, actor_user_id, actor_role, note) VALUES ($1, $2, $3, $4, $5, $6)',
    [c.id, c.status, to, userId, role, note]
  );
}

async function notifyShop(db, c, title, body) {
  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, deep_link)
     SELECT user_id, 'ad_campaign', $2, $3, $4 FROM vendor_profiles WHERE id = $1`,
    [c.vendor_id, title, body, `/vendor/ads/${c.id}`]
  );
}

const rupees = (c) => `₹${(c / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The pricing engine's input, from a campaign row (or a form). */
const quoteInput = (c, over = {}) => ({
  vendorId: c.vendor_id,
  categoryId: c.category_id,
  model: c.model,
  level: c.level,
  packageId: c.package_id,
  regionIds: c.region_ids,
  placements: c.placements,
  startsAt: new Date(c.starts_at).toISOString(),
  hours: c.hours,
  couponCode: c.coupon_code,
  ...over,
});

// ----------------------------------------------------------------- content

function readContent(b, existing = null) {
  const out = {};
  const str = (k, label, max, required = false) => {
    if (b[k] === undefined && existing) return;
    const v = typeof b[k] === 'string' ? b[k].trim() : '';
    if (required && !v) throw new CampaignError(400, `${label} is required.`);
    if (v.length > max) throw new CampaignError(400, `${label} is at most ${max} characters.`);
    out[k] = v || null;
  };
  str('title', 'Title', 120, true);
  str('description', 'Description', 1000);
  str('offerText', 'Offer', 160);
  str('ctaLabel', 'Button text', 30);
  if (b.ctaKind !== undefined || !existing) {
    const kind = b.ctaKind ?? 'shop';
    if (!CTA_KINDS.includes(kind)) throw new CampaignError(400, `The button opens one of: ${CTA_KINDS.join(', ')}.`);
    out.ctaKind = kind;
  }
  str('ctaTarget', 'Button target', 500);
  const kind = out.ctaKind ?? existing?.cta_kind;
  const target = out.ctaTarget !== undefined ? out.ctaTarget : existing?.cta_target;
  if (kind === 'url' && !/^https:\/\/\S+$/.test(target ?? '')) throw new CampaignError(400, 'A link button needs an https:// address.');
  if (['call', 'whatsapp'].includes(kind) && !/^\+?\d{10,15}$/.test((target ?? '').replace(/[\s-]/g, ''))) throw new CampaignError(400, 'Give the phone number the button calls or messages.');
  if (kind === 'product' && !/^\d+$/.test(String(target ?? ''))) throw new CampaignError(400, 'Give the product id the button opens.');
  return out;
}

/** Pricing inputs from a form, merged over an existing campaign. */
function readBooking(b, existing = null) {
  const pick = (k, col) => (b[k] !== undefined ? b[k] : existing?.[col]);
  return {
    vendorId: Number(pick('vendorId', 'vendor_id')),
    categoryId: pick('categoryId', 'category_id') ?? null,
    model: pick('model', 'model') ?? 'fixed',
    level: pick('level', 'level'),
    packageId: pick('packageId', 'package_id') ?? null,
    regionIds: b.regionIds !== undefined ? b.regionIds : existing?.region_ids ?? [],
    placements: b.placements !== undefined ? b.placements : existing?.placements ?? [],
    startsAt: b.startsAt !== undefined ? b.startsAt : existing && new Date(existing.starts_at).toISOString(),
    hours: b.hours !== undefined ? Number(b.hours) : existing?.hours,
    couponCode: b.couponCode !== undefined ? (String(b.couponCode || '').trim() || null) : existing?.coupon_code ?? null,
  };
}

async function writeQuote(db, id, q, booking) {
  await db.query(
    `UPDATE ad_campaigns SET model = $2, level = $3, package_id = $4, placements = $5, coupon_code = $6, category_id = $7,
       starts_at = $8, ends_at = $9, hours = $10, price_snapshot = $11, subtotal_cents = $12, discount_cents = $13,
       taxable_cents = $14, tax_cents = $15, total_cents = $16, commission_percent = $17, updated_at = now()
     WHERE id = $1`,
    [id, q.model, q.level, booking.packageId || null, JSON.stringify(booking.placements), booking.couponCode, booking.categoryId || null,
      q.startsAt, q.endsAt, q.hours, JSON.stringify({ ...q.snapshot, lines: q.lines }), q.subtotalCents, q.discountCents,
      q.taxableCents, q.taxCents, q.totalCents, q.commissionPercent]
  );
  await db.query('DELETE FROM ad_campaign_regions WHERE campaign_id = $1', [id]);
  for (const r of booking.regionIds) await db.query('INSERT INTO ad_campaign_regions (campaign_id, region_id) VALUES ($1, $2)', [id, Number(r)]);
}

async function createDraft({ body, userId, role = 'admin' }) {
  const content = readContent(body ?? {});
  const booking = readBooking(body ?? {});
  if (!Number.isInteger(booking.vendorId)) throw new CampaignError(400, 'Choose the shop the campaign is for.');
  return inTxn(async (client) => {
    const { rows: shop } = await client.query("SELECT id, status FROM vendor_profiles WHERE id = $1", [booking.vendorId]);
    if (!shop[0]) throw new CampaignError(400, 'That shop does not exist.');
    if (shop[0].status !== 'approved') throw new CampaignError(409, 'Only approved shops can advertise.');
    const q = await pricing.quote(booking, client);
    const { rows: seq } = await client.query("SELECT nextval('ad_campaign_ref_seq') AS n");
    const { rows } = await client.query(
      `INSERT INTO ad_campaigns (reference, vendor_id, created_by, created_by_role, title, description, offer_text, cta_label, cta_kind, cta_target,
         discount_campaign_id, model, level, starts_at, ends_at, hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [`ADC-${new Date().getFullYear()}-${String(seq[0].n).padStart(5, '0')}`, booking.vendorId, userId, role, content.title, content.description,
        content.offerText, content.ctaLabel, content.ctaKind, content.ctaTarget, body.discountCampaignId || null, q.model, q.level, q.startsAt, q.endsAt, q.hours]
    );
    await writeQuote(client, rows[0].id, q, booking);
    await client.query("INSERT INTO ad_campaign_history (campaign_id, to_status, actor_user_id, actor_role, note) VALUES ($1, 'draft', $2, $3, 'Created')", [rows[0].id, userId, role]);
    return rows[0].id;
  });
}

async function updateDraft({ id, body, userId }) {
  return inTxn(async (client) => {
    const c = await lockCampaign(client, id);
    if (!EDITABLE.includes(c.status)) throw new CampaignError(409, `This campaign is ${c.status.replace('_', ' ')} — only drafts can be changed.`);
    const content = readContent(body ?? {}, c);
    const map = { title: 'title', description: 'description', offerText: 'offer_text', ctaLabel: 'cta_label', ctaKind: 'cta_kind', ctaTarget: 'cta_target' };
    const sets = Object.entries(content).map(([k], i) => `${map[k]} = $${i + 2}`);
    if (body.discountCampaignId !== undefined) {
      sets.push(`discount_campaign_id = $${sets.length + 2}`);
      content.discountCampaignId = body.discountCampaignId || null;
    }
    if (sets.length) await client.query(`UPDATE ad_campaigns SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [c.id, ...Object.values(content)]);
    const pricingKeys = ['categoryId', 'model', 'level', 'packageId', 'regionIds', 'placements', 'startsAt', 'hours', 'couponCode'];
    if (pricingKeys.some((k) => body[k] !== undefined)) {
      const booking = readBooking(body, c);
      await writeQuote(client, c.id, await pricing.quote(booking, client), booking);
    }
    return c.id;
  });
}

// ------------------------------------------------------------------ assets

async function addAsset({ id, body }) {
  return inTxn(async (client) => {
    const c = await lockCampaign(client, id);
    if (!['draft', 'pending_payment', 'pending_approval'].includes(c.status)) throw new CampaignError(409, 'Images can be changed until the campaign is approved.');
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!/^\/uploads\/ads\/[\w.-]+\.(jpg|png|webp)$/.test(url)) throw new CampaignError(400, 'Upload the image first (it is saved under /uploads/ads).');
    const kind = body.kind ?? 'banner';
    if (!['banner', 'card', 'square'].includes(kind)) throw new CampaignError(400, 'kind is banner, card or square.');
    const dim = (v) => (v == null ? null : Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : NaN);
    const width = dim(body.width);
    const height = dim(body.height);
    if (Number.isNaN(width) || Number.isNaN(height)) throw new CampaignError(400, 'Width and height are whole pixels.');
    const { rows: n } = await client.query('SELECT COUNT(*)::int AS n FROM ad_assets WHERE campaign_id = $1', [c.id]);
    if (n[0].n >= 5) throw new CampaignError(409, 'Up to 5 images per campaign.');
    await client.query('INSERT INTO ad_assets (campaign_id, url, kind, width, height, sort_order) VALUES ($1, $2, $3, $4, $5, $6)', [c.id, url, kind, width, height, n[0].n]);
    return c.id;
  });
}

async function removeAsset({ id, assetId }) {
  return inTxn(async (client) => {
    const c = await lockCampaign(client, id);
    if (!['draft', 'pending_payment', 'pending_approval'].includes(c.status)) throw new CampaignError(409, 'Images can be changed until the campaign is approved.');
    const { rowCount } = await client.query('DELETE FROM ad_assets WHERE id = $1 AND campaign_id = $2', [Number(assetId), c.id]);
    if (!rowCount) throw new CampaignError(404, 'Image not found');
    return c.id;
  });
}

// ------------------------------------------------------------------- money

async function issueInvoice(db, c, payment) {
  const { rows: s } = await db.query('SELECT platform_name, gst_number, state FROM platform_settings WHERE id = 1');
  const { rows: v } = await db.query('SELECT * FROM vendor_profiles WHERE id = $1', [c.vendor_id]);
  const { rows: cfg } = await db.query('SELECT sac_code FROM ad_settings WHERE id = 1');
  const seller = s[0] ?? {};
  const shop = v[0];
  const fy = financialYear(new Date());
  const { rows: counter } = await db.query(
    `INSERT INTO ad_invoice_series (financial_year, last_number) VALUES ($1, 1)
     ON CONFLICT (financial_year) DO UPDATE SET last_number = ad_invoice_series.last_number + 1 RETURNING last_number`,
    [fy]
  );
  const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z]/g, '');
  // Same state → CGST + SGST; otherwise IGST. Unknown states count as the same.
  const intra = !seller.state || !shop.state || norm(seller.state) === norm(shop.state);
  const cgst = intra ? Math.floor(payment.tax_cents / 2) : 0;
  const { rows } = await db.query(
    `INSERT INTO ad_invoices (invoice_number, financial_year, campaign_id, payment_id, seller_name, seller_gstin, seller_state,
       buyer_vendor_id, buyer_name, buyer_gstin, buyer_state, buyer_address, sac_code, description, supply_type,
       taxable_cents, cgst_cents, sgst_cents, igst_cents, total_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING *`,
    [`ADV/${fy}/${String(counter[0].last_number).padStart(6, '0')}`, fy, c.id, payment.id, seller.platform_name || 'GLOARO Mart', seller.gst_number || null,
      seller.state || null, shop.id, shop.business_name, shop.gst_number || null, shop.state || null,
      [shop.address_line, shop.city, shop.state, shop.pincode].filter(Boolean).join(', ') || null, cfg[0]?.sac_code ?? '998365',
      `${payment.purpose === 'extension' ? 'Extension of advertising' : 'Advertising'} — ${c.reference} ${c.title}${payment.extension_hours ? ` (+${payment.extension_hours} h)` : ''}`,
      intra ? 'intra_state' : 'inter_state', payment.taxable_cents, cgst, intra ? payment.tax_cents - cgst : 0, intra ? 0 : payment.tax_cents, payment.amount_cents]
  );
  return rows[0];
}

/** A payment that has the money: ledger, invoice, and — paid from a payout — the charge on the next settlement. */
async function settlePaid(db, c, payment, { discountCents = 0 } = {}) {
  await db.query(
    `INSERT INTO ad_ledger (campaign_id, vendor_id, entry, amount_cents, payment_id, note) VALUES
       ($1, $2, 'ad_revenue', $3, $4, $6), ($1, $2, 'ad_tax', $5, $4, $6)`,
    [c.id, c.vendor_id, payment.taxable_cents, payment.id, payment.tax_cents, `${payment.purpose} · ${payment.method}`]
  );
  if (discountCents > 0) {
    await db.query("INSERT INTO ad_ledger (campaign_id, vendor_id, entry, amount_cents, payment_id, note) VALUES ($1, $2, 'ad_discount', $3, $4, 'Coupon')",
      [c.id, c.vendor_id, discountCents, payment.id]);
  }
  if (payment.method === 'settlement') {
    await db.query(
      "INSERT INTO vendor_charges (vendor_id, kind, label, amount_cents, ad_payment_id) VALUES ($1, 'advertising', $2, $3, $4)",
      [c.vendor_id, `Advertising ${c.reference}${payment.purpose === 'extension' ? ' (extension)' : ''}`, payment.amount_cents, payment.id]
    );
  }
  return issueInvoice(db, c, payment);
}

/** Re-quotes the booking now. Stops when the price moved from what the admin agreed to. */
async function priceNow(db, c, acceptTotalCents) {
  const q = await pricing.quote(quoteInput(c), db);
  const agreed = acceptTotalCents == null ? c.total_cents : Number(acceptTotalCents);
  if (q.totalCents !== agreed) {
    throw new CampaignError(409, `The price is now ${rupees(q.totalCents)} (it was ${rupees(agreed)}). Check it and pay again to accept.`, { quote: q });
  }
  return q;
}

async function existingPayment(db, key) {
  if (!key) return null;
  const { rows } = await db.query('SELECT * FROM ad_payments WHERE idempotency_key = $1', [String(key)]);
  return rows[0] ?? null;
}

function readMethod(method) {
  if (method === 'online') throw new CampaignError(409, 'Online payment comes with the payment gateway — use the shop’s next payout or an offline payment for now.');
  if (!['settlement', 'offline'].includes(method)) throw new CampaignError(400, 'Pay from the next payout (settlement) or offline.');
  return method;
}

/**
 * Books it: the price is fixed now (snapshot), then paid from the next payout
 * at once, or offline once the admin confirms. Commission-only campaigns cost
 * nothing upfront and go straight to approval.
 */
async function pay({ id, method, reference, idempotencyKey, acceptTotalCents, userId, role = 'admin' }) {
  return inTxn(async (client) => {
    const replay = await existingPayment(client, idempotencyKey);
    if (replay) return { campaignId: replay.campaign_id, paymentId: replay.id, replay: true };
    const c = await lockCampaign(client, id);
    if (c.status !== 'draft') throw new CampaignError(409, `This campaign is already ${c.status.replace('_', ' ')}.`);
    const { rows: assets } = await client.query('SELECT 1 FROM ad_assets WHERE campaign_id = $1 LIMIT 1', [c.id]);
    if (!assets.length) throw new CampaignError(409, 'Add the banner image before paying.');
    const q = await priceNow(client, c, acceptTotalCents);
    await writeQuote(client, c.id, q, quoteInput(c));
    if (c.coupon_code) await client.query('UPDATE ad_coupons SET used_count = used_count + 1 WHERE upper(code) = upper($1)', [c.coupon_code]);

    if (q.totalCents === 0) {
      await history(client, c, 'pending_approval', { userId, role, note: 'Commission only — nothing to pay upfront' });
      await client.query("UPDATE ad_campaigns SET status = 'pending_approval', payment_status = 'not_required', updated_at = now() WHERE id = $1", [c.id]);
      return { campaignId: c.id, paymentId: null };
    }
    const how = readMethod(method);
    const { rows } = await client.query(
      `INSERT INTO ad_payments (campaign_id, purpose, method, amount_cents, taxable_cents, tax_cents, status, reference, idempotency_key, created_by, paid_at)
       VALUES ($1, 'booking', $2, $3, $4, $5, $6::varchar, $7, $8, $9, CASE WHEN $6::varchar = 'paid' THEN now() END) RETURNING *`,
      [c.id, how, q.totalCents, q.taxableCents, q.taxCents, how === 'settlement' ? 'paid' : 'pending',
        typeof reference === 'string' ? reference.trim() || null : null, idempotencyKey || null, userId]
    );
    const payment = rows[0];
    if (how === 'settlement') {
      await settlePaid(client, c, payment, { discountCents: q.discountCents });
      await history(client, c, 'pending_approval', { userId, role, note: `${rupees(q.totalCents)} from the next payout` });
      await client.query("UPDATE ad_campaigns SET status = 'pending_approval', payment_status = 'paid', updated_at = now() WHERE id = $1", [c.id]);
      await notifyShop(client, c, 'Ad booked', `${c.title}: ${rupees(q.totalCents)} will be taken from your next payout. It goes live once approved.`);
    } else {
      await history(client, c, 'pending_payment', { userId, role, note: `Waiting for ${rupees(q.totalCents)} offline` });
      await client.query("UPDATE ad_campaigns SET status = 'pending_payment', payment_status = 'pending', updated_at = now() WHERE id = $1", [c.id]);
      await notifyShop(client, c, 'Ad booked — payment due', `${c.title}: pay ${rupees(q.totalCents)} to GLOARO to submit it for approval.`);
    }
    return { campaignId: c.id, paymentId: payment.id };
  });
}

/** The money for an offline payment arrived. */
async function confirmPayment({ paymentId, reference, userId }) {
  return inTxn(async (client) => {
    const { rows } = await client.query('SELECT * FROM ad_payments WHERE id = $1 FOR UPDATE', [Number(paymentId)]);
    const p = rows[0];
    if (!p) throw new CampaignError(404, 'Payment not found');
    if (p.status !== 'pending') throw new CampaignError(409, `This payment is ${p.status}.`);
    const ref = typeof reference === 'string' ? reference.trim() : '';
    if (!ref) throw new CampaignError(400, 'Enter the bank / UPI reference of the payment.');
    const c = await lockCampaign(client, p.campaign_id);
    if (['cancelled', 'rejected'].includes(c.status)) throw new CampaignError(409, `The campaign is ${c.status}; cancel this payment instead.`);
    const { rows: paidRows } = await client.query(
      "UPDATE ad_payments SET status = 'paid', reference = $2, confirmed_by = $3, paid_at = now() WHERE id = $1 RETURNING *",
      [p.id, ref, userId]
    );
    const paid = paidRows[0];
    await settlePaid(client, c, paid, { discountCents: p.purpose === 'booking' ? c.discount_cents : 0 });
    if (p.purpose === 'booking') {
      await history(client, c, 'pending_approval', { userId, role: 'admin', note: `Paid offline (${ref})` });
      await client.query("UPDATE ad_campaigns SET status = 'pending_approval', payment_status = 'paid', updated_at = now() WHERE id = $1", [c.id]);
      await notifyShop(client, c, 'Payment received', `${c.title}: we received ${rupees(p.amount_cents)}. It goes live once approved.`);
    } else {
      await applyExtension(client, c, paid, userId);
    }
    return { campaignId: c.id, paymentId: p.id };
  });
}

/** Slots are limited: at most N campaigns at once in one placement and region. */
async function assertCapacity(db, c, startsAt, endsAt) {
  const { rows } = await db.query(
    `SELECT p.key, p.name, p.max_live_per_region, r.region_id, ar.name AS region_name,
            (SELECT COUNT(*)::int FROM ad_campaigns o JOIN ad_campaign_regions orr ON orr.campaign_id = o.id
             WHERE o.id <> $1 AND o.status IN ('scheduled', 'live', 'paused') AND o.placements ? p.key
               AND orr.region_id = r.region_id AND o.starts_at < $3 AND o.ends_at > $2) AS taken
     FROM ad_campaign_regions r
     JOIN ad_regions ar ON ar.id = r.region_id
     JOIN ad_placements p ON (SELECT placements FROM ad_campaigns WHERE id = $1) ? p.key
     WHERE r.campaign_id = $1`,
    [c.id, startsAt, endsAt]
  );
  const full = rows.find((r) => r.taken >= r.max_live_per_region);
  if (full) throw new CampaignError(409, `${full.name} in ${full.region_name} is full for those dates (${full.max_live_per_region} at once). Reject it to refund, or move another campaign.`);
}

async function approve({ id, userId }) {
  return inTxn(async (client) => {
    const c = await lockCampaign(client, id);
    if (c.status !== 'pending_approval') throw new CampaignError(409, `This campaign is ${c.status.replace('_', ' ')}, not waiting for approval.`);
    if (new Date(c.ends_at) <= new Date()) throw new CampaignError(409, 'Its dates have passed — reject it to refund the shop.');
    const { rows: assets } = await client.query('SELECT 1 FROM ad_assets WHERE campaign_id = $1 LIMIT 1', [c.id]);
    if (!assets.length) throw new CampaignError(409, 'It has no banner image.');
    await assertCapacity(client, c, c.starts_at, c.ends_at);
    const live = new Date(c.starts_at) <= new Date();
    const to = live ? 'live' : 'scheduled';
    await history(client, c, to, { userId, role: 'admin', note: 'Approved' });
    await client.query(
      `UPDATE ad_campaigns SET status = $2::varchar, approved_by = $3, approved_at = now(), went_live_at = CASE WHEN $2::varchar = 'live' THEN now() END, updated_at = now() WHERE id = $1`,
      [c.id, to, userId]
    );
    await notifyShop(client, c, 'Ad approved', live ? `${c.title} is live now.` : `${c.title} goes live on ${new Date(c.starts_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.`);
    return c.id;
  });
}

/**
 * Pays back `amount` of what was paid, spread over the paid payments in
 * proportion. Settlement payments are credited on the next payout at once;
 * offline ones wait for the admin to send the money back.
 */
async function refund(db, c, amount, reason, userId) {
  if (amount <= 0) return [];
  const { rows: paid } = await db.query("SELECT * FROM ad_payments WHERE campaign_id = $1 AND status = 'paid' ORDER BY id", [c.id]);
  const { rows: prior } = await db.query('SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM ad_refunds WHERE campaign_id = $1', [c.id]);
  const paidTotal = paid.reduce((n, p) => n + p.amount_cents, 0);
  const left = paidTotal - prior[0].n;
  const total = Math.min(amount, left);
  if (total <= 0) return [];
  const out = [];
  let remaining = total;
  for (const [i, p] of paid.entries()) {
    const share = i === paid.length - 1 ? remaining : Math.min(remaining, Math.round((total * p.amount_cents) / paidTotal));
    if (share <= 0) continue;
    remaining -= share;
    const tax = Math.round((p.tax_cents * share) / p.amount_cents);
    const settled = p.method === 'settlement';
    const { rows } = await db.query(
      `INSERT INTO ad_refunds (campaign_id, payment_id, method, amount_cents, taxable_cents, tax_cents, reason, status, created_by, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::varchar, $9, CASE WHEN $8::varchar = 'completed' THEN now() END) RETURNING *`,
      [c.id, p.id, p.method, share, share - tax, tax, reason, settled ? 'completed' : 'pending', userId]
    );
    if (settled) {
      await db.query(
        "INSERT INTO vendor_charges (vendor_id, kind, label, amount_cents, ad_refund_id) VALUES ($1, 'ad_refund', $2, $3, $4)",
        [c.vendor_id, `Ad refund ${c.reference}`, -share, rows[0].id]
      );
      await ledgerRefund(db, c, rows[0]);
    }
    out.push(rows[0]);
  }
  const refundedAll = prior[0].n + total >= paidTotal;
  await db.query('UPDATE ad_campaigns SET payment_status = $2, updated_at = now() WHERE id = $1', [c.id, refundedAll ? 'refunded' : 'partially_refunded']);
  return out;
}

async function ledgerRefund(db, c, r) {
  await db.query(
    `INSERT INTO ad_ledger (campaign_id, vendor_id, entry, amount_cents, refund_id, note) VALUES
       ($1, $2, 'ad_refund', $3, $4, $6), ($1, $2, 'ad_tax_refund', $5, $4, $6)`,
    [c.id, c.vendor_id, -r.taxable_cents, r.id, -r.tax_cents, r.reason]
  );
}

/** An offline refund has been paid back to the shop. */
async function completeRefund({ refundId, reference, userId }) {
  return inTxn(async (client) => {
    const { rows } = await client.query('SELECT * FROM ad_refunds WHERE id = $1 FOR UPDATE', [Number(refundId)]);
    const r = rows[0];
    if (!r) throw new CampaignError(404, 'Refund not found');
    if (r.status !== 'pending') throw new CampaignError(409, 'This refund is already completed.');
    const ref = typeof reference === 'string' ? reference.trim() : '';
    if (!ref) throw new CampaignError(400, 'Enter the bank / UPI reference of the refund.');
    const { rows: done } = await client.query("UPDATE ad_refunds SET status = 'completed', reference = $2, completed_at = now() WHERE id = $1 RETURNING *", [r.id, ref]);
    const c = await lockCampaign(client, r.campaign_id);
    await ledgerRefund(client, c, done[0]);
    await notifyShop(client, c, 'Refund sent', `${rupees(r.amount_cents)} for ${c.title} was paid back (${ref}).`);
    void userId;
    return { campaignId: c.id };
  });
}

/** Pending offline payments are void once the campaign won't run. */
async function cancelPendingPayments(db, c) {
  await db.query("UPDATE ad_payments SET status = 'cancelled' WHERE campaign_id = $1 AND status = 'pending'", [c.id]);
}

async function reject({ id, reason, userId }) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text || text.length > 500) throw new CampaignError(400, 'Tell the shop why (up to 500 characters).');
  return inTxn(async (client) => {
    const c = await lockCampaign(client, id);
    if (!['pending_approval', 'pending_payment'].includes(c.status)) throw new CampaignError(409, `This campaign is ${c.status.replace('_', ' ')}.`);
    await cancelPendingPayments(client, c);
    // GLOARO said no, so everything paid comes back.
    const refunds = await refund(client, c, Number.MAX_SAFE_INTEGER, `Rejected: ${text}`, userId);
    await history(client, c, 'rejected', { userId, role: 'admin', note: text });
    await client.query("UPDATE ad_campaigns SET status = 'rejected', rejection_reason = $2, updated_at = now() WHERE id = $1", [c.id, text]);
    const back = refunds.reduce((n, r) => n + r.amount_cents, 0);
    await notifyShop(client, c, 'Ad not approved', `${c.title}: ${text}${back ? ` ${rupees(back)} is refunded.` : ''}`);
    return c.id;
  });
}

async function pause({ id, userId, role = 'admin' }) {
  return inTxn(async (client) => {
    const c = await lockCampaign(client, id);
    if (c.status !== 'live') throw new CampaignError(409, 'Only a live campaign can be paused.');
    await history(client, c, 'paused', { userId, role });
    await client.query("UPDATE ad_campaigns SET status = 'paused', paused_at = now(), updated_at = now() WHERE id = $1", [c.id]);
    await notifyShop(client, c, 'Ad paused', `${c.title} is paused. Its end date stays ${new Date(c.ends_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}.`);
    return c.id;
  });
}

async function resume({ id, userId, role = 'admin' }) {
  return inTxn(async (client) => {
    const c = await lockCampaign(client, id);
    if (c.status !== 'paused') throw new CampaignError(409, 'Only a paused campaign can be resumed.');
    const ended = new Date(c.ends_at) <= new Date();
    const to = ended ? 'completed' : 'live';
    await history(client, c, to, { userId, role, note: ended ? 'Its end date passed while paused' : 'Resumed' });
    await client.query(
      `UPDATE ad_campaigns SET status = $2::varchar, paused_at = NULL, completed_at = CASE WHEN $2::varchar = 'completed' THEN now() END, updated_at = now() WHERE id = $1`,
      [c.id, to]
    );
    return c.id;
  });
}

/**
 * The shop calls it off (or the admin does for them). Before it starts: back
 * less the cancellation fee. While running: the unserved share, if allowed.
 */
async function cancel({ id, reason, userId, role = 'admin' }) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text || text.length > 500) throw new CampaignError(400, 'Give a reason (up to 500 characters).');
  return inTxn(async (client) => {
    const c = await lockCampaign(client, id);
    if (['completed', 'rejected', 'cancelled'].includes(c.status)) throw new CampaignError(409, `This campaign is already ${c.status}.`);
    const { rows: cfg } = await client.query('SELECT * FROM ad_settings WHERE id = 1');
    const { rows: paid } = await client.query("SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM ad_payments WHERE campaign_id = $1 AND status = 'paid'", [c.id]);
    const now = Date.now();
    const start = new Date(c.starts_at).getTime();
    const end = new Date(c.ends_at).getTime();
    let back = 0;
    let note;
    if (now < start) {
      back = Math.round((paid[0].n * (100 - Number(cfg[0].cancellation_fee_percent))) / 100);
      note = `Cancelled before it started — ${Number(cfg[0].cancellation_fee_percent)}% fee kept`;
    } else if (cfg[0].prorata_refund) {
      back = Math.round((paid[0].n * Math.max(0, end - now)) / (end - start));
      note = 'Cancelled while running — the unserved time refunded';
    } else {
      note = 'Cancelled while running — no refund under the policy';
    }
    await cancelPendingPayments(client, c);
    const refunds = await refund(client, c, back, `Cancelled: ${text}`, userId);
    await history(client, c, 'cancelled', { userId, role, note: `${text} · ${note}` });
    await client.query("UPDATE ad_campaigns SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1", [c.id, text]);
    const sum = refunds.reduce((n, r) => n + r.amount_cents, 0);
    await notifyShop(client, c, 'Ad cancelled', `${c.title}: ${text}.${sum ? ` ${rupees(sum)} is refunded.` : ''}`);
    return { campaignId: c.id, refundedCents: sum };
  });
}

async function applyExtension(db, c, payment, userId, role = 'admin') {
  const hours = payment.extension_hours;
  await db.query(
    `UPDATE ad_campaigns SET ends_at = ends_at + make_interval(hours => $2), hours = hours + $2,
       status = CASE WHEN status = 'completed' THEN 'live' ELSE status END, updated_at = now() WHERE id = $1`,
    [c.id, hours]
  );
  await db.query(
    'INSERT INTO ad_campaign_history (campaign_id, from_status, to_status, actor_user_id, actor_role, note) VALUES ($1, $2, $2, $3, $4, $5)',
    [c.id, c.status, userId, role, `Extended by ${hours} h (${rupees(payment.amount_cents)})`]
  );
  await notifyShop(db, c, 'Ad extended', `${c.title} now runs ${hours} hours longer.`);
}

/**
 * More hours on a running campaign, from its current end, at today's prices —
 * only the added hours are charged. Packages can't be extended (book another).
 */
async function extend({ id, hours, method, reference, idempotencyKey, acceptTotalCents, userId, role = 'admin' }) {
  return inTxn(async (client) => {
    const replay = await existingPayment(client, idempotencyKey);
    if (replay) return { campaignId: replay.campaign_id, paymentId: replay.id, replay: true };
    const c = await lockCampaign(client, id);
    if (!RUNNING.includes(c.status)) throw new CampaignError(409, 'Only a scheduled, live or paused campaign can be extended.');
    if (c.model === 'package') throw new CampaignError(409, 'A package can’t be extended — book another one.');
    const add = Number(hours);
    if (!Number.isInteger(add) || add < 1) throw new CampaignError(400, 'Add a whole number of hours.');
    const { rows: pending } = await client.query("SELECT 1 FROM ad_payments WHERE campaign_id = $1 AND status = 'pending' LIMIT 1", [c.id]);
    if (pending.length) throw new CampaignError(409, 'An extension is already waiting for its payment.');
    // Price only the new hours, from the current end; no coupon on extensions.
    const q = await pricing.quote(quoteInput(c, { startsAt: new Date(c.ends_at).toISOString(), hours: add, couponCode: null }), client);
    if (acceptTotalCents == null || Number(acceptTotalCents) !== q.totalCents) {
      throw new CampaignError(409, `Adding ${add} h costs ${rupees(q.totalCents)}. Confirm that amount to extend.`, { quote: q });
    }
    const newEnd = new Date(new Date(c.ends_at).getTime() + add * HOUR).toISOString();
    await assertCapacity(client, c, c.ends_at, newEnd);
    if (q.totalCents === 0) {
      await applyExtension(client, c, { extension_hours: add, amount_cents: 0 }, userId, role);
      return { campaignId: c.id, paymentId: null };
    }
    const how = readMethod(method);
    const { rows } = await client.query(
      `INSERT INTO ad_payments (campaign_id, purpose, method, amount_cents, taxable_cents, tax_cents, status, reference, extension_hours,
         extension_snapshot, idempotency_key, created_by, paid_at)
       VALUES ($1, 'extension', $2, $3, $4, $5, $6::varchar, $7, $8, $9, $10, $11, CASE WHEN $6::varchar = 'paid' THEN now() END) RETURNING *`,
      [c.id, how, q.totalCents, q.taxableCents, q.taxCents, how === 'settlement' ? 'paid' : 'pending', typeof reference === 'string' ? reference.trim() || null : null,
        add, JSON.stringify({ ...q.snapshot, lines: q.lines }), idempotencyKey || null, userId]
    );
    if (how === 'settlement') {
      await settlePaid(client, c, rows[0]);
      await applyExtension(client, c, rows[0], userId, role);
    }
    return { campaignId: c.id, paymentId: rows[0].id };
  });
}

/**
 * Books the same ad again: a new draft with the same message, targeting and
 * banner, from a new start, priced at today's rates. The old one is untouched.
 */
async function renew({ id, startsAt, hours, userId, role = 'admin' }) {
  const { rows } = await pool.query('SELECT * FROM ad_campaigns WHERE id = $1', [Number(id)]);
  const c = rows[0];
  if (!c) throw new CampaignError(404, 'Campaign not found');
  const { rows: regions } = await pool.query('SELECT region_id FROM ad_campaign_regions WHERE campaign_id = $1', [c.id]);
  const newId = await createDraft({
    userId,
    role,
    body: {
      vendorId: c.vendor_id, title: c.title, description: c.description, offerText: c.offer_text, ctaLabel: c.cta_label,
      ctaKind: c.cta_kind, ctaTarget: c.cta_target, discountCampaignId: c.discount_campaign_id, categoryId: c.category_id,
      model: c.model, level: c.level, packageId: c.package_id, regionIds: regions.map((r) => r.region_id), placements: c.placements,
      startsAt, hours: hours ?? (c.model === 'package' ? undefined : c.hours),
    },
  });
  await pool.query(
    `INSERT INTO ad_assets (campaign_id, url, kind, width, height, sort_order)
     SELECT $2, url, kind, width, height, sort_order FROM ad_assets WHERE campaign_id = $1`,
    [c.id, newId]
  );
  await pool.query("UPDATE ad_campaign_history SET note = $2 WHERE campaign_id = $1 AND to_status = 'draft'", [newId, `Renewed from ${c.reference}`]);
  return newId;
}

/** The schedule: scheduled → live at the start, live / paused → completed at the end. */
async function sweep() {
  const moved = [];
  for (const [from, to, cond] of [
    ['scheduled', 'live', 'starts_at <= now() AND ends_at > now()'],
    ['scheduled', 'completed', 'ends_at <= now()'],
    ['live', 'completed', 'ends_at <= now()'],
    ['paused', 'completed', 'ends_at <= now()'],
  ]) {
    const { rows } = await pool.query(`SELECT id FROM ad_campaigns WHERE status = '${from}' AND ${cond} ORDER BY id LIMIT 200`);
    for (const { id } of rows) {
      await inTxn(async (client) => {
        const c = await lockCampaign(client, id);
        if (c.status !== from) return;
        await history(client, c, to);
        await client.query(
          `UPDATE ad_campaigns SET status = $2::varchar, went_live_at = CASE WHEN $2::varchar = 'live' THEN now() ELSE went_live_at END,
             completed_at = CASE WHEN $2::varchar = 'completed' THEN now() END, paused_at = NULL, updated_at = now() WHERE id = $1`,
          [c.id, to]
        );
        if (to === 'live') await notifyShop(client, c, 'Your ad is live', `${c.title} is showing now.`);
        if (to === 'completed') await notifyShop(client, c, 'Ad finished', `${c.title} has finished. Book again any time.`);
        moved.push({ id: c.id, from, to });
      });
    }
  }
  return moved;
}

module.exports = {
  CampaignError, RUNNING, createDraft, updateDraft, addAsset, removeAsset, pay, confirmPayment, approve, reject, pause, resume, cancel,
  extend, renew, completeRefund, sweep, quoteInput,
};
