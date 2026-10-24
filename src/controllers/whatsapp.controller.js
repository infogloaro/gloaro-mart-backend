const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const { ProviderError } = require('../connectors/http');
const whatsapp = require('../services/whatsapp');
const templates = require('../services/whatsappTemplates');
const botAccess = require('../services/botAccess');
const events = require('../services/whatsappEvents');
const { PLATFORM_SELECT, toPlatformJson } = require('./platformRegistry.controller');

/**
 * Admin → Channels (every channel, WhatsApp the first one live) and
 * Admin → WhatsApp: templates, the message log and test sends.
 * Plan: docs/whatsapp-plan.md.
 */

const PAGE_SIZE = 25;
const fail = (res, err) => {
  if (err instanceof whatsapp.WhatsAppError || err instanceof templates.TemplateError) return res.status(err.status).json({ message: err.message });
  if (err instanceof ProviderError) return res.status(502).json({ message: err.message });
  throw err;
};
const audit = (req, action, entityType, entityId, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: 'channels', entityType, entityId, newValue });

// ------------------------------------------------------------------ channels

/**
 * Every channel the admin will manage, grouped as in the Settings plan.
 * status: 'available' (set up here), 'built_in' (works without a provider),
 * 'coming_soon'.
 */
const CHANNELS = [
  ['communication', 'whatsapp', 'WhatsApp', 'Order updates, shop alerts and customer chat through Meta’s Cloud API.', 'available'],
  ['communication', 'email', 'Email', 'Password resets and admin OTPs, sent through Resend (set on the server).', 'built_in'],
  ['communication', 'sms', 'SMS', 'Transactional SMS with DLT templates (MSG91, Twilio, Gupshup).', 'coming_soon'],
  ['communication', 'voice', 'Voice & masked calling', 'Calls between customers and delivery partners without sharing numbers (Exotel).', 'coming_soon'],
  ['communication', 'support_chat', 'Support tickets', 'Customer and shop tickets inside the app.', 'built_in'],
  ['verification', 'phone_otp', 'Phone OTP login', 'Sign in with a one-time code by SMS or WhatsApp.', 'coming_soon'],
  ['verification', 'email_otp', 'Email OTP', 'Admin password changes and password reset links.', 'built_in'],
  ['verification', 'social_login', 'Google / Apple sign-in', 'One-tap sign-in in the app.', 'coming_soon'],
  ['verification', 'gst_check', 'GSTIN check', 'Check digit on every GSTIN; live GST lookup to come.', 'built_in'],
  ['verification', 'pan_check', 'PAN verification', 'Shop PAN checked against NSDL.', 'coming_soon'],
  ['verification', 'aadhaar', 'Aadhaar / DigiLocker', 'Identity documents for shops and delivery partners.', 'coming_soon'],
  ['verification', 'bank_check', 'Bank account verification', 'Penny-drop check before a shop is paid.', 'coming_soon'],
  ['notification', 'in_app', 'In-app notifications', 'The notification inbox in the app and vendor portal.', 'built_in'],
  ['notification', 'push', 'Push notifications', 'Firebase Cloud Messaging for Android and iOS.', 'coming_soon'],
  ['notification', 'event_rules', 'Event rules', 'Choose which channels each event goes to.', 'coming_soon'],
  ['notification', 'admin_alerts', 'Admin alerts', 'Failed payments, disputes and SLA breaches to the team.', 'coming_soon'],
  ['marketing', 'campaigns', 'Campaigns, coupons & banners', 'Promotions managed in this panel.', 'built_in'],
  ['marketing', 'broadcasts', 'Broadcasts', 'Opt-in WhatsApp, SMS and email campaigns to customer segments.', 'coming_soon'],
  ['marketing', 'ads_pixels', 'Ads pixels', 'Meta Pixel, Google Ads and GA4 conversion tracking.', 'coming_soon'],
  ['marketing', 'product_feeds', 'Product feeds', 'Google Merchant Center and Meta catalogue.', 'coming_soon'],
  ['integration', 'payments', 'Payment gateway', 'Razorpay, Cashfree or PhonePe at checkout.', 'coming_soon'],
  ['integration', 'payouts', 'Vendor payouts', 'Pay settlements straight to shop bank accounts.', 'coming_soon'],
  ['integration', 'shipping', 'Shipping partners', 'Shiprocket, Delhivery and others.', 'coming_soon'],
  ['integration', 'maps', 'Maps', 'Google Maps or Mappls for addresses and distance.', 'coming_soon'],
  ['integration', 'einvoice', 'e-Invoice & e-Way bill', 'GST IRP through a GSP.', 'coming_soon'],
  ['integration', 'accounting', 'Accounting', 'Tally or Zoho Books.', 'coming_soon'],
].map(([group, key, name, description, status]) => ({ group, key, name, description, status }));

