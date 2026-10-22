const pool = require('../config/db');

/**
 * Reward points (schema REWARD POINTS (SB11)).
 *
 *   checkout    planRedemption → (per order) pointsForOrder + earnOnOrder → spendPoints
 *   delivered   creditForOrder         pending earn → credited (balance moves now)
 *   cancelled   onOrderCancelled       pending earn → void; points spent come back
 *   refunded    onReturnRefunded       a refunded return takes back its share of the
 *                                      points earned and gives back its share of the
 *                                      points spent
 *
 * Every function that moves points is safe to run twice: the unique indexes on
 * reward_transactions let each order earn, spend and give back only once.
 */

const DEFAULTS = {
  enabled: true,
  earn_points: 1,
  earn_per_rupees: 10,
  points_per_rupee: 10,
  max_redeem_percent: 20,
  min_redeem_points: 10,
};

class RewardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The admin's rules; the defaults when the migration hasn't seeded the row. */
async function getSettings(db = pool) {
  const { rows } = await db.query('SELECT * FROM reward_settings WHERE id = 1');
  return { ...DEFAULTS, ...(rows[0] || {}) };
}

const settingsJson = (s) => ({
  enabled: s.enabled,
  earnPoints: s.earn_points,
  earnPerRupees: s.earn_per_rupees,
  pointsPerRupee: s.points_per_rupee,
  maxRedeemPercent: s.max_redeem_percent,
  minRedeemPoints: s.min_redeem_points,
  updatedAt: s.updated_at ?? null,
});

/** What [points] take off, in paise. */
const valueCents = (points, s) => Math.floor((points * 100) / s.points_per_rupee);
/** The most points that fit in [cents]. */
const pointsWorth = (cents, s) => Math.floor((Math.max(0, cents) * s.points_per_rupee) / 100);
/** Points earned on [cents] paid for items. */
const earnFor = (cents, s) => (s.enabled ? Math.floor(Math.max(0, cents) / (s.earn_per_rupees * 100)) * s.earn_points : 0);

/** Splits [total] over [weights] in whole numbers (largest remainder), adding up exactly. */
function split(total, weights) {
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * Math.max(0, w)) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

