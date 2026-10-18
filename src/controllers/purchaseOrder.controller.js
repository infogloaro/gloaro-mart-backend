const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const { membershipFor } = require('../services/business');
const { RfqError } = require('../services/rfqs');
const purchaseOrders = require('../services/purchaseOrders');

/**
 * Admin → Purchase Orders, the vendor's side (acknowledge, deliver, confirm
 * payment) and the buyer's (follow, cancel, close). Rules in
 * services/purchaseOrders.js.
 */

const PAGE_SIZE = 25;
const fail = (res, err) => {
  if (err instanceof RfqError || (err.status && err.status < 500)) return res.status(err.status).json({ message: err.message });
  throw err;
};

// Delivered share is by value: each line's total weighted by how much of it arrived.
const SELECT = `
  SELECT po.*, q.reference AS quotation_reference, r.reference AS rfq_reference, r.title AS rfq_title,
         COALESCE(a.trade_name, a.legal_name) AS business_name, COALESCE(u.full_name, u.email) AS buyer_name,
         vp.business_name AS vendor_name, m.invoiced, m.paid, m.last_delivery_at, m.line_count, m.fulfilled
  FROM purchase_orders po
  JOIN quotations q ON q.id = po.quotation_id
  JOIN rfqs r ON r.id = po.rfq_id
  JOIN business_accounts a ON a.id = po.business_account_id
  JOIN vendor_profiles vp ON vp.id = po.vendor_id
  LEFT JOIN users u ON u.id = po.buyer_user_id
  CROSS JOIN LATERAL (
    SELECT (SELECT COALESCE(SUM(value_cents), 0) FROM purchase_order_deliveries d WHERE d.purchase_order_id = po.id)::bigint AS invoiced,
           (SELECT COALESCE(SUM(amount_cents), 0) FROM purchase_order_payments p WHERE p.purchase_order_id = po.id)::bigint AS paid,
           (SELECT MAX(delivered_at) FROM purchase_order_deliveries d WHERE d.purchase_order_id = po.id) AS last_delivery_at,
           (SELECT COUNT(*)::int FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS line_count,
           (SELECT CASE WHEN SUM(l.line_total_cents) > 0
                        THEN SUM(l.line_total_cents::float * l.delivered_quantity / l.quantity) / SUM(l.line_total_cents)
                        WHEN COUNT(*) > 0 THEN SUM(l.delivered_quantity)::float / SUM(l.quantity) ELSE 0 END
            FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS fulfilled
  ) m`;
const FROM_COUNT = `FROM purchase_orders po JOIN rfqs r ON r.id = po.rfq_id JOIN business_accounts a ON a.id = po.business_account_id
  JOIN vendor_profiles vp ON vp.id = po.vendor_id`;

/** Payment is due the terms' days after the latest delivery. */
function paymentDueAt(po) {
  if (!po.last_delivery_at) return null;
  return new Date(new Date(po.last_delivery_at).getTime() + po.payment_terms_days * 86400000).toISOString();
}

function toJson(po) {
  return {
    id: po.id,
    poNumber: po.po_number,
    quotationId: po.quotation_id,
    quotationReference: po.quotation_reference,
    rfqId: po.rfq_id,
    rfqReference: po.rfq_reference,
    rfqTitle: po.rfq_title,
    businessAccountId: po.business_account_id,
    businessName: po.business_name,
    buyerName: po.buyer_name ?? '—',
    vendorId: po.vendor_id,
    vendorName: po.vendor_name,
    status: po.status,
    subtotalCents: po.subtotal_cents,
    taxCents: po.tax_cents,
    deliveryCents: po.delivery_cents,
    totalCents: po.total_cents,
    invoicedCents: Number(po.invoiced),
    paidCents: Number(po.paid),
    paymentTermsDays: po.payment_terms_days,
    paymentDueAt: paymentDueAt(po),
    expectedDeliveryAt: po.expected_delivery_at,
    acknowledgedAt: po.acknowledged_at,
    lineCount: po.line_count,
    fulfilledRatio: Math.min(1, Number(po.fulfilled) || 0),
    invoiceNumber: po.invoice_number,
    issuedAt: po.issued_at,
    deliveredAt: po.delivered_at,
    closedAt: po.closed_at,
    cancelReason: po.cancel_reason,
  };
}

