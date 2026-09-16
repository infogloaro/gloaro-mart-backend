/**
 * The gateway seam.
 *
 * No payment gateway is chosen yet, so nothing gateway-specific may leak into a
 * controller. Everything the rest of the server needs from a provider is the
 * four methods below; adding Razorpay, Cashfree or PhonePe later means one new
 * file here and one line in PROVIDERS, with no controller changes.
 *
 * A provider implements:
 *
 *   name                                          — stored on payments.provider
 *   createAttempt({ payment, attempt, amountCents })
 *       -> { providerOrderId, redirect }          — redirect is null when the
 *                                                   customer has nowhere to go
 *   verifyWebhook({ headers, rawBody })  -> bool  — signature check, before the
 *                                                   body is treated as true
 *   parseWebhook({ body })
 *       -> { providerEventId, providerPaymentId, event, amountCents, failureReason }
 *   createRefund({ payment, refund })    -> { providerRefundId, status }
 */
const cod = require('./cod');
const manual = require('./manual');

const PROVIDERS = { cod, manual };

/** The provider handling a payment, by name. Throws rather than guessing. */
function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    const err = new Error(`Unknown payment provider: ${name}`);
    err.status = 400;
    throw err;
  }
  return provider;
}

/** Which method names each provider is willing to handle. */
function providerForMethod(method) {
  return method === 'cod' ? cod : manual;
}

module.exports = { getProvider, providerForMethod, PROVIDERS };
