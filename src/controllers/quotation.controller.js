const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const { membershipFor } = require('../services/business');
const { RfqError, closeDue } = require('../services/rfqs');
const quotations = require('../services/quotations');

/**
 * Admin → Quotations, plus the buyer's and the vendor's moves on a quotation.
 * Rules in services/quotations.js.
 */

const PAGE_SIZE = 25;
const fail = (res, err) => {
  if (err instanceof RfqError || (err.status && err.status < 500)) return res.status(err.status).json({ message: err.message });
  throw err;
};

// Cheapest live quote on the same RFQ, to say how far above it each one is.
const SELECT = `
  SELECT q.*, r.reference AS rfq_reference, r.title AS rfq_title, vp.business_name AS vendor_name,
         COALESCE(a.trade_name, a.legal_name) AS business_name,
         (SELECT COUNT(*)::int FROM quotation_lines l WHERE l.quotation_id = q.id) AS line_count,
         (SELECT COUNT(*)::int FROM quotation_lines l WHERE l.quotation_id = q.id AND l.unavailable) AS unavailable_count,
         (SELECT MIN(o.total_cents) FROM quotations o WHERE o.rfq_id = q.rfq_id
            AND o.status IN ('submitted', 'revision_requested', 'accepted')) AS best_total
  FROM quotations q
  JOIN rfqs r ON r.id = q.rfq_id
  JOIN vendor_profiles vp ON vp.id = q.vendor_id
  JOIN business_accounts a ON a.id = r.business_account_id`;

function toJson(q) {
  return {
    id: q.id,
    reference: q.reference,
    rfqId: q.rfq_id,
    rfqReference: q.rfq_reference,
    rfqTitle: q.rfq_title,
    vendorId: q.vendor_id,
    vendorName: q.vendor_name,
    businessName: q.business_name,
    status: q.status,
    revision: q.revision,
    subtotalCents: q.subtotal_cents,
    taxCents: q.tax_cents,
    deliveryCents: q.delivery_cents,
    totalCents: q.total_cents,
    deltaVsBestCents: q.best_total == null || q.total_cents <= q.best_total ? null : q.total_cents - q.best_total,
    validUntil: q.valid_until,
    deliveryDays: q.delivery_days,
    paymentTermsDays: q.payment_terms_days,
    lineCount: q.line_count,
    unavailableCount: q.unavailable_count,
    submittedAt: q.submitted_at,
    decidedAt: q.decided_at,
  };
}

async function loadDetail(id) {
  const { rows } = await pool.query(`${SELECT} WHERE q.id = $1`, [Number(id)]);
  const q = rows[0];
  if (!q) return null;
  const [{ rows: lines }, { rows: competing }, thread] = await Promise.all([
    pool.query(
      `SELECT l.*, i.product_name, i.specification, i.quantity, i.unit, i.target_price_cents
       FROM quotation_lines l JOIN rfq_items i ON i.id = l.rfq_item_id WHERE l.quotation_id = $1 ORDER BY l.id`,
      [q.id]
    ),
    pool.query(
      `SELECT o.id, o.total_cents, o.status, vp.business_name FROM quotations o JOIN vendor_profiles vp ON vp.id = o.vendor_id
       WHERE o.rfq_id = $1 AND o.id <> $2 AND o.vendor_id <> $3 AND o.status IN ('submitted', 'revision_requested', 'accepted')`,
      [q.rfq_id, q.id, q.vendor_id]
    ),
    quotations.threadFor(pool, q),
  ]);
  return {
    ...toJson(q),
    notes: q.notes,
    decisionNote: q.decision_note,
    lines: lines.map((l) => ({
      id: l.id, rfqItemId: l.rfq_item_id,
      description: l.specification ? `${l.product_name} — ${l.specification}` : l.product_name,
      quantity: l.quantity, unit: l.unit, unitPriceCents: l.unit_price_cents, taxPercent: Number(l.tax_percent),
      lineTotalCents: l.line_total_cents, targetPriceCents: l.target_price_cents, unavailable: l.unavailable, note: l.note,
    })),
    messages: thread.map((m) => ({ id: m.id, from: m.author_role, authorName: m.author_name, body: m.body, createdAt: m.created_at })),
    competing: competing.map((c) => ({ quotationId: c.id, vendorName: c.business_name, totalCents: c.total_cents, status: c.status })),
  };
}

const STATUSES = ['submitted', 'revision_requested', 'revised', 'accepted', 'rejected', 'withdrawn', 'expired'];