async function loadDetail(id, extraWhere = '', params = []) {
  const { rows } = await pool.query(`${SELECT} WHERE po.id = $1 ${extraWhere}`, [Number(id), ...params]);
  const po = rows[0];
  if (!po) return null;
  const [{ rows: lines }, { rows: deliveries }, { rows: delLines }, { rows: payments }] = await Promise.all([
    pool.query('SELECT * FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY id', [po.id]),
    pool.query('SELECT * FROM purchase_order_deliveries WHERE purchase_order_id = $1 ORDER BY delivered_at, id', [po.id]),
    pool.query(
      `SELECT dl.* FROM purchase_order_delivery_lines dl JOIN purchase_order_deliveries d ON d.id = dl.delivery_id
       WHERE d.purchase_order_id = $1`,
      [po.id]
    ),
    pool.query('SELECT * FROM purchase_order_payments WHERE purchase_order_id = $1 ORDER BY paid_at, id', [po.id]),
  ]);
  return {
    ...toJson(po),
    deliveryAddress: po.delivery_address,
    notes: po.notes,
    lines: lines.map((l) => ({
      id: l.id, description: l.description, hsnCode: l.hsn_code, quantity: l.quantity, unit: l.unit,
      deliveredQuantity: l.delivered_quantity, unitPriceCents: l.unit_price_cents, taxPercent: Number(l.tax_percent),
      lineTotalCents: l.line_total_cents,
    })),
    deliveries: deliveries.map((d) => ({
      id: d.id, deliveredAt: d.delivered_at, note: d.note, shipmentId: d.shipment_id, trackingNumber: d.tracking_number,
      valueCents: d.value_cents,
      lines: delLines.filter((x) => x.delivery_id === d.id).map((x) => ({ lineId: x.purchase_order_line_id, quantity: x.quantity })),
    })),
    payments: payments.map((p) => ({ id: p.id, amountCents: p.amount_cents, method: p.method, reference: p.reference, paidAt: p.paid_at })),
  };
}

// "In progress" on the page covers everything between acknowledged and delivered.
const FILTERS = {
  issued: ['issued'],
  acknowledged: ['acknowledged'],
  in_progress: ['acknowledged', 'in_progress', 'partially_delivered'],
  partially_delivered: ['partially_delivered'],
  delivered: ['delivered'],
  closed: ['closed'],
  cancelled: ['cancelled'],
};