async function platformJson(id) {
  const { rows } = await pool.query(`${PLATFORM_SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? toPlatformJson(rows[0]) : null;
}

/** Each provider, set up or not, for the switch on the WhatsApp card. */
async function providerList(current) {
  return Promise.all(
    Object.entries(whatsapp.PROVIDERS).map(async ([key, p]) => {
      const conn = await whatsapp.loadConnection(pool, key);
      return {
        key,
        label: p.label,
        needsApproval: p.needsApproval,
        inUse: key === current,
        setUp: Boolean(conn),
        connectionStatus: conn?.connectionStatus ?? null,
        platformStatus: conn?.platformStatus ?? null,
      };
    })
  );
}

async function whatsappOverview() {
  const provider = await whatsapp.currentProvider();
  const providers = await providerList(provider);
  const needsApproval = whatsapp.PROVIDERS[provider].needsApproval;
  const conn = await whatsapp.loadConnection(pool, provider);
  if (!conn) return { provider, providers, needsApproval, setUp: false, platform: null, ready: false };
  const [{ rows: t }, { rows: m }] = await Promise.all([
    pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                       COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts, COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
                FROM whatsapp_templates`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status IN ('sent', 'delivered', 'read'))::int AS sent,
                       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed, COUNT(*) FILTER (WHERE status IN ('queued', 'sending'))::int AS queued
                FROM whatsapp_messages WHERE direction = 'out' AND created_at > now() - interval '24 hours'`),
  ]);
  let ready = true;
  try {
    whatsapp.assertReady(conn);
  } catch {
    ready = false;
  }
  return {
    provider,
    providers,
    needsApproval,
    setUp: true,
    platform: await platformJson(conn.platformId),
    ready,
    environment: conn.environment,
    connectionStatus: conn.connectionStatus,
    lastTestedAt: conn.lastTestedAt,
    lastError: conn.lastError,
    templates: t[0],
    last24h: m[0],
  };
}

async function listChannels(req, res) {
  res.json({ whatsapp: await whatsappOverview(), channels: CHANNELS });
}

/** Creates the platform of the provider in use (once), so its settings can be entered. */
async function setupWhatsapp(req, res) {
  const provider = await whatsapp.currentProvider();
  const before = await whatsapp.loadConnection(pool, provider);
  const id = await whatsapp.ensurePlatform(pool, req.user.id, provider);
  if (!before) await audit(req, 'channel.whatsapp_set_up', 'platform', id, { provider });
  res.json(await whatsappOverview());
}

/**
 * Picks who sends WhatsApp messages: { provider: 'whatsapp_cloud' | 'ultramsg' }.
 * Messages already queued go out through the new one.
 */
async function setWhatsappProvider(req, res) {
  try {
    const before = await whatsapp.currentProvider();
    const provider = await whatsapp.setProvider(req.body?.provider);
    await whatsapp.ensurePlatform(pool, req.user.id, provider);
    if (before !== provider) await audit(req, 'channel.whatsapp_provider_changed', 'platform_settings', 1, { from: before, to: provider });
    res.json(await whatsappOverview());
  } catch (err) {
    fail(res, err);
  }
}

// ----------------------------------------------------------------- templates

function templateJson(t) {
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    headerText: t.header_text,
    bodyText: t.body_text,
    footerText: t.footer_text,
    buttons: t.buttons ?? [],
    bodyExamples: t.body_examples ?? [],
    variableCount: templates.variablesIn(t.body_text).length,
    preview: templates.render(t.body_text, t.body_examples ?? []),
    status: t.status,
    metaTemplateId: t.meta_template_id,
    rejectedReason: t.rejected_reason,
    purpose: t.purpose,
    submittedAt: t.submitted_at,
    lastSyncedAt: t.last_synced_at,
    updatedAt: t.updated_at,
  };
}

async function listTemplates(req, res) {
  const params = [];
  let where = '';
  if (req.query.status) {
    params.push(req.query.status);
    where = 'WHERE status = $1';
  }
  const { rows } = await pool.query(`SELECT * FROM whatsapp_templates ${where} ORDER BY (status = 'approved') DESC, name, language`, params);
  res.json({ items: rows.map(templateJson), languages: templates.LANGUAGES, categories: templates.CATEGORIES });
}

async function loadTemplate(id) {
  const { rows } = await pool.query('SELECT * FROM whatsapp_templates WHERE id = $1', [Number(id)]);
  if (!rows[0]) throw new templates.TemplateError(404, 'Template not found');
  return rows[0];
}

async function createTemplate(req, res) {
  try {
    const { errors, template: t } = templates.validate(req.body ?? {});
    if (errors.length) return res.status(400).json({ message: errors.join('. '), errors });
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_templates (name, language, category, header_text, body_text, footer_text, buttons, body_examples, purpose, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (name, language) DO NOTHING RETURNING *`,
      [t.name, t.language, t.category, t.header_text, t.body_text, t.footer_text, JSON.stringify(t.buttons), JSON.stringify(t.body_examples), t.purpose, req.user.id]
    );
    if (!rows[0]) return res.status(409).json({ message: `A template named ${t.name} in ${t.language} already exists.` });
    await audit(req, 'whatsapp.template_created', 'whatsapp_template', rows[0].id, { name: t.name, language: t.language });
    res.status(201).json(templateJson(rows[0]));
  } catch (err) {
    fail(res, err);
  }
}

