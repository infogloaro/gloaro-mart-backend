const crypto = require('node:crypto');
const pool = require('../../config/db');
const secretBox = require('../secretBox');
const connector = require('../../connectors/razorpay');
const { requestJson, safeEqual } = require('../../connectors/http');

/**
 * Razorpay as a payment provider (RZ1).
 *
 * The keys are not in the server environment: admin saves them on the
 * Razorpay platform (Admin → Payment settings, or Integrations), test and live
 * apart, and the environment the platform is set to is the one used. Changing
 * them takes effect on the next payment with no redeploy.
 *
 * Money is only ever counted as received in two places, both of which check a
 * signature made with a secret the customer never sees:
 *   - verifyCheckout: the app hands back Razorpay's payment id + signature,
 *     which is HMAC(order_id|payment_id, key_secret); the payment is then
 *     fetched from Razorpay and captured if it is only authorised.
 *   - the webhook: X-Razorpay-Signature is HMAC(raw body, webhook_secret).
 * Both produce the same event ids (rzp:<event>:<payment id>), so whichever
 * lands second is a no-op.
 */

const API = 'https://api.razorpay.com/v1';
const SLUG = 'razorpay';

class RazorpayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The Razorpay platform row, created once so its keys can be entered. */
async function ensurePlatform(db = pool, userId = null) {
  const { rows } = await db.query('SELECT id FROM platforms WHERE connector_key = $1 ORDER BY id LIMIT 1', [connector.key]);
  if (rows[0]) return rows[0].id;
  const { rows: cat } = await db.query("SELECT id FROM platform_categories WHERE slug = 'finance'");
  const { rows: created } = await db.query(
    `INSERT INTO platforms (category_id, slug, name, description, integration_method, connector_key, status, capabilities,
       config_schema, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, $3, $4, 'connector', $5, 'inactive', $6, $7, $8, $8)
     ON CONFLICT (slug) DO UPDATE SET connector_key = EXCLUDED.connector_key RETURNING id`,
    [cat[0]?.id ?? null, SLUG, connector.name, connector.description, connector.key,
      JSON.stringify(connector.capabilities), JSON.stringify(connector.settings), userId]
  );
  return created[0].id;
}

