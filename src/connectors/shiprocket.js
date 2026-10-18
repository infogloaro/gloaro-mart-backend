const { requestJson, safeEqual } = require("./http");

/**
 * Shiprocket (shipping). Uses an API user created in the Shiprocket panel →
 * Settings → API → Configure — not the main login. Shiprocket has no sandbox,
 * so Test and Live settings both reach the real account; keep Test pointed at
 * a separate API user if you want them apart.
 *
 * Tracking webhooks carry the token you set in Shiprocket's webhook settings
 * in the x-api-key header.
 */

const API = "https://apiv2.shiprocket.in/v1/external";

module.exports = {
  key: "shiprocket",
  name: "Shiprocket",
  category: "fulfilment",
  description: "Courier aggregator: shipments, labels and tracking.",
  capabilities: ["shipments", "tracking"],
  settings: [
    { key: "api_email", label: "API user email", type: "text", required: true, secret: false },
    { key: "api_password", label: "API user password", type: "password", required: true, secret: true },
    {
      key: "webhook_token",
      label: "Webhook token",
      type: "password",
      required: false,
      secret: true,
      help: "The token set in Shiprocket → Settings → Webhooks; sent back to us as x-api-key.",
    },
  ],
  webhookSignatureHeader: "x-api-key",

  async testConnection({ config, secrets }) {
    if (!config.api_email || !secrets.api_password) return { ok: false, message: "API user email and password are both required." };
    const { status, data } = await requestJson(`${API}/auth/login`, {
      method: "POST",
      body: { email: config.api_email, password: secrets.api_password },
    });
    if (status === 200 && data?.token) return { ok: true, message: "Shiprocket accepted the API user." };
    if (status === 400 || status === 401 || status === 403) {
      return { ok: false, message: "Shiprocket rejected the API user email or password." };
    }
    return { ok: false, message: data?.message ?? `Shiprocket answered HTTP ${status}.` };
  },

  verifyWebhook({ headers, secrets }) {
    if (!secrets.webhook_token) return { ok: false, message: "No webhook token is saved, so the webhook can't be verified." };
    return safeEqual(headers["x-api-key"], secrets.webhook_token) ? { ok: true } : { ok: false, message: "Token did not match." };
  },

  describeEvent(body) {
    return {
      event: body?.current_status ? `tracking.${String(body.current_status).toLowerCase().replace(/\s+/g, "_")}` : "tracking.update",
      detail: { awb: body?.awb ?? null, order_id: body?.order_id ?? null, status: body?.current_status ?? null },
    };
  },
};