/** Drafts and rejected ones can be edited; approved ones are what Meta signed off, so they stay as they are. */
async function updateTemplate(req, res) {
  try {
    const existing = await loadTemplate(req.params.id);
    if (!['draft', 'rejected', 'paused'].includes(existing.status)) {
      return res.status(409).json({ message: `This template is ${existing.status}; make a new one to change the wording.` });
    }
    const renamed = (req.body?.name ?? existing.name) !== existing.name || (req.body?.language ?? existing.language) !== existing.language;
    if (existing.meta_template_id && renamed) {
      return res.status(409).json({ message: 'Meta already has this template, so its name and language are fixed.' });
    }
    const { errors, template: t } = templates.validate(req.body ?? {}, { partial: true, existing });
    if (errors.length) return res.status(400).json({ message: errors.join('. '), errors });
    const { rows } = await pool.query(
      `UPDATE whatsapp_templates SET name = $2, language = $3, category = $4, header_text = $5, body_text = $6, footer_text = $7,
         buttons = $8, body_examples = $9, purpose = $10, status = CASE WHEN meta_template_id IS NULL THEN 'draft' ELSE status END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [existing.id, t.name, t.language, t.category, t.header_text, t.body_text, t.footer_text, JSON.stringify(t.buttons), JSON.stringify(t.body_examples), t.purpose]
    );
    res.json(templateJson(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'Another template already has that name and language.' });
    fail(res, err);
  }
}

async function deleteTemplate(req, res) {
  try {
    const t = await loadTemplate(req.params.id);
    if (t.meta_template_id) {
      const conn = whatsapp.assertReady(await whatsapp.loadConnection(pool, 'whatsapp_cloud'));
      await templates.removeOnMeta(conn, t);
    }
    await pool.query('DELETE FROM whatsapp_templates WHERE id = $1', [t.id]);
    await audit(req, 'whatsapp.template_deleted', 'whatsapp_template', t.id, { name: t.name, language: t.language, onMeta: Boolean(t.meta_template_id) });
    res.json({ deleted: true });
  } catch (err) {
    fail(res, err);
  }
}

async function submitTemplate(req, res) {
  try {
    const t = await loadTemplate(req.params.id);
    if (!['draft', 'rejected', 'paused'].includes(t.status)) return res.status(409).json({ message: `This template is already ${t.status}.` });
    const { errors } = templates.validate({}, { partial: true, existing: t });
    if (errors.length) return res.status(400).json({ message: errors.join('. '), errors });
    const conn = whatsapp.assertReady(await whatsapp.loadConnection(pool, 'whatsapp_cloud'));
    const r = await templates.submit(conn, t);
    const { rows } = await pool.query(
      `UPDATE whatsapp_templates SET meta_template_id = $2, status = $3, category = $4, rejected_reason = NULL, submitted_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [t.id, r.metaTemplateId, r.status, r.category]
    );
    await audit(req, 'whatsapp.template_submitted', 'whatsapp_template', t.id, { name: t.name, language: t.language, status: r.status });
    res.json(templateJson(rows[0]));
  } catch (err) {
    fail(res, err);
  }
}

