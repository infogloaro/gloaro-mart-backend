const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const pricing = require('../services/adPricing');
const campaigns = require('../services/adCampaigns');

/**
 * Admin → Ad Promotions → Campaigns and Payments. Rules in
 * services/adCampaigns.js; plan in docs/ad-promotions-plan.md.
 */

const PAGE_SIZE = 25;
const run = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof campaigns.CampaignError || err instanceof pricing.QuoteError) {
      return res.status(err.status).json({ message: err.message, ...(err.quote ? { quote: err.quote } : {}) });
    }
    if (err.code === '23505') return res.status(409).json({ message: 'That was already done.' });
    throw err;
  }
};
const audit = (req, action, id, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: 'ad_promotions', entityType: 'ad_campaign', entityId: id, newValue });

const SELECT = `
  SELECT c.*, vp.business_name AS shop_name, vp.city AS shop_city,
         (SELECT string_agg(r.name, ', ' ORDER BY r.name) FROM ad_campaign_regions cr JOIN ad_regions r ON r.id = cr.region_id WHERE cr.campaign_id = c.id) AS region_names,
         (SELECT url FROM ad_assets a WHERE a.campaign_id = c.id ORDER BY a.sort_order, a.id LIMIT 1) AS thumb,
         (SELECT COALESCE(SUM(amount_cents), 0) FROM ad_payments p WHERE p.campaign_id = c.id AND p.status = 'paid')::int AS paid_cents,
         (SELECT COALESCE(SUM(amount_cents), 0) FROM ad_refunds f WHERE f.campaign_id = c.id)::int AS refunded_cents
  FROM ad_campaigns c JOIN vendor_profiles vp ON vp.id = c.vendor_id`;

function toJson(c) {
  return {
    id: c.id,
    reference: c.reference,
    vendorId: c.vendor_id,
    shopName: c.shop_name,
    shopCity: c.shop_city,
    title: c.title,
    thumbnail: c.thumb ?? null,
    model: c.model,
    level: c.level,
    placements: c.placements,
    regionNames: c.region_names ?? '',
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    hours: c.hours,
    status: c.status,
    paymentStatus: c.payment_status,
    totalCents: c.total_cents,
    paidCents: c.paid_cents ?? 0,
    refundedCents: c.refunded_cents ?? 0,
    commissionPercent: Number(c.commission_percent),
    createdByRole: c.created_by_role,
    createdAt: c.created_at,
  };
}

const STATUSES = ['draft', 'pending_payment', 'pending_approval', 'scheduled', 'live', 'paused', 'completed', 'rejected', 'cancelled'];

