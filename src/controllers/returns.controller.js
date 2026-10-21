const pool = require('./../config/db');
const { raiseCreditNote } = require('../services/creditNotes');
const { recordAudit } = require('../services/auditLog');

/**
 * Returns on delivered orders (schema PHASE 13, lifecycle PHASE 43).
 *
 * A return is a *request*, not money moving. The customer asks (for a refund
 * or a replacement); an admin approves it with the refund to authorise, and
 * pickup is scheduled; the goods arrive and are inspected; only then is the
 * refund released — and even that only queues it, through the same refund
 * approval as any other. A replacement-return hands over to Replacements.
 *
 * One return per order: once one has been approved (or is in progress), the
 * order can't be returned again. A rejected or withdrawn one doesn't count.
 */

const REASON_CODES = ['damaged', 'wrong_item', 'not_as_described', 'missing_items', 'other'];
// The admin page's names for the same reasons.
const PAGE_REASON = { missing_items: 'missing_parts' };
const RESOLUTIONS = ['refund', 'replacement'];
const CONDITIONS = ['unopened', 'opened', 'used', 'damaged', 'missing'];
// States that use up the order's one return.
const SETTLED_OR_OPEN = ['requested', 'approved', 'pickup_scheduled', 'picked_up', 'received', 'refunded', 'disputed'];

/** How long after delivery a return can still be raised. */
const RETURN_WINDOW_DAYS = 7;
const PAGE_SIZE = 25;

// Evidence: only paths this server stored (POST /api/orders/returns/photos).
const MAX_PHOTOS = 5;
const PHOTO_PATH = /^\/uploads\/returns\/[\w.-]+$/;
const MIN_COMMENT_LENGTH = 10;

/**
 * When the order was actually delivered.
 *
 * Read from the status history rather than orders.updated_at: that column moves
 * on any later write, which would silently extend or shorten someone's return
 * window. The history row is written once and never changes.
 */
async function deliveredAtFor(orderId) {
  const { rows } = await pool.query(
    `SELECT created_at FROM order_status_history
     WHERE order_id = $1 AND to_status = 'delivered'
     ORDER BY created_at DESC LIMIT 1`,
    [orderId]
  );
  return rows[0]?.created_at ?? null;
}

/**
 * Whether an order can still be returned, and why not when it cannot.
 *
 * Shared by the request handler and the order payload so the button the app
 * shows and the rule the server enforces can never disagree. `latestReturn` is
 * the order's most recent return, if any.
 */
function returnEligibility(order, deliveredAt, latestReturn = null) {
  if (order.status !== 'delivered') {
    return { eligible: false, reason: 'Only delivered orders can be returned.' };
  }
  if (order.replacement_of_order_id) {
    return { eligible: false, reason: 'A replacement order cannot be returned again — contact support instead.' };
  }
  if (latestReturn && SETTLED_OR_OPEN.includes(latestReturn.status)) {
    return { eligible: false, reason: 'This order already has a return.' };
  }
  // Orders delivered before the history table existed have no row. Refusing
  // them would be worse than allowing one late return, so they stay eligible.
  if (!deliveredAt) return { eligible: true, daysLeft: RETURN_WINDOW_DAYS };

  const elapsedDays = (Date.now() - new Date(deliveredAt).getTime()) / 86400000;
  if (elapsedDays > RETURN_WINDOW_DAYS) {
    return {
      eligible: false,
      reason: `The ${RETURN_WINDOW_DAYS}-day return window for this order has closed.`,
    };
  }
  return { eligible: true, daysLeft: Math.max(0, Math.ceil(RETURN_WINDOW_DAYS - elapsedDays)) };
}

async function latestReturnFor(db, orderId) {
  const { rows } = await db.query(
    'SELECT id, status, reason_code, resolution FROM order_returns WHERE order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [orderId]
  );
  return rows[0] ?? null;
}

async function addEvent(db, returnId, status, { note = null, actorRole = 'system', userId = null } = {}) {
  await db.query(
    'INSERT INTO order_return_events (return_id, status, note, actor_role, actor_user_id) VALUES ($1, $2, $3, $4, $5)',
    [returnId, status, note, actorRole, userId]
  );
}

