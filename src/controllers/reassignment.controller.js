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

/**
 * Rejection and re-routing.
 * Contracts per documents/SPRINT_5_VENDOR_MATCHING_SPEC.md §6.
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

/**
 * The best shop that can fill every line of a rejected order.
 *
 * All-or-nothing on purpose: an alternative that can supply two of three items
 * is not an alternative, it is a second problem. Each line is matched
 * independently and only vendors present in every result survive.
 */
async function findReplacementVendor(client, { lines, address, excludeVendorId, weights, userId }) {
  let shared = null;
  const perLine = [];

  for (const line of lines) {
    const found = await findCandidates({
      productId: line.product_id,
      quantity: line.quantity,
      address,
      excludeVendorId,
      client,
    });
    const ranked = rank(found.candidates, weights, 'recommended');
    const deliverable = ranked.filter((c) => c.deliverable);

    await logMatch(client, {
      userId,
      addressId: address?.id ?? null,
      context: 'reroute',
      strategy: 'recommended',
      seed: found.seed,
      quantity: line.quantity,
      candidates: ranked,
      weights,
    });

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

/**
 * The vendor cannot fill this order.
 *
 * Releases the hold, looks for somewhere else, and either assigns it or asks
 * the customer — a dearer replacement is not a decision the platform makes on
 * its own. Finding nothing leaves the order cancelled with a reason, because a
 * rejected order that stays pending forever is the worst of the three outcomes.
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
  let outcome;
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
    if (order.status !== 'pending') {
      // Past 'pending' the shop has accepted it. Backing out then is a
      // cancellation, and cancellations do not re-route.
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'This order was already accepted — cancel it instead of rejecting it.',
      });
    }

    const lines = await orderLines(client, order.id);

    // The hold goes back before anything else: whatever happens next, this shop
    // is not filling this order and must not keep its stock reserved.
    await releaseReservations(client, {
      orderId: order.id,
      userId: req.user.id,
      note: `Rejected by the vendor: ${reason}`,
    });

    const { rows: addressRows } = await client.query('SELECT * FROM addresses WHERE id = $1', [order.address_id]);
    const address = addressRows[0] ?? null;

    const replacement = await findReplacementVendor(client, {
      lines,
      address,
      excludeVendorId: order.vendor_id,
      weights,
      userId: order.user_id,
    });

    // The rejecting shop's order ends here either way.
    await client.query(
      `UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [order.id]
    );
    await recordStatusChange(client, {
      orderId: order.id,
      fromStatus: order.status,
      toStatus: 'cancelled',
      userId: req.user.id,
      actorRole: 'vendor',
      note: `Rejected: ${reason}`,
    });
    await bumpMetrics(client, order.vendor_id, { ordersRejected: 1, openOrders: -1 });

    if (!replacement) {
      await client.query(
        `INSERT INTO order_assignment_history
           (checkout_group_id, from_order_id, from_vendor_id, status, reason,
            original_total_cents, actor_role, changed_by_user_id)
         VALUES ($1, $2, $3, 'no_alternative', $4, $5, 'vendor', $6)`,
        [order.checkout_group_id, order.id, order.vendor_id, reason, order.total_cents, req.user.id]
      );
      outcome = { status: 'no_alternative', message: 'No other shop can fill this order.' };
    } else {
      const proposedTotal = replacement.lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
      const tolerance = Number(weights.reassign_price_tolerance_percent);
      const ceiling = order.subtotal_cents * (1 + tolerance / 100);

      if (proposedTotal > ceiling) {
        // Dearer than the customer agreed to. Silently charging more is not a
        // reassignment the platform gets to make alone.
        const { rows: pending } = await client.query(
          `INSERT INTO order_assignment_history
             (checkout_group_id, from_order_id, from_vendor_id, to_vendor_id, status, reason,
              original_total_cents, proposed_total_cents, actor_role, changed_by_user_id)
           VALUES ($1, $2, $3, $4, 'pending_customer', $5, $6, $7, 'vendor', $8)
           RETURNING id`,
          [order.checkout_group_id, order.id, order.vendor_id, replacement.vendorId, reason,
           order.subtotal_cents, proposedTotal, req.user.id]
        );
        outcome = {
          status: 'pending_customer',
          reassignmentId: pending[0].id,
          proposedVendor: { id: replacement.vendorId, businessName: replacement.businessName },
          originalSubtotalCents: order.subtotal_cents,
          proposedSubtotalCents: proposedTotal,
        };
      } else {
        const newOrder = await createReplacementOrder(client, {
          order,
          replacement,
          lines,
          actorUserId: req.user.id,
        });
        await client.query(
          `INSERT INTO order_assignment_history
             (checkout_group_id, from_order_id, to_order_id, from_vendor_id, to_vendor_id, status, reason,
              original_total_cents, proposed_total_cents, actor_role, changed_by_user_id)
           VALUES ($1, $2, $3, $4, $5, 'assigned', $6, $7, $8, 'system', $9)`,
          [order.checkout_group_id, order.id, newOrder.id, order.vendor_id, replacement.vendorId,
           reason, order.subtotal_cents, proposedTotal, req.user.id]
        );
        outcome = {
          status: 'assigned',
          newOrderId: newOrder.id,
          vendor: { id: replacement.vendorId, businessName: replacement.businessName },
        };
      }
    }

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
  await settleCodForOrder(req.params.id);
  res.json(outcome);
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
        `UPDATE order_assignment_history SET status = 'declined', updated_at = now() WHERE id = $1`,
        [reassignment.id]
      );
      result = { status: 'declined' };
    } else {
      const { rows: originalRows } = await client.query('SELECT * FROM orders WHERE id = $1', [
        reassignment.from_order_id,
      ]);
      const original = originalRows[0];
      const lines = await orderLines(client, original.id);

      // Re-matched rather than replayed: the quote was made when the vendor
      // rejected, and stock or price may have moved while the customer thought
      // about it.
      const weights = await loadWeights(client);
      const { rows: addressRows } = await client.query('SELECT * FROM addresses WHERE id = $1', [original.address_id]);
      const replacement = await findReplacementVendor(client, {
        lines,
        address: addressRows[0] ?? null,
        excludeVendorId: reassignment.from_vendor_id,
        weights,
        userId: req.user.id,
      });

      if (!replacement) {
        await client.query(
          `UPDATE order_assignment_history SET status = 'no_alternative', updated_at = now() WHERE id = $1`,
          [reassignment.id]
        );
        result = { status: 'no_alternative', message: 'That shop can no longer fill this order.' };
      } else {
        const newOrder = await createReplacementOrder(client, {
          order: original,
          replacement,
          lines,
          actorUserId: req.user.id,
        });
        await client.query(
          `UPDATE order_assignment_history
           SET status = 'accepted', to_order_id = $2, to_vendor_id = $3, updated_at = now()
           WHERE id = $1`,
          [reassignment.id, newOrder.id, replacement.vendorId]
        );
        result = {
          status: 'accepted',
          newOrderId: newOrder.id,
          vendor: { id: replacement.vendorId, businessName: replacement.businessName },
        };
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

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

module.exports = { rejectOrder, listPending, respond, listForGroup };
