const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../middleware/auth');
const { normalizePhone } = require('./whatsapp');

/**
 * The Gloaro bot's way in (schema PHASE 50). A service key proves the caller
 * is the bot; the WhatsApp number says which customer it's acting for. The
 * bot gets a short customer login and from there uses the app's own APIs, so
 * every rule — stock, MOQ, delivery area, coupons — is the same for an order
 * placed on WhatsApp as in the app.
 */

const SESSION_MINUTES = 60;
const SALES_CHANNEL = 'whatsapp_bot';

class BotError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

/** A new key. The full key is returned once and never stored. */
async function createKey({ name, userId }) {
  const label = typeof name === 'string' ? name.trim() : '';
  if (!label || label.length > 80) throw new BotError(400, 'Give the key a name (up to 80 characters), e.g. "Gloaro bot — production".');
  const key = `gmb_${crypto.randomBytes(24).toString('base64url')}`;
  const { rows } = await pool.query(
    'INSERT INTO bot_api_keys (name, key_prefix, key_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
    [label, key.slice(0, 12), hash(key), userId]
  );
  await ensureSalesChannel(userId);
  return { row: rows[0], key };
}

async function revokeKey({ id, userId }) {
  const { rows } = await pool.query(
    'UPDATE bot_api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *',
    [Number(id), userId]
  );
  if (!rows[0]) throw new BotError(404, 'No active key with that id.');
  return rows[0];
}

/** The key's row when it's valid and not revoked; records that it was used. */
async function verifyKey(key) {
  if (typeof key !== 'string' || !key.startsWith('gmb_')) return null;
  const { rows } = await pool.query(
    'UPDATE bot_api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, name',
    [hash(key)]
  );
  return rows[0] ?? null;
}

/**
 * The "WhatsApp bot" sales channel, so orders the bot places are attributed
 * to it (checkout reads X-Sales-Channel). Made with the first key.
 */
async function ensureSalesChannel(userId = null) {
  const { rows: cat } = await pool.query("SELECT id FROM platform_categories WHERE slug = 'sales_channels'");
  if (!cat[0]) return;
  await pool.query(
    `INSERT INTO platforms (category_id, slug, name, description, integration_method, status, capabilities, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, 'WhatsApp bot', 'Orders placed through the Gloaro WhatsApp bot.', 'api', 'active', '["orders"]'::jsonb, $3, $3)
     ON CONFLICT (slug) DO NOTHING`,
    [cat[0].id, SALES_CHANNEL, userId]
  );
}

/** How a number is stored on a new account: 10 digits for India, +digits otherwise. */
const storedForm = (digits) => (digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : `+${digits}`);

/**
 * The customer account for a WhatsApp number:
 *  1. one already linked to it;
 *  2. else a customer whose phone is the same number (written any way) — the
 *     most recently active, when two share it — which is then linked;
 *  3. else a new customer account.
 * Staff and vendor accounts are never used: a shop owner ordering on WhatsApp
 * gets a customer account of their own.
 */
async function resolveCustomer({ phone, name }) {
  const digits = normalizePhone(phone);
  if (!digits) throw new BotError(400, 'phone must be a WhatsApp number with country code, e.g. 919876543210.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Two messages from a new number at once must not make two accounts.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wa:${digits}`]);
    let { rows } = await client.query("SELECT * FROM users WHERE whatsapp_phone = $1 AND role = 'customer'", [digits]);
    let user = rows[0];
    let isNew = false;
    if (!user) {
      const last10 = digits.slice(-10);
      ({ rows } = await client.query(
        `SELECT u.* FROM users u
         WHERE u.role = 'customer' AND u.whatsapp_phone IS NULL
           AND right(regexp_replace(COALESCE(u.phone_number, ''), '\\D', '', 'g'), 10) = $1
         ORDER BY GREATEST(u.created_at, (SELECT MAX(o.created_at) FROM orders o WHERE o.user_id = u.id)) DESC NULLS LAST, u.id DESC
         LIMIT 1`,
        [last10]
      ));
      user = rows[0];
      if (user) {
        await client.query('UPDATE users SET whatsapp_phone = $2 WHERE id = $1', [user.id, digits]);
      } else {
        const displayName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null;
        // No password and no real email: this account signs in through WhatsApp
        // until the customer sets them up in the app.
        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
        ({ rows } = await client.query(
          `INSERT INTO users (full_name, email, phone_number, password_hash, role, whatsapp_phone)
           VALUES ($1, $2, $3, $4, 'customer', $5) RETURNING *`,
          [displayName, `wa${digits}@whatsapp.gloaromart.invalid`, storedForm(digits), passwordHash, digits]
        ));
        user = rows[0];
        isNew = true;
      }
    }
    // Writing to the business number is consent to hear back about what they
    // order there — unless they said STOP, which only START undoes.
    if (!user.whatsapp_opt_in && !user.whatsapp_opt_out_at) {
      ({ rows } = await client.query(
        'UPDATE users SET whatsapp_opt_in = TRUE, whatsapp_opt_in_at = now() WHERE id = $1 RETURNING *',
        [user.id]
      ));
      user = rows[0];
    }
    await client.query('COMMIT');
    return { user, isNew, phone: digits };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A customer login for the bot to use on the app's APIs. */
async function openSession({ phone, name }) {
  const { user, isNew, phone: digits } = await resolveCustomer({ phone, name });
  const token = jwt.sign(
    { id: user.id, email: user.email, role: 'customer', tokenVersion: user.token_version, via: 'whatsapp_bot' },
    JWT_SECRET,
    { expiresIn: `${SESSION_MINUTES}m` }
  );
  return {
    token,
    expiresAt: new Date(Date.now() + SESSION_MINUTES * 60000).toISOString(),
    salesChannel: SALES_CHANNEL,
    customer: {
      id: user.id,
      name: user.full_name,
      phone: digits,
      isNew,
      whatsappOptIn: user.whatsapp_opt_in,
    },
  };
}

/** STOP and START from the chat. STOP stops every automatic WhatsApp message to the number. */
async function setOptIn({ phone, optIn }) {
  const { user } = await resolveCustomer({ phone });
  const { rows } = await pool.query(
    optIn
      ? 'UPDATE users SET whatsapp_opt_in = TRUE, whatsapp_opt_in_at = now(), whatsapp_opt_out_at = NULL WHERE id = $1 RETURNING whatsapp_opt_in'
      : 'UPDATE users SET whatsapp_opt_in = FALSE, whatsapp_opt_out_at = now() WHERE id = $1 RETURNING whatsapp_opt_in',
    [user.id]
  );
  return { customerId: user.id, whatsappOptIn: rows[0].whatsapp_opt_in };
}

module.exports = { BotError, SALES_CHANNEL, SESSION_MINUTES, createKey, revokeKey, verifyKey, ensureSalesChannel, resolveCustomer, openSession, setOptIn };
