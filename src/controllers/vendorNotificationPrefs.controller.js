const pool = require('../config/db');

/**
 * The shop's notification settings (VD28, schema "VENDOR NOTIFICATION PREFS"):
 * which alerts it gets, and how. No stored row means the default below, and
 * so does a server whose database doesn't have the table yet — every alert on,
 * as before VD28.
 *
 * GET /api/vendor/notification-prefs
 * PUT /api/vendor/notification-prefs  { changes: [{ topic, channel, enabled }] }
 *
 * What each choice does today:
 * - new_order/sound and new_order/popup: read by the vendor app (new_order_alert.dart).
 * - new_order/whatsapp: the shop_new_order WhatsApp alert (whatsappEvents.dispatch) is skipped when off.
 * - Payouts, reviews, questions, low stock: always shown in the app; WhatsApp
 *   for them isn't built yet, so the choice is stored for when it is.
 */

const CHANNELS = {
  sound: 'Sound and vibration',
  popup: 'Pop-up in the app',
  in_app: 'In the app',
  whatsapp: 'WhatsApp',
};
const TOPICS = [
  {
    topic: 'new_order',
    label: 'New orders',
    description: 'When a customer places an order with your shop.',
    channels: { sound: true, popup: true, whatsapp: true },
    locked: [],
    soon: [],
  },
  {
    topic: 'payout',
    label: 'Payouts',
    description: 'When a weekly settlement is ready, paid, held or fails.',
    channels: { in_app: true, whatsapp: true },
    locked: ['in_app'],
    soon: ['whatsapp'],
  },
  {
    topic: 'review',
    label: 'Reviews',
    description: 'When a customer rates your shop or a product.',
    channels: { in_app: true, whatsapp: true },
    locked: ['in_app'],
    soon: ['whatsapp'],
  },
  {
    topic: 'question',
    label: 'Customer questions',
    description: 'When someone asks about stock, options or bulk prices.',
    channels: { in_app: true, whatsapp: true },
    locked: ['in_app'],
    soon: ['whatsapp'],
  },
  {
    topic: 'low_stock',
    label: 'Low stock',
    description: 'When a product is running out or has run out.',
    channels: { in_app: true, whatsapp: true },
    locked: ['in_app'],
    soon: ['whatsapp'],
  },
];
const BY_TOPIC = Object.fromEntries(TOPICS.map((t) => [t.topic, t]));
const MAX_CHANGES = 20;

// Postgres "undefined_table": the VD28 migration hasn't run on this database.
const NO_TABLE = '42P01';

/** The shop's stored choices as "topic/channel" → enabled; null when the table isn't there. */
async function stored(vendorId) {
  try {
    const { rows } = await pool.query('SELECT topic, channel, enabled FROM vendor_notification_prefs WHERE vendor_id = $1', [vendorId]);
    return new Map(rows.map((r) => [`${r.topic}/${r.channel}`, r.enabled]));
  } catch (err) {
    if (err.code === NO_TABLE) return null;
    throw err;
  }
}

async function view(vendorId) {
  const { rows: wa } = await pool.query(
    `SELECT (SELECT enabled FROM whatsapp_event_rules WHERE event = 'shop_new_order') AS rule_on,
            u.whatsapp_opt_out_at IS NOT NULL AS stopped,
            COALESCE(NULLIF(u.whatsapp_phone, ''), NULLIF(u.phone_number, '')) IS NOT NULL AS has_phone
     FROM vendor_profiles vp JOIN users u ON u.id = vp.user_id WHERE vp.id = $1`,
    [vendorId]
  );
  // Last: on a database without the table this read fails, and nothing may follow it in a transaction.
  const saved = await stored(vendorId);
  const w = wa[0] ?? {};
  return {
    // false: the database has no table yet — every alert is on and can't be changed.
    vendorId,
    canSave: saved != null,
    topics: TOPICS.map((t) => ({
      topic: t.topic,
      label: t.label,
      description: t.description,
      channels: Object.entries(t.channels).map(([channel, def]) => ({
        channel,
        label: CHANNELS[channel],
        locked: t.locked.includes(channel),
        comingSoon: t.soon.includes(channel),
        enabled: saved?.get(`${t.topic}/${channel}`) ?? def,
      })),
    })),
    whatsapp: {
      // Gloaro Mart switches the shop alert on in Admin → WhatsApp.
      orderAlertsLive: w.rule_on === true,
      stopped: w.stopped === true,
      hasPhone: w.has_phone === true,
    },
  };
}

async function getPrefs(req, res) {
  res.json(await view(req.vendorId));
}

async function updatePrefs(req, res) {
  const changes = req.body?.changes;
  if (!Array.isArray(changes) || changes.length === 0) return res.status(400).json({ message: 'Send changes: [{ topic, channel, enabled }].' });
  if (changes.length > MAX_CHANGES) return res.status(400).json({ message: `At most ${MAX_CHANGES} changes at once.` });
  for (const c of changes) {
    const t = BY_TOPIC[c?.topic];
    if (!t) return res.status(400).json({ message: `topic is one of ${TOPICS.map((x) => x.topic).join(', ')}.` });
    if (!(c.channel in t.channels)) return res.status(400).json({ message: `channel for ${t.topic} is one of ${Object.keys(t.channels).join(', ')}.` });
    if (typeof c.enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be true or false.' });
    if (!c.enabled && t.locked.includes(c.channel)) return res.status(400).json({ message: `${t.label} always show in the app.` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      await client.query(
        `INSERT INTO vendor_notification_prefs (vendor_id, topic, channel, enabled, updated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vendor_id, topic, channel) DO UPDATE SET enabled = $4, updated_by = $5, updated_at = now()`,
        [req.vendorId, c.topic, c.channel, c.enabled, req.user?.id ?? null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === NO_TABLE) return res.status(503).json({ message: 'Notification settings need a server update. Every alert stays on until then.' });
    throw err;
  } finally {
    client.release();
  }
  res.json(await view(req.vendorId));
}

/**
 * Does the shop that owns [orderId] want [topic] on [channel]? Its stored
 * choice, else the default. Anything unknown — no table, no row, a failed
 * read — means yes, so an alert is never lost to a settings problem.
 */
async function shopAllows(db, orderId, topic, channel) {
  const def = BY_TOPIC[topic]?.channels[channel] ?? true;
  try {
    const { rows } = await db.query(
      `SELECT np.enabled FROM vendor_notification_prefs np JOIN orders o ON o.vendor_id = np.vendor_id
       WHERE o.id = $1 AND np.topic = $2 AND np.channel = $3`,
      [orderId, topic, channel]
    );
    return rows.length ? rows[0].enabled : def;
  } catch {
    return true;
  }
}

module.exports = { TOPICS, getPrefs, updatePrefs, shopAllows };
