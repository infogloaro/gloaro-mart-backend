const pool = require('../config/db');
const { recordStatusChange } = require('./order.controller');
const { settleCodForOrder } = require('./payment.controller');
const {
  loadWeights,
  rank,
  findCandidates,
  logMatch,
  bumpMetrics,
} = require('../services/matching');
const {
  releaseReservations,
  lockStockForLines,
  reserveForOrder,
  confirmReservations,
} = require('../services/inventory');
const { notifyNewOrders } = require('../services/vendorNotify');

/**
 * Rejection and re-routing.
 * Contracts per documents/SPRINT_5_VENDOR_MATCHING_SPEC.md §6, plus the admin
 * rules of schema VENDOR MATCHING RULES (PHASE 39).
 *
 * A rejection is not a cancellation. A cancelled order is over; a rejected one
 * is looking for another shop — which is why this is its own endpoint rather
 * than a value on PATCH /status, where the two would be indistinguishable.
 *
 * Reassignment does not move an order between vendors. The original is
 * cancelled and a replacement is created in the same checkout group, so each
 * vendor keeps its own order and its own lifecycle — the constraint every
 * sprint since Sprint 2 has been written around. order_assignment_history is
 * the link between the two.
 *
 * Three things start a re-route, all through rerouteOrder(): the shop rejects
 * the order, the shop lets the accept window run out (the sweep at the bottom),
 * or an admin approves a re-route that was waiting for them.
 */

/** The lines of an order, in the shape the stock engine and matcher both want. */
async function orderLines(client, orderId) {
  const { rows } = await client.query(
    `SELECT oi.product_id, oi.variant_id, oi.quantity, oi.unit_price_cents,
            oi.product_name_snapshot, oi.variant_label_snapshot, oi.gst_rate_percent_snapshot
     FROM order_items oi WHERE oi.order_id = $1 ORDER BY oi.id`,
    [orderId]
  );
  return rows;
}

/** `orderId` becomes the deep link the app opens (/orders/<id>); a moved order links to its new order. */
async function notify(client, userId, type, title, body, orderId = null) {
  if (!userId) return;
  await client.query('INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, $2, $3, $4, $5)', [
    userId,
    type,
    title,
    body,
    orderId ? `/orders/${orderId}` : null,
  ]);
}

/** How many re-routes this order is already the result of (0 for an order as placed). */
async function rerouteDepth(client, orderId) {
  const { rows } = await client.query(
    `WITH RECURSIVE chain(order_id, depth) AS (
       SELECT $1::int, 0
       UNION ALL
       SELECT h.from_order_id, c.depth + 1
       FROM order_assignment_history h JOIN chain c ON h.to_order_id = c.order_id
       WHERE h.from_order_id IS NOT NULL AND c.depth < 20
     )
     SELECT MAX(depth)::int AS depth FROM chain`,
    [orderId]
  );
  return rows[0].depth ?? 0;
}

/**
 * The best shop that can fill every line of a rejected order.
 *
 * All-or-nothing on purpose: an alternative that can supply two of three items
 * is not an alternative, it is a second problem. Each line is matched
 * independently and only vendors present in every result survive. Every
 * line's run is logged; `logIds` collects them so the outcome can be stamped.
 */
async function findReplacementVendor(client, { lines, address, excludeVendorId, weights, userId, orderId = null, attempt = null, logIds = [] }) {
  let shared = null;
  const perLine = [];

  for (const line of lines) {
    const started = Date.now();
    const found = await findCandidates({
      productId: line.product_id,
      quantity: line.quantity,
      address,
      excludeVendorId,
      client,
    });
    const ranked = rank(found.candidates, weights, 'recommended');
    const deliverable = ranked.filter((c) => c.deliverable);

    logIds.push(
      await logMatch(client, {
        userId,
        addressId: address?.id ?? null,
        context: 'reroute',
        strategy: 'recommended',
        seed: found.seed,
        quantity: line.quantity,
        candidates: ranked,
        weights,
        orderId,
        attempt,
        durationMs: Date.now() - started,
      })
    );

    perLine.push({ line, candidates: deliverable });
    const vendorIds = new Set(deliverable.map((c) => c.vendorId));
    shared = shared === null ? vendorIds : new Set([...shared].filter((id) => vendorIds.has(id)));
    if (shared.size === 0) return null;
  }

  if (!shared || shared.size === 0) return null;

  // Rank the surviving vendors by their total score across the whole order,
  // not by their score on whichever line happened to be matched last.
  const totals = new Map();
  for (const { candidates } of perLine) {
    for (const c of candidates) {
      if (!shared.has(c.vendorId)) continue;
      const entry = totals.get(c.vendorId) ?? { vendorId: c.vendorId, businessName: c.businessName, score: 0, lines: [] };
      entry.score += c.score;
      entry.lines.push(c);
      totals.set(c.vendorId, entry);
    }
  }

  return [...totals.values()].sort((a, b) => b.score - a.score)[0];
}

