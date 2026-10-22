const pool = require('../config/db');
const { getOrCreateActiveCart } = require('./cart.controller');
const { resolveUnitPriceCents } = require('./product.controller');
const { creditWalletForOrder } = require('./wallet.controller');
const { resolveCouponForCheckout } = require('./coupon.controller');
const { findOwnedAddress, toSnapshot } = require('./address.controller');
const { evaluate } = require('./serviceability.controller');
const { createPaymentForGroup, settleCodForOrder, recordPaymentEvent } = require('./payment.controller');
const customerWallet = require('../services/payments/wallet');
const { returnEligibility, deliveredAtFor } = require('./returns.controller');
const { bestCampaignForOrder } = require('../services/campaigns');
const {
  lockStockForLines,
  reserveForOrder,
  confirmReservations,
  releaseExpiredHolds,
  settleStockForOrder,
} = require('../services/inventory');
const { bumpMetrics, metricsForTransition } = require('../services/matching');
const cancellations = require('../services/cancellations');
const shipments = require('../services/shipments');
const { issueAfterDelivery } = require('../services/invoices');
const business = require('../services/business');
const analytics = require('../services/analytics');
const { notifyNewOrders } = require('../services/vendorNotify');
const rewards = require('../services/rewards');
const { CancellationError } = cancellations;

const STATUS_FLOW = ['pending', 'confirmed', 'packed', 'out_for_delivery', 'delivered'];

/**
 * A checkout group's status, computed from its vendor orders.
 *
 * Deliberately not a column: a stored status would be a second source of truth
 * that drifts the moment one vendor cancels. Cancelled orders are excluded
 * before the least-advanced order is picked, so a single cancellation cannot
 * peg a healthy group at 'cancelled' forever.
 */
function deriveGroupStatus(statuses) {
  if (statuses.length === 0) return 'pending';
  const live = statuses.filter((s) => s !== 'cancelled');
  if (live.length === 0) return 'cancelled';
  if (live.every((s) => s === 'delivered')) return 'delivered';
  if (live.some((s) => s === 'delivered')) return 'partially_delivered';
  return STATUS_FLOW.find((s) => live.includes(s)) ?? live[0];
}

/**
 * Appends to an order's timeline. Takes a client rather than the pool so the
 * history row lands in the same transaction as the status update it describes —
 * as two separate statements, a failure on the second silently leaves the
 * timeline disagreeing with the order.
 */
async function recordStatusChange(client, { orderId, fromStatus = null, toStatus, userId = null, actorRole = 'system', note = null }) {
  await client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_user_id, actor_role, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, fromStatus, toStatus, userId, actorRole, note]
  );
}

/** Flattens a structured address into the legacy free-text column. */
function addressToLine(a) {
  const parts = [a.house_building, a.street, a.area, a.city, a.state].filter((p) => p && String(p).trim());
  return `${a.receiver_name}, ${parts.join(', ')} - ${a.pincode} (${a.mobile_number})`;
}

/**
 * Everything payments has understood since Sprint 3. COD is the default because
 * an app build already in the field sends no method at all.
 */
const PAYMENT_METHODS = ['cod', 'upi', 'card', 'netbanking', 'wallet', 'credit'];

/**
 * The sales channel an order came through, from the X-Sales-Channel header: the
 * slug of an enabled Platform Registry entry with the "orders" capability (e.g.
 * mobile_app, website_storefront). Anything else — no header, an unknown or
 * disabled channel — leaves the order unattributed; it never blocks checkout.
 */
async function resolveSalesChannel(slug) {
  if (!slug || !/^[a-z][a-z0-9_]{1,79}$/.test(slug)) return null;
  const { rows } = await pool.query(
    `SELECT id FROM platforms WHERE slug = $1 AND status = 'active' AND capabilities ? 'orders'`,
    [slug]
  );
  return rows[0]?.id ?? null;
}

