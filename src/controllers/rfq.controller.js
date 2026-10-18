const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const { membershipFor } = require('../services/business');
const rfqs = require('../services/rfqs');

/**
 * RFQs: raised by a business in the app, worked by staff on Admin → RFQ
 * Management (invite, close, cancel), answered by shops in the vendor portal.
 */

const PAGE_SIZE = 25;
const { RfqError, LIVE_QUOTE } = rfqs;

const fail = (res, err) => {
  if (err instanceof RfqError || (err.status && err.status < 500)) return res.status(err.status).json({ message: err.message });
  throw err;
};

const SELECT = `
  SELECT r.*, a.legal_name, a.trade_name, COALESCE(u.full_name, u.email) AS buyer_name,
         (SELECT COUNT(*)::int FROM rfq_items i WHERE i.rfq_id = r.id) AS item_count,
         (SELECT SUM(i.target_price_cents * i.quantity)::bigint FROM rfq_items i WHERE i.rfq_id = r.id
            HAVING COUNT(i.target_price_cents) = COUNT(*)) AS estimated_value,
         (SELECT COUNT(*)::int FROM rfq_vendors v WHERE v.rfq_id = r.id) AS invited_count,
         (SELECT COUNT(*)::int FROM quotations q WHERE q.rfq_id = r.id AND ${LIVE_QUOTE}) AS quoted_count,
         (SELECT MIN(q.total_cents) FROM quotations q WHERE q.rfq_id = r.id AND ${LIVE_QUOTE}) AS best_quote,
         (SELECT vp.business_name FROM quotations q JOIN vendor_profiles vp ON vp.id = q.vendor_id WHERE q.id = r.awarded_quotation_id) AS awarded_vendor
  FROM rfqs r
  JOIN business_accounts a ON a.id = r.business_account_id
  JOIN users u ON u.id = r.created_by`;

function toJson(r) {
  return {
    id: r.id,
    reference: r.reference,
    title: r.title,
    businessAccountId: r.business_account_id,
    businessName: r.trade_name ?? r.legal_name,
    buyerName: r.buyer_name,
    status: r.status,
    itemCount: r.item_count,
    estimatedValueCents: r.estimated_value == null ? null : Number(r.estimated_value),
    deliveryCity: r.delivery_city,
    deliveryBy: r.delivery_by,
    closesAt: r.closes_at,
    invitedCount: r.invited_count,
    quotedCount: r.quoted_count,
    bestQuoteCents: r.best_quote,
    awardedVendorName: r.awarded_vendor,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
  };
}

async function itemsFor(db, rfqId) {
  const { rows } = await db.query('SELECT * FROM rfq_items WHERE rfq_id = $1 ORDER BY id', [rfqId]);
  return rows.map((i) => ({
    id: i.id, productId: i.product_id, productName: i.product_name, specification: i.specification,
    quantity: i.quantity, unit: i.unit, targetPriceCents: i.target_price_cents,
  }));
}

async function loadDetail(id, { withSuggestions = true } = {}) {
  const { rows } = await pool.query(`${SELECT} WHERE r.id = $1`, [Number(id)]);
  const r = rows[0];
  if (!r) return null;
  const { rows: vendors } = await pool.query(
    `SELECT rv.*, vp.business_name, q.id AS quotation_id, q.total_cents
     FROM rfq_vendors rv JOIN vendor_profiles vp ON vp.id = rv.vendor_id
     LEFT JOIN quotations q ON q.rfq_id = rv.rfq_id AND q.vendor_id = rv.vendor_id AND ${LIVE_QUOTE}
     WHERE rv.rfq_id = $1 ORDER BY q.total_cents NULLS LAST, rv.invited_at`,
    [r.id]
  );
  return {
    ...toJson(r),
    notes: r.notes,
    deliveryAddress: r.delivery_address,
    items: await itemsFor(pool, r.id),
    vendors: vendors.map((v) => ({
      vendorId: v.vendor_id, vendorName: v.business_name, status: v.status, invitedAt: v.invited_at,
      quotationId: v.quotation_id, quotedTotalCents: v.total_cents, declineReason: v.decline_reason, distanceKm: null,
    })),
    suggestions: withSuggestions && r.status === 'open' ? await rfqs.suggestionsFor(pool, r) : [],
  };
}

// ------------------------------------------------------------------ admin

