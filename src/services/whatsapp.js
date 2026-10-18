const pool = require('../config/db');
const secretBox = require('./secretBox');
const { requestJson, ProviderError } = require('../connectors/http');
const whatsappCloud = require('../connectors/whatsappCloud');
const templates = require('./whatsappTemplates');

/**
 * Sending WhatsApp messages (schema PHASE 49). Every message is a row first
 * and is sent from a queue (processQueue, run by server.js and right away for a
 * test send), so a slow or failing Meta never holds up the request that caused
 * it, and every attempt is on record.
 */

const { GRAPH } = whatsappCloud;
const CONNECTOR = 'whatsapp_cloud';
const SLUG = 'whatsapp_cloud';
// After a failure that may pass: 1 min, 5 min, 30 min; then it's failed.
const BACKOFF_SECONDS = [60, 300, 1800];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
// Meta's codes for "try again later" (rate limits, temporary trouble).
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 80007, 130429, 131000, 131016, 131056, 133004]);

class WhatsAppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The WhatsApp platform row, made on first use from the connector: Engagement
 * category, connector attached, its settings form applied. A row made before a
 * setting was added to the connector gets the missing fields too.
 */
async function ensurePlatform(db = pool, userId = null) {
  const { rows } = await db.query('SELECT * FROM platforms WHERE connector_key = $1 ORDER BY id LIMIT 1', [CONNECTOR]);
  if (rows[0]) {
    const have = new Set((rows[0].config_schema ?? []).map((f) => f.key));
    const missing = whatsappCloud.settings.filter((f) => !have.has(f.key));
    if (missing.length) {
      await db.query('UPDATE platforms SET config_schema = config_schema || $2::jsonb, updated_at = now() WHERE id = $1', [rows[0].id, JSON.stringify(missing)]);
    }
    return rows[0].id;
  }
  const { rows: cat } = await db.query("SELECT id FROM platform_categories WHERE slug = 'engagement'");
  const { rows: created } = await db.query(
    `INSERT INTO platforms (category_id, slug, name, description, integration_method, connector_key, status, capabilities,
       config_schema, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, 'WhatsApp', $3, 'connector', $4, 'inactive', $5, $6, $7, $7)
     ON CONFLICT (slug) DO UPDATE SET connector_key = EXCLUDED.connector_key RETURNING id`,
    [cat[0]?.id, SLUG, whatsappCloud.description, CONNECTOR, JSON.stringify(whatsappCloud.capabilities),
      JSON.stringify(whatsappCloud.settings), userId]
  );
  return created[0].id;
}

