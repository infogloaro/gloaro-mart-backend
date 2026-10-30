const pool = require('../config/db');
const paymentSettings = require('../services/paymentSettings');
const razorpay = require('../services/payments/razorpay');
const { recordAudit } = require('../services/auditLog');
const { PLATFORM_SELECT, toPlatformJson } = require('./platformRegistry.controller');

/**
 * Admin → Payment settings (RZ3): online payment on/off, COD on/off and its
 * limit, and the Razorpay keys (saved on the Razorpay platform through the
 * same settings form as Integrations, test and live apart).
 */

/** Where Razorpay should send webhooks: this server, as the admin reached it. */
function webhookUrl(req) {
  const proto = String(req.get('x-forwarded-proto') ?? req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}/api/payments/webhook/razorpay`;
}

async function overview(req) {
  const [s, conn] = await Promise.all([paymentSettings.getSettings(), razorpay.loadConnection()]);
  let platform = null;
  if (conn) {
    const { rows } = await pool.query(`${PLATFORM_SELECT} WHERE p.id = $1`, [conn.platformId]);
    platform = rows[0] ? toPlatformJson(rows[0]) : null;
  }
  const ready = razorpay.isReady(conn);
  return {
    onlineEnabled: s.online_enabled,
    codEnabled: s.cod_enabled,
    codMaxCents: s.cod_max_cents,
    updatedAt: s.updated_at,
    // What customers actually get, after the keys are checked.
    onlineLive: s.online_enabled && ready,
    razorpay: {
      setUp: Boolean(conn),
      ready,
      environment: conn?.environment ?? null,
      keyId: conn?.keyId ?? null,
      hasWebhookSecret: Boolean(conn?.webhookSecret),
      connectionStatus: conn?.connectionStatus ?? null,
      lastTestedAt: conn?.lastTestedAt ?? null,
      lastError: conn?.lastError ?? null,
      webhookUrl: webhookUrl(req),
      webhookEvents: ['payment.captured', 'payment.failed', 'refund.processed', 'refund.failed'],
      platform,
    },
  };
}

async function getSettings(req, res) {
  res.json(await overview(req));
}

/** Creates the Razorpay platform (once) so its keys can be entered. */
async function setupRazorpay(req, res) {
  const before = await razorpay.loadConnection();
  const id = await razorpay.ensurePlatform(pool, req.user.id);
  if (!before) {
    await recordAudit({
      actorUserId: req.user.id,
      action: 'payments.razorpay_set_up',
      module: 'payments',
      entityType: 'platform',
      entityId: id,
    }).catch(() => {});
  }
  res.json(await overview(req));
}

async function updateSettings(req, res) {
  const b = req.body ?? {};
  const set = {};
  for (const [key, column] of [['onlineEnabled', 'online_enabled'], ['codEnabled', 'cod_enabled']]) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== 'boolean') return res.status(400).json({ message: `${key} is on or off.` });
    set[column] = b[key];
  }
  if (b.codMaxCents !== undefined) {
    const v = b.codMaxCents;
    if (v !== null && !(Number.isInteger(v) && v > 0 && v <= 100_000_000)) {
      return res.status(400).json({ message: 'The COD limit is an amount in paise, or empty for no limit.' });
    }
    set.cod_max_cents = v;
  }
  const keys = Object.keys(set);
  if (!keys.length) return res.status(400).json({ message: 'Nothing to change.' });

  const before = await paymentSettings.getSettings();
  const next = { ...before, ...set };
  // Turning online on needs working keys; at least one way to pay must stay.
  if (set.online_enabled === true && !razorpay.isReady(await razorpay.loadConnection())) {
    return res.status(409).json({ message: 'Save Razorpay keys for the environment in use before turning online payment on.' });
  }
  if (!next.online_enabled && !next.cod_enabled) {
    return res.status(409).json({ message: 'Keep at least one way to pay: online or cash on delivery.' });
  }

  await pool.query('INSERT INTO payment_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  await pool.query(
    `UPDATE payment_settings SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')},
       updated_by = $${keys.length + 1}, updated_at = now()
     WHERE id = 1`,
    [...keys.map((k) => set[k]), req.user.id]
  );
  await recordAudit({
    actorUserId: req.user.id,
    action: 'payments.settings_updated',
    module: 'payments',
    entityType: 'payment_settings',
    entityId: 1,
    newValue: set,
    previousValue: Object.fromEntries(keys.map((k) => [k, before[k]])),
  }).catch(() => {});
  res.json(await overview(req));
}

module.exports = { getSettings, updateSettings, setupRazorpay };