const FILTERS = ['draft', 'open', 'closed', 'awarded', 'cancelled', 'expired'];

async function adminList(req, res) {
  await rfqs.closeDue();
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const conditions = [];
  if (req.query.status) {
    if (!FILTERS.includes(req.query.status)) return res.status(400).json({ message: 'Unknown status' });
    params.push(req.query.status);
    conditions.push(`r.status = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(`(r.reference ILIKE ${p} OR r.title ILIKE ${p} OR a.legal_name ILIKE ${p} OR a.trade_name ILIKE ${p})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = req.query.status === 'open' ? 'r.closes_at ASC' : 'r.created_at DESC';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY ${order}, r.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(`SELECT COUNT(*)::int AS total FROM rfqs r JOIN business_accounts a ON a.id = r.business_account_id ${where}`, params),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

async function adminSummary(req, res) {
  await rfqs.closeDue();
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE r.status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE r.status = 'open' AND r.closes_at < now() + interval '24 hours'
              AND NOT EXISTS (SELECT 1 FROM quotations q WHERE q.rfq_id = r.id AND ${LIVE_QUOTE}))::int AS closing_soon,
            COUNT(*) FILTER (WHERE r.status = 'open' AND EXISTS (SELECT 1 FROM rfq_vendors v WHERE v.rfq_id = r.id)
              AND NOT EXISTS (SELECT 1 FROM quotations q WHERE q.rfq_id = r.id AND ${LIVE_QUOTE}))::int AS awaiting,
            COUNT(*) FILTER (WHERE r.status = 'awarded' AND to_char(r.awarded_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM'))::int AS awarded_month,
            COALESCE(SUM((SELECT q.total_cents FROM quotations q WHERE q.id = r.awarded_quotation_id))
              FILTER (WHERE r.status = 'awarded' AND to_char(r.awarded_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')), 0)::bigint AS awarded_value
     FROM rfqs r`
  );
  const s = rows[0];
  res.json({ open: s.open, closingSoon: s.closing_soon, awaitingQuotes: s.awaiting, awardedThisMonth: s.awarded_month, awardedValueCents: Number(s.awarded_value) });
}

async function adminGet(req, res) {
  await rfqs.closeDue();
  const detail = await loadDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'RFQ not found' });
  res.json(detail);
}

const audit = (req, action, id, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: 'customers', entityType: 'rfq', entityId: id, newValue });

async function lockOpen(client, id) {
  await rfqs.closeDue(client);
  const { rows } = await client.query('SELECT * FROM rfqs WHERE id = $1 FOR UPDATE', [Number(id)]);
  if (!rows[0]) throw new RfqError(404, 'RFQ not found');
  if (rows[0].status !== 'open') throw new RfqError(409, `This RFQ is ${rows[0].status}.`);
  return rows[0];
}

async function adminInvite(req, res) {
  const client = await pool.connect();
  let added;
  try {
    await client.query('BEGIN');
    const rfq = await lockOpen(client, req.params.id);
    added = await rfqs.inviteVendors(client, rfq, req.body?.vendorIds, req.user.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return fail(res, err);
  } finally {
    client.release();
  }
  await audit(req, 'rfq.invited', req.params.id, { vendorIds: req.body.vendorIds, added });
  res.json(await loadDetail(req.params.id));
}

/** Stops new quotes so the ones in can be compared. Needs at least one. */
async function adminClose(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rfq = await lockOpen(client, req.params.id);
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM quotations q WHERE q.rfq_id = $1 AND ${LIVE_QUOTE}`, [rfq.id]);
    if (rows[0].n === 0) throw new RfqError(409, 'No quotes to compare yet.');
    await client.query("UPDATE rfqs SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [rfq.id]);
    await rfqs.notify(client, rfq.created_by, 'rfq_closed', 'Quotes are in', `${rfq.reference} is closed with ${rows[0].n} quote${rows[0].n === 1 ? '' : 's'} to compare.`, `/business/rfqs/${rfq.id}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return fail(res, err);
  } finally {
    client.release();
  }
  await audit(req, 'rfq.closed', req.params.id, null);
  res.json(await loadDetail(req.params.id));
}

/** Cancels an RFQ not yet awarded; everyone invited and the buyer are told. */
async function cancelRfq(client, id, reason, { userId }) {
  const { rows } = await client.query('SELECT * FROM rfqs WHERE id = $1 FOR UPDATE', [Number(id)]);
  const rfq = rows[0];
  if (!rfq) throw new RfqError(404, 'RFQ not found');
  if (!['draft', 'open', 'closed'].includes(rfq.status)) throw new RfqError(409, `This RFQ is ${rfq.status}.`);
  await client.query("UPDATE rfqs SET status = 'cancelled', cancel_reason = $2, updated_at = now() WHERE id = $1", [rfq.id, reason]);
  await client.query(
    `UPDATE quotations SET status = 'withdrawn', decided_at = now(), decided_by = $2, decision_note = 'The RFQ was cancelled'
     WHERE rfq_id = $1 AND status IN ('submitted', 'revision_requested')`,
    [rfq.id, userId]
  );
  const { rows: invited } = await client.query(
    'SELECT vp.user_id FROM rfq_vendors rv JOIN vendor_profiles vp ON vp.id = rv.vendor_id WHERE rv.rfq_id = $1',
    [rfq.id]
  );
  for (const v of invited) await rfqs.notify(client, v.user_id, 'rfq_cancelled', 'RFQ cancelled', `${rfq.reference}: ${reason}`, `/vendor/rfqs/${rfq.id}`);
  if (rfq.created_by !== userId) await rfqs.notify(client, rfq.created_by, 'rfq_cancelled', 'Your RFQ was cancelled', `${rfq.reference}: ${reason}`, `/business/rfqs/${rfq.id}`);
  return rfq;
}

function readReason(req) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) throw new RfqError(400, 'Give a reason (up to 500 characters).');
  return reason;
}

async function adminCancel(req, res) {
  const client = await pool.connect();
  try {
    const reason = readReason(req);
    await client.query('BEGIN');
    await cancelRfq(client, req.params.id, reason, { userId: req.user.id });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return fail(res, err);
  } finally {
    client.release();
  }
  await audit(req, 'rfq.cancelled', req.params.id, { reason: req.body.reason });
  res.json(await loadDetail(req.params.id));
}

// --------------------------------------------------------------- business

async function businessMember(req) {
  const m = await membershipFor(pool, req.user.id);
  if (!m) throw new RfqError(404, 'You are not part of a business account.');
  return m;
}

/** A business member raising an RFQ. Opens straight away; shops can be invited with it. */
async function businessCreate(req, res) {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    const m = await businessMember(req);
    if (m.account_status !== 'verified') throw new RfqError(409, 'Your business must be verified before it can ask for quotes.');
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title || title.length > 160) throw new RfqError(400, 'Give the RFQ a title (up to 160 characters).');
    if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 50) throw new RfqError(400, 'Add 1 to 50 lines.');
    const closesAt = b.closesAt ? new Date(b.closesAt) : new Date(Date.now() + 3 * 86400000);
    if (Number.isNaN(closesAt.getTime()) || closesAt < new Date(Date.now() + 3600000) || closesAt > new Date(Date.now() + 30 * 86400000)) {
      throw new RfqError(400, 'Quotes must close between 1 hour and 30 days from now.');
    }
    if (b.deliveryBy && Number.isNaN(Date.parse(b.deliveryBy))) throw new RfqError(400, 'deliveryBy must be a date.');
    const items = [];
    for (const it of b.items) {
      const qty = it?.quantity;
      if (!Number.isInteger(qty) || qty <= 0) throw new RfqError(400, 'Each line needs a whole-number quantity.');
      const target = it.targetPriceCents ?? null;
      if (target !== null && !(Number.isInteger(target) && target > 0)) throw new RfqError(400, 'targetPriceCents must be a positive whole number.');
      let name = typeof it.productName === 'string' ? it.productName.trim() : '';
      let productId = null;
      if (it.productId != null) {
        const { rows } = await pool.query("SELECT id, name FROM products WHERE id = $1 AND is_active AND moderation_status = 'approved'", [it.productId]);
        if (!rows[0]) throw new RfqError(400, 'A catalogue product on the RFQ is not available.');
        productId = rows[0].id;
        name ||= rows[0].name;
      }
      if (!name) throw new RfqError(400, 'Each line needs a product or a description.');
      items.push({ productId, name: name.slice(0, 200), spec: typeof it.specification === 'string' ? it.specification.trim() || null : null,
        qty, unit: typeof it.unit === 'string' && it.unit.trim() ? it.unit.trim().slice(0, 20) : 'pcs', target });
    }
    // Deliver to one of the business's addresses.
    let address = null;
    if (b.deliveryAddressId != null) {
      const { rows } = await pool.query('SELECT * FROM business_addresses WHERE id = $1 AND account_id = $2', [b.deliveryAddressId, m.account_id]);
      if (!rows[0]) throw new RfqError(404, 'Address not found');
      address = rows[0];
    } else {
      ({ rows: [address] } = await pool.query('SELECT * FROM business_addresses WHERE account_id = $1 AND is_default', [m.account_id]));
    }

    await client.query('BEGIN');
    const { rows: seq } = await client.query("SELECT nextval('rfq_ref_seq') AS n");
    const { rows } = await client.query(
      `INSERT INTO rfqs (reference, business_account_id, created_by, title, notes, delivery_address, delivery_city, delivery_by, closes_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [`RFQ-${new Date().getFullYear()}-${String(seq[0].n).padStart(5, '0')}`, m.account_id, req.user.id, title,
        typeof b.notes === 'string' ? b.notes.trim() || null : null,
        address ? [address.line1, address.line2, address.city, address.state, address.pincode].filter(Boolean).join(', ') : null,
        address?.city ?? null, b.deliveryBy || null, closesAt]
    );
    const rfq = rows[0];
    for (const it of items) {
      await client.query(
        `INSERT INTO rfq_items (rfq_id, product_id, product_name, specification, quantity, unit, target_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [rfq.id, it.productId, it.name, it.spec, it.qty, it.unit, it.target]
      );
    }
    if (Array.isArray(b.vendorIds) && b.vendorIds.length) await rfqs.inviteVendors(client, rfq, b.vendorIds, req.user.id);
    await client.query('COMMIT');
    res.status(201).json(await loadDetail(rfq.id, { withSuggestions: false }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally {
    client.release();
  }
}

async function businessList(req, res) {
  try {
    const m = await businessMember(req);
    await rfqs.closeDue();
    const { rows } = await pool.query(`${SELECT} WHERE r.business_account_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [m.account_id]);
    res.json({ items: rows.map(toJson) });
  } catch (err) {
    fail(res, err);
  }
}

/** One RFQ with the live quotations on it, for the buyer to compare. */
async function businessGet(req, res) {
  try {
    const m = await businessMember(req);
    await rfqs.closeDue();
    const { rows } = await pool.query('SELECT id FROM rfqs WHERE id = $1 AND business_account_id = $2', [Number(req.params.id), m.account_id]);
    if (!rows[0]) throw new RfqError(404, 'RFQ not found');
    const detail = await loadDetail(rows[0].id, { withSuggestions: false });
    const { rows: quotes } = await pool.query(
      `SELECT q.*, vp.business_name FROM quotations q JOIN vendor_profiles vp ON vp.id = q.vendor_id
       WHERE q.rfq_id = $1 AND q.status IN ('submitted', 'revision_requested', 'accepted') ORDER BY q.total_cents`,
      [rows[0].id]
    );
    res.json({
      ...detail,
      suggestions: undefined,
      quotations: quotes.map((q) => ({
        id: q.id, reference: q.reference, revision: q.revision, vendorName: q.business_name, status: q.status,
        subtotalCents: q.subtotal_cents, taxCents: q.tax_cents, deliveryCents: q.delivery_cents, totalCents: q.total_cents,
        validUntil: q.valid_until, deliveryDays: q.delivery_days, paymentTermsDays: q.payment_terms_days, submittedAt: q.submitted_at,
      })),
    });
  } catch (err) {
    fail(res, err);
  }
}

async function businessCancel(req, res) {
  const client = await pool.connect();
  try {
    const m = await businessMember(req);
    const reason = readReason(req);
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM rfqs WHERE id = $1 AND business_account_id = $2', [Number(req.params.id), m.account_id]);
    if (!rows[0]) throw new RfqError(404, 'RFQ not found');
    await cancelRfq(client, rows[0].id, reason, { userId: req.user.id });
    await client.query('COMMIT');
    res.json(await loadDetail(rows[0].id, { withSuggestions: false }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------- vendor

async function vendorList(req, res) {
  await rfqs.closeDue();
  const { rows } = await pool.query(
    `SELECT r.id, r.reference, r.title, r.status, r.closes_at, r.delivery_city, r.delivery_by, rv.status AS my_status,
            (SELECT COUNT(*)::int FROM rfq_items i WHERE i.rfq_id = r.id) AS item_count,
            (SELECT q.total_cents FROM quotations q WHERE q.rfq_id = r.id AND q.vendor_id = $1 AND ${LIVE_QUOTE}) AS my_quote_cents
     FROM rfq_vendors rv JOIN rfqs r ON r.id = rv.rfq_id WHERE rv.vendor_id = $1 ORDER BY rv.invited_at DESC LIMIT 100`,
    [req.vendorId]
  );
  res.json({
    items: rows.map((r) => ({
      id: r.id, reference: r.reference, title: r.title, status: r.status, closesAt: r.closes_at, deliveryCity: r.delivery_city,
      deliveryBy: r.delivery_by, myStatus: r.my_status, itemCount: r.item_count, myQuoteCents: r.my_quote_cents,
    })),
  });
}

/** Opening an invitation marks it viewed. The buyer's identity is shown; rival quotes are not. */
async function vendorGet(req, res) {
  await rfqs.closeDue();
  const { rows } = await pool.query(
    `UPDATE rfq_vendors SET status = CASE WHEN status = 'invited' THEN 'viewed' ELSE status END, viewed_at = COALESCE(viewed_at, now())
     WHERE rfq_id = $1 AND vendor_id = $2 RETURNING status`,
    [Number(req.params.id), req.vendorId]
  );
  if (!rows[0]) return res.status(404).json({ message: 'RFQ not found' });
  const detail = await loadDetail(req.params.id, { withSuggestions: false });
  const { rows: mine } = await pool.query(
    `SELECT q.*, (SELECT json_agg(json_build_object('rfqItemId', l.rfq_item_id, 'unitPriceCents', l.unit_price_cents, 'taxPercent', l.tax_percent::float,
              'lineTotalCents', l.line_total_cents, 'unavailable', l.unavailable, 'note', l.note) ORDER BY l.id) FROM quotation_lines l WHERE l.quotation_id = q.id) AS lines
     FROM quotations q WHERE q.rfq_id = $1 AND q.vendor_id = $2 ORDER BY q.revision DESC LIMIT 1`,
    [Number(req.params.id), req.vendorId]
  );
  const q = mine[0];
  res.json({
    id: detail.id, reference: detail.reference, title: detail.title, status: detail.status, businessName: detail.businessName,
    notes: detail.notes, deliveryAddress: detail.deliveryAddress, deliveryBy: detail.deliveryBy, closesAt: detail.closesAt,
    items: detail.items, myStatus: rows[0].status,
    myQuotation: q ? {
      id: q.id, reference: q.reference, revision: q.revision, status: q.status, totalCents: q.total_cents, subtotalCents: q.subtotal_cents,
      taxCents: q.tax_cents, deliveryCents: q.delivery_cents, validUntil: q.valid_until, deliveryDays: q.delivery_days,
      paymentTermsDays: q.payment_terms_days, notes: q.notes, lines: q.lines,
    } : null,
  });
}

async function vendorDecline(req, res) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) || null : null;
  const { rows } = await pool.query(
    `UPDATE rfq_vendors rv SET status = 'declined', decline_reason = $3
     FROM rfqs r WHERE r.id = rv.rfq_id AND rv.rfq_id = $1 AND rv.vendor_id = $2 AND rv.status IN ('invited', 'viewed') AND r.status = 'open'
     RETURNING rv.rfq_id`,
    [Number(req.params.id), req.vendorId, reason]
  );
  if (!rows[0]) return res.status(409).json({ message: 'Only an open invitation you have not quoted on can be declined.' });
  res.json({ declined: true });
}

async function vendorQuote(req, res) {
  try {
    const q = await rfqs.submitQuotation({ rfqId: Number(req.params.id), vendorId: req.vendorId, userId: req.user.id, body: req.body });
    res.status(201).json({ id: q.id, reference: q.reference, revision: q.revision, status: q.status, totalCents: q.total_cents });
  } catch (err) {
    fail(res, err);
  }
}

module.exports = {
  adminList, adminSummary, adminGet, adminInvite, adminClose, adminCancel,
  businessCreate, businessList, businessGet, businessCancel,
  vendorList, vendorGet, vendorDecline, vendorQuote,
};