async function syncTemplates(req, res) {
  try {
    const conn = whatsapp.assertReady(await whatsapp.loadConnection(pool, 'whatsapp_cloud'));
    const result = await templates.sync(conn);
    await audit(req, 'whatsapp.templates_synced', 'whatsapp_template', null, result);
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
}

// ------------------------------------------------------------------ messages

function messageJson(m) {
  return {
    id: Number(m.id),
    direction: m.direction,
    phone: m.phone,
    userId: m.user_id,
    userName: m.user_name ?? null,
    kind: m.kind,
    templateName: m.template_name,
    language: m.language,
    variables: m.variables ?? [],
    body: m.body,
    status: m.status,
    metaMessageId: m.meta_message_id,
    errorCode: m.error_code,
    errorMessage: m.error_message,
    skipReason: m.skip_reason ?? null,
    orderId: m.order_id ?? null,
    checkoutGroupId: m.checkout_group_id ?? null,
    attempts: m.attempts,
    nextAttemptAt: m.status === 'queued' ? m.next_attempt_at : null,
    event: m.event,
    environment: m.environment,
    createdAt: m.created_at,
    sentAt: m.sent_at,
    deliveredAt: m.delivered_at,
    readAt: m.read_at,
    failedAt: m.failed_at,
  };
}

const MESSAGE_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'received', 'skipped'];