async function adminList(req, res) {
  await closeDue();
  await quotations.expireDue();
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const conditions = [];
  if (req.query.status) {
    if (!STATUSES.includes(req.query.status)) return res.status(400).json({ message: 'Unknown status' });
    params.push(req.query.status);
    conditions.push(`q.status = $${params.length}`);
  } else {
    // "All" leaves out superseded revisions; they're history, reachable from the live one.
    conditions.push("q.status <> 'revised'");
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(`(q.reference ILIKE ${p} OR r.reference ILIKE ${p} OR r.title ILIKE ${p} OR vp.business_name ILIKE ${p} OR a.legal_name ILIKE ${p})`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const order = req.query.status === 'submitted' ? 'q.submitted_at ASC' : 'q.submitted_at DESC';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY ${order}, q.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM quotations q JOIN rfqs r ON r.id = q.rfq_id JOIN vendor_profiles vp ON vp.id = q.vendor_id
       JOIN business_accounts a ON a.id = r.business_account_id ${where}`,
      params
    ),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

/** "Against target": on accepted quotes, how far below the buyer's target prices they landed, on lines that had one. */
async function adminSummary(req, res) {
  await quotations.expireDue();
  const MONTH = "to_char(q.decided_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')";
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE q.status = 'submitted')::int AS awaiting,
            COUNT(*) FILTER (WHERE q.status = 'revision_requested')::int AS negotiating,
            COUNT(*) FILTER (WHERE q.status = 'accepted' AND ${MONTH})::int AS accepted_month,
            COALESCE(SUM(q.total_cents) FILTER (WHERE q.status = 'accepted' AND ${MONTH}), 0)::bigint AS accepted_value
     FROM quotations q`
  );
  const { rows: saving } = await pool.query(
    `SELECT SUM(i.target_price_cents * i.quantity)::float AS target, SUM(l.unit_price_cents * i.quantity)::float AS quoted
     FROM quotations q JOIN quotation_lines l ON l.quotation_id = q.id JOIN rfq_items i ON i.id = l.rfq_item_id
     WHERE q.status = 'accepted' AND NOT l.unavailable AND i.target_price_cents IS NOT NULL`
  );
  const s = rows[0];
  const t = saving[0];
  res.json({
    awaitingReview: s.awaiting,
    inNegotiation: s.negotiating,
    acceptedThisMonth: s.accepted_month,
    acceptedValueCents: Number(s.accepted_value),
    avgSavingPercent: t.target ? ((t.target - t.quoted) / t.target) * 100 : null,
  });
}

async function adminGet(req, res) {
  await quotations.expireDue();
  const detail = await loadDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'Quotation not found' });
  res.json(detail);
}

const audit = (req, action, id, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: 'customers', entityType: 'quotation', entityId: id, newValue });

async function adminAward(req, res) {
  try {
    const { purchaseOrder } = await quotations.award({ id: req.params.id, userId: req.user.id, role: 'admin' });
    await audit(req, 'quotation.awarded', req.params.id, { purchaseOrder: purchaseOrder.po_number, totalCents: purchaseOrder.total_cents });
    res.json({ ...(await loadDetail(req.params.id)), purchaseOrderId: purchaseOrder.id, poNumber: purchaseOrder.po_number });
  } catch (err) {
    fail(res, err);
  }
}