/** The saved settings of the environment in use, secrets opened. Null when WhatsApp isn't set up. */
async function loadConnection(db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.status, p.environment, pc.config, pc.secrets_encrypted, pc.status AS connection_status,
            pc.last_tested_at, pc.last_error
     FROM platforms p LEFT JOIN platform_connections pc ON pc.platform_id = p.id AND pc.environment = p.environment
     WHERE p.connector_key = $1 ORDER BY p.id LIMIT 1`,
    [CONNECTOR]
  );
  const p = rows[0];
  if (!p) return null;
  let secrets = {};
  try {
    secrets = secretBox.open(p.secrets_encrypted);
  } catch {
    secrets = {};
  }
  return {
    platformId: p.id, platformStatus: p.status, environment: p.environment, config: p.config ?? {}, secrets,
    connectionStatus: p.connection_status ?? 'not_connected', lastTestedAt: p.last_tested_at, lastError: p.last_error,
  };
}

/** Ready to send: settings saved and the connection test passed for the environment in use. */
function assertReady(conn) {
  if (!conn) throw new WhatsAppError(409, 'WhatsApp is not set up yet — open Channels → WhatsApp.');
  if (!conn.config.phone_number_id || !conn.secrets.access_token) throw new WhatsAppError(409, 'Save the phone number ID and access token first.');
  if (conn.connectionStatus !== 'connected') throw new WhatsAppError(409, 'Test the WhatsApp connection first — it has not passed yet.');
  return conn;
}

/**
 * A number in the form Meta wants: digits with the country code. A 10-digit
 * Indian mobile gets 91 in front. Returns null when it can't be a phone number.
 */
function normalizePhone(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  let digits = raw.replace(/[^\d]/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);
  if (!raw.startsWith('+') && !raw.startsWith('00')) {
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10 && /^[6-9]/.test(digits)) digits = `91${digits}`;
  }
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.startsWith('91') && digits.length !== 12) return null;
  return digits;
}

/**
 * Puts a message on the queue. A template message must name an approved
 * template and give exactly its variables; a text message is free-form, which
 * Meta only delivers inside 24 hours of the person's last message.
 */
async function enqueue(db, {
  phone, userId = null, template = null, variables = [], buttonParam = null, text = null, event = null, createdBy = null,
  // Automatic messages: one per dedupeKey; a second enqueue of the same key returns null.
  dedupeKey = null, orderId = null, groupId = null,
}) {
  const to = normalizePhone(phone);
  if (!to) throw new WhatsAppError(400, 'Enter a WhatsApp number with country code, e.g. +91 98765 43210.');
  if (template) {
    if (template.status !== 'approved') throw new WhatsAppError(409, `The template ${template.name} is ${template.status}, not approved by Meta yet.`);
    const needed = templates.variablesIn(template.body_text).length;
    const vars = (Array.isArray(variables) ? variables : []).map((v) => String(v ?? '').trim());
    if (vars.length !== needed || vars.some((v) => !v)) throw new WhatsAppError(400, `The template ${template.name} needs ${needed} value(s).`);
    if (vars.some((v) => v.length > 1024 || /[\n\t]| {5,}/.test(v))) throw new WhatsAppError(400, 'Values are one line, without tabs or long runs of spaces (a Meta rule).');
    const dynamic = (template.buttons ?? []).some((b) => b.type === 'URL' && /\{\{1\}\}$/.test(b.url));
    if (dynamic && !buttonParam) throw new WhatsAppError(400, 'This template has a link button — give the end of the link.');
    const { rows } = await db.query(
      `INSERT INTO whatsapp_messages (direction, phone, user_id, kind, template_id, template_name, language, variables, button_param, body, event, created_by,
         dedupe_key, order_id, checkout_group_id)
       VALUES ('out', $1, $2, 'template', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
      [to, userId, template.id, template.name, template.language, JSON.stringify(vars), dynamic ? String(buttonParam) : null,
        templates.render(template.body_text, vars), event, createdBy, dedupeKey, orderId, groupId]
    );
    return rows[0] ?? null;
  }
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body || body.length > 4096) throw new WhatsAppError(400, 'Write a message of up to 4096 characters.');
  const { rows } = await db.query(
    `INSERT INTO whatsapp_messages (direction, phone, user_id, kind, body, event, created_by)
     VALUES ('out', $1, $2, 'text', $3, $4, $5) RETURNING *`,
    [to, userId, body, event, createdBy]
  );
  return rows[0];
}

function payloadFor(m) {
  if (m.kind === 'text') return { messaging_product: 'whatsapp', to: m.phone, type: 'text', text: { body: m.body, preview_url: false } };
  const components = [];
  const vars = m.variables ?? [];
  if (vars.length) components.push({ type: 'body', parameters: vars.map((text) => ({ type: 'text', text })) });
  if (m.button_param) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: m.button_param }] });
  return {
    messaging_product: 'whatsapp', to: m.phone, type: 'template',
    template: { name: m.template_name, language: { code: m.language }, ...(components.length ? { components } : {}) },
  };
}

/** One send attempt. Returns what to write back to the row. */
async function attempt(conn, m) {
  try {
    const { status, data } = await requestJson(`${GRAPH}/${encodeURIComponent(String(conn.config.phone_number_id))}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.secrets.access_token}` },
      body: payloadFor(m),
      retries: 1,
    });
    if (status === 200 && data?.messages?.[0]?.id) return { ok: true, metaId: String(data.messages[0].id) };
    const e = data?.error ?? {};
    const code = e.code != null ? String(e.code) : String(status);
    const message = e.error_data?.details || e.error_user_msg || e.message || `Meta answered HTTP ${status}`;
    const retryable = status === 429 || status >= 500 || RETRYABLE_CODES.has(Number(e.code));
    return { ok: false, code, message: String(message).slice(0, 500), retryable };
  } catch (err) {
    if (err instanceof ProviderError) return { ok: false, code: 'network', message: err.message, retryable: true };
    throw err;
  }
}

/**
 * Sends what's due. Rows are claimed with SKIP LOCKED, so two servers never
 * send the same one; a claimed row that's never finished (a crash) comes back
 * after two minutes. `ids` sends just those (a test send), whatever their time.
 */