async function requestReturn(req, res) {
  const { reasonCode, comment, resolution = 'refund', photos = [] } = req.body || {};
  if (!REASON_CODES.includes(reasonCode)) {
    return res.status(400).json({ message: `reasonCode must be one of ${REASON_CODES.join(', ')}` });
  }
  if (!RESOLUTIONS.includes(resolution)) {
    return res.status(400).json({ message: "resolution must be 'refund' or 'replacement'" });
  }
  // The customer says in their own words what went wrong, and shows it: at
  // least one photo of the item, uploaded first through POST /api/orders/returns/photos.
  const words = typeof comment === 'string' ? comment.trim() : '';
  if (words.length < MIN_COMMENT_LENGTH) {
    return res.status(400).json({ message: `Tell us what went wrong (at least ${MIN_COMMENT_LENGTH} characters).` });
  }
  if (!Array.isArray(photos) || photos.length < 1 || photos.length > MAX_PHOTOS || !photos.every((p) => typeof p === 'string' && PHOTO_PATH.test(p))) {
    return res.status(400).json({
      message: photos?.length > MAX_PHOTOS ? `Up to ${MAX_PHOTOS} photos.` : 'Add at least one photo of the item you want to return.',
    });
  }

  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  const order = rows[0];
  if (!order) return res.status(404).json({ message: 'Order not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Locked so two requests at once can't both pass the one-return check.
    await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [order.id]);
    const eligibility = returnEligibility(order, await deliveredAtFor(order.id), await latestReturnFor(client, order.id));
    if (!eligibility.eligible) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: eligibility.reason });
    }
    const { rows: created } = await client.query(
      `INSERT INTO order_returns (order_id, user_id, reason_code, comment, resolution, photos)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
      [order.id, req.user.id, reasonCode, words, resolution, JSON.stringify(photos)]
    );
    await addEvent(client, created[0].id, 'requested', { note: words, actorRole: 'customer', userId: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(created[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ message: 'A return request for this order is already open.' });
    throw err;
  } finally {
    client.release();
  }
}

/** The caller's own return requests for one order. */
async function listReturnsForOrder(req, res) {
  const { rows: orderRows } = await pool.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  if (!orderRows[0]) return res.status(404).json({ message: 'Order not found' });

  const { rows } = await pool.query(
    `SELECT r.id, r.order_id, r.reason_code, r.comment, r.status, r.resolution, r.resolution_note, r.refund_id,
            r.approved_refund_cents, r.dispute_reason, r.created_at, r.reviewed_at, r.received_at, r.photos,
            rp.reference AS replacement_reference
     FROM order_returns r LEFT JOIN replacements rp ON rp.return_id = r.id
     WHERE r.order_id = $1 ORDER BY r.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}

/** The customer withdrawing a request an admin has not decided yet. */
async function cancelReturn(req, res) {
  const { rows } = await pool.query(
    `UPDATE order_returns SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'requested' RETURNING *`,
    [req.params.returnId, req.user.id]
  );
  if (!rows[0]) {
    return res.status(409).json({ message: 'That request no longer exists or has already been decided.' });
  }
  await addEvent(pool, rows[0].id, 'cancelled', { note: 'Withdrawn by the customer', actorRole: 'customer', userId: req.user.id });
  res.json(rows[0]);
}

/** The customer contesting a rejection: it goes back to an admin to decide again. */
async function disputeReturn(req, res) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) return res.status(400).json({ message: 'Say why you disagree (up to 500 characters).' });
  const { rows } = await pool.query(
    `UPDATE order_returns SET status = 'disputed', dispute_reason = $3, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'rejected' RETURNING *`,
    [req.params.returnId, req.user.id, reason]
  );
  if (!rows[0]) return res.status(409).json({ message: 'Only a rejected return can be disputed.' });
  await addEvent(pool, rows[0].id, 'disputed', { note: reason, actorRole: 'customer', userId: req.user.id });
  res.json(rows[0]);
}

// --- Admin ---

const SELECT = `
  SELECT r.*, o.total_cents, o.vendor_id, o.payment_method, o.checkout_group_id,
         vp.business_name AS vendor_name, COALESCE(u.full_name, u.email) AS customer_name,
         COALESCE(o.delivery_address_snapshot->>'mobile_number', u.phone_number) AS customer_phone,
         COALESCE(cg.reference, '#' || o.id) AS group_reference,
         (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
         (SELECT MAX(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'delivered') AS delivered_at,
         rf.status AS refund_status,
         (SELECT cn.credit_note_number FROM credit_notes cn WHERE cn.return_id = r.id AND cn.status = 'issued' ORDER BY cn.id DESC LIMIT 1) AS credit_note_number
  FROM order_returns r
  JOIN orders o ON o.id = r.order_id
  LEFT JOIN vendor_profiles vp ON vp.id = o.vendor_id
  JOIN users u ON u.id = r.user_id
  LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
  LEFT JOIN refunds rf ON rf.id = r.refund_id`;

