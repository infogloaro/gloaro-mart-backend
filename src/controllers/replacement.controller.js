const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const replacements = require('../services/replacements');

/** Admin → Replacements. Rules in services/replacements.js. */

const PAGE_SIZE = 25;
const PAGE_REASON = { missing_items: 'missing_parts' };

const SELECT = `
  SELECT rp.*, ${replacements.STATUS_SQL} AS shown_status,
         rt.reason_code, rt.comment AS return_note, o.id AS orig_id, o.user_id, o.delivery_address,
         COALESCE(cg.reference, '#' || o.id) AS group_reference,
         vp.business_name AS vendor_name, fv.business_name AS fulfil_vendor_name,
         COALESCE(u.full_name, u.email) AS customer_name,
         COALESCE(o.delivery_address_snapshot->>'mobile_number', u.phone_number) AS customer_phone,
         (SELECT COUNT(*)::int FROM replacement_items ri WHERE ri.replacement_id = rp.id) AS item_count,
         (SELECT MAX(h.created_at) FROM order_status_history h WHERE h.order_id = rp.replacement_order_id AND h.to_status = 'delivered') AS delivered_at
  FROM replacements rp
  JOIN order_returns rt ON rt.id = rp.return_id
  JOIN orders o ON o.id = rp.original_order_id
  LEFT JOIN orders ro ON ro.id = rp.replacement_order_id
  LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
  JOIN vendor_profiles vp ON vp.id = rp.vendor_id
  LEFT JOIN vendor_profiles fv ON fv.id = rp.fulfil_vendor_id
  JOIN users u ON u.id = o.user_id`;

function toJson(r) {
  return {
    id: r.id,
    reference: r.reference,
    returnId: r.return_id,
    returnReference: `RET-${String(r.return_id).padStart(5, '0')}`,
    originalOrderId: r.original_order_id,
    originalOrderReference: `${r.group_reference} · #${r.original_order_id}`,
    replacementOrderId: r.replacement_order_id,
    replacementOrderReference: r.replacement_order_id ? `${r.group_reference} · #${r.replacement_order_id}` : null,
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    fulfilVendorId: r.fulfil_vendor_id,
    fulfilVendorName: r.fulfil_vendor_name,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    status: r.shown_status,
    reason: PAGE_REASON[r.reason_code] ?? r.reason_code,
    note: r.cancel_reason ?? r.return_note,
    itemCount: r.item_count,
    valueCents: r.value_cents,
    priceDifferenceCents: r.price_difference_cents,
    blockedReason: r.shown_status === 'failed' ? 'The replacement order was cancelled.' : r.blocked_reason,
    requestedAt: r.created_at,
    approvedAt: r.approved_at,
    deliveredAt: r.delivered_at,
  };
}

async function loadDetail(id) {
  const { rows } = await pool.query(`${SELECT} WHERE rp.id = $1`, [Number(id)]);
  const r = rows[0];
  if (!r) return null;
  const [{ rows: items }, { rows: events }] = await Promise.all([
    pool.query(
      `SELECT ri.*, p.name, p.sku, p.image_url, oi.variant_label_snapshot FROM replacement_items ri
       JOIN products p ON p.id = ri.product_id JOIN order_items oi ON oi.id = ri.order_item_id
       WHERE ri.replacement_id = $1 ORDER BY ri.id`,
      [r.id]
    ),
    pool.query(
      `SELECT e.*, u.full_name AS actor_name FROM replacement_events e LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.replacement_id = $1 ORDER BY e.created_at DESC, e.id DESC`,
      [r.id]
    ),
  ]);
  const stock = await replacements.stockFor(pool, items.map((i) => i.product_id));
  const open = ['requested', 'awaiting_stock'].includes(r.status);
  return {
    ...toJson(r),
    deliveryAddress: r.delivery_address,
    items: items.map((i) => ({
      id: i.id,
      productName: i.name,
      variantLabel: i.variant_label_snapshot,
      sku: i.sku,
      imageUrl: i.image_url,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      availableQty: stock.get(i.product_id) ?? 0,
    })),
    // Only worth computing while it can still be moved.
    alternates: open ? await replacements.alternatesFor(pool, r) : [],
    timeline: events.map((e) => ({ id: e.id, status: e.status, note: e.note, actorRole: e.actor_role, actorName: e.actor_name, createdAt: e.created_at })),
  };
}

