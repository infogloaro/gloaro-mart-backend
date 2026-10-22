/**
 * Notification preferences (SB8, schema "NOTIFICATION PREFERENCES"): which
 * topics a customer hears about, on which channel. No stored row means the
 * topic's default below. Push is stored now and used once push exists (P6);
 * WhatsApp consent stays with the bot (users.whatsapp_opt_in, START / STOP).
 */
const pool = require('../config/db');

const TOPICS = [
  {
    topic: 'order_updates',
    label: 'Order updates',
    description: 'Confirmations, delivery, returns and refunds.',
    defaults: { in_app: true, push: true },
    locked: ['in_app'],
    comingSoon: false,
  },
  {
    topic: 'shop_offers',
    label: 'Offers from shops you follow',
    description: 'A new offer from a followed shop you asked to hear from.',
    defaults: { in_app: true, push: false },
    locked: [],
    comingSoon: false,
  },
  {
    topic: 'price_drops',
    label: 'Price drops',
    description: 'When something you saved gets cheaper.',
    defaults: { in_app: false, push: false },
    locked: [],
    comingSoon: true,
  },
];
const CHANNELS = [
  { channel: 'in_app', label: 'In the app', available: true },
  { channel: 'push', label: 'Phone notifications', available: false },
];
const BY_TOPIC = Object.fromEntries(TOPICS.map((t) => [t.topic, t]));
const CHANNEL_KEYS = CHANNELS.map((c) => c.channel);
const MAX_CHANGES = 10;

class PrefsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** SQL: does the user [userExpr] want [topic] on [channel]? (stored choice, else the default) */
function wantsSql(userExpr, topic, channel) {
  const fallback = BY_TOPIC[topic].defaults[channel] ? 'true' : 'false';
  return `COALESCE((SELECT np.enabled FROM notification_preferences np
                    WHERE np.user_id = ${userExpr} AND np.topic = '${topic}' AND np.channel = '${channel}'), ${fallback})`;
}

/** Every topic with its channels, as the customer's settings screen shows them. */
async function get(userId) {
  const [{ rows }, { rows: user }] = await Promise.all([
    pool.query('SELECT topic, channel, enabled, consent_at FROM notification_preferences WHERE user_id = $1', [userId]),
    pool.query('SELECT whatsapp_opt_in FROM users WHERE id = $1', [userId]),
  ]);
  const saved = new Map(rows.map((r) => [`${r.topic}/${r.channel}`, r]));
  return {
    topics: TOPICS.map((t) => ({
      topic: t.topic,
      label: t.label,
      description: t.description,
      comingSoon: t.comingSoon,
      channels: CHANNELS.map((c) => {
        const row = saved.get(`${t.topic}/${c.channel}`);
        return {
          channel: c.channel,
          label: c.label,
          available: c.available,
          locked: t.locked.includes(c.channel),
          enabled: row ? row.enabled : t.defaults[c.channel],
          consentAt: row?.consent_at ?? null,
        };
      }),
    })),
    whatsapp: {
      optedIn: user[0]?.whatsapp_opt_in === true,
      howTo: 'Order updates on WhatsApp: send START to our WhatsApp number to switch on, STOP to switch off.',
    },
  };
}

/**
 * Applies { changes: [{ topic, channel, enabled }] } in one go. A locked
 * channel can't be switched off. Switching on records when (consent).
 */
async function update(userId, body = {}) {
  const changes = body.changes;
  if (!Array.isArray(changes) || changes.length === 0) throw new PrefsError(400, 'Send changes: [{ topic, channel, enabled }].');
  if (changes.length > MAX_CHANGES) throw new PrefsError(400, `At most ${MAX_CHANGES} changes at once.`);
  for (const c of changes) {
    const t = BY_TOPIC[c?.topic];
    if (!t) throw new PrefsError(400, `topic is one of ${TOPICS.map((x) => x.topic).join(', ')}.`);
    if (!CHANNEL_KEYS.includes(c.channel)) throw new PrefsError(400, `channel is one of ${CHANNEL_KEYS.join(', ')}.`);
    if (typeof c.enabled !== 'boolean') throw new PrefsError(400, 'enabled must be true or false.');
    if (!c.enabled && t.locked.includes(c.channel)) {
      throw new PrefsError(400, `${t.label} in the app can't be switched off: they are how you follow your orders.`);
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of changes) {
      await client.query(
        `INSERT INTO notification_preferences (user_id, topic, channel, enabled, consent_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() END)
         ON CONFLICT (user_id, topic, channel) DO UPDATE SET
           enabled = $4,
           consent_at = CASE WHEN NOT $4 THEN NULL
                             WHEN notification_preferences.enabled THEN notification_preferences.consent_at
                             ELSE now() END,
           updated_at = now()`,
        [userId, c.topic, c.channel, c.enabled]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return get(userId);
}

module.exports = { PrefsError, TOPICS, CHANNELS, wantsSql, get, update };