async function adminReject(req, res) {
  try {
    await quotations.reject({ id: req.params.id, role: 'admin', userId: req.user.id, reason: req.body?.reason });
    await audit(req, 'quotation.rejected', req.params.id, { reason: req.body.reason });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

async function adminRequestRevision(req, res) {
  try {
    await quotations.requestRevision({ id: req.params.id, role: 'admin', userId: req.user.id, message: req.body?.message });
    await audit(req, 'quotation.revision_requested', req.params.id, { message: req.body.message });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

/** A message to the vendor on an undecided quote; the vendor is told. */
async function postMessage(req, res, { role, quote }) {
  if (['accepted', 'rejected', 'withdrawn', 'expired'].includes(quote.status)) throw new RfqError(409, 'This quote is decided — the thread is closed.');
  await quotations.addMessage(pool, quote.id, { role, userId: req.user.id, body: req.body?.body });
  if (role !== 'vendor') {
    const { rows } = await pool.query('SELECT user_id FROM vendor_profiles WHERE id = $1', [quote.vendor_id]);
    await pool.query("INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'quotation_message', $2, $3, $4)", [
      rows[0]?.user_id, 'New message on your quotation', req.body.body.slice(0, 200), `/vendor/rfqs/${quote.rfq_id}`,
    ]);
  } else {
    const { rows } = await pool.query('SELECT created_by FROM rfqs WHERE id = $1', [quote.rfq_id]);
    await pool.query("INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, 'quotation_message', $2, $3, $4)", [
      rows[0]?.created_by, 'The vendor replied', req.body.body.slice(0, 200), `/business/rfqs/${quote.rfq_id}`,
    ]);
  }
}

async function adminMessage(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM quotations WHERE id = $1', [Number(req.params.id)]);
    if (!rows[0]) throw new RfqError(404, 'Quotation not found');
    await postMessage(req, res, { role: 'admin', quote: rows[0] });
    res.status(201).json(await loadDetail(rows[0].id));
  } catch (err) {
    fail(res, err);
  }
}

// ------------------------------------------------------------ buyer & vendor

/** A quote on one of the caller's business's RFQs. Deciding needs an owner or approver. */
async function buyersQuote(req, { decide = false } = {}) {
  const m = await membershipFor(pool, req.user.id);
  if (!m) throw new RfqError(404, 'Quotation not found');
  const { rows } = await pool.query(
    'SELECT q.* FROM quotations q JOIN rfqs r ON r.id = q.rfq_id WHERE q.id = $1 AND r.business_account_id = $2',
    [Number(req.params.id), m.account_id]
  );
  if (!rows[0]) throw new RfqError(404, 'Quotation not found');
  if (decide && m.role === 'buyer') throw new RfqError(403, 'Ask an owner or approver to accept or reject quotes.');
  return rows[0];
}

async function buyerGet(req, res) {
  try {
    const q = await buyersQuote(req);
    const detail = await loadDetail(q.id);
    res.json({ ...detail, competing: undefined });
  } catch (err) {
    fail(res, err);
  }
}

async function buyerAccept(req, res) {
  try {
    await buyersQuote(req, { decide: true });
    const { purchaseOrder } = await quotations.award({ id: req.params.id, userId: req.user.id, role: 'buyer' });
    await audit(req, 'quotation.awarded', req.params.id, { by: 'buyer', purchaseOrder: purchaseOrder.po_number, totalCents: purchaseOrder.total_cents });
    res.json({ accepted: true, purchaseOrderId: purchaseOrder.id, poNumber: purchaseOrder.po_number });
  } catch (err) {
    fail(res, err);
  }
}

async function buyerReject(req, res) {
  try {
    await buyersQuote(req, { decide: true });
    await quotations.reject({ id: req.params.id, role: 'buyer', userId: req.user.id, reason: req.body?.reason });
    await audit(req, 'quotation.rejected', req.params.id, { by: 'buyer', reason: req.body.reason });
    res.json({ rejected: true });
  } catch (err) {
    fail(res, err);
  }
}

async function buyerRequestRevision(req, res) {
  try {
    await buyersQuote(req);
    await quotations.requestRevision({ id: req.params.id, role: 'buyer', userId: req.user.id, message: req.body?.message });
    res.json({ revisionRequested: true });
  } catch (err) {
    fail(res, err);
  }
}

async function buyerMessage(req, res) {
  try {
    const q = await buyersQuote(req);
    await postMessage(req, res, { role: 'buyer', quote: q });
    res.status(201).json({ sent: true });
  } catch (err) {
    fail(res, err);
  }
}

async function vendorsQuote(req) {
  const { rows } = await pool.query('SELECT * FROM quotations WHERE id = $1 AND vendor_id = $2', [Number(req.params.id), req.vendorId]);
  if (!rows[0]) throw new RfqError(404, 'Quotation not found');
  return rows[0];
}

/** The vendor's thread on a quote (all its revisions). */
async function vendorThread(req, res) {
  try {
    const q = await vendorsQuote(req);
    const thread = await quotations.threadFor(pool, q);
    res.json({ status: q.status, decisionNote: q.decision_note, messages: thread.map((m) => ({ id: m.id, from: m.author_role, authorName: m.author_name, body: m.body, createdAt: m.created_at })) });
  } catch (err) {
    fail(res, err);
  }
}

async function vendorMessage(req, res) {
  try {
    const q = await vendorsQuote(req);
    await postMessage(req, res, { role: 'vendor', quote: q });
    res.status(201).json({ sent: true });
  } catch (err) {
    fail(res, err);
  }
}

async function vendorWithdraw(req, res) {
  try {
    await quotations.withdraw({ id: req.params.id, vendorId: req.vendorId });
    res.json({ withdrawn: true });
  } catch (err) {
    fail(res, err);
  }
}

module.exports = {
  adminList, adminSummary, adminGet, adminAward, adminReject, adminRequestRevision, adminMessage,
  buyerGet, buyerAccept, buyerReject, buyerRequestRevision, buyerMessage,
  vendorThread, vendorMessage, vendorWithdraw,
};