const FILTERS = {
  requested: "rp.status = 'requested'",
  awaiting_stock: "rp.status = 'awaiting_stock'",
  // The page's "approved" is everything in fulfilment.
  approved: `rp.replacement_order_id IS NOT NULL AND ro.status NOT IN ('delivered', 'cancelled')`,
  delivered: "ro.status = 'delivered'",
  failed: "ro.status = 'cancelled'",
  cancelled: "rp.status = 'cancelled'",
};

async function listReplacements(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const conditions = [];
  if (req.query.status) {
    if (!FILTERS[req.query.status]) return res.status(400).json({ message: 'Unknown status' });
    conditions.push(FILTERS[req.query.status]);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(`(rp.reference ILIKE ${p} OR cg.reference ILIKE ${p} OR u.full_name ILIKE ${p} OR u.email ILIKE ${p}
      OR ('RET-' || lpad(rp.return_id::text, 5, '0')) ILIKE ${p})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY rp.created_at DESC, rp.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM replacements rp JOIN orders o ON o.id = rp.original_order_id
       LEFT JOIN orders ro ON ro.id = rp.replacement_order_id LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
       JOIN users u ON u.id = o.user_id ${where}`,
      params
    ),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

async function replacementSummary(req, res) {
  const MONTH = "to_char(COALESCE(rp.approved_at, rp.created_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')";
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE rp.status = 'requested')::int AS awaiting_decision,
            COUNT(*) FILTER (WHERE rp.status = 'awaiting_stock')::int AS awaiting_stock,
            COUNT(*) FILTER (WHERE rp.replacement_order_id IS NOT NULL AND ro.status NOT IN ('delivered', 'cancelled'))::int AS in_fulfilment,
            COUNT(*) FILTER (WHERE ro.status = 'delivered' AND ${MONTH})::int AS delivered_month,
            COUNT(*) FILTER (WHERE ro.status = 'cancelled')::int AS failed,
            COALESCE(SUM(GREATEST(rp.price_difference_cents, 0)) FILTER (WHERE rp.replacement_order_id IS NOT NULL AND ${MONTH}), 0)::bigint AS absorbed
     FROM replacements rp LEFT JOIN orders ro ON ro.id = rp.replacement_order_id`
  );
  const s = rows[0];
  res.json({
    awaitingDecision: s.awaiting_decision,
    awaitingStock: s.awaiting_stock,
    inFulfilment: s.in_fulfilment,
    deliveredThisMonth: s.delivered_month,
    failed: s.failed,
    priceDifferenceCents: Number(s.absorbed),
  });
}

async function getReplacement(req, res) {
  const detail = await loadDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'Replacement not found' });
  res.json(detail);
}

const fail = (res, err) => {
  if (err instanceof replacements.ReplacementError || err.status) return res.status(err.status).json({ message: err.message });
  throw err;
};
const audit = (req, action, id, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: 'orders', entityType: 'replacement', entityId: id, newValue });

async function approveReplacement(req, res) {
  try {
    const result = await replacements.approve({ id: Number(req.params.id), userId: req.user.id });
    if (result.blocked) return res.status(409).json({ message: result.blocked });
    await audit(req, 'replacement.approved', req.params.id, { orderId: result.order.id });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

async function reassignReplacement(req, res) {
  try {
    await replacements.reassign({ id: Number(req.params.id), vendorId: req.body?.vendorId, userId: req.user.id });
    await audit(req, 'replacement.reassigned', req.params.id, { vendorId: req.body?.vendorId });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

async function cancelReplacement(req, res) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) return res.status(400).json({ message: 'Say why (up to 500 characters).' });
  try {
    await replacements.cancel({ id: Number(req.params.id), reason, userId: req.user.id });
    await audit(req, 'replacement.cancelled', req.params.id, { reason });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

module.exports = { listReplacements, replacementSummary, getReplacement, approveReplacement, reassignReplacement, cancelReplacement };
