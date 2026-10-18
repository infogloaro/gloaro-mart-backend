const { requestJson, hmacHex, safeEqual } = require("./http");

/**
 * WhatsApp Business through Meta's Cloud API. Values come from the Meta app
 * dashboard → WhatsApp → API Setup (phone number ID, access token) and
 * App settings → Basic (app secret).
 *
 * Meta first checks the webhook with a GET handshake (hub.verify_token), then
 * signs each POST: X-Hub-Signature-256 = "sha256=" + HMAC of the raw body with
 * the app secret.
 */

// Overridable so tests can point it at a stand-in for Meta.
const GRAPH = process.env.WHATSAPP_GRAPH_URL || "https://graph.facebook.com/v21.0";

module.exports = {
  GRAPH,
  key: "whatsapp_cloud",
  name: "WhatsApp Cloud API",
  category: "engagement",
  description: "Order updates and customer chat on WhatsApp.",
  capabilities: ["messaging", "notifications"],
  settings: [
    { key: "phone_number_id", label: "Phone number ID", type: "text", required: true, secret: false },
    {
      key: "business_number",
      label: "Business WhatsApp number",
      type: "text",
      required: false,
      secret: false,
      help: "The number customers see, e.g. +91 72005 37071. The connection test fails if the phone number ID belongs to another number.",
    },
    {
      key: "waba_id",
      label: "WhatsApp Business Account ID",
      type: "text",
      required: true,
      secret: false,
      help: "Meta app → WhatsApp → API Setup. Needed to create and sync message templates.",
    },
    { key: "access_token", label: "Access token", type: "password", required: true, secret: true },
    { key: "app_secret", label: "App secret", type: "password", required: false, secret: true, help: "Used to verify incoming webhooks." },
    {
      key: "verify_token",
      label: "Webhook verify token",
      type: "password",
      required: false,
      secret: true,
      help: "Any phrase; enter the same one in Meta's webhook setup.",
    },
  ],
  webhookSignatureHeader: "x-hub-signature-256",

  async testConnection({ config, secrets }) {
    if (!config.phone_number_id || !secrets.access_token) {
      return { ok: false, message: "Phone number ID and access token are both required." };
    }
    const id = encodeURIComponent(String(config.phone_number_id));
    const { status, data } = await requestJson(`${GRAPH}/${id}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${secrets.access_token}` },
    });
    if (status === 200) {
      const who = [data?.verified_name, data?.display_phone_number].filter(Boolean).join(", ");
      // Sending from the wrong number would reach customers from a stranger.
      const expected = String(config.business_number ?? "").replace(/\D/g, "");
      const actual = String(data?.display_phone_number ?? "").replace(/\D/g, "");
      if (expected && actual && expected.slice(-10) !== actual.slice(-10)) {
        return { ok: false, message: `This phone number ID is ${data.display_phone_number}, not the business number ${config.business_number}.` };
      }
      // The business account is what templates live under; a wrong id would
      // only show up later, at the first template sync.
      if (config.waba_id) {
        const waba = await requestJson(`${GRAPH}/${encodeURIComponent(String(config.waba_id))}?fields=name`, {
          headers: { Authorization: `Bearer ${secrets.access_token}` },
        });
        if (waba.status !== 200) {
          return { ok: false, message: `The phone number works, but Meta doesn't recognise the business account ID: ${waba.data?.error?.message ?? `HTTP ${waba.status}`}` };
        }
      }
      return { ok: true, message: who ? `Connected to ${who}.` : "Meta accepted the access token." };
    }
    if (status === 401 || data?.error?.code === 190) return { ok: false, message: "Meta rejected the access token." };
    return { ok: false, message: data?.error?.message ?? `Meta answered HTTP ${status}.` };
  },

  /** GET handshake: echo hub.challenge only when the verify token matches. */
  verifySubscription({ query, secrets }) {
    if (query["hub.mode"] !== "subscribe" || !secrets.verify_token) return null;
    return safeEqual(String(query["hub.verify_token"] ?? ""), secrets.verify_token) ? String(query["hub.challenge"] ?? "") : null;
  },

  verifyWebhook({ rawBody, headers, secrets }) {
    if (!secrets.app_secret) return { ok: false, message: "No app secret is saved, so the webhook can't be verified." };
    const ok = safeEqual(`sha256=${hmacHex(secrets.app_secret, rawBody)}`, headers["x-hub-signature-256"]);
    return ok ? { ok: true } : { ok: false, message: "Signature did not match." };
  },

  describeEvent(body) {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const kind = value?.messages ? "message.received" : value?.statuses ? `message.${value.statuses[0]?.status ?? "status"}` : "update";
    return { event: kind, detail: { messages: value?.messages?.length ?? 0, statuses: value?.statuses?.length ?? 0 } };
  },
};