async function processQueue({ limit = 20, ids = null } = {}) {
  const { rows: claimed } = await pool.query(
    `UPDATE whatsapp_messages SET status = 'sending', attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
     WHERE id IN (
       SELECT id FROM whatsapp_messages
       WHERE direction = 'out' AND status IN ('queued', 'sending') AND ($2::bigint[] IS NOT NULL AND id = ANY($2) OR $2::bigint[] IS NULL AND next_attempt_at <= now())
       ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [limit, ids]
  );
  if (claimed.length === 0) return { sent: 0, failed: 0, retrying: 0 };
  const conn = await loadConnection();
  let notReady = null;
  try {
    assertReady(conn);
  } catch (err) {
    notReady = err.message;
  }
  const out = { sent: 0, failed: 0, retrying: 0 };
  for (const m of claimed) {
    const r = notReady ? { ok: false, code: 'not_ready', message: notReady, retryable: true } : await attempt(conn, m);
    if (r.ok) {
      await pool.query(
        "UPDATE whatsapp_messages SET status = 'sent', meta_message_id = $2, sent_at = now(), environment = $3, error_code = NULL, error_message = NULL WHERE id = $1",
        [m.id, r.metaId, conn.environment]
      );
      out.sent += 1;
    } else if (r.retryable && m.attempts < MAX_ATTEMPTS) {
      await pool.query(
        "UPDATE whatsapp_messages SET status = 'queued', next_attempt_at = now() + make_interval(secs => $2), error_code = $3, error_message = $4 WHERE id = $1",
        [m.id, BACKOFF_SECONDS[m.attempts - 1], r.code, r.message]
      );
      out.retrying += 1;
    } else {
      await pool.query(
        "UPDATE whatsapp_messages SET status = 'failed', failed_at = now(), error_code = $2, error_message = $3, environment = $4 WHERE id = $1",
        [m.id, r.code, r.message, conn?.environment ?? null]
      );
      out.failed += 1;
    }
  }
  return out;
}

/** A failed message, back on the queue as if new. */
async function retry(id) {
  const { rows } = await pool.query(
    `UPDATE whatsapp_messages SET status = 'queued', attempts = 0, next_attempt_at = now(), failed_at = NULL
     WHERE id = $1 AND direction = 'out' AND status = 'failed' RETURNING *`,
    [Number(id)]
  );
  if (!rows[0]) throw new WhatsAppError(409, 'Only a failed message can be sent again.');
  return rows[0];
}

// A status only ever moves forward: a late "delivered" never undoes "read".
const STATUS_RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5 };

/**
 * Delivery and read receipts from Meta's webhook — sent to us directly, or
 * forwarded unchanged by the Gloaro bot, which owns the webhook. Receipts for
 * messages we didn't send (the bot's own) are ignored. Returns how many rows changed.
 */
async function applyStatuses(body) {
  let changed = 0;
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const s of change?.value?.statuses ?? []) {
        if (!s?.id || !(s.status in STATUS_RANK)) continue;
        const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
        const err = s.errors?.[0];
        const { rowCount } = await pool.query(
          `UPDATE whatsapp_messages SET
             status = $2::varchar,
             delivered_at = CASE WHEN $2::varchar IN ('delivered', 'read') THEN COALESCE(delivered_at, $3::timestamptz) ELSE delivered_at END,
             read_at = CASE WHEN $2::varchar = 'read' THEN COALESCE(read_at, $3::timestamptz) ELSE read_at END,
             failed_at = CASE WHEN $2::varchar = 'failed' THEN $3::timestamptz ELSE failed_at END,
             error_code = CASE WHEN $2::varchar = 'failed' THEN $4::text ELSE error_code END,
             error_message = CASE WHEN $2::varchar = 'failed' THEN $5::text ELSE error_message END
           WHERE meta_message_id = $1 AND direction = 'out'
             AND (CASE status WHEN 'queued' THEN 0 WHEN 'sending' THEN 1 WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 ELSE 5 END) < $6`,
          [String(s.id), s.status, at, err?.code != null ? String(err.code) : null,
            err ? String(err.error_data?.details || err.message || err.title || 'Failed').slice(0, 500) : null, STATUS_RANK[s.status]]
        );
        changed += rowCount;
      }
    }
  }
  return changed;
}

module.exports = {
  WhatsAppError, SLUG, MAX_ATTEMPTS, ensurePlatform, loadConnection, assertReady, normalizePhone, enqueue, processQueue, retry, applyStatuses,
};