async function checkout(req, res) {
  const {
    addressId,
    deliveryAddress,
    deliveryMethod = 'delivery',
    couponsByVendor,
    paymentMethod = 'cod',
    // Set to order for the caller's business (Business Accounts): its GSTIN goes
    // on the invoices, and it may pay 'credit'.
    businessAccountId = null,
    // SB11: reward points to spend on this checkout (capped server-side).
    redeemPoints = 0,
  } = req.body || {};
  // addressId is the current contract; deliveryAddress is the legacy free-text
  // field, still accepted while older app builds are in the field.
  if (!addressId && !deliveryAddress) {
    return res.status(400).json({ message: 'addressId is required' });
  }
  if (!['delivery', 'pickup'].includes(deliveryMethod)) {
    return res.status(400).json({ message: "deliveryMethod must be 'delivery' or 'pickup'" });
  }
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ message: `paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}` });
  }
  if (paymentMethod === 'credit' && !businessAccountId) {
    return res.status(400).json({ message: 'Credit is only for orders placed for a business account.' });
  }
  // Credit, like COD, needs nothing more from the buyer now; both commit the sale at once.
  // The customer wallet is paid in full inside this checkout, so it commits too.
  const isWallet = paymentMethod === 'wallet';
  const isCod = paymentMethod === 'cod' || paymentMethod === 'credit' || isWallet;

  let member = null;
  if (businessAccountId != null) {
    if (!Number.isInteger(businessAccountId)) return res.status(400).json({ message: 'businessAccountId must be an id' });
    try {
      member = await business.assertCanOrderFor(req.user.id, businessAccountId);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ message: err.message });
      throw err;
    }
  }

  let address = null;
  if (addressId) {
    address = await findOwnedAddress(req.user.id, addressId);
    if (!address) return res.status(404).json({ message: 'Address not found' });
  }

  const cart = await getOrCreateActiveCart(req.user.id);
  const { rows: items } = await pool.query(
    `SELECT ci.product_id, ci.variant_id, ci.quantity, p.name, p.vendor_id, p.gst_rate_percent, p.moq, p.category,
            -- The variant's price when the line names one; the product's own
            -- otherwise. Bulk tiers still apply on top of whichever it is.
            COALESCE(v.price_cents, p.price_cents) AS price_cents,
            (SELECT string_agg(av.value, ' / ' ORDER BY a.sort_order, av.sort_order)
             FROM variant_attribute_values vav
             JOIN attribute_values av ON av.id = vav.attribute_value_id
             JOIN product_attributes a ON a.id = av.attribute_id
             WHERE vav.variant_id = ci.variant_id) AS variant_label
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants v ON v.id = ci.variant_id
     WHERE ci.cart_id = $1 AND p.is_active = true AND p.moderation_status = 'approved'
       AND (v.id IS NULL OR v.is_active = true)`,
    [cart.id]
  );
  if (items.length === 0) {
    return res.status(400).json({ message: 'Cart is empty' });
  }

  const { rows: tierRows } = await pool.query(
    'SELECT * FROM product_price_tiers WHERE product_id = ANY($1)',
    [items.map((i) => i.product_id)]
  );
  const tiersByProduct = new Map();
  for (const tier of tierRows) {
    if (!tiersByProduct.has(tier.product_id)) tiersByProduct.set(tier.product_id, []);
    tiersByProduct.get(tier.product_id).push(tier);
  }

  for (const item of items) {
    if (item.moq > 1 && item.quantity < item.moq) {
      return res
        .status(400)
        .json({ message: `${item.name} requires a minimum order quantity of ${item.moq}` });
    }
  }

  const itemsByVendor = new Map();
  for (const item of items) {
    if (!itemsByVendor.has(item.vendor_id)) itemsByVendor.set(item.vendor_id, []);
    itemsByVendor.get(item.vendor_id).push(item);
  }

  // Re-run serviceability here rather than trusting whatever the client checked
  // earlier — stock, prices and store hours move between the check and the tap.
  const deliveryChargeByVendor = new Map();
  if (address) {
    let serviceability;
    try {
      serviceability = await evaluate({
        userId: req.user.id,
        addressId: address.id,
        items: items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ message: err.message });
      throw err;
    }
    if (!serviceability.deliverable) {
      const blockers = serviceability.vendors.filter((v) => !v.deliverable);
      return res.status(409).json({
        message: blockers[0]
          ? `${blockers[0].businessName} cannot deliver to this address.`
          : 'This address cannot be served.',
        vendors: blockers.map((v) => ({
          vendorId: v.vendorId,
          businessName: v.businessName,
          reason: v.reason,
        })),
      });
    }
    for (const v of serviceability.vendors) {
      deliveryChargeByVendor.set(v.vendorId, deliveryMethod === 'pickup' ? 0 : v.deliveryChargeCents);
    }
  }

  // Re-resolve coupons server-side per vendor before opening the transaction,
  // so a bad coupon fails the whole checkout up front rather than mid-transaction.
  const resolvedCoupons = new Map();
  if (couponsByVendor && typeof couponsByVendor === 'object') {
    for (const [vendorIdStr, code] of Object.entries(couponsByVendor)) {
      const vendorId = Number(vendorIdStr);
      const vendorItems = itemsByVendor.get(vendorId);
      if (!vendorItems) continue;
      const subtotalCents = vendorItems.reduce(
        (sum, it) => sum + resolveUnitPriceCents(it, it.quantity, tiersByProduct.get(it.product_id)) * it.quantity,
        0
      );
      try {
        // SB6: the customer's own coupon limits, and the delivery charge a
        // free-delivery coupon takes off.
        const resolved = await resolveCouponForCheckout(vendorId, code, subtotalCents, {
          userId: req.user.id,
          deliveryChargeCents: deliveryChargeByVendor.get(vendorId) || 0,
        });
        resolvedCoupons.set(vendorId, resolved);
      } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        throw err;
      }
    }
  }

  const stockLines = items.map((it) => ({
    productId: it.product_id,
    variantId: it.variant_id,
    quantity: it.quantity,
    name: it.variant_label ? `${it.name} (${it.variant_label})` : it.name,
  }));

  const salesChannelId = await resolveSalesChannel(req.get('x-sales-channel'));
  // Which app surface the cart was built from, for Analytics. Unknown values
  // leave it unset rather than refuse the order.
  const origin = ['shop', 'near_me'].includes(req.body?.origin) ? req.body.origin : null;

  const client = await pool.connect();
  const createdOrders = [];
  try {
    await client.query('BEGIN');

    // Holds that were never paid for go back on the shelf first, before this
    // checkout takes its locks — otherwise a customer could be refused stock
    // that a dead hold was sitting on.
    await releaseExpiredHolds(client);

    // Every stock row this cart touches is locked here, before a single row is
    // written. Locking per vendor order instead would let two carts that share
    // items across two shops each hold half of what the other needs.
    const stock = await lockStockForLines(client, stockLines);

    // The group is created first so every vendor order can reference it. Its
    // money columns start at zero and are rolled up once the orders exist.
    const { rows: groupRows } = await client.query(
      `INSERT INTO checkout_groups
         (reference, user_id, address_id, delivery_address_snapshot, delivery_method, payment_method, business_account_id)
       VALUES (
         'GLM-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('checkout_group_ref_seq')::text, 5, '0'),
         $1, $2, $3, $4, $5, $6
       )
       RETURNING id, reference`,
      [
        req.user.id,
        address?.id || null,
        address ? JSON.stringify(toSnapshot(address)) : null,
        deliveryMethod,
        paymentMethod,
        businessAccountId,
      ]
    );
    const group = groupRows[0];

    // SB11: the points this checkout spends, split over the shops by what
    // their items cost after coupons. Locks the customer's balance.
    const rewardSettings = await rewards.getSettings(client);
    const baseByVendor = new Map();
    for (const [vendorId, vendorItems] of itemsByVendor) {
      const subtotal = vendorItems.reduce(
        (sum, it) => sum + resolveUnitPriceCents(it, it.quantity, tiersByProduct.get(it.product_id)) * it.quantity,
        0
      );
      baseByVendor.set(vendorId, subtotal - (resolvedCoupons.get(vendorId)?.discountCents || 0));
    }
    const redemption = await rewards.planRedemption(client, {
      userId: req.user.id,
      requestedPoints: redeemPoints,
      baseByVendor,
      settings: rewardSettings,
    });
    const pointSpends = [];

    for (const [vendorId, vendorItems] of itemsByVendor) {
      const resolvedItems = vendorItems.map((it) => ({
        ...it,
        unitPriceCents: resolveUnitPriceCents(it, it.quantity, tiersByProduct.get(it.product_id)),
      }));
      const subtotalCents = resolvedItems.reduce((sum, it) => sum + it.unitPriceCents * it.quantity, 0);
      const gstCents = resolvedItems.reduce(
        (sum, it) => sum + Math.round(it.unitPriceCents * it.quantity * (it.gst_rate_percent / 100)),
        0
      );
      const coupon = resolvedCoupons.get(vendorId);
      const couponDiscountCents = coupon?.discountCents || 0;
      const deliveryChargeCents = deliveryChargeByVendor.get(vendorId) || 0;
      // The best running campaign this shop's order qualifies for, on top of any
      // coupon. Its row is locked until commit so its budget can't be overspent.
      const campaign = await bestCampaignForOrder(client, {
        vendorId,
        items: resolvedItems,
        subtotalCents,
        couponDiscountCents,
        deliveryChargeCents,
      });
      const campaignDiscountCents = campaign?.discountCents || 0;
      // Points come last, so they never take the items below zero.
      const spend = rewards.pointsForOrder(
        redemption.byVendor.get(vendorId) || 0,
        subtotalCents - couponDiscountCents - campaignDiscountCents,
        rewardSettings
      );
      // discount_cents stays the whole discount, so totals and groups add up as before.
      const discountCents = couponDiscountCents + campaignDiscountCents + spend.cents;
      const totalCents = subtotalCents - discountCents + gstCents + deliveryChargeCents;

      const { rows: orderRows } = await client.query(
        `INSERT INTO orders
          (user_id, vendor_id, status, payment_method, subtotal_cents, gst_cents, discount_cents, total_cents,
           delivery_address, coupon_id, coupon_code_snapshot,
           address_id, delivery_address_snapshot, delivery_charge_cents, delivery_method, checkout_group_id,
           sales_channel_id, campaign_discount_cents, business_account_id, origin,
           points_redeemed, points_discount_cents)
         VALUES ($1, $2, 'pending', $15, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $16, $17, $18, $19, $20, $21)
         RETURNING *`,
        [
          req.user.id,
          vendorId,
          subtotalCents,
          gstCents,
          discountCents,
          totalCents,
          // Keep the legacy column populated so anything still reading it — the
          // admin orders list, older app builds — does not show a blank address.
          address ? addressToLine(address) : deliveryAddress,
          coupon?.couponId || null,
          coupon?.code || null,
          address?.id || null,
          address ? JSON.stringify(toSnapshot(address)) : null,
          deliveryChargeCents,
          deliveryMethod,
          group.id,
          paymentMethod,
          salesChannelId,
          campaignDiscountCents,
          businessAccountId,
          origin,
          spend.points,
          spend.cents,
        ]
      );
      const order = orderRows[0];
      pointSpends.push({ order, ...spend });
      if (campaign) {
        await client.query(
          `INSERT INTO order_campaigns (order_id, campaign_id, discount_cents, platform_cents, vendor_cents)
           VALUES ($1, $2, $3, $4, $5)`,
          [order.id, campaign.campaign.id, campaign.discountCents, campaign.platformCents, campaign.vendorCents]
        );
      }
      await recordStatusChange(client, {
        orderId: order.id,
        toStatus: 'pending',
        userId: req.user.id,
        actorRole: 'customer',
        note: 'Order placed',
      });
      for (const item of resolvedItems) {
        await client.query(
          `INSERT INTO order_items
            (order_id, product_id, variant_id, product_name_snapshot, variant_label_snapshot,
             unit_price_cents, quantity, gst_rate_percent_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            order.id,
            item.product_id,
            item.variant_id,
            item.name,
            item.variant_label,
            item.unitPriceCents,
            item.quantity,
            item.gst_rate_percent,
          ]
        );
      }
      // Points on what the customer pays for the items; spendable once delivered.
      await rewards.earnOnOrder(client, {
        order,
        items: resolvedItems,
        eligibleCents: subtotalCents - discountCents,
        settings: rewardSettings,
      });

      // Stock is held only now that the order exists to hold it against. The
      // rows were locked above, so this is the check that decides the checkout.
      await reserveForOrder(client, {
        stock,
        lines: stockLines.filter((l) =>
          vendorItems.some((it) => it.product_id === l.productId && it.variant_id === l.variantId)
        ),
        orderId: order.id,
        groupId: group.id,
        userId: req.user.id,
      });

      // The vendor's workload and order count move with the order, inside the
      // same transaction — a metrics row that counts an order the checkout
      // rolled back would rank the shop on business it never had.
      await bumpMetrics(client, vendorId, { ordersTotal: 1, openOrders: 1 });

      createdOrders.push({ ...order, checkout_group_reference: group.reference });
    }
    if (redemption.points > 0) await rewards.spendPoints(client, { userId: req.user.id, spends: pointSpends });

    // Roll the group total up from the vendor orders, so the customer sees one
    // figure without the app having to add up N orders itself.
    await client.query(
      `UPDATE checkout_groups cg SET
         subtotal_cents = t.subtotal, gst_cents = t.gst, discount_cents = t.discount,
         delivery_charge_cents = t.delivery, total_cents = t.total, updated_at = now()
       FROM (
         SELECT COALESCE(SUM(subtotal_cents), 0) AS subtotal, COALESCE(SUM(gst_cents), 0) AS gst,
                COALESCE(SUM(discount_cents), 0) AS discount,
                COALESCE(SUM(delivery_charge_cents), 0) AS delivery, COALESCE(SUM(total_cents), 0) AS total
         FROM orders WHERE checkout_group_id = $1
       ) t
       WHERE cg.id = $1`,
      [group.id]
    );

    // The payment the purchase owes, opened in the same transaction so a
    // checkout can never leave a group with no payment record.
    const { rows: groupTotals } = await client.query(
      'SELECT total_cents FROM checkout_groups WHERE id = $1',
      [group.id]
    );
    // The buyer's per-order limit and, on credit, the account's room — now that the total is known.
    if (member) {
      await business.checkFinalCredit(client, {
        member,
        accountId: businessAccountId,
        totalCents: groupTotals[0].total_cents,
        paymentMethod,
      });
    }
    const payment = await createPaymentForGroup(client, {
      groupId: group.id,
      userId: req.user.id,
      amountCents: groupTotals[0].total_cents,
      method: paymentMethod,
    });

    // Wallet: the money is on the platform already, so it moves now, in this
    // transaction. A short balance rolls the whole checkout back (402).
    if (isWallet) {
      const total = groupTotals[0].total_cents;
      await customerWallet.debit(client, { userId: req.user.id, amountCents: total, groupReference: group.reference });
      await client.query(
        `UPDATE payments SET status = 'successful', amount_captured_cents = $2, updated_at = now() WHERE id = $1`,
        [payment.id, total]
      );
      await recordPaymentEvent(client, {
        paymentId: payment.id,
        event: 'captured',
        amountCents: total,
        actorRole: 'customer',
        userId: req.user.id,
        note: 'Paid from the Gloaro wallet',
      });
    }

    // COD commits the sale the moment the order is placed — there is no gateway
    // to wait on, so the held units become sold ones now rather than sitting in
    // a hold that nothing would ever come back to resolve.
    //
    // An online order does the opposite: the stock stays held until the capture
    // webhook lands. Confirming here would sell stock for money that has not
    // arrived and might never.
    if (isCod) {
      await confirmReservations(client, { groupId: group.id, note: 'COD order placed' });
      await notifyNewOrders(client, { groupId: group.id });
    }

    await client.query("UPDATE carts SET status = 'converted' WHERE id = $1", [cart.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // An out-of-stock line rolls the whole checkout back: a partially reserved
    // basket is worse than none.
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

  // Analytics: the session that placed it reached the end of the funnel. Never
  // allowed to fail a checkout that has already committed.
  await analytics.recordServerEvent(req, 'order_placed').catch(() => {});

  // Still an array of vendor orders, with a few fields added. Changing this to
  // { group, orders } would break every app build already in the field.
  //
  // requiresPayment tells the app whether to route the customer to a gateway or
  // straight to the order. An older build ignores it and gets COD, which is the
  // only thing it ever asked for.
  res.status(201).json(
    createdOrders.map((order) => ({
      ...order,
      payment_method: paymentMethod,
      requiresPayment: !isCod,
    }))
  );
}

async function getMyOrders(req, res) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
}

/** One card per purchase, newest first — the customer's My Orders list. */
async function getOrderGroups(req, res) {
  const { rows } = await pool.query(
    // payment_method and payment_status ride along on the list so My Orders can
    // show 'Payment pending' without one extra request per purchase.
    `SELECT cg.id, cg.reference, cg.total_cents, cg.delivery_charge_cents, cg.created_at,
            cg.payment_method, cg.payment_status,
            COUNT(o.id)::int AS order_count,
            -- What is still owed once some shops cancelled; total_cents stays what was placed.
            COALESCE(SUM(o.total_cents) FILTER (WHERE o.status <> 'cancelled'), 0)::int AS payable_cents,
            COUNT(o.id) FILTER (WHERE o.status = 'cancelled')::int AS cancelled_count,
            ARRAY_AGG(vp.business_name ORDER BY o.id) AS vendor_names,
            ARRAY_AGG(o.status ORDER BY o.id) AS statuses
     FROM checkout_groups cg
     JOIN orders o ON o.checkout_group_id = cg.id
     JOIN vendor_profiles vp ON vp.id = o.vendor_id
     WHERE cg.user_id = $1
     GROUP BY cg.id
     ORDER BY cg.created_at DESC`,
    [req.user.id]
  );

  res.json({
    groups: rows.map((g) => ({
      id: g.id,
      reference: g.reference,
      derivedStatus: deriveGroupStatus(g.statuses),
      totalCents: g.total_cents,
      payableCents: g.payable_cents,
      deliveryChargeCents: g.delivery_charge_cents,
      orderCount: g.order_count,
      cancelledCount: g.cancelled_count,
      vendorNames: g.vendor_names,
      paymentMethod: g.payment_method,
      paymentStatus: g.payment_status,
      createdAt: g.created_at,
    })),
  });
}

/** One purchase in full: the group header with its vendor orders nested under it. */
async function getOrderGroup(req, res) {
  const { rows: groupRows } = await pool.query('SELECT * FROM checkout_groups WHERE id = $1', [req.params.id]);
  const group = groupRows[0];
  if (!group) return res.status(404).json({ message: 'Order group not found' });
  if (group.user_id !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

  const { rows: orders } = await pool.query(
    `SELECT o.id, o.vendor_id, o.status, o.total_cents, vp.business_name AS vendor_name,
            o.points_redeemed, o.points_discount_cents,
            (SELECT t.points FROM reward_transactions t WHERE t.order_id = o.id AND t.type = 'earn' AND t.status <> 'void') AS points_earned
     FROM orders o
     JOIN vendor_profiles vp ON vp.id = o.vendor_id
     WHERE o.checkout_group_id = $1
     ORDER BY o.id ASC`,
    [group.id]
  );

  // One query for every order's items rather than one per order.
  const { rows: items } = await pool.query(
    `SELECT order_id, product_name_snapshot, quantity, unit_price_cents
     FROM order_items WHERE order_id = ANY($1) ORDER BY id ASC`,
    [orders.map((o) => o.id)]
  );
  const itemsByOrder = new Map();
  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push({
      productNameSnapshot: it.product_name_snapshot,
      quantity: it.quantity,
      unitPriceCents: it.unit_price_cents,
    });
  }

  res.json({
    id: group.id,
    reference: group.reference,
    derivedStatus: deriveGroupStatus(orders.map((o) => o.status)),
    deliveryAddressSnapshot: group.delivery_address_snapshot,
    deliveryMethod: group.delivery_method,
    subtotalCents: group.subtotal_cents,
    gstCents: group.gst_cents,
    discountCents: group.discount_cents,
    deliveryChargeCents: group.delivery_charge_cents,
    totalCents: group.total_cents,
    // SB11: points spent on this purchase (inside discountCents) and earned on it.
    pointsRedeemed: orders.reduce((s, o) => s + o.points_redeemed, 0),
    pointsDiscountCents: orders.reduce((s, o) => s + o.points_discount_cents, 0),
    pointsEarned: orders.reduce((s, o) => s + (o.points_earned || 0), 0),
    paymentMethod: group.payment_method,
    paymentStatus: group.payment_status,
    createdAt: group.created_at,
    orders: orders.map((o) => ({
      id: o.id,
      vendorId: o.vendor_id,
      vendorName: o.vendor_name,
      status: o.status,
      totalCents: o.total_cents,
      items: itemsByOrder.get(o.id) ?? [],
    })),
  });
}

/** The order's timeline. Readable by the owning customer, the owning vendor, or any admin. */
async function getOrderHistory(req, res) {
  const { rows } = await pool.query('SELECT user_id, vendor_id FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ message: 'Order not found' });

  if (req.user.role !== 'admin' && order.user_id !== req.user.id) {
    const { rows: vendorRows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [req.user.id]);
    if (!vendorRows.some((v) => v.id === order.vendor_id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
  }

  const { rows: history } = await pool.query(
    `SELECT h.from_status, h.to_status, h.actor_role, h.note, h.created_at,
            CASE WHEN h.actor_role = 'vendor'
                 THEN COALESCE(
                   (SELECT business_name FROM vendor_profiles WHERE user_id = h.changed_by_user_id ORDER BY id LIMIT 1),
                   u.full_name)
                 ELSE u.full_name END AS actor_name
     FROM order_status_history h
     LEFT JOIN users u ON u.id = h.changed_by_user_id
     WHERE h.order_id = $1
     ORDER BY h.created_at ASC, h.id ASC`,
    [req.params.id]
  );

  res.json({
    history: history.map((h) => ({
      fromStatus: h.from_status,
      toStatus: h.to_status,
      actorRole: h.actor_role,
      actorName: h.actor_name,
      note: h.note,
      createdAt: h.created_at,
    })),
  });
}

async function getVendorOrders(req, res) {
  const { rows: vendorRows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [req.user.id]);
  const vendorId = vendorRows[0]?.id;
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  const { rows } = await pool.query('SELECT * FROM orders WHERE vendor_id = $1 ORDER BY created_at DESC', [vendorId]);
  res.json(rows);
}

async function getOrder(req, res) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ message: 'Order not found' });

  const { rows: vendorRows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [req.user.id]);
  const ownsAsVendor = vendorRows[0]?.id === order.vendor_id;
  const ownsAsCustomer = order.user_id === req.user.id;
  if (!ownsAsVendor && !ownsAsCustomer) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);

  // What the customer can still do with this order, decided here so the app
  // never has to reimplement the return window and disagree with the server.
  // Vendors reading their own order do not get it — none of it is theirs.
  if (!ownsAsCustomer) return res.json({ ...order, items });

  const [openReturn, review, cancellationPolicy] = await Promise.all([
    pool.query(
      `SELECT id, status, reason_code, resolution FROM order_returns
       WHERE order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [order.id]
    ),
    pool.query("SELECT id, rating, status FROM vendor_reviews WHERE order_id = $1 AND target = 'vendor'", [order.id]),
    cancellations.customerPolicy(order),
  ]);

  res.json({
    ...order,
    items,
    // Kept meaning "cancels at once" for app builds that show a plain Cancel
    // button; cancellation_policy says when a request to an admin is possible.
    can_cancel: cancellationPolicy.instant,
    cancellation_policy: cancellationPolicy,
    return_eligibility: returnEligibility(order, await deliveredAtFor(order.id), openReturn.rows[0] ?? null),
    latest_return: openReturn.rows[0] ?? null,
    my_review: review.rows[0] ?? null,
  });
}