async function listMessages(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const conditions = [];
  if (req.query.status) {
    if (!MESSAGE_STATUSES.includes(req.query.status)) return res.status(400).json({ message: 'Unknown status' });
    params.push(req.query.status);
    conditions.push(`m.status = $${params.length}`);
  }
  if (req.query.direction) {
    if (!['out', 'in'].includes(req.query.direction)) return res.status(400).json({ message: 'direction is out or in' });
    params.push(req.query.direction);
    conditions.push(`m.direction = $${params.length}`);
  }
  if (req.query.q) {
    const digits = String(req.query.q).replace(/\D/g, '');
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    let phoneMatch = '';
    if (digits.length >= 4) {
      params.push(`%${digits}%`);
      phoneMatch = ` OR m.phone LIKE $${params.length}`;
    }
    conditions.push(`(m.template_name ILIKE ${p} OR m.body ILIKE ${p} OR m.event ILIKE ${p}${phoneMatch})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(
      `SELECT m.*, COALESCE(u.full_name, u.email) AS user_name FROM whatsapp_messages m LEFT JOIN users u ON u.id = m.user_id
       ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM whatsapp_messages m ${where}`, params),
  ]);
  res.json({ items: rows.map(messageJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

async function retryMessage(req, res) {
  try {
    const m = await whatsapp.retry(req.params.id);
    await whatsapp.processQueue({ ids: [m.id] });
    const { rows } = await pool.query('SELECT * FROM whatsapp_messages WHERE id = $1', [m.id]);
    await audit(req, 'whatsapp.message_retried', 'whatsapp_message', m.id, { status: rows[0].status });
    res.json(messageJson(rows[0]));
  } catch (err) {
    fail(res, err);
  }
}

/**
 * Sends one message now and answers with how it went. With Meta's test number,
 * only numbers added as test recipients in the Meta app receive it.
 */
async function testSend(req, res) {
  try {
    const conn = whatsapp.assertReady(await whatsapp.loadConnection());
    const { to, templateId, variables, buttonParam, text } = req.body ?? {};
    const template = templateId != null ? await loadTemplate(templateId) : null;
    if (!template && (text == null || text === '')) return res.status(400).json({ message: 'Pick a template, or write a text message.' });
    const m = await whatsapp.enqueue(pool, {
      phone: to, template, variables, buttonParam, text: template ? null : text, event: 'test', createdBy: req.user.id, approvedOnly: conn.needsApproval,
    });
    await whatsapp.processQueue({ ids: [m.id] });
    const { rows } = await pool.query('SELECT * FROM whatsapp_messages WHERE id = $1', [m.id]);
    await audit(req, 'whatsapp.test_sent', 'whatsapp_message', m.id, { to: m.phone, template: m.template_name, status: rows[0].status });
    const sent = rows[0];
    res.status(sent.status === 'failed' ? 502 : 200).json({
      ...messageJson(sent),
      message: sent.status === 'sent' ? `Sent — ${conn.providerLabel} accepted it.` : sent.status === 'failed' ? `Not sent: ${sent.error_message}` : `Queued: ${sent.error_message ?? 'will retry'}`,
    });
  } catch (err) {
    fail(res, err);
  }
}

// ------------------------------------------------------------- event rules

async function listRules(req, res) {
  const conn = await whatsapp.loadConnection();
  let ready = true;
  try {
    whatsapp.assertReady(conn);
  } catch {
    ready = false;
  }
  res.json({
    items: await events.listRules(),
    // Automatic messages need both; the page says which one is missing.
    connected: ready,
    platformActive: conn?.platformStatus === 'active',
    provider: conn?.provider ?? (await whatsapp.currentProvider()),
    maxAgeHours: events.MAX_AGE_HOURS,
  });
}

async function updateRule(req, res) {
  try {
    const { enabled, templateName, language } = req.body ?? {};
    const row = await events.updateRule({ event: req.params.event, enabled, templateName, language, userId: req.user.id });
    await audit(req, row.enabled ? 'whatsapp.rule_enabled' : 'whatsapp.rule_disabled', 'whatsapp_event_rule', row.event, { template: row.template_name, language: row.language });
    res.json((await events.listRules()).find((r) => r.event === row.event));
  } catch (err) {
    if (err instanceof events.RuleError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
}

// --------------------------------------------------------------- bot access

const botKeyJson = (k) => ({
  id: k.id,
  name: k.name,
  prefix: k.key_prefix,
  createdAt: k.created_at,
  createdByName: k.created_by_name ?? null,
  lastUsedAt: k.last_used_at,
  revokedAt: k.revoked_at,
});

async function listBotKeys(req, res) {
  const { rows } = await pool.query(
    `SELECT k.*, COALESCE(u.full_name, u.email) AS created_by_name FROM bot_api_keys k LEFT JOIN users u ON u.id = k.created_by
     ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`
  );
  const { rows: orders } = await pool.query(
    `SELECT COUNT(DISTINCT COALESCE(o.checkout_group_id::text, 'o' || o.id))::int AS n
     FROM orders o JOIN platforms p ON p.id = o.sales_channel_id
     WHERE p.slug = $1 AND o.created_at > now() - interval '30 days'`,
    [botAccess.SALES_CHANNEL]
  );
  res.json({ items: rows.map(botKeyJson), ordersLast30Days: orders[0].n, salesChannel: botAccess.SALES_CHANNEL, sessionMinutes: botAccess.SESSION_MINUTES });
}

/** The full key is in this response only. */
async function createBotKey(req, res) {
  try {
    const { row, key } = await botAccess.createKey({ name: req.body?.name, userId: req.user.id });
    await audit(req, 'channel.bot_key_created', 'bot_api_key', row.id, { name: row.name, prefix: row.key_prefix });
    res.status(201).json({ ...botKeyJson(row), key });
  } catch (err) {
    if (err instanceof botAccess.BotError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
}

async function revokeBotKey(req, res) {
  try {
    const row = await botAccess.revokeKey({ id: req.params.id, userId: req.user.id });
    await audit(req, 'channel.bot_key_revoked', 'bot_api_key', row.id, { name: row.name, prefix: row.key_prefix });
    res.json(botKeyJson(row));
  } catch (err) {
    if (err instanceof botAccess.BotError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
}

module.exports = {
  listRules, updateRule,
  listBotKeys, createBotKey, revokeBotKey,
  CHANNELS, listChannels, setupWhatsapp, setWhatsappProvider,
  listTemplates, createTemplate, updateTemplate, deleteTemplate, submitTemplate, syncTemplates,
  listMessages, retryMessage, testSend,
};