const list = run(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const where = [];
  if (req.query.status) {
    const s = String(req.query.status).split(',');
    if (s.some((x) => !STATUSES.includes(x))) return res.status(400).json({ message: 'Unknown status' });
    params.push(s);
    where.push(`c.status = ANY($${params.length})`);
  }
  if (req.query.vendorId) {
    params.push(Number(req.query.vendorId));
    where.push(`c.vendor_id = $${params.length}`);
  }
  if (req.query.placement) {
    params.push(String(req.query.placement));
    where.push(`c.placements ? $${params.length}`);
  }
  if (req.query.regionId) {
    params.push(Number(req.query.regionId));
    where.push(`EXISTS (SELECT 1 FROM ad_campaign_regions cr WHERE cr.campaign_id = c.id AND cr.region_id = $${params.length})`);
  }
  if (req.query.from) {
    params.push(req.query.from);
    where.push(`c.ends_at >= $${params.length}::timestamptz`);
  }
  if (req.query.to) {
    params.push(req.query.to);
    where.push(`c.starts_at < $${params.length}::timestamptz`);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    where.push(`(c.reference ILIKE ${p} OR c.title ILIKE ${p} OR vp.business_name ILIKE ${p})`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // The approval queue oldest first; everything else newest first.
  const order = req.query.status === 'pending_approval' ? 'c.updated_at ASC' : 'c.created_at DESC';
  const [{ rows }, { rows: count }, { rows: counts }] = await Promise.all([
    pool.query(`${SELECT} ${w} ORDER BY ${order}, c.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(`SELECT COUNT(*)::int AS total FROM ad_campaigns c JOIN vendor_profiles vp ON vp.id = c.vendor_id ${w}`, params),
    pool.query('SELECT status, COUNT(*)::int AS n FROM ad_campaigns GROUP BY status'),
  ]);
  res.json({
    items: rows.map(toJson),
    total: count[0].total,
    page,
    pageSize: PAGE_SIZE,
    counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((x) => x.status === s)?.n ?? 0])),
  });
});

async function loadDetail(id) {
  const { rows } = await pool.query(`${SELECT} WHERE c.id = $1`, [Number(id)]);
  const c = rows[0];
  if (!c) return null;
  const [regions, assets, payments, refunds, invoices, hist, discount] = await Promise.all([
    pool.query(
      `SELECT r.id, r.name, r.level, r.price_multiplier, p.name AS parent_name FROM ad_campaign_regions cr
       JOIN ad_regions r ON r.id = cr.region_id LEFT JOIN ad_regions p ON p.id = r.parent_id WHERE cr.campaign_id = $1 ORDER BY r.name`,
      [c.id]
    ),
    pool.query('SELECT * FROM ad_assets WHERE campaign_id = $1 ORDER BY sort_order, id', [c.id]),
    pool.query('SELECT p.*, i.invoice_number FROM ad_payments p LEFT JOIN ad_invoices i ON i.payment_id = p.id WHERE p.campaign_id = $1 ORDER BY p.id', [c.id]),
    pool.query('SELECT * FROM ad_refunds WHERE campaign_id = $1 ORDER BY id', [c.id]),
    pool.query('SELECT * FROM ad_invoices WHERE campaign_id = $1 ORDER BY id', [c.id]),
    pool.query(
      `SELECT h.*, COALESCE(u.full_name, u.email) AS actor_name FROM ad_campaign_history h LEFT JOIN users u ON u.id = h.actor_user_id
       WHERE h.campaign_id = $1 ORDER BY h.created_at, h.id`,
      [c.id]
    ),
    c.discount_campaign_id ? pool.query('SELECT id, name FROM campaigns WHERE id = $1', [c.discount_campaign_id]) : Promise.resolve({ rows: [] }),
  ]);
  return {
    ...toJson(c),
    description: c.description,
    offerText: c.offer_text,
    ctaLabel: c.cta_label,
    ctaKind: c.cta_kind,
    ctaTarget: c.cta_target,
    discountCampaign: discount.rows[0] ?? null,
    categoryId: c.category_id,
    packageId: c.package_id,
    couponCode: c.coupon_code,
    regionIds: regions.rows.map((r) => r.id),
    regions: regions.rows.map((r) => ({ id: r.id, name: r.name, level: r.level, parentName: r.parent_name, multiplier: Number(r.price_multiplier) })),
    subtotalCents: c.subtotal_cents,
    discountCents: c.discount_cents,
    taxableCents: c.taxable_cents,
    taxCents: c.tax_cents,
    priceLines: c.price_snapshot?.lines ?? [],
    priceSnapshot: c.price_snapshot,
    rejectionReason: c.rejection_reason,
    cancelReason: c.cancel_reason,
    approvedAt: c.approved_at,
    wentLiveAt: c.went_live_at,
    completedAt: c.completed_at,
    assets: assets.rows.map((a) => ({ id: a.id, url: a.url, kind: a.kind, width: a.width, height: a.height })),
    payments: payments.rows.map((p) => ({
      id: p.id, purpose: p.purpose, method: p.method, amountCents: p.amount_cents, taxCents: p.tax_cents, status: p.status,
      reference: p.reference, extensionHours: p.extension_hours, invoiceNumber: p.invoice_number, paidAt: p.paid_at, createdAt: p.created_at,
    })),
    refunds: refunds.rows.map((r) => ({
      id: r.id, method: r.method, amountCents: r.amount_cents, reason: r.reason, status: r.status, reference: r.reference,
      completedAt: r.completed_at, createdAt: r.created_at,
    })),
    invoices: invoices.rows.map((i) => ({
      id: i.id, number: i.invoice_number, date: i.invoice_date, supplyType: i.supply_type, taxableCents: i.taxable_cents,
      cgstCents: i.cgst_cents, sgstCents: i.sgst_cents, igstCents: i.igst_cents, totalCents: i.total_cents, buyerGstin: i.buyer_gstin,
      sellerGstin: i.seller_gstin, description: i.description,
    })),
    history: hist.rows.map((h) => ({ id: h.id, from: h.from_status, to: h.to_status, actorRole: h.actor_role, actorName: h.actor_name, note: h.note, at: h.created_at })),
  };
}

const get = run(async (req, res) => {
  const d = await loadDetail(req.params.id);
  if (!d) return res.status(404).json({ message: 'Campaign not found' });
  res.json(d);
});

const respond = async (res, id, status = 200) => res.status(status).json(await loadDetail(id));

const create = run(async (req, res) => {
  const id = await campaigns.createDraft({ body: req.body, userId: req.user.id, role: 'admin' });
  await audit(req, 'ads.campaign_created', id, { vendorId: req.body?.vendorId, title: req.body?.title });
  await respond(res, id, 201);
});

const update = run(async (req, res) => {
  const id = await campaigns.updateDraft({ id: req.params.id, body: req.body ?? {}, userId: req.user.id });
  await respond(res, id);
});

const addAsset = run(async (req, res) => {
  const id = await campaigns.addAsset({ id: req.params.id, body: req.body });
  await respond(res, id, 201);
});

const removeAsset = run(async (req, res) => {
  const id = await campaigns.removeAsset({ id: req.params.id, assetId: req.params.assetId });
  await respond(res, id);
});

const pay = run(async (req, res) => {
  const b = req.body ?? {};
  const out = await campaigns.pay({
    id: req.params.id, method: b.method, reference: b.reference, acceptTotalCents: b.acceptTotalCents,
    idempotencyKey: req.get('idempotency-key') || b.idempotencyKey, userId: req.user.id,
  });
  if (!out.replay) await audit(req, 'ads.campaign_paid', out.campaignId, { method: b.method, paymentId: out.paymentId });
  await respond(res, out.campaignId);
});

const confirmPayment = run(async (req, res) => {
  const out = await campaigns.confirmPayment({ paymentId: req.params.paymentId, reference: req.body?.reference, userId: req.user.id });
  await audit(req, 'ads.payment_confirmed', out.campaignId, { paymentId: out.paymentId, reference: req.body?.reference });
  await respond(res, out.campaignId);
});

const completeRefund = run(async (req, res) => {
  const out = await campaigns.completeRefund({ refundId: req.params.refundId, reference: req.body?.reference, userId: req.user.id });
  await audit(req, 'ads.refund_completed', out.campaignId, { refundId: req.params.refundId, reference: req.body?.reference });
  await respond(res, out.campaignId);
});

const action = (name, fn) => run(async (req, res) => {
  const out = await fn(req);
  const id = typeof out === 'object' && out ? out.campaignId : out;
  await audit(req, `ads.campaign_${name}`, id, req.body ?? null);
  await respond(res, id);
});
const approve = action('approved', (req) => campaigns.approve({ id: req.params.id, userId: req.user.id }));
const reject = action('rejected', (req) => campaigns.reject({ id: req.params.id, reason: req.body?.reason, userId: req.user.id }));
const pause = action('paused', (req) => campaigns.pause({ id: req.params.id, userId: req.user.id }));
const resume = action('resumed', (req) => campaigns.resume({ id: req.params.id, userId: req.user.id }));
const cancel = action('cancelled', (req) => campaigns.cancel({ id: req.params.id, reason: req.body?.reason, userId: req.user.id }));
const extend = action('extended', (req) => campaigns.extend({
  id: req.params.id, hours: req.body?.hours, method: req.body?.method, reference: req.body?.reference,
  acceptTotalCents: req.body?.acceptTotalCents, idempotencyKey: req.get('idempotency-key') || req.body?.idempotencyKey, userId: req.user.id,
}));

/** The campaign's price if it were paid now — for the "pay" step to show before it charges. */
const requote = run(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ad_campaigns WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ message: 'Campaign not found' });
  const { rows: regions } = await pool.query('SELECT region_id FROM ad_campaign_regions WHERE campaign_id = $1', [rows[0].id]);
  rows[0].region_ids = regions.map((r) => r.region_id);
  res.json(await pricing.quote(campaigns.quoteInput(rows[0])));
});

// --------------------------------------------------------- payments & ledger

const payments = run(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const where = [];
  if (req.query.status) {
    params.push(String(req.query.status));
    where.push(`p.status = $${params.length}`);
  }
  if (req.query.method) {
    params.push(String(req.query.method));
    where.push(`p.method = $${params.length}`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ rows }, { rows: count }, { rows: refunds }, { rows: totals }] = await Promise.all([
    pool.query(
      `SELECT p.*, c.reference AS campaign_reference, c.title, vp.business_name AS shop_name, i.invoice_number FROM ad_payments p
       JOIN ad_campaigns c ON c.id = p.campaign_id JOIN vendor_profiles vp ON vp.id = c.vendor_id
       LEFT JOIN ad_invoices i ON i.payment_id = p.id ${w}
       ORDER BY (p.status = 'pending') DESC, p.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM ad_payments p ${w}`, params),
    pool.query(
      `SELECT f.*, c.reference AS campaign_reference, c.title, vp.business_name AS shop_name FROM ad_refunds f
       JOIN ad_campaigns c ON c.id = f.campaign_id JOIN vendor_profiles vp ON vp.id = c.vendor_id
       ORDER BY (f.status = 'pending') DESC, f.created_at DESC LIMIT 50`
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE entry = 'ad_revenue'), 0)::bigint AS revenue,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry = 'ad_tax'), 0)::bigint AS tax,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry = 'ad_refund'), 0)::bigint AS refunds,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry = 'ad_tax_refund'), 0)::bigint AS tax_refunds,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry = 'ad_discount'), 0)::bigint AS discounts,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM ad_payments WHERE status = 'pending')::bigint AS pending,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM ad_refunds WHERE status = 'pending')::bigint AS refunds_pending,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM vendor_charges WHERE settlement_id IS NULL AND kind = 'advertising')::bigint AS awaiting_payout
       FROM ad_ledger`
    ),
  ]);
  const t = totals[0];
  res.json({
    totals: {
      revenueCents: Number(t.revenue), taxCents: Number(t.tax), refundsCents: -Number(t.refunds), taxRefundsCents: -Number(t.tax_refunds),
      netRevenueCents: Number(t.revenue) + Number(t.refunds), discountsCents: Number(t.discounts), pendingCents: Number(t.pending),
      refundsPendingCents: Number(t.refunds_pending), awaitingPayoutCents: Number(t.awaiting_payout),
    },
    items: rows.map((p) => ({
      id: p.id, campaignId: p.campaign_id, campaignReference: p.campaign_reference, title: p.title, shopName: p.shop_name, purpose: p.purpose,
      method: p.method, amountCents: p.amount_cents, taxCents: p.tax_cents, status: p.status, bankReference: p.reference,
      extensionHours: p.extension_hours, invoiceNumber: p.invoice_number, paidAt: p.paid_at, createdAt: p.created_at,
    })),
    total: count[0].total,
    page,
    pageSize: PAGE_SIZE,
    refunds: refunds.map((f) => ({
      id: f.id, campaignId: f.campaign_id, campaignReference: f.campaign_reference, title: f.title, shopName: f.shop_name, method: f.method,
      amountCents: f.amount_cents, reason: f.reason, status: f.status, bankReference: f.reference, createdAt: f.created_at, completedAt: f.completed_at,
    })),
  });
});

const renew = run(async (req, res) => {
  const id = await campaigns.renew({ id: req.params.id, startsAt: req.body?.startsAt, hours: req.body?.hours, userId: req.user.id, role: 'admin' });
  await audit(req, 'ads.campaign_renewed', id, { from: Number(req.params.id) });
  await respond(res, id, 201);
});

module.exports = {
  list, get, create, update, addAsset, removeAsset, pay, confirmPayment, completeRefund, approve, reject, pause, resume, cancel, extend, renew, requote,
  payments,
  // For the vendor portal, which shows the same detail for the shop's own campaigns.
  SELECT, toJson, loadDetail, STATUSES,
};