/** The customer's balance row, created on first use and locked for this transaction. */
async function lockAccount(client, userId) {
  await client.query('INSERT INTO reward_accounts (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const { rows } = await client.query('SELECT balance_points FROM reward_accounts WHERE user_id = $1 FOR UPDATE', [userId]);
  return rows[0].balance_points;
}

async function setBalance(client, userId, balance) {
  await client.query('UPDATE reward_accounts SET balance_points = $2, updated_at = now() WHERE user_id = $1', [userId, balance]);
}

/**
 * How many of [requestedPoints] this checkout may spend, split over the shops'
 * orders by what each order's items cost after its coupon ([baseByVendor]:
 * vendorId → paise). Clamped to the balance and the admin's cap; fewer than
 * the minimum is refused (400) rather than silently dropped. Locks the balance.
 */
async function planRedemption(client, { userId, requestedPoints, baseByVendor, settings }) {
  const none = { points: 0, byVendor: new Map() };
  const requested = Number(requestedPoints) || 0;
  if (requested <= 0) return none;
  if (!Number.isInteger(requested)) throw new RewardError(400, 'redeemPoints must be a whole number');
  if (!settings.enabled) throw new RewardError(409, 'Reward points can’t be used right now.');

  const balance = await lockAccount(client, userId);
  const vendors = [...baseByVendor.keys()];
  const base = vendors.reduce((sum, v) => sum + Math.max(0, baseByVendor.get(v)), 0);
  const cap = pointsWorth(Math.floor((base * settings.max_redeem_percent) / 100), settings);
  const points = Math.min(requested, balance, cap);
  if (points < Math.max(1, settings.min_redeem_points)) {
    throw new RewardError(
      400,
      balance < settings.min_redeem_points
        ? `You need at least ${settings.min_redeem_points} points to use them.`
        : `Use at least ${settings.min_redeem_points} points (this order allows up to ${cap}).`
    );
  }
  const shares = split(points, vendors.map((v) => baseByVendor.get(v)));
  return { points, byVendor: new Map(vendors.map((v, i) => [v, shares[i]])) };
}

/**
 * One order's share of the points, trimmed so the discount never takes the
 * items below zero once its campaign is known. Returns { points, cents }.
 */
function pointsForOrder(planned, roomCents, settings) {
  let points = Math.min(planned, pointsWorth(roomCents, settings));
  if (points < 0) points = 0;
  return { points, cents: valueCents(points, settings) };
}

/**
 * The order's pending earn, split per product by what each line cost.
 * [eligibleCents] is what the customer pays for the items (after every discount).
 */
async function earnOnOrder(client, { order, items, eligibleCents, settings }) {
  const points = earnFor(eligibleCents, settings);
  if (points <= 0) return 0;
  const shares = split(points, items.map((it) => it.unitPriceCents * it.quantity));
  const lines = items.map((it, i) => ({
    productId: it.product_id,
    variantId: it.variant_id ?? null,
    name: it.name,
    variant: it.variant_label ?? null,
    quantity: it.quantity,
    points: shares[i],
  }));
  await client.query(
    `INSERT INTO reward_transactions (user_id, order_id, type, status, points, value_cents, items, description)
     VALUES ($1, $2, 'earn', 'pending', $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [order.user_id, order.id, points, valueCents(points, settings), JSON.stringify(lines), `Order #${order.id}`]
  );
  return points;
}

/** Takes the spent points off the balance: one 'redeem' row per order. Balance already locked. */
async function spendPoints(client, { userId, spends }) {
  let balance = await lockAccount(client, userId);
  for (const { order, points, cents } of spends) {
    if (points <= 0) continue;
    if (points > balance) throw new RewardError(409, 'Your points balance changed — please try again.');
    balance -= points;
    await client.query(
      `INSERT INTO reward_transactions (user_id, order_id, type, points, balance_after, value_cents, description)
       VALUES ($1, $2, 'redeem', $3, $4, $5, $6)`,
      [userId, order.id, -points, balance, cents, `Used on order #${order.id}`]
    );
  }
  await setBalance(client, userId, balance);
}

/** Adds a give-back / take-back row once; returns the points it moved (0 when it already ran). */
async function applyOnce(client, { userId, orderId, returnId = null, type, points, cents, description }) {
  if (points === 0) return 0;
  const balance = await lockAccount(client, userId);
  // A take-back can't push the balance below zero (the points may be spent).
  const moved = points < 0 ? -Math.min(-points, balance) : points;
  if (moved === 0) return 0;
  const { rows } = await client.query(
    `INSERT INTO reward_transactions (user_id, order_id, return_id, type, points, balance_after, value_cents, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING RETURNING id`,
    [userId, orderId, returnId, type, moved, balance + moved, cents, description]
  );
  if (!rows[0]) return 0;
  await setBalance(client, userId, balance + moved);
  return moved;
}

/**
 * Delivered: the order's pending points become spendable. On its own
 * transaction, after the delivery committed (like the vendor wallet credit).
 */
async function creditForOrder(orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT t.id, t.user_id, t.points FROM reward_transactions t JOIN orders o ON o.id = t.order_id
       WHERE t.order_id = $1 AND t.type = 'earn' AND t.status = 'pending' AND o.status = 'delivered'
       FOR UPDATE OF t`,
      [orderId]
    );
    const earn = rows[0];
    if (earn) {
      const balance = (await lockAccount(client, earn.user_id)) + earn.points;
      await client.query(
        `UPDATE reward_transactions SET status = 'credited', balance_after = $2, credited_at = now() WHERE id = $1`,
        [earn.id, balance]
      );
      await setBalance(client, earn.user_id, balance);
    }
    await client.query('COMMIT');
    return earn?.points ?? 0;
  } catch (err) {
    await client.query('ROLLBACK');
    // Logged, not thrown: the delivery has happened; the next status event or
    // an admin can credit it again (it only ever credits once).
    console.error(`[rewards] crediting order ${orderId} failed:`, err.message);
    return 0;
  } finally {
    client.release();
  }
}

/** Cancelled (inside the cancelling transaction): void the pending earn, give back what was spent. */
async function onOrderCancelled(client, order) {
  await client.query(
    `UPDATE reward_transactions SET status = 'void' WHERE order_id = $1 AND type = 'earn' AND status = 'pending'`,
    [order.id]
  );
  const { rows } = await client.query('SELECT user_id, points_redeemed, points_discount_cents FROM orders WHERE id = $1', [order.id]);
  const o = rows[0];
  if (!o || o.points_redeemed <= 0) return;
  await applyOnce(client, {
    userId: o.user_id,
    orderId: order.id,
    type: 'redeem_refund',
    points: o.points_redeemed,
    cents: o.points_discount_cents,
    description: `Order #${order.id} cancelled — points returned`,
  });
}

