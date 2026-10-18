const { requestJson, hmacHex, safeEqual } = require("./http");

/**
 * Razorpay (payments). Test mode and live mode are separate key pairs from the
 * Razorpay dashboard → Account & Settings → API keys; test keys start
 * rzp_test_, live keys rzp_live_.
 *
 * This connects the account and receives its webhooks. Checkout still takes
 * payment through the existing payment providers (src/services/payments);
 * routing checkout through Razorpay is a separate step.
 */

const API = "https://api.razorpay.com/v1";

module.exports = {
  key: "razorpay",
  name: "Razorpay",
  category: "finance",
  description: "Payment gateway: UPI, cards, net banking and wallets.",
  capabilities: ["payments", "refunds"],
  settings: [
    { key: "key_id", label: "Key ID", type: "text", required: true, secret: false, help: "Starts with rzp_test_ or rzp_live_." },
    { key: "key_secret", label: "Key secret", type: "password", required: true, secret: true },
    {
      key: "webhook_secret",
      label: "Webhook secret",
      type: "password",
      required: false,
      secret: true,
      help: "The secret you set when adding the webhook in the Razorpay dashboard.",
    },
  ],
  webhookSignatureHeader: "x-razorpay-signature",

  async testConnection({ config, secrets, environment }) {
    const keyId = String(config.key_id ?? "");
    if (!keyId || !secrets.key_secret) return { ok: false, message: "Key ID and Key secret are both required." };
    const expected = environment === "live" ? "rzp_live_" : "rzp_test_";
    if (!keyId.startsWith(expected)) {
      return { ok: false, message: `${environment === "live" ? "Live" : "Test"} settings need a key starting ${expected}.` };
    }
    const auth = Buffer.from(`${keyId}:${secrets.key_secret}`).toString("base64");
    const { status, data } = await requestJson(`${API}/payments?count=1`, { headers: { Authorization: `Basic ${auth}` } });
    if (status === 200) return { ok: true, message: `Razorpay accepted the ${environment} keys.` };
    if (status === 401) return { ok: false, message: "Razorpay rejected the Key ID or Key secret." };
    return { ok: false, message: data?.error?.description ?? `Razorpay answered HTTP ${status}.` };
  },

  /** X-Razorpay-Signature is HMAC-SHA256 of the raw body with the webhook secret. */
  verifyWebhook({ rawBody, headers, secrets }) {
    if (!secrets.webhook_secret) return { ok: false, message: "No webhook secret is saved, so the webhook can't be verified." };
    const ok = safeEqual(hmacHex(secrets.webhook_secret, rawBody), headers["x-razorpay-signature"]);
    return ok ? { ok: true } : { ok: false, message: "Signature did not match." };
  },

  describeEvent(body) {
    const entity = body?.payload?.payment?.entity ?? body?.payload?.refund?.entity ?? null;
    return {
      event: body?.event ?? "unknown",
      detail: entity ? { id: entity.id, status: entity.status, amount: entity.amount, currency: entity.currency } : null,
    };
  },
};
