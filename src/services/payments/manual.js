const crypto = require('node:crypto');

/**
 * Manually settled payments — a bank transfer ops confirm, or any external
 * system that can post a signed callback.
 *
 * This is also the provider the webhook path is proven against before a real
 * gateway exists: it implements the same signature check and the same parsed
 * shape a Razorpay or Cashfree adapter will, so the receiver, the idempotency
 * guard and the state machine are all exercised for real rather than stubbed.
 *
 * Set PAYMENTS_WEBHOOK_SECRET to enable it. Unset, every webhook is rejected —
 * failing closed, because the alternative is an endpoint that captures payments
 * for anyone who can find the URL.
 */
const SIGNATURE_HEADER = 'x-gloaro-signature';

function verifyWebhook({ headers, rawBody }) {
  const secret = process.env.PAYMENTS_WEBHOOK_SECRET;
  if (!secret || !rawBody) return false;

  const provided = headers[SIGNATURE_HEADER];
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  // Both buffers must be the same length for timingSafeEqual, and a length
  // mismatch is itself a failed signature.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const EVENTS = new Set(['captured', 'failed', 'cancelled', 'refund.completed', 'refund.failed']);

function parseWebhook({ body }) {
  const { eventId, event, providerPaymentId, providerRefundId, amountCents, failureReason } = body || {};
  if (!eventId || !EVENTS.has(event)) {
    const err = new Error('Unrecognised webhook payload.');
    err.status = 400;
    throw err;
  }
  return {
    providerEventId: String(eventId),
    providerPaymentId: providerPaymentId ? String(providerPaymentId) : null,
    providerRefundId: providerRefundId ? String(providerRefundId) : null,
    event,
    amountCents: Number.isInteger(amountCents) ? amountCents : 0,
    failureReason: failureReason ? String(failureReason) : null,
  };
}

module.exports = {
  name: 'manual',

  createAttempt({ attempt }) {
    return { providerOrderId: `manual_${attempt.id}`, redirect: null };
  },

  verifyWebhook,
  parseWebhook,

  createRefund({ refund }) {
    return { providerRefundId: `manual_rf_${refund.id}`, status: 'processing' };
  },
};
