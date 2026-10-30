const pool = require("../config/db");
const secretBox = require("../services/secretBox");
const { getConnector } = require("../connectors");
const { recordSyncLog } = require("../services/platformSyncLog");

/**
 * Public webhook receiver for Platform Registry connectors:
 *   POST /api/webhooks/platforms/:slug   provider events
 *   GET  /api/webhooks/platforms/:slug   subscription handshake (Meta)
 *
 * Nothing is trusted until the connector has verified the request against the
 * secrets saved for the environment the platform uses. Every attempt is logged,
 * rejected ones included, so a misconfigured provider shows up in the panel.
 * Events are recorded only; acting on them (marking an order paid, updating
 * tracking) is wired per flow later.
 */

async function loadTarget(slug) {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.status, p.connector_key, p.environment, pc.secrets_encrypted
     FROM platforms p
     LEFT JOIN platform_connections pc ON pc.platform_id = p.id AND pc.environment = p.environment
     WHERE p.slug = $1`,
    [slug],
  );
  const platform = rows[0];
  const connector = platform && getConnector(platform.connector_key);
  // Unknown, unconnected and disabled platforms all look the same from outside.
  if (!platform || !connector || platform.status !== "active") return null;
  let secrets = {};
  try {
    secrets = secretBox.open(platform.secrets_encrypted);
  } catch {
    secrets = {};
  }
  return { platform, connector, secrets };
}

async function receive(req, res) {
  const target = await loadTarget(req.params.slug);
  if (!target) return res.status(404).json({ message: "Not found" });
  const { platform, connector, secrets } = target;

  const verdict = connector.verifyWebhook({ rawBody: req.rawBody, headers: req.headers, query: req.query, secrets });
  if (!verdict.ok) {
    await recordSyncLog({
      platformId: platform.id,
      environment: platform.environment,
      kind: "webhook",
      status: "rejected",
      message: verdict.message,
    });
    return res.status(401).json({ message: "Webhook could not be verified" });
  }

  const { event, detail } = connector.describeEvent(req.body ?? {});
  await recordSyncLog({
    platformId: platform.id,
    environment: platform.environment,
    kind: "webhook",
    status: "ok",
    event,
    message: "Received and verified.",
    detail,
  });
  // Providers retry anything but a quick 2xx, so answer before doing more.
  res.status(200).json({ received: true });

  // WhatsApp delivery and read receipts update the message log.
  if (connector.key === "whatsapp_cloud") {
    require("../services/whatsapp")
      .applyStatuses(req.body)
      .catch((err) => console.error(`[whatsapp] receipts failed: ${err.message}`));
  }
  // RZ2: Razorpay events pasted at this URL instead of /api/payments/webhook/razorpay
  // still settle payments and refunds (same secret, already verified above).
  if (connector.key === "razorpay") {
    require("./payment.controller")
      .applyVerifiedWebhook("razorpay", req.body ?? {})
      .catch((err) => console.error(`[payments] razorpay webhook (platform URL) failed: ${err.message}`));
  }
  // UltraMsg: acks update the log; START / STOP set the customer's consent.
  if (connector.key === "ultramsg") {
    require("../services/whatsapp")
      .applyUltraMsgEvent(req.body)
      .catch((err) => console.error(`[whatsapp] ultramsg webhook failed: ${err.message}`));
  }
}

async function handshake(req, res) {
  const target = await loadTarget(req.params.slug);
  if (!target || !target.connector.verifySubscription) return res.status(404).json({ message: "Not found" });
  const challenge = target.connector.verifySubscription({ query: req.query, secrets: target.secrets });
  await recordSyncLog({
    platformId: target.platform.id,
    environment: target.platform.environment,
    kind: "webhook",
    status: challenge === null ? "rejected" : "ok",
    event: "subscription.verify",
    message: challenge === null ? "Verify token did not match." : "Webhook subscription confirmed.",
  });
  if (challenge === null) return res.status(403).json({ message: "Verification failed" });
  res.type("text/plain").send(challenge);
}

module.exports = { receive, handshake };
