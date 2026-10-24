const { requestJson, safeEqual } = require("./http");

/**
 * WhatsApp through UltraMsg (ultramsg.com): a WhatsApp number linked by
 * scanning a QR code, sending plain text — no Meta templates or approval.
 * A stand-in until the Meta Cloud API is approved; Admin → Channels picks
 * which one sends. Values come from the UltraMsg dashboard → the instance.
 *
 * UltraMsg doesn't sign its webhooks, so the webhook URL carries a secret:
 *   /api/webhooks/platforms/whatsapp_ultramsg?secret=<webhook secret>
 */

// Overridable so tests can point it at a stand-in for UltraMsg.
const API = process.env.ULTRAMSG_API_URL || "https://api.ultramsg.com";

const base = (config) => `${API}/${encodeURIComponent(String(config.instance_id ?? "").trim())}`;

module.exports = {
  API,
  key: "ultramsg",
  name: "UltraMsg (WhatsApp)",
  category: "engagement",
  description: "WhatsApp order updates and shop alerts through an UltraMsg instance (QR-linked number).",
  capabilities: ["messaging", "notifications"],
  settings: [
    { key: "instance_id", label: "Instance ID", type: "text", required: true, secret: false, help: "UltraMsg dashboard, e.g. instance12345." },
    {
      key: "business_number",
      label: "Business WhatsApp number",
      type: "text",
      required: false,
      secret: false,
      help: "The number scanned into the instance, e.g. +91 98765 43210.",
    },
    { key: "token", label: "Token", type: "password", required: true, secret: true },
    {
      key: "webhook_secret",
      label: "Webhook secret",
      type: "password",
      required: false,
      secret: true,
      help: "Any phrase. In UltraMsg set the webhook URL to …/api/webhooks/platforms/whatsapp_ultramsg?secret=<this phrase>, with “message received” and “message ack” on.",
    },
  ],

  base,

  async testConnection({ config, secrets }) {
    if (!config.instance_id || !secrets.token) return { ok: false, message: "Instance ID and token are both required." };
    const { status, data } = await requestJson(`${base(config)}/instance/status?token=${encodeURIComponent(secrets.token)}`);
    if (status !== 200 || data?.error) {
      const err = typeof data?.error === "string" ? data.error : `UltraMsg answered HTTP ${status}`;
      return { ok: false, message: `UltraMsg: ${err}` };
    }
    const state = data?.status?.accountStatus?.status ?? data?.accountStatus?.status ?? null;
    if (state !== "authenticated") {
      return { ok: false, message: `The instance is ${state ?? "not ready"} — scan the QR code in the UltraMsg dashboard first.` };
    }
    return { ok: true, message: "Connected — the WhatsApp number is linked." };
  },

  verifyWebhook({ query, secrets }) {
    if (!secrets.webhook_secret) return { ok: false, message: "No webhook secret is saved, so the webhook can't be verified." };
    return safeEqual(String(query?.secret ?? ""), secrets.webhook_secret) ? { ok: true } : { ok: false, message: "Secret did not match." };
  },

  describeEvent(body) {
    const event = body?.event_type ? `message.${String(body.event_type).replace(/^message_/, "")}` : "update";
    return { event, detail: { type: body?.data?.type ?? null } };
  },
};