/** Stamps how the run ended on the log rows it wrote. */
async function stampLogs(client, logIds, { outcome, vendorId = null, reason = null }) {
  if (!logIds.length) return;
  await client.query(
    `UPDATE vendor_matching_logs SET outcome = $2, reason = $3,
       selected_vendor_id = CASE WHEN $4::int IS NULL THEN selected_vendor_id ELSE $4 END
     WHERE id = ANY($1)`,
    [logIds, outcome, reason, vendorId]
  );
}

/**
 * Ends the original shop's order: stock back, cancelled, counted against the
 * shop as a rejection. Inside the caller's transaction; COD settles after commit.
 */
async function cancelOriginal(client, order, { note, userId, actorRole }) {
  await releaseReservations(client, { orderId: order.id, userId, note });
  await client.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [order.id]);
  await recordStatusChange(client, {
    orderId: order.id,
    fromStatus: order.status,
    toStatus: 'cancelled',
    userId,
    actorRole,
    note,
  });
  await bumpMetrics(client, order.vendor_id, { ordersRejected: 1, openOrders: -1 });
  // The re-routed order carries no discount, so the points come back.
  await require('../services/rewards').onOrderCancelled(client, order);
}

const proposedTotalOf = (replacement) => replacement.lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
const withinTolerance = (order, proposedTotal, weights) =>
  proposedTotal <= order.subtotal_cents * (1 + Number(weights.reassign_price_tolerance_percent) / 100);

/**
 * Looks for another shop for a pending order and acts on the admin's rules.
 * `order` must be locked by the caller. Returns the outcome and whether the
 * original was cancelled (the caller settles its COD after committing).
 *
 *   trigger 'rejected' — the shop said no: the original always ends.
 *   trigger 'expired'  — the shop didn't answer in time: the original only ends
 *                        when a replacement is placed, so it can still be accepted
 *                        while a re-route waits for someone.
 */