function toJson(r) {
  const windowCloses = r.delivered_at ? new Date(new Date(r.delivered_at).getTime() + RETURN_WINDOW_DAYS * 86400000) : null;
  return {
    id: r.id,
    reference: `RET-${String(r.id).padStart(5, '0')}`,
    orderId: r.order_id,
    orderReference: `${r.group_reference} · #${r.order_id}`,
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    status: r.status,
    reason: PAGE_REASON[r.reason_code] ?? r.reason_code,
    reasonNote: r.comment,
    resolution: r.resolution,
    itemCount: r.item_count,
    refundableCents: r.total_cents,
    approvedRefundCents: r.approved_refund_cents,
    requestedAt: r.created_at,
    windowClosesAt: windowCloses,
    isWithinWindow: !windowCloses || new Date(r.created_at) <= windowCloses,
    pickupScheduledAt: r.pickup_scheduled_at,
    receivedAt: r.received_at,
    refundId: r.refund_id,
    refundStatus: r.refund_status,
    creditNoteNumber: r.credit_note_number,
    disputeReason: r.dispute_reason,
    evidenceCount: Array.isArray(r.photos) ? r.photos.length : 0,
  };
}

async function loadDetail(id) {
  const { rows } = await pool.query(`${SELECT} WHERE r.id = $1`, [Number(id)]);
  const r = rows[0];
  if (!r) return null;
  const [{ rows: items }, { rows: events }] = await Promise.all([
    pool.query(
      `SELECT oi.*, p.sku, p.image_url FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 ORDER BY oi.id`,
      [r.order_id]
    ),
    pool.query(
      `SELECT e.*, u.full_name AS actor_name FROM order_return_events e LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.return_id = $1 ORDER BY e.created_at DESC, e.id DESC`,
      [r.id]
    ),
  ]);
  // A line's refundable share of what was paid (the order total spread by line value).
  const values = items.map((i) => i.unit_price_cents * i.quantity);
  const sum = values.reduce((a, b) => a + b, 0);
  let given = 0;
  return {
    ...toJson(r),
    pickupAddress: r.delivery_address ?? null,
    items: items.map((i, idx) => {
      const share = idx === items.length - 1 ? r.total_cents - given : sum ? Math.floor((r.total_cents * values[idx]) / sum) : 0;
      given += share;
      return {
        id: i.id,
        orderItemId: i.id,
        productName: i.variant_label_snapshot ? `${i.product_name_snapshot} (${i.variant_label_snapshot})` : i.product_name_snapshot,
        sku: i.sku,
        imageUrl: i.image_url,
        quantity: i.quantity,
        unitPriceCents: i.unit_price_cents,
        refundableCents: share,
        condition: r.condition,
      };
    }),
    // Photos the customer attached when asking; the admin panel prefixes its
    // API base to the path like any other upload.
    evidence: (Array.isArray(r.photos) ? r.photos : []).map((p, i) => ({
      id: i + 1,
      url: p,
      kind: 'image',
      caption: null,
      uploadedAt: r.created_at,
    })),
    timeline: events.map((e) => ({
      id: e.id,
      status: e.status,
      note: e.note,
      actorRole: e.actor_role,
      actorName: e.actor_name,
      createdAt: e.created_at,
    })),
  };
}

const STATUS_FILTERS = {
  requested: ['requested'],
  // The page's "approved" covers everything between approval and inspection.
  approved: ['approved', 'pickup_scheduled', 'picked_up'],
  received: ['received'],
  disputed: ['disputed'],
  refunded: ['refunded'],
  rejected: ['rejected'],
  cancelled: ['cancelled'],
};