async function updateStatus(req, res) {
  const { status, deliveryPartnerName, deliveryPartnerPhone, estimatedDeliveryAt } = req.body || {};
  const { rows: vendorRows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [req.user.id]);
  const vendorId = vendorRows[0]?.id;
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });

  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1 AND vendor_id = $2', [req.params.id, vendorId]);
  const order = rows[0];
  if (!order) return res.status(404).json({ message: 'Order not found' });

  // The shop cancelling goes through the stage rules like everyone else's:
  // straight through where vendors are allowed, a request to the admins where not.
  if (status === 'cancelled') {
    try {
      const result = await cancellations.requestCancellation({
        orderId: order.id,
        by: 'vendor',
        userId: req.user.id,
        body: req.body,
        owns: (o) => o.vendor_id === vendorId,
      });
      return sendCancellation(res, result, (r) => r.order);
    } catch (err) {
      return cancellationFailed(res, err);
    }
  }

  const currentIdx = STATUS_FLOW.indexOf(order.status);
  const nextIdx = STATUS_FLOW.indexOf(status);
  if (nextIdx === -1 || nextIdx !== currentIdx + 1) {
    return res.status(400).json({ message: `Cannot transition from ${order.status} to ${status}` });
  }

  // The status change and its history row are one transaction: a rejected
  // transition writes neither, and a committed one can never lack its timeline entry.
  const client = await pool.connect();
  let updatedOrder;
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE orders SET
        status = $2,
        delivery_partner_name = COALESCE($3, delivery_partner_name),
        delivery_partner_phone = COALESCE($4, delivery_partner_phone),
        estimated_delivery_at = COALESCE($5, estimated_delivery_at),
        updated_at = now()
       WHERE id = $1 RETURNING *`,
      [order.id, status, deliveryPartnerName || null, deliveryPartnerPhone || null, estimatedDeliveryAt || null]
    );
    updatedOrder = updated[0];
    await recordStatusChange(client, {
      orderId: order.id,
      fromStatus: order.status,
      toStatus: status,
      userId: req.user.id,
      actorRole: 'vendor',
    });
    // Acceptance, cancellation and fulfilment time are what this vendor gets
    // ranked on later, so they move with the status that caused them.
    const deltas = metricsForTransition(
      order.status,
      status,
      (Date.now() - new Date(order.created_at).getTime()) / 60000
    );
    if (deltas) await bumpMetrics(client, order.vendor_id, deltas);
    await shipments.onOrderStatusChanged(client, updatedOrder, status, { actorRole: 'vendor', userId: req.user.id });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (status === 'delivered') {
    await creditWalletForOrder(updatedOrder);
    await issueAfterDelivery(updatedOrder.id);
    await settleCodForOrder(updatedOrder.id);
    await rewards.creditForOrder(updatedOrder.id);
  }

  res.json(updatedOrder);
}

/** Turns a cancellation outcome into the response both the customer and vendor routes give. */
function sendCancellation(res, result, orderJson) {
  if (result.immediate) return res.json(orderJson(result));
  const c = result.cancellation;
  res.status(202).json({
    pendingApproval: true,
    cancellation: { id: c.id, reference: c.reference, status: c.status, eligible: c.eligible },
    message: c.eligible
      ? `Cancellation request ${c.reference} sent — an admin will confirm it.`
      : `This order can't normally be cancelled at this stage. Request ${c.reference} was sent to an admin to decide.`,
  });
}