async function rerouteOrder(client, order, { reason, trigger, actorRole, userId, weights }) {
  const lines = await orderLines(client, order.id);
  const depth = await rerouteDepth(client, order.id);
  const attempt = depth + 1;
  const { rows: addressRows } = await client.query('SELECT * FROM addresses WHERE id = $1', [order.address_id]);
  const address = addressRows[0] ?? null;
  const logIds = [];

  const limitReached = depth >= weights.max_reassign_attempts;
  const replacement = limitReached
    ? null
    : await findReplacementVendor(client, {
        lines,
        address,
        excludeVendorId: order.vendor_id,
        weights,
        userId: order.user_id,
        orderId: order.id,
        attempt,
        logIds,
      });

  let cancelled = false;
  const endOriginal = async () => {
    await cancelOriginal(client, order, {
      note: trigger === 'rejected' ? `Rejected: ${reason}` : reason,
      userId,
      actorRole,
    });
    cancelled = true;
  };
  if (trigger === 'rejected') await endOriginal();

  const history = (status, extra = {}) =>
    client.query(
      `INSERT INTO order_assignment_history
         (checkout_group_id, from_order_id, to_order_id, from_vendor_id, to_vendor_id, status, reason,
          original_total_cents, proposed_total_cents, actor_role, changed_by_user_id, trigger)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [order.checkout_group_id, order.id, extra.toOrderId ?? null, order.vendor_id, extra.toVendorId ?? null, status,
        reason, order.subtotal_cents, extra.proposedTotal ?? null, extra.actorRole ?? actorRole, userId, trigger]
    );

  if (!replacement) {
    const why = limitReached ? `Re-route limit reached (${weights.max_reassign_attempts})` : 'No other shop can fill this order';
    await history('no_alternative');
    await stampLogs(client, logIds, { outcome: trigger === 'expired' ? 'expired' : 'no_vendor', reason: why });
    if (cancelled) {
      await notify(client, order.user_id, 'order_cancelled', 'Your order was cancelled',
        `The shop couldn't fill order #${order.id} and no other shop nearby can. Please try again or pick another shop.`, order.id);
    }
    return { outcome: { status: 'no_alternative', message: `${why}.` }, cancelled };
  }

  const proposedTotal = proposedTotalOf(replacement);
  const proposedVendor = { id: replacement.vendorId, businessName: replacement.businessName };

  if (!withinTolerance(order, proposedTotal, weights)) {
    // Dearer than the customer agreed to. Silently charging more is not a
    // reassignment the platform gets to make alone.
    const { rows } = await history('pending_customer', { toVendorId: replacement.vendorId, proposedTotal });
    await stampLogs(client, logIds, { outcome: 'matched', vendorId: replacement.vendorId, reason: 'Costs more — waiting for the customer' });
    await notify(client, order.user_id, 'reassignment_offer', 'Another shop can fill your order',
      `${replacement.businessName} can deliver order #${order.id}, but it costs more. Open the app to accept or decline.`, order.id);
    return {
      outcome: { status: 'pending_customer', reassignmentId: rows[0].id, proposedVendor,
        originalSubtotalCents: order.subtotal_cents, proposedSubtotalCents: proposedTotal },
      cancelled,
    };
  }

  if (!weights.auto_reassign) {
    const { rows } = await history('pending_admin', { toVendorId: replacement.vendorId, proposedTotal });
    await stampLogs(client, logIds, { outcome: 'matched', vendorId: replacement.vendorId, reason: 'Waiting for an admin to approve' });
    return { outcome: { status: 'pending_admin', reassignmentId: rows[0].id, proposedVendor }, cancelled };
  }

  if (!cancelled) await endOriginal();
  const newOrder = await createReplacementOrder(client, { order, replacement, lines, actorUserId: userId });
  await history('assigned', { toOrderId: newOrder.id, toVendorId: replacement.vendorId, proposedTotal, actorRole: 'system' });
  await stampLogs(client, logIds, { outcome: 'reassigned', vendorId: replacement.vendorId });
  await notify(client, order.user_id, 'order_rerouted', 'Your order moved to another shop',
    `${replacement.businessName} is now fulfilling your order (it was #${order.id}, now #${newOrder.id}).`, newOrder.id);
  return { outcome: { status: 'assigned', newOrderId: newOrder.id, vendor: proposedVendor }, cancelled };
}

/**
 * The vendor cannot fill this order.
 *
 * Releases the hold, looks for somewhere else, and either assigns it, asks the
 * customer (dearer) or an admin (auto re-route off). Finding nothing leaves the
 * order cancelled with a reason, because a rejected order that stays pending
 * forever is the worst of the outcomes.
 */
