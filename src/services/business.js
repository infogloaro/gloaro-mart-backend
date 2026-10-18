const pool = require('../config/db');

/**
 * Business accounts (schema BUSINESS ACCOUNTS, PHASE 44): GSTIN checks, the
 * credit position, and what checkout asks before taking a business order.
 */

// GST state codes, from the first two digits of a GSTIN.
const STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Checks a GSTIN's shape, state code and check digit (the standard mod-36
 * scheme). Returns { gstin, pan, state } or { error }.
 */
function parseGstin(raw) {
  const gstin = String(raw ?? '').trim().toUpperCase();
  if (!GSTIN_FORMAT.test(gstin)) return { error: 'That is not a GSTIN — it looks like 33ABCDE1234F1Z5.' };
  const state = STATE_CODES[gstin.slice(0, 2)];
  if (!state) return { error: 'The GSTIN starts with an unknown state code.' };
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(gstin[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const check = CHARS[(36 - (sum % 36)) % 36];
  if (check !== gstin[14]) return { error: 'The GSTIN check digit is wrong — please re-check it.' };
  return { gstin, pan: gstin.slice(2, 12), state };
}

/**
 * Credit drawn, what's overdue, and the lifetime figures. Credit orders are the
 * business's orders paid 'credit' that weren't cancelled; payments are applied
 * oldest first, so overdue = credit orders past their terms that payments
 * haven't covered yet.
 */
async function creditPosition(db, accountId) {
  const { rows } = await db.query(
    `SELECT a.credit_limit_cents::bigint AS credit_limit, a.payment_terms_days,
       COALESCE((SELECT SUM(o.total_cents) FROM orders o
                 WHERE o.business_account_id = a.id AND o.payment_method = 'credit' AND o.status <> 'cancelled'), 0)::bigint AS charged,
       COALESCE((SELECT SUM(o.total_cents) FROM orders o
                 WHERE o.business_account_id = a.id AND o.payment_method = 'credit' AND o.status <> 'cancelled'
                   AND o.created_at < now() - make_interval(days => a.payment_terms_days)), 0)::bigint AS due,
       COALESCE((SELECT SUM(amount_cents) FROM business_credit_payments p WHERE p.account_id = a.id), 0)::bigint AS paid,
       COALESCE((SELECT SUM(o.total_cents) FROM orders o WHERE o.business_account_id = a.id AND o.status <> 'cancelled'), 0)::bigint AS lifetime,
       (SELECT COUNT(*)::int FROM orders o WHERE o.business_account_id = a.id) AS orders,
       (SELECT MAX(o.created_at) FROM orders o WHERE o.business_account_id = a.id) AS last_order
     FROM business_accounts a WHERE a.id = $1`,
    [accountId]
  );
  const r = rows[0];
  if (!r) return null;
  const used = Math.max(0, Number(r.charged) - Number(r.paid));
  const overdue = Math.max(0, Number(r.due) - Number(r.paid));
  return {
    limitCents: Number(r.credit_limit),
    usedCents: used,
    availableCents: Math.max(0, Number(r.credit_limit) - used),
    overdueCents: overdue,
    termsDays: r.payment_terms_days,
    lifetimeValueCents: Number(r.lifetime),
    ordersCount: r.orders,
    lastOrderAt: r.last_order,
  };
}

class BusinessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The caller's membership, with the account row. Null when they belong to none. */
async function membershipFor(db, userId) {
  const { rows } = await db.query(
    `SELECT m.*, a.status AS account_status, a.legal_name FROM business_members m
     JOIN business_accounts a ON a.id = m.account_id WHERE m.user_id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

/**
 * Before checkout writes anything for a business order: the caller belongs to a
 * verified account. Returns the membership (the account is locked by
 * checkFinalCredit inside the transaction).
 */
async function assertCanOrderFor(userId, accountId) {
  const m = await membershipFor(pool, userId);
  if (!m || m.account_id !== accountId) throw new BusinessError(403, "You don't order for that business.");
  if (m.account_status !== 'verified') throw new BusinessError(409, `${m.legal_name} isn't verified yet, so it can't place orders.`);
  return m;
}

/**
 * Inside the checkout transaction, once the total is known: the member's
 * per-order limit, and for credit, the account's limit and overdue balance.
 */
async function checkFinalCredit(client, { member, accountId, totalCents, paymentMethod }) {
  if (member.order_limit_cents != null && totalCents > Number(member.order_limit_cents)) {
    throw new BusinessError(403, `This order is more than your limit of ₹${(Number(member.order_limit_cents) / 100).toFixed(2)}. Ask an approver to place it.`);
  }
  if (paymentMethod !== 'credit') return;
  await client.query('SELECT id FROM business_accounts WHERE id = $1 FOR UPDATE', [accountId]);
  const pos = await creditPosition(client, accountId);
  if (pos.limitCents <= 0) throw new BusinessError(409, 'This business has no credit — choose another way to pay.');
  if (pos.overdueCents > 0) {
    throw new BusinessError(409, `₹${(pos.overdueCents / 100).toFixed(2)} is overdue. Clear it before ordering on credit.`);
  }
  // The new order is already written, so it's part of what's drawn.
  if (pos.usedCents > pos.limitCents) {
    throw new BusinessError(409, `Not enough credit: ₹${((pos.limitCents - (pos.usedCents - totalCents)) / 100).toFixed(2)} left.`);
  }
}

module.exports = { STATE_CODES, parseGstin, creditPosition, membershipFor, assertCanOrderFor, checkFinalCredit, BusinessError };