async function listReturns(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const conditions = [];
  if (req.query.status) {
    if (!STATUS_FILTERS[req.query.status]) return res.status(400).json({ message: 'Unknown status' });
    params.push(STATUS_FILTERS[req.query.status]);
    conditions.push(`r.status = ANY($${params.length})`);
  }
  if (req.query.q) {
    const q = req.query.q.replace(/^RET-0*/i, '');
    params.push(`%${req.query.q}%`, q);
    const p = `$${params.length - 1}`;
    conditions.push(`(cg.reference ILIKE ${p} OR u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR vp.business_name ILIKE ${p}
      OR r.id::text = $${params.length} OR o.id::text = $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = req.query.status === 'requested' ? 'r.created_at ASC' : 'r.created_at DESC';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY ${order}, r.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM order_returns r JOIN orders o ON o.id = r.order_id
       LEFT JOIN vendor_profiles vp ON vp.id = o.vendor_id JOIN users u ON u.id = r.user_id
       LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id ${where}`,
      params
    ),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

async function returnSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE r.status = 'requested')::int AS requested,
            COUNT(*) FILTER (WHERE r.status IN ('approved', 'pickup_scheduled', 'picked_up'))::int AS awaiting_pickup,
            COUNT(*) FILTER (WHERE r.status = 'received')::int AS awaiting_inspection,
            COUNT(*) FILTER (WHERE r.status = 'disputed')::int AS disputed,
            COUNT(*) FILTER (WHERE r.status = 'refunded' AND to_char(r.updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM'))::int AS refunded_month,
            COALESCE(SUM(r.approved_refund_cents) FILTER (WHERE r.status = 'refunded' AND to_char(r.updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')), 0)::bigint AS refunded_cents
     FROM order_returns r`
  );
  const s = rows[0];
  res.json({
    requested: s.requested,
    awaitingPickup: s.awaiting_pickup,
    awaitingInspection: s.awaiting_inspection,
    disputed: s.disputed,
    refundedThisMonth: s.refunded_month,
    refundedCents: Number(s.refunded_cents),
  });
}

async function getReturn(req, res) {
  const detail = await loadDetail(req.params.returnId);
  if (!detail) return res.status(404).json({ message: 'Return not found' });
  res.json(detail);
}

const audit = (req, action, id, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: 'orders', entityType: 'order_return', entityId: id, newValue });

/**
 * Approves a return with the refund to authorise (up to what was paid; the
 * full amount when none is given) and schedules pickup. No money moves yet —
 * it is released after inspection. A replacement-return raises its replacement.
 */
async function approveReturn(req, res) {
  const { note } = req.body || {};
  const client = await pool.connect();
  let request;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT r.*, o.total_cents FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.id = $1 FOR UPDATE OF r`,
      [req.params.returnId]
    );
    request = rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Return request not found' });
    }
    if (!['requested', 'disputed'].includes(request.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This request is already ${request.status.replace(/_/g, ' ')}.` });
    }
    const refundCents = req.body?.refundCents ?? (request.resolution === 'replacement' ? 0 : request.total_cents);
    if (!Number.isInteger(refundCents) || refundCents < 0 || refundCents > request.total_cents) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'The refund must be a whole number of paise, up to what was paid.' });
    }
    const { rows: updated } = await client.query(
      `UPDATE order_returns
       SET status = 'pickup_scheduled', approved_refund_cents = $2, resolution_note = $3, pickup_scheduled_at = now(),
           reviewed_by_user_id = $4, reviewed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [request.id, refundCents, note || null, req.user.id]
    );
    request = updated[0];
    await addEvent(client, request.id, 'pickup_scheduled', {
      note: request.resolution === 'replacement' ? 'Approved for a replacement; pickup scheduled' : `Approved; pickup scheduled${note ? ` — ${note}` : ''}`,
      actorRole: 'admin',
      userId: req.user.id,
    });
    if (request.resolution === 'replacement') {
      await require('../services/replacements').raiseForReturn(client, request, req.user.id);
    }
    await client.query('INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, $2, $3, $4, $5)', [
      request.user_id,
      'return_approved',
      'Your return was approved',
      request.resolution === 'replacement'
        ? `We'll collect the item from order #${request.order_id} and send a replacement.`
        : `We'll collect the item from order #${request.order_id}. Your refund is released once it's checked.`,
      `/orders/${request.order_id}`,
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await audit(req, 'return.approved', request.id, { refundCents: request.approved_refund_cents, resolution: request.resolution });
  res.json(await loadDetail(request.id));
}

async function rejectReturn(req, res) {
  const reason = (req.body?.reason ?? req.body?.note ?? '').toString().trim();
  if (!reason) return res.status(400).json({ message: 'Give a reason the customer can read.' });
  const { rows } = await pool.query(
    `UPDATE order_returns
     SET status = 'rejected', resolution_note = $2, reviewed_by_user_id = $3, reviewed_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ('requested', 'disputed') RETURNING *`,
    [req.params.returnId, reason, req.user.id]
  );
  if (!rows[0]) return res.status(409).json({ message: 'That request has already been decided.' });
  await addEvent(pool, rows[0].id, 'rejected', { note: reason, actorRole: 'admin', userId: req.user.id });
  await pool.query('INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, $2, $3, $4, $5)', [
    rows[0].user_id, 'return_rejected', 'Your return was not approved', `${reason} You can dispute this from the order.`,
    `/orders/${rows[0].order_id}`,
  ]);
  await audit(req, 'return.rejected', rows[0].id, { reason });
  res.json(await loadDetail(rows[0].id));
}

/** The goods arrived: what condition they're in. Doesn't change the approved amount by itself. */
async function receiveReturn(req, res) {
  const { condition } = req.body || {};
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() || null : null;
  if (!CONDITIONS.includes(condition)) return res.status(400).json({ message: `condition must be one of ${CONDITIONS.join(', ')}` });
  const { rows } = await pool.query(
    `UPDATE order_returns SET status = 'received', condition = $2, received_at = now(), updated_at = now()
     WHERE id = $1 AND status IN ('approved', 'pickup_scheduled', 'picked_up') RETURNING *`,
    [req.params.returnId, condition]
  );
  if (!rows[0]) return res.status(409).json({ message: 'Only an approved return on its way back can be received.' });
  await addEvent(pool, rows[0].id, 'received', { note: `Arrived ${condition}${note ? ` — ${note}` : ''}`, actorRole: 'admin', userId: req.user.id });
  await audit(req, 'return.received', rows[0].id, { condition, note });
  res.json(await loadDetail(rows[0].id));
}

/**
 * Releases the approved refund after inspection: a pending refund on the online
 * payment (COD is settled off-platform, as before) and the credit note that
 * reverses the sale. A replacement-return has nothing to release here.
 */
async function releaseRefund(req, res) {
  const client = await pool.connect();
  let request;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT r.*, o.checkout_group_id FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.id = $1 FOR UPDATE OF r`,
      [req.params.returnId]
    );
    request = rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Return not found' });
    }
    if (request.status !== 'received') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'The refund is released after the goods are received and inspected.' });
    }
    if (request.resolution === 'replacement') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This return is for a replacement — it is handled on the Replacements page.' });
    }
    request.refund_id = await raiseRefund(client, request, req.user.id);
    await client.query(
      `UPDATE order_returns SET status = 'refunded', refund_id = $2, updated_at = now() WHERE id = $1`,
      [request.id, request.refund_id]
    );
    await addEvent(client, request.id, 'refunded', {
      note: request.refund_id ? 'Refund raised' : 'Paid by cash on delivery — settle the refund off-platform',
      actorRole: 'admin',
      userId: req.user.id,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await creditNoteForReturn(request, req.user.id);
  await audit(req, 'return.refund_released', request.id, { refundId: request.refund_id, amountCents: request.approved_refund_cents });
  res.json(await loadDetail(request.id));
}

/** A pending refund for the approved amount on the order's online payment, or null for COD. */
async function raiseRefund(client, request, userId) {
  const { rows } = await client.query(
    `SELECT * FROM payments WHERE checkout_group_id = $1 AND method <> 'cod' FOR UPDATE`,
    [request.checkout_group_id]
  );
  const payment = rows[0];
  if (!payment || payment.amount_captured_cents <= 0) return null;
  const amount = Math.min(request.approved_refund_cents ?? 0, payment.amount_captured_cents - payment.amount_refunded_cents);
  if (amount <= 0) return null;
  const { rows: refund } = await client.query(
    `INSERT INTO refunds (payment_id, order_id, amount_cents, reason, requested_by_user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [payment.id, request.order_id, amount, `Return approved: ${request.reason_code}`, request.user_id]
  );
  await client.query(
    `INSERT INTO refund_transactions (refund_id, event, amount_cents, actor_role, changed_by_user_id, note)
     VALUES ($1, 'requested', $2, 'admin', $3, 'Raised by an approved return')`,
    [refund[0].id, amount, userId]
  );
  return refund[0].id;
}

/**
 * Goods coming back reverse the sale, so a refunded return gets the credit
 * note for whatever of the invoice is still uncredited, tied to its refund.
 * After the commit and logged on failure: a credit note problem must not undo
 * the release, and Admin → Credit Notes can raise it by hand.
 */
async function creditNoteForReturn(request, userId) {
  try {
    const { rows } = await pool.query("SELECT id FROM invoices WHERE order_id = $1 AND status = 'issued'", [request.order_id]);
    if (!rows[0]) return;
    await raiseCreditNote({
      invoiceId: rows[0].id,
      reason: 'return',
      note: `Return RET-${String(request.id).padStart(5, '0')}`,
      lines: 'all',
      userId,
      refundId: request.refund_id,
      returnId: request.id,
    });
  } catch (err) {
    console.error(`[credit-notes] return ${request.id}: ${err.message}`);
  }
}

module.exports = {
  requestReturn,
  listReturnsForOrder,
  cancelReturn,
  disputeReturn,
  listReturns,
  returnSummary,
  getReturn,
  approveReturn,
  rejectReturn,
  receiveReturn,
  releaseRefund,
  raiseRefund,
  creditNoteForReturn,
  addEvent,
  returnEligibility,
  latestReturnFor,
  deliveredAtFor,
};