async function rejectOrder(req, res) {
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ message: 'A reason is required to reject an order' });
  }

  const { rows: vendorRows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [req.user.id]);
  const vendorId = vendorRows[0]?.id;
  if (!vendorId && req.user.role !== 'admin') {
    return res.status(404).json({ message: 'Vendor profile not found' });
  }

  const weights = await loadWeights();
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');

    const { rows: orderRows } = await client.query(
      `SELECT o.*, cg.address_id FROM orders o
       JOIN checkout_groups cg ON cg.id = o.checkout_group_id
       WHERE o.id = $1 FOR UPDATE OF o`,
      [req.params.id]
    );
    const order = orderRows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Order not found' });
    }
    if (req.user.role !== 'admin' && order.vendor_id !== vendorId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (['delivered', 'cancelled'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This order is already ${order.status}.` });
    }
    if (order.replacement_of_order_id) {
      // Re-routing would charge the customer for a replacement they get free.
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This is a free replacement — cancel it instead, and an admin will arrange another shop.' });
    }
    if (order.status !== 'pending') {
      // Past 'pending' the shop has accepted it. Backing out then is a
      // cancellation, and cancellations do not re-route.
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'This order was already accepted — cancel it instead of rejecting it.',
      });
    }

    result = await rerouteOrder(client, order, {
      reason: String(reason).trim(),
      trigger: 'rejected',
      actorRole: req.user.role === 'admin' ? 'admin' : 'vendor',
      userId: req.user.id,
      weights,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

  // After the commit, for the same reason Sprint 3 settles COD after one: a
  // failure here must not undo a rejection that really happened.
  if (result.cancelled) await settleCodForOrder(req.params.id);
  res.json(result.outcome);
}

/**
 * Writes the replacement order, its items and its stock hold.
 *
 * The new order is COD-pending in the same checkout group, so the customer's
 * purchase stays one purchase and the group total rolls up as it always did.
 */
async function createReplacementOrder(client, { order, replacement, lines, actorUserId }) {
  const byProduct = new Map(replacement.lines.map((c) => [c.quantity + ':' + c.productName, c]));
  const resolved = lines.map((line, index) => {
    const candidate = replacement.lines[index] ?? byProduct.get(line.quantity + ':' + line.product_name_snapshot);
    return { line, candidate };
  });

  const subtotalCents = resolved.reduce((sum, r) => sum + r.candidate.lineTotalCents, 0);
  const gstCents = resolved.reduce(
    (sum, r) => sum + Math.round(r.candidate.lineTotalCents * (Number(r.line.gst_rate_percent_snapshot) / 100)),
    0
  );
  const deliveryChargeCents = resolved[0]?.candidate.deliveryChargeCents ?? 0;
  const totalCents = subtotalCents + gstCents + deliveryChargeCents;

  const { rows } = await client.query(
    `INSERT INTO orders
       (user_id, vendor_id, status, payment_method, subtotal_cents, gst_cents, discount_cents, total_cents,
        delivery_address, address_id, delivery_address_snapshot, delivery_charge_cents, delivery_method,
        checkout_group_id)
     VALUES ($1, $2, 'pending', 'cod', $3, $4, 0, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      order.user_id,
      replacement.vendorId,
      subtotalCents,
      gstCents,
      totalCents,
      order.delivery_address,
      order.address_id,
      order.delivery_address_snapshot,
      deliveryChargeCents,
      order.delivery_method,
      order.checkout_group_id,
    ]
  );
  const newOrder = rows[0];

  await recordStatusChange(client, {
    orderId: newOrder.id,
    toStatus: 'pending',
    userId: actorUserId,
    actorRole: 'system',
    note: `Re-routed from order ${order.id}`,
  });

  for (const { line, candidate } of resolved) {
    await client.query(
      `INSERT INTO order_items
         (order_id, product_id, variant_id, product_name_snapshot, variant_label_snapshot,
          unit_price_cents, quantity, gst_rate_percent_snapshot)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
      [
        newOrder.id,
        candidate.productId,
        line.product_name_snapshot,
        line.variant_label_snapshot,
        candidate.unitPriceCents,
        line.quantity,
        line.gst_rate_percent_snapshot,
      ]
    );
  }

  // Hold the new shop's stock under the same lock discipline as checkout.
  const stockLines = resolved.map(({ line, candidate }) => ({
    productId: candidate.productId,
    variantId: null,
    quantity: line.quantity,
    name: line.product_name_snapshot,
  }));
  const stock = await lockStockForLines(client, stockLines);
  await reserveForOrder(client, {
    stock,
    lines: stockLines,
    orderId: newOrder.id,
    groupId: order.checkout_group_id,
    userId: order.user_id,
  });
  // COD, so the sale commits immediately — the same rule checkout follows.
  await confirmReservations(client, { orderId: newOrder.id, note: 'Re-routed COD order placed' });
  await notifyNewOrders(client, { orderId: newOrder.id });

  await bumpMetrics(client, replacement.vendorId, { ordersTotal: 1, openOrders: 1 });

  // The group total moved, so roll it up again.
  await client.query(
    `UPDATE checkout_groups cg SET
       subtotal_cents = t.subtotal, gst_cents = t.gst, discount_cents = t.discount,
       delivery_charge_cents = t.delivery, total_cents = t.total, updated_at = now()
     FROM (
       SELECT COALESCE(SUM(subtotal_cents), 0) AS subtotal, COALESCE(SUM(gst_cents), 0) AS gst,
              COALESCE(SUM(discount_cents), 0) AS discount,
              COALESCE(SUM(delivery_charge_cents), 0) AS delivery, COALESCE(SUM(total_cents), 0) AS total
       FROM orders WHERE checkout_group_id = $1 AND status <> 'cancelled'
     ) t
     WHERE cg.id = $1`,
    [order.checkout_group_id]
  );

  return newOrder;
}

/**
 * A waiting re-route goes ahead (customer accepted, or an admin approved).
 * Re-matched rather than replayed: stock or price may have moved while it
 * waited. Ends the original if it's still open. Returns the outcome and the
 * original order id when it was cancelled here.
 */
async function completeWaitingReroute(client, reassignment, { userId, actorRole, resolvedBy = null, checkPrice }) {
  const { rows: originalRows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [reassignment.from_order_id]);
  const original = originalRows[0];
  const lines = await orderLines(client, original.id);
  const weights = await loadWeights(client);
  const { rows: addressRows } = await client.query('SELECT * FROM addresses WHERE id = $1', [original.address_id]);
  const replacement = await findReplacementVendor(client, {
    lines,
    address: addressRows[0] ?? null,
    excludeVendorId: reassignment.from_vendor_id,
    weights,
    userId: original.user_id,
    orderId: original.id,
    attempt: (await rerouteDepth(client, original.id)) + 1,
  });

  if (!replacement) {
    await client.query(
      `UPDATE order_assignment_history SET status = 'no_alternative', resolved_by = $2, resolved_at = now(), updated_at = now() WHERE id = $1`,
      [reassignment.id, resolvedBy]
    );
    return { outcome: { status: 'no_alternative', message: 'That shop can no longer fill this order.' }, cancelledOrderId: null };
  }
  const proposedTotal = proposedTotalOf(replacement);
  if (checkPrice && !withinTolerance(original, proposedTotal, weights)) {
    // It got dearer while it waited: the customer has to agree first.
    await client.query(
      `UPDATE order_assignment_history SET status = 'pending_customer', to_vendor_id = $2, proposed_total_cents = $3, updated_at = now() WHERE id = $1`,
      [reassignment.id, replacement.vendorId, proposedTotal]
    );
    await notify(client, original.user_id, 'reassignment_offer', 'Another shop can fill your order',
      `${replacement.businessName} can deliver order #${original.id}, but it costs more. Open the app to accept or decline.`, original.id);
    return { outcome: { status: 'pending_customer', message: 'It now costs more, so the customer has been asked.' }, cancelledOrderId: null };
  }

  let cancelledOrderId = null;
  if (original.status !== 'cancelled') {
    await cancelOriginal(client, original, { note: `Re-routed: ${reassignment.reason ?? 'not accepted in time'}`, userId, actorRole });
    cancelledOrderId = original.id;
  }
  const newOrder = await createReplacementOrder(client, { order: original, replacement, lines, actorUserId: userId });
  await client.query(
    `UPDATE order_assignment_history
     SET status = $4, to_order_id = $2, to_vendor_id = $3, proposed_total_cents = $5, resolved_by = $6, resolved_at = now(), updated_at = now()
     WHERE id = $1`,
    [reassignment.id, newOrder.id, replacement.vendorId, actorRole === 'customer' ? 'accepted' : 'assigned', proposedTotal, resolvedBy]
  );
  await notify(client, original.user_id, 'order_rerouted', 'Your order moved to another shop',
    `${replacement.businessName} is now fulfilling your order (it was #${original.id}, now #${newOrder.id}).`, newOrder.id);
  return {
    outcome: { status: actorRole === 'customer' ? 'accepted' : 'assigned', newOrderId: newOrder.id,
      vendor: { id: replacement.vendorId, businessName: replacement.businessName } },
    cancelledOrderId,
  };
}

/** Reassignments the customer still has to decide on. */
async function listPending(req, res) {
  const { rows } = await pool.query(
    `SELECT h.*, vp.business_name AS proposed_vendor_name, cg.reference AS group_reference
     FROM order_assignment_history h
     JOIN checkout_groups cg ON cg.id = h.checkout_group_id
     LEFT JOIN vendor_profiles vp ON vp.id = h.to_vendor_id
     WHERE cg.user_id = $1 AND h.status = 'pending_customer'
     ORDER BY h.created_at DESC`,
    [req.user.id]
  );
  res.json({ reassignments: rows });
}

/** The customer accepts or declines a replacement that costs more. */
async function respond(req, res) {
  const { accept } = req.body || {};
  if (typeof accept !== 'boolean') {
    return res.status(400).json({ message: 'accept must be true or false' });
  }

  const client = await pool.connect();
  let result;
  let cancelledOrderId = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT h.*, cg.user_id FROM order_assignment_history h
       JOIN checkout_groups cg ON cg.id = h.checkout_group_id
       WHERE h.id = $1 FOR UPDATE OF h`,
      [req.params.id]
    );
    const reassignment = rows[0];
    if (!reassignment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Reassignment not found' });
    }
    if (reassignment.user_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (reassignment.status !== 'pending_customer') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This reassignment was already ${reassignment.status}.` });
    }

    if (!accept) {
      await client.query(
        `UPDATE order_assignment_history SET status = 'declined', resolved_at = now(), updated_at = now() WHERE id = $1`,
        [reassignment.id]
      );
      result = { status: 'declined' };
    } else {
      // The customer agreeing to the price is the whole point, so no price check here.
      const done = await completeWaitingReroute(client, reassignment, { userId: req.user.id, actorRole: 'customer', checkPrice: false });
      result = done.outcome;
      cancelledOrderId = done.cancelledOrderId;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

  if (cancelledOrderId) await settleCodForOrder(cancelledOrderId);
  res.json(result);
}

