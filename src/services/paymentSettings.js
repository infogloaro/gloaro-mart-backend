const pool = require('../config/db');
const razorpay = require('./payments/razorpay');

/**
 * What checkout offers (RZ3): online payment through Razorpay and cash on
 * delivery, set from Admin → Payment settings. Online is only offered while
 * Razorpay's keys are saved for the environment in use, whatever the switch
 * says. A database without the table yet gets the old behaviour: COD only.
 */

const DEFAULTS = { online_enabled: false, cod_enabled: true, cod_max_cents: null, updated_at: null };

async function getSettings(db = pool) {
  try {
    const { rows } = await db.query('SELECT * FROM payment_settings WHERE id = 1');
    return { ...DEFAULTS, ...(rows[0] || {}) };
  } catch (err) {
    if (err.code !== '42P01') throw err;
    return { ...DEFAULTS };
  }
}

/** The options a customer sees, keys checked. */
async function options(db = pool) {
  const [s, conn] = await Promise.all([getSettings(db), razorpay.loadConnection(db).catch(() => null)]);
  const ready = razorpay.isReady(conn);
  return {
    online: { enabled: s.online_enabled && ready, environment: ready ? conn.environment : null },
    cod: { enabled: s.cod_enabled, maxCents: s.cod_max_cents },
  };
}

class PaymentChoiceError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Throws when checkout asks for a way of paying admin has switched off. */
async function assertMethodAllowed(method, db = pool) {
  if (method !== 'online' && method !== 'cod') return;
  const o = await options(db);
  if (method === 'online' && !o.online.enabled) throw new PaymentChoiceError('Online payment is not available right now. Please pay another way.');
  if (method === 'cod' && !o.cod.enabled) throw new PaymentChoiceError('Cash on delivery is not available. Please pay online.');
}

/** COD above the limit, once the order total is known. */
async function assertCodLimit(method, totalCents, db = pool) {
  if (method !== 'cod') return;
  const s = await getSettings(db);
  if (s.cod_max_cents != null && totalCents > s.cod_max_cents) {
    throw new PaymentChoiceError(`Cash on delivery is for orders up to ₹${(s.cod_max_cents / 100).toLocaleString('en-IN')}. Please pay online.`);
  }
}

module.exports = { DEFAULTS, getSettings, options, assertMethodAllowed, assertCodLimit, PaymentChoiceError };