async function list(req, res, scope = {}) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const conditions = [];
  if (req.query.status && req.query.status !== 'all') {
    const statuses = FILTERS[req.query.status];
    if (!statuses) return res.status(400).json({ message: 'Unknown status' });
    params.push(statuses);
    conditions.push(`po.status = ANY($${params.length})`);
  }
  if (scope.vendorId != null) {
    params.push(scope.vendorId);
    conditions.push(`po.vendor_id = $${params.length}`);
  }
  if (scope.accountId != null) {
    params.push(scope.accountId);
    conditions.push(`po.business_account_id = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(`(po.po_number ILIKE ${p} OR r.reference ILIKE ${p} OR r.title ILIKE ${p} OR vp.business_name ILIKE ${p} OR a.legal_name ILIKE ${p} OR a.trade_name ILIKE ${p})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // Waiting ones oldest first: the longest unacknowledged is the one to chase.
  const order = req.query.status === 'issued' ? 'po.issued_at ASC' : 'po.issued_at DESC';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY ${order}, po.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(`SELECT COUNT(*)::int AS total ${FROM_COUNT} ${where}`, params),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

const adminList = (req, res) => list(req, res);

async function adminSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE po.status = 'issued')::int AS awaiting,
            COUNT(*) FILTER (WHERE po.status IN ('acknowledged', 'in_progress', 'partially_delivered'))::int AS in_progress,
            COUNT(*) FILTER (WHERE po.status = ANY($1) AND po.expected_delivery_at < now())::int AS overdue,
            COALESCE(SUM(po.total_cents) FILTER (WHERE po.status <> 'cancelled'
              AND to_char(po.issued_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')), 0)::bigint AS issued_month,
            COALESCE(SUM(GREATEST(m.invoiced - m.paid, 0)), 0)::bigint AS outstanding
     FROM purchase_orders po
     CROSS JOIN LATERAL (
       SELECT (SELECT COALESCE(SUM(value_cents), 0) FROM purchase_order_deliveries d WHERE d.purchase_order_id = po.id) AS invoiced,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM purchase_order_payments p WHERE p.purchase_order_id = po.id) AS paid
     ) m`,
    [purchaseOrders.OPEN]
  );
  const s = rows[0];
  res.json({
    awaitingAcknowledgement: s.awaiting,
    inProgress: s.in_progress,
    overdue: s.overdue,
    issuedThisMonthCents: Number(s.issued_month),
    outstandingCents: Number(s.outstanding),
  });
}

async function adminGet(req, res) {
  const detail = await loadDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'Purchase order not found' });
  res.json(detail);
}

const audit = (req, action, id, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: 'purchase_orders', entityType: 'purchase_order', entityId: id, newValue });

async function adminResend(req, res) {
  try {
    const po = await purchaseOrders.resend({ id: req.params.id });
    await audit(req, 'purchase_order.resent', po.id, { poNumber: po.po_number });
    res.json(await loadDetail(po.id));
  } catch (err) {
    fail(res, err);
  }
}

async function adminCancel(req, res) {
  try {
    const po = await purchaseOrders.cancel({ id: req.params.id, userId: req.user.id, reason: req.body?.reason, by: 'admin' });
    await audit(req, 'purchase_order.cancelled', po.id, { poNumber: po.po_number, reason: req.body.reason });
    res.json(await loadDetail(po.id));
  } catch (err) {
    fail(res, err);
  }
}

async function adminClose(req, res) {
  try {
    const po = await purchaseOrders.close({ id: req.params.id, userId: req.user.id });
    await audit(req, 'purchase_order.closed', po.id, { poNumber: po.po_number });
    res.json(await loadDetail(po.id));
  } catch (err) {
    fail(res, err);
  }
}

// ------------------------------------------------------------------ vendor

const vendorList = (req, res) => list(req, res, { vendorId: req.vendorId });

async function vendorGet(req, res) {
  const detail = await loadDetail(req.params.id, 'AND po.vendor_id = $2', [req.vendorId]);
  if (!detail) return res.status(404).json({ message: 'Purchase order not found' });
  res.json(detail);
}

/** Runs a vendor move, audits it, and answers with the fresh detail. */
const vendorAction = (action, fn, status = 200) => async (req, res) => {
  try {
    const out = await fn(req);
    const po = out.po ?? out;
    await audit(req, `purchase_order.${action}`, po.id, { poNumber: po.po_number, by: 'vendor', ...(req.body ?? {}) });
    res.status(status).json(await loadDetail(po.id));
  } catch (err) {
    fail(res, err);
  }
};

const vendorAcknowledge = vendorAction('acknowledged', (req) => purchaseOrders.acknowledge({ id: req.params.id, vendorId: req.vendorId }));
const vendorStart = vendorAction('started', (req) => purchaseOrders.start({ id: req.params.id, vendorId: req.vendorId }));
const vendorDeliver = vendorAction('delivery_recorded', (req) => purchaseOrders.recordDelivery({
  id: req.params.id, vendorId: req.vendorId, userId: req.user.id, lines: req.body?.lines,
  trackingNumber: req.body?.trackingNumber, note: req.body?.note, deliveredAt: req.body?.deliveredAt,
}), 201);
const vendorInvoiceNumber = vendorAction('invoice_number_set', (req) => purchaseOrders.setInvoiceNumber({
  id: req.params.id, vendorId: req.vendorId, invoiceNumber: req.body?.invoiceNumber,
}));
const vendorPayment = vendorAction('payment_recorded', (req) => purchaseOrders.recordPayment({
  id: req.params.id, vendorId: req.vendorId, userId: req.user.id, amountCents: req.body?.amountCents,
  method: req.body?.method, reference: req.body?.reference, paidAt: req.body?.paidAt,
}), 201);

// ------------------------------------------------------------------- buyer

/** The caller's business. Cancelling or closing needs an owner or approver. */
async function buyerAccount(req, { decide = false } = {}) {
  const m = await membershipFor(pool, req.user.id);
  if (!m) throw new RfqError(404, 'Purchase order not found');
  if (decide && m.role === 'buyer') throw new RfqError(403, 'Ask an owner or approver to cancel or close purchase orders.');
  return m;
}

async function buyerList(req, res) {
  const m = await membershipFor(pool, req.user.id);
  if (!m) return res.json({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE });
  return list(req, res, { accountId: m.account_id });
}

async function buyerGet(req, res) {
  try {
    const m = await buyerAccount(req);
    const detail = await loadDetail(req.params.id, 'AND po.business_account_id = $2', [m.account_id]);
    if (!detail) throw new RfqError(404, 'Purchase order not found');
    res.json(detail);
  } catch (err) {
    fail(res, err);
  }
}

async function buyersPo(req, opts) {
  const m = await buyerAccount(req, opts);
  const { rows } = await pool.query('SELECT id FROM purchase_orders WHERE id = $1 AND business_account_id = $2', [Number(req.params.id), m.account_id]);
  if (!rows[0]) throw new RfqError(404, 'Purchase order not found');
  return rows[0].id;
}

async function buyerCancel(req, res) {
  try {
    const id = await buyersPo(req, { decide: true });
    const po = await purchaseOrders.cancel({ id, userId: req.user.id, reason: req.body?.reason, by: 'buyer' });
    await audit(req, 'purchase_order.cancelled', po.id, { poNumber: po.po_number, by: 'buyer', reason: req.body.reason });
    res.json(await loadDetail(po.id));
  } catch (err) {
    fail(res, err);
  }
}

async function buyerClose(req, res) {
  try {
    const id = await buyersPo(req, { decide: true });
    const po = await purchaseOrders.close({ id, userId: req.user.id });
    await audit(req, 'purchase_order.closed', po.id, { poNumber: po.po_number, by: 'buyer' });
    res.json(await loadDetail(po.id));
  } catch (err) {
    fail(res, err);
  }
}

module.exports = {
  adminList, adminSummary, adminGet, adminResend, adminCancel, adminClose,
  vendorList, vendorGet, vendorAcknowledge, vendorStart, vendorDeliver, vendorInvoiceNumber, vendorPayment,
  buyerList, buyerGet, buyerCancel, buyerClose,
};
