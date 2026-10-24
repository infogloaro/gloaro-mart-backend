/**
 * Connector code that actually exists on this server, keyed by the
 * connector_key a platform row points at.
 *
 * Only what is registered here can test credentials or move a platform to
 * "connected". A platform whose connector_key is missing from this map is not
 * connected, whatever its row says. Each connector exports:
 *
 *   key, name, category, description, capabilities
 *   settings                 the settings form it needs (applied to the platform)
 *   testConnection({ config, secrets, environment }) → { ok, message }
 *   verifyWebhook({ rawBody, headers, query, secrets }) → { ok, message? }
 *   describeEvent(body)      → { event, detail } — a short, credential-free summary
 *   verifySubscription?      for providers with a GET handshake (Meta)
 */
const CONNECTORS = new Map(
  [require("./razorpay"), require("./shiprocket"), require("./whatsappCloud"), require("./ultramsg")].map((c) => [c.key, c]),
);

function getConnector(key) {
  return key ? CONNECTORS.get(key) ?? null : null;
}

/** What the panel may know about the available connectors. */
function listConnectors() {
  return [...CONNECTORS.values()].map(({ key, name, category, description, capabilities, settings }) => ({
    key,
    name,
    category,
    description,
    capabilities,
    settings,
  }));
}

module.exports = { CONNECTORS, getConnector, listConnectors };