function cancellationFailed(res, err) {
  if (err instanceof CancellationError) return res.status(err.status).json({ message: err.message, ...err.extra });
  throw err;
}

/**
 * The customer cancelling one shop's order, under the rule for the stage it
 * has reached (services/cancellations.js). 200 with the cancelled order when it
 * goes through at once, 202 when it waits for an admin.
 *
 * Orders are per shop, so a purchase spanning three shops cancels one at a
 * time; the group's status is derived and follows on its own.
 */
async function cancelOrder(req, res) {
  try {
    const result = await cancellations.requestCancellation({
      orderId: req.params.id,
      by: 'customer',
      userId: req.user.id,
      body: req.body,
      owns: (order) => order.user_id === req.user.id,
    });
    sendCancellation(res, result, (r) => ({ ...r.order, refund: r.refund, cancellation_fee_cents: r.feeCents }));
  } catch (err) {
    cancellationFailed(res, err);
  }
}

/** The customer's latest cancellation request on their order, or null. */
async function getCancellation(req, res) {
  const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  if (!orderRows[0]) return res.status(404).json({ message: 'Order not found' });
  const { rows } = await pool.query(
    `SELECT id, reference, status, reason_code, reason_note, order_status_at_request, fee_cents, refund_cents,
            decision_note, created_at, decided_at
     FROM order_cancellations WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id]
  );
  res.json({ latest: rows[0] ?? null, policy: await cancellations.customerPolicy(orderRows[0]) });
}

async function withdrawCancellation(req, res) {
  try {
    res.json(await cancellations.withdraw({ orderId: req.params.id, userId: req.user.id }));
  } catch (err) {
    cancellationFailed(res, err);
  }
}

module.exports = {
  checkout,
  getMyOrders,
  getOrderGroups,
  getOrderGroup,
  getOrderHistory,
  getVendorOrders,
  getOrder,
  updateStatus,
  cancelOrder,
  getCancellation,
  withdrawCancellation,
  STATUS_FLOW,
  deriveGroupStatus,
  recordStatusChange,
};