/** Saved keys of the environment in use, secrets opened. Null when Razorpay isn't set up at all. */
async function loadConnection(db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.status, p.environment, pc.config, pc.secrets_encrypted, pc.status AS connection_status,
            pc.last_tested_at, pc.last_error
     FROM platforms p LEFT JOIN platform_connections pc ON pc.platform_id = p.id AND pc.environment = p.environment
     WHERE p.connector_key = $1 ORDER BY p.id LIMIT 1`,
    [connector.key]
  );
  const p = rows[0];
  if (!p) return null;
  let secrets = {};
  try {
    secrets = p.secrets_encrypted ? secretBox.open(p.secrets_encrypted) : {};
  } catch {
    secrets = {};
  }
  return {
    platformId: p.id,
    platformStatus: p.status,
    environment: p.environment,
    keyId: p.config?.key_id ? String(p.config.key_id) : null,
    keySecret: secrets.key_secret ?? null,
    webhookSecret: secrets.webhook_secret ?? null,
    connectionStatus: p.connection_status ?? 'not_connected',
    lastTestedAt: p.last_tested_at,
    lastError: p.last_error,
  };
}

/** Keys present and the right kind for the environment: rzp_test_ in test, rzp_live_ in live. */
function isReady(conn) {
  if (!conn?.keyId || !conn.keySecret) return false;
  return conn.keyId.startsWith(conn.environment === 'live' ? 'rzp_live_' : 'rzp_test_');
}

async function readyConnection() {
  const conn = await loadConnection();
  if (!isReady(conn)) throw new RazorpayError(409, 'Online payment is not set up yet. Please pay another way.');
  return conn;
}

/** One Razorpay API call. POSTs are never retried: a retried "create" could make two. */
async function call(conn, method, path, body) {
  const auth = Buffer.from(`${conn.keyId}:${conn.keySecret}`).toString('base64');
  let res;
  try {
    res = await requestJson(`${API}${path}`, {
      method,
      body,
      headers: { Authorization: `Basic ${auth}` },
      retries: method === 'GET' ? 2 : 0,
      timeoutMs: 15000,
    });
  } catch (err) {
    throw new RazorpayError(502, `Razorpay could not be reached (${err.message})`);
  }
  if (res.status >= 200 && res.status < 300) return res.data;
  if (res.status === 401) throw new RazorpayError(502, 'Razorpay rejected the saved keys.');
  throw new RazorpayError(res.status >= 500 ? 502 : 400, res.data?.error?.description ?? `Razorpay answered HTTP ${res.status}.`);
}

const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');

/** The checkout signature Razorpay hands the app: HMAC(order_id|payment_id, key_secret). */
function checkoutSignatureOk(conn, { orderId, paymentId, signature }) {
  if (!orderId || !paymentId || typeof signature !== 'string') return false;
  return safeEqual(hmac(conn.keySecret, `${orderId}|${paymentId}`), signature);
}

/** A Razorpay payment, in the shape the payment and top-up code apply. */
function eventFromPayment(entity, { orderId = null } = {}) {
  const captured = entity.status === 'captured';
  return {
    providerEventId: `rzp:payment.${captured ? 'captured' : entity.status}:${entity.id}`,
    providerPaymentId: entity.id,
    providerOrderId: entity.order_id ?? orderId,
    event: captured ? 'captured' : entity.status === 'failed' ? 'attempt.failed' : 'ignored',
    amountCents: Number(entity.amount) || 0,
    instrument: entity.method ?? null,
    failureReason: entity.error_description ?? null,
  };
}

/**
 * After the app's success callback: signature first, then Razorpay's own word
 * on the payment. An authorised (not yet captured) payment is captured here
 * for the order's amount, so money is never left hanging when auto-capture is
 * off in the dashboard.
 */
async function verifyCheckout({ orderId, paymentId, signature }) {
  const conn = await readyConnection();
  if (!checkoutSignatureOk(conn, { orderId, paymentId, signature })) {
    throw new RazorpayError(400, 'The payment could not be verified.');
  }
  let entity = await call(conn, 'GET', `/payments/${encodeURIComponent(paymentId)}`);
  if (entity.order_id !== orderId) throw new RazorpayError(400, 'That payment belongs to another order.');
  if (entity.status === 'authorized') {
    entity = await call(conn, 'POST', `/payments/${encodeURIComponent(paymentId)}/capture`, {
      amount: entity.amount,
      currency: entity.currency,
    });
  }
  return eventFromPayment(entity, { orderId });
}

const WEBHOOK_EVENTS = new Set(['payment.captured', 'payment.failed', 'refund.processed', 'refund.failed']);

module.exports = {
  name: 'razorpay',
  RazorpayError,
  SLUG,
  ensurePlatform,
  loadConnection,
  isReady,
  verifyCheckout,
  checkoutSignatureOk,
  eventFromPayment,

  /**
   * Opens a Razorpay order for the amount owed. `checkout` is what the app
   * passes to Razorpay's checkout: the public key id and the order — never the
   * secret.
   */
  async createAttempt({ payment, attempt, amountCents }) {
    const conn = await readyConnection();
    const order = await call(conn, 'POST', '/orders', {
      amount: amountCents,
      currency: 'INR',
      receipt: String(payment ? `pay_${payment.id}_${attempt.id}` : attempt.id).slice(0, 40),
      notes: payment ? { payment_id: String(payment.id), checkout_group_id: String(payment.checkout_group_id) } : { purpose: String(attempt.id) },
    });
    return {
      providerOrderId: order.id,
      redirect: null,
      checkout: { keyId: conn.keyId, orderId: order.id, amountCents: order.amount, currency: order.currency, environment: conn.environment },
    };
  },

  /** X-Razorpay-Signature over the raw body, with the webhook secret saved for the environment in use. */
  async verifyWebhook({ headers, rawBody }) {
    const conn = await loadConnection();
    if (!conn?.webhookSecret || !rawBody) return false;
    return safeEqual(hmac(conn.webhookSecret, rawBody), headers['x-razorpay-signature']);
  },

  parseWebhook({ body }) {
    const event = body?.event;
    if (!WEBHOOK_EVENTS.has(event)) return { event: 'ignored', providerEventId: null };
    if (event.startsWith('refund.')) {
      const r = body.payload?.refund?.entity ?? {};
      return {
        providerEventId: `rzp:${event}:${r.id}`,
        providerPaymentId: r.payment_id ?? null,
        providerRefundId: r.id ?? null,
        event: event === 'refund.processed' ? 'refund.completed' : 'refund.failed',
        amountCents: Number(r.amount) || 0,
        failureReason: null,
      };
    }
    return eventFromPayment(body.payload?.payment?.entity ?? {});
  },

  /**
   * Sends the money back to where it came from. Razorpay answers at once with
   * the refund id; its own status ('processed' or 'pending') settles later by
   * webhook.
   */
  async createRefund({ payment, refund }) {
    if (!payment.provider_payment_id) throw new RazorpayError(409, 'This payment has no Razorpay payment id to refund.');
    const conn = await readyConnection();
    const r = await call(conn, 'POST', `/payments/${encodeURIComponent(payment.provider_payment_id)}/refund`, {
      amount: refund.amount_cents,
      notes: { refund_id: String(refund.id), order_id: refund.order_id ? String(refund.order_id) : '' },
    });
    return { providerRefundId: r.id, status: r.status === 'processed' ? 'completed' : 'processing' };
  },
};