/**
 * A return was refunded (inside its transaction): its share of the order —
 * refund ÷ what was paid — of the points earned is taken back and of the
 * points spent is given back.
 */
async function onReturnRefunded(client, { orderId, returnId, refundCents }) {
  const { rows } = await client.query(
    `SELECT o.user_id, o.total_cents, o.points_redeemed, o.points_discount_cents,
            (SELECT points FROM reward_transactions WHERE order_id = o.id AND type = 'earn' AND status = 'credited') AS earned
     FROM orders o WHERE o.id = $1`,
    [orderId]
  );
  const o = rows[0];
  if (!o || !(refundCents > 0) || o.total_cents <= 0) return;
  const share = Math.min(1, refundCents / o.total_cents);
  const takeBack = Math.round((o.earned || 0) * share);
  const giveBack = Math.round(o.points_redeemed * share);
  if (takeBack > 0) {
    await applyOnce(client, {
      userId: o.user_id,
      orderId,
      returnId,
      type: 'earn_reversal',
      points: -takeBack,
      cents: 0,
      description: `Return on order #${orderId} — earned points taken back`,
    });
  }
  if (giveBack > 0) {
    await applyOnce(client, {
      userId: o.user_id,
      orderId,
      returnId,
      type: 'redeem_refund',
      points: giveBack,
      cents: Math.round(o.points_discount_cents * share),
      description: `Return on order #${orderId} — points returned`,
    });
  }
}

/** Balance, points waiting on deliveries, and the rules the app shows. */
async function summary(userId) {
  const [settings, { rows }] = await Promise.all([
    getSettings(),
    pool.query(
      `SELECT COALESCE((SELECT balance_points FROM reward_accounts WHERE user_id = $1), 0)::int AS balance,
              COALESCE((SELECT SUM(points) FROM reward_transactions
                        WHERE user_id = $1 AND type = 'earn' AND status = 'pending'), 0)::int AS pending,
              COALESCE((SELECT SUM(points) FROM reward_transactions
                        WHERE user_id = $1 AND type = 'earn' AND status = 'credited'), 0)::int AS earned,
              COALESCE((SELECT -SUM(points) FROM reward_transactions WHERE user_id = $1 AND type = 'redeem'), 0)::int AS spent`,
      [userId]
    ),
  ]);
  const r = rows[0];
  return {
    balancePoints: r.balance,
    balanceValueCents: valueCents(r.balance, settings),
    pendingPoints: r.pending,
    lifetimeEarnedPoints: r.earned,
    lifetimeSpentPoints: r.spent,
    settings: settingsJson(settings),
  };
}

/** The history, newest first, with the order's shop, reference and status. */
async function history(userId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.status, t.points, t.balance_after, t.value_cents, t.items, t.description,
            t.created_at, t.credited_at, t.order_id, t.return_id,
            o.status AS order_status, cg.reference AS order_reference, vp.business_name AS shop_name
     FROM reward_transactions t
     LEFT JOIN orders o ON o.id = t.order_id
     LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
     LEFT JOIN vendor_profiles vp ON vp.id = o.vendor_id
     WHERE t.user_id = $1
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows.map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    points: t.points,
    balanceAfter: t.balance_after,
    valueCents: t.value_cents,
    items: t.items,
    description: t.description,
    createdAt: t.created_at,
    creditedAt: t.credited_at,
    orderId: t.order_id,
    orderReference: t.order_reference,
    orderStatus: t.order_status,
    shopName: t.shop_name,
    returnId: t.return_id,
  }));
}

module.exports = {
  DEFAULTS,
  RewardError,
  getSettings,
  settingsJson,
  valueCents,
  pointsWorth,
  earnFor,
  split,
  planRedemption,
  pointsForOrder,
  earnOnOrder,
  spendPoints,
  creditForOrder,
  onOrderCancelled,
  onReturnRefunded,
  summary,
  history,
};