/** The reassignment trail for one purchase. */
async function listForGroup(req, res) {
  const { rows: groupRows } = await pool.query('SELECT user_id FROM checkout_groups WHERE id = $1', [req.params.id]);
  if (!groupRows[0]) return res.status(404).json({ message: 'Order group not found' });
  if (groupRows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const { rows } = await pool.query(
    `SELECT h.*, fv.business_name AS from_vendor_name, tv.business_name AS to_vendor_name
     FROM order_assignment_history h
     LEFT JOIN vendor_profiles fv ON fv.id = h.from_vendor_id
     LEFT JOIN vendor_profiles tv ON tv.id = h.to_vendor_id
     WHERE h.checkout_group_id = $1
     ORDER BY h.created_at ASC, h.id ASC`,
    [req.params.id]
  );
  res.json({ reassignments: rows });
}

/**
 * Orders the shop hasn't accepted within the admin's window are re-routed.
 * Only orders placed after the window was introduced, only those the customer
 * has paid for or chose COD on, and only once each — any re-route record for
 * the order (waiting, turned down, or nothing found) stops it being swept again.
 * Each order is its own transaction, skipping any another sweep has locked.
 */
async function expireUnaccepted() {
  const weights = await loadWeights();
  const { rows } = await pool.query(
    `SELECT o.id FROM orders o
     LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
     WHERE o.status = 'pending' AND o.checkout_group_id IS NOT NULL
       -- A replacement goes to the shop chosen on the Replacements page, not wherever is free.
       AND o.replacement_of_order_id IS NULL
       AND o.created_at >= $1 AND o.created_at < now() - make_interval(mins => $2)
       AND (p.id IS NULL OR p.method = 'cod' OR p.status = 'successful')
       AND NOT EXISTS (SELECT 1 FROM order_assignment_history h WHERE h.from_order_id = o.id)
     ORDER BY o.created_at LIMIT 20`,
    [weights.accept_window_since, weights.accept_window_minutes]
  );
  const results = [];
  for (const { id } of rows) {
    const client = await pool.connect();
    let result = null;
    try {
      await client.query('BEGIN');
      const { rows: locked } = await client.query(
        `SELECT o.*, cg.address_id FROM orders o JOIN checkout_groups cg ON cg.id = o.checkout_group_id
         WHERE o.id = $1 AND o.status = 'pending' FOR UPDATE OF o SKIP LOCKED`,
        [id]
      );
      if (locked[0]) {
        result = await rerouteOrder(client, locked[0], {
          reason: `Not accepted within ${weights.accept_window_minutes} minutes`,
          trigger: 'expired',
          actorRole: 'system',
          userId: null,
          weights,
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[matching] re-routing order ${id} failed: ${err.message}`);
    } finally {
      client.release();
    }
    if (result?.cancelled) await settleCodForOrder(id);
    if (result) results.push({ orderId: id, ...result.outcome });
  }
  return results;
}

module.exports = {
  rejectOrder,
  listPending,
  respond,
  listForGroup,
  completeWaitingReroute,
  expireUnaccepted,
};
