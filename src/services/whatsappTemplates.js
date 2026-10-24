const pool = require('../config/db');
const { requestJson } = require('../connectors/http');
const { GRAPH } = require('../connectors/whatsappCloud');

/**
 * WhatsApp message templates (schema PHASE 49): drafted in the admin, sent to
 * Meta for approval, and kept in step with what Meta says about them. Meta
 * only lets a business start a conversation with an approved template.
 */

const LANGUAGES = ['en', 'en_US', 'en_GB', 'ta', 'hi', 'te', 'kn', 'ml'];
const CATEGORIES = ['UTILITY', 'AUTHENTICATION', 'MARKETING'];
const NAME = /^[a-z0-9_]{1,512}$/;
const VAR = /\{\{(\d+)\}\}/g;

class TemplateError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The {{n}} numbers in a text, in order of first use. */
function variablesIn(text) {
  return [...new Set([...String(text ?? '').matchAll(VAR)].map((m) => Number(m[1])))];
}

/**
 * Checks a template against Meta's rules before it ever reaches Meta, so the
 * admin sees the reason here instead of a rejection a day later.
 */
function validate(input, { partial = false, existing = null } = {}) {
  const t = { ...(existing ?? {}) };
  const errors = [];
  const has = (k) => !partial || input[k] !== undefined;

  if (has('name')) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!NAME.test(name)) errors.push('name uses lowercase letters, digits and underscores only (e.g. order_placed)');
    t.name = name;
  }
  if (has('language')) {
    const language = input.language ?? 'en';
    if (!LANGUAGES.includes(language)) errors.push(`language is one of ${LANGUAGES.join(', ')}`);
    t.language = language;
  }
  if (has('category')) {
    const category = input.category ?? 'UTILITY';
    if (!CATEGORIES.includes(category)) errors.push(`category is one of ${CATEGORIES.join(', ')}`);
    t.category = category;
  }
  for (const [key, max, label] of [['header_text', 60, 'Header'], ['footer_text', 60, 'Footer']]) {
    const inKey = key === 'header_text' ? 'headerText' : 'footerText';
    if (!partial || input[inKey] !== undefined) {
      const v = typeof input[inKey] === 'string' ? input[inKey].trim() : '';
      if (v.length > max) errors.push(`${label} is at most ${max} characters`);
      if (variablesIn(v).length) errors.push(`${label} can't have variables`);
      t[key] = v || null;
    }
  }
  if (!partial || input.bodyText !== undefined) {
    t.body_text = typeof input.bodyText === 'string' ? input.bodyText.trim() : '';
  }
  if (!partial || input.bodyExamples !== undefined) {
    t.body_examples = Array.isArray(input.bodyExamples) ? input.bodyExamples.map((x) => String(x ?? '').trim()) : [];
  }
  if (!partial || input.buttons !== undefined) {
    t.buttons = Array.isArray(input.buttons) ? input.buttons : [];
  }
  if (!partial || input.purpose !== undefined) {
    t.purpose = typeof input.purpose === 'string' && input.purpose.trim() ? input.purpose.trim().slice(0, 40) : null;
  }

  // Body rules apply to the result, whichever fields changed.
  const body = t.body_text ?? '';
  if (!body) errors.push('The message text is required');
  if (body.length > 1024) errors.push('The message text is at most 1024 characters');
  const vars = variablesIn(body);
  const expected = vars.length ? Array.from({ length: Math.max(...vars) }, (_, i) => i + 1) : [];
  if (vars.length !== expected.length) errors.push('Variables are numbered {{1}}, {{2}}… with none skipped');
  if (/^\{\{\d+\}\}/.test(body) || /\{\{\d+\}\}$/.test(body)) errors.push("The text can't start or end with a variable — add words around it");
  const examples = t.body_examples ?? [];
  if (examples.length !== expected.length || examples.some((e) => !e || e.length > 200)) {
    errors.push(`Give a sample value for each variable (${expected.length} needed) — Meta reviews the template with them`);
  }

  const buttons = t.buttons ?? [];
  if (buttons.length > 3) errors.push('At most 3 buttons');
  let urls = 0;
  let phones = 0;
  t.buttons = buttons.map((b, i) => {
    const where = `Button ${i + 1}`;
    const type = b?.type;
    const text = typeof b?.text === 'string' ? b.text.trim() : '';
    if (!text || text.length > 25) errors.push(`${where}: text of 1–25 characters`);
    if (type === 'URL') {
      urls += 1;
      const url = typeof b.url === 'string' ? b.url.trim() : '';
      if (!/^https:\/\/[^\s]+$/.test(url)) errors.push(`${where}: the link starts with https://`);
      const dynamic = /\{\{1\}\}$/.test(url);
      if (variablesIn(url).length && !dynamic) errors.push(`${where}: only one variable, {{1}}, at the very end of the link`);
      const example = typeof b.example === 'string' ? b.example.trim() : '';
      if (dynamic && !example) errors.push(`${where}: give a sample for the end of the link`);
      return { type, text, url, ...(dynamic ? { example } : {}) };
    }
    if (type === 'PHONE_NUMBER') {
      phones += 1;
      const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
      if (!/^\+\d{8,15}$/.test(phone)) errors.push(`${where}: the phone number with country code, e.g. +919876543210`);
      return { type, text, phone };
    }
    if (type === 'QUICK_REPLY') return { type, text };
    errors.push(`${where}: type is URL, PHONE_NUMBER or QUICK_REPLY`);
    return { type, text };
  });
  if (urls > 2) errors.push('At most 2 link buttons');
  if (phones > 1) errors.push('At most 1 call button');

  return { errors, template: t };
}

/** The template in Meta's components format. */
function toMetaComponents(t) {
  const components = [];
  if (t.header_text) components.push({ type: 'HEADER', format: 'TEXT', text: t.header_text });
  const body = { type: 'BODY', text: t.body_text };
  if ((t.body_examples ?? []).length) body.example = { body_text: [t.body_examples] };
  components.push(body);
  if (t.footer_text) components.push({ type: 'FOOTER', text: t.footer_text });
  if ((t.buttons ?? []).length) {
    components.push({
      type: 'BUTTONS',
      buttons: t.buttons.map((b) => {
        if (b.type === 'URL') return { type: 'URL', text: b.text, url: b.url, ...(b.example ? { example: [b.url.replace('{{1}}', b.example)] } : {}) };
        if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone };
        return { type: 'QUICK_REPLY', text: b.text };
      }),
    });
  }
  return components;
}

/** A template Meta already has, in our columns (for templates made in Meta's own tools). */
function fromMetaComponents(components = []) {
  const out = { header_text: null, body_text: '', footer_text: null, buttons: [], body_examples: [] };
  for (const c of components) {
    if (c.type === 'HEADER' && c.format === 'TEXT') out.header_text = (c.text ?? '').slice(0, 60) || null;
    if (c.type === 'BODY') {
      out.body_text = c.text ?? '';
      out.body_examples = c.example?.body_text?.[0] ?? [];
    }
    if (c.type === 'FOOTER') out.footer_text = (c.text ?? '').slice(0, 60) || null;
    if (c.type === 'BUTTONS') {
      out.buttons = (c.buttons ?? []).map((b) =>
        b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url, ...(b.example?.[0] ? { example: String(b.example[0]).slice(String(b.url).replace('{{1}}', '').length) } : {}) }
        : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text, phone: b.phone_number }
        : { type: b.type, text: b.text });
    }
  }
  return out;
}

/** The body as the recipient reads it. */
function render(bodyText, variables = []) {
  return String(bodyText ?? '').replace(VAR, (m, n) => variables[Number(n) - 1] ?? m);
}

const META_STATUS = { APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'disabled', PENDING_DELETION: 'disabled', DELETED: 'disabled', ARCHIVED: 'disabled', LIMIT_EXCEEDED: 'disabled' };
const mapStatus = (s) => META_STATUS[String(s ?? '').toUpperCase()] ?? 'pending';

function metaError(status, data) {
  const e = data?.error;
  const text = e?.error_user_msg || e?.error_user_title || e?.message || `Meta answered HTTP ${status}`;
  return new TemplateError(status === 401 || e?.code === 190 ? 502 : 409, `Meta: ${text}`);
}

function needWaba(conn) {
  if (!conn.config.waba_id) throw new TemplateError(409, 'Add the WhatsApp Business Account ID to the WhatsApp settings first.');
  return encodeURIComponent(String(conn.config.waba_id));
}

/** Sends a draft (or an edited rejected one) to Meta for review. */
async function submit(conn, t) {
  const auth = { Authorization: `Bearer ${conn.secrets.access_token}` };
  const components = toMetaComponents(t);
  let result;
  if (t.meta_template_id) {
    // Meta edits a template it already has in place (allowed for rejected and paused ones).
    const { status, data } = await requestJson(`${GRAPH}/${encodeURIComponent(t.meta_template_id)}`, {
      method: 'POST', headers: auth, body: { category: t.category, components },
    });
    if (status !== 200) throw metaError(status, data);
    result = { id: t.meta_template_id, status: 'PENDING' };
  } else {
    const { status, data } = await requestJson(`${GRAPH}/${needWaba(conn)}/message_templates`, {
      method: 'POST', headers: auth, body: { name: t.name, language: t.language, category: t.category, components },
    });
    if (status !== 200) throw metaError(status, data);
    result = data;
  }
  return { metaTemplateId: String(result.id), status: mapStatus(result.status), category: CATEGORIES.includes(result.category) ? result.category : t.category };
}

/**
 * Pulls every template Meta has for the business account: updates ours, adds
 * ones made in Meta's tools, and marks submitted ones Meta no longer has.
 */
async function sync(conn, db = pool) {
  const auth = { Authorization: `Bearer ${conn.secrets.access_token}` };
  let url = `${GRAPH}/${needWaba(conn)}/message_templates?fields=id,name,language,status,category,rejected_reason,components&limit=100`;
  const remote = [];
  for (let page = 0; url && page < 20; page += 1) {
    const { status, data } = await requestJson(url, { headers: auth });
    if (status !== 200) throw metaError(status, data);
    remote.push(...(data?.data ?? []));
    url = data?.paging?.next ?? null;
  }
  let updated = 0;
  let added = 0;
  const seen = new Set();
  for (const r of remote) {
    seen.add(String(r.id));
    const rejected = r.rejected_reason && r.rejected_reason !== 'NONE' ? String(r.rejected_reason) : null;
    const { rowCount } = await db.query(
      `UPDATE whatsapp_templates SET meta_template_id = $3, status = $4, category = $5, rejected_reason = $6,
         last_synced_at = now(), updated_at = now()
       WHERE name = $1 AND language = $2`,
      [r.name, r.language, String(r.id), mapStatus(r.status), CATEGORIES.includes(r.category) ? r.category : 'UTILITY', rejected]
    );
    if (rowCount) { updated += 1; continue; }
    const c = fromMetaComponents(r.components);
    await db.query(
      `INSERT INTO whatsapp_templates (name, language, category, header_text, body_text, footer_text, buttons, body_examples,
         status, meta_template_id, rejected_reason, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
      [r.name, r.language, CATEGORIES.includes(r.category) ? r.category : 'UTILITY', c.header_text, c.body_text || '(no text)',
        c.footer_text, JSON.stringify(c.buttons), JSON.stringify(c.body_examples), mapStatus(r.status), String(r.id), rejected]
    );
    added += 1;
  }
  const { rowCount: removed } = await db.query(
    `UPDATE whatsapp_templates SET status = 'disabled', rejected_reason = 'No longer on Meta', updated_at = now()
     WHERE meta_template_id IS NOT NULL AND NOT (meta_template_id = ANY($1)) AND status <> 'disabled'`,
    [[...seen]]
  );
  return { total: remote.length, updated, added, removed };
}

/** Deletes the template on Meta too, when Meta has it. */
async function removeOnMeta(conn, t) {
  if (!t.meta_template_id) return;
  const { status, data } = await requestJson(
    `${GRAPH}/${needWaba(conn)}/message_templates?hsm_id=${encodeURIComponent(t.meta_template_id)}&name=${encodeURIComponent(t.name)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${conn.secrets.access_token}` } }
  );
  // Already gone on Meta's side is fine.
  if (status !== 200 && data?.error?.code !== 100) throw metaError(status, data);
}

// ------------------------------------------------------------ starting drafts

/**
 * The templates the plan calls for (docs/whatsapp-plan.md §2), as drafts to
 * review and submit. Utility only; English first.
 */
const DRAFTS = [
  ['order_placed', 'order_placed', 'Hi {{1}}, thank you for your order {{2}} at Gloaro Mart. Order total: ₹{{3}}. We will update you here when the shop confirms it.', ['Priya', 'GLM-2026-00012', '630.00']],
  ['order_confirmed', 'order_confirmed', 'Your order {{1}} has been confirmed by {{2}}. Expected delivery: {{3}}.', ['GLM-2026-00012', 'Sri Balaji Stores', 'today by 7 PM']],
  ['order_out_for_delivery', 'order_out_for_delivery', 'Your order {{1}} is out for delivery. Delivery partner: {{2}}, phone {{3}}.', ['GLM-2026-00012', 'Ravi', '+91 98765 43210']],
  ['order_delivered', 'order_delivered', 'Your order {{1}} has been delivered. Thank you for shopping with Gloaro Mart — you can rate your order in the app.', ['GLM-2026-00012']],
  ['order_cancelled', 'order_cancelled', 'Your order {{1}} has been cancelled. A refund of ₹{{2}} has been started and should reach you within {{3}} working days.', ['GLM-2026-00012', '630.00', '5']],
  ['order_cancelled_cod', 'order_cancelled_cod', 'Your order {{1}} from {{2}} has been cancelled. No payment was taken, so nothing is due.', ['GLM-2026-00012', 'Sri Balaji Stores']],
  ['refund_completed', 'refund_completed', 'Your refund of ₹{{1}} for order {{2}} has been completed to your {{3}}.', ['630.00', 'GLM-2026-00012', 'UPI account']],
  ['return_pickup', 'return_pickup', 'A pickup for your return on order {{1}} is scheduled for {{2}}. Please keep the item packed and ready.', ['GLM-2026-00012', '16 Oct, 10 AM–1 PM']],
  ['payment_pending', 'payment_pending', 'Payment for your order {{1}} of ₹{{2}} is pending. Please complete it in the Gloaro Mart app to confirm your order.', ['GLM-2026-00012', '630.00']],
  ['invoice_ready', 'invoice_ready', 'The invoice {{1}} for your order {{2}} is ready. You can download it from the order page in the Gloaro Mart app.', ['GLM/2026-27/000123', 'GLM-2026-00012']],
  ['vendor_new_order', 'vendor_new_order', 'New order {{1}} for {{2}}: {{3}} item(s), ₹{{4}}. Please accept it by {{5}} in the Gloaro Mart vendor app.', ['GLM-2026-00012', 'Sri Balaji Stores', '3', '630.00', '6:45 PM']],
  ['shop_new_order', 'shop_new_order', 'New order {{1}} for {{2}}: {{3}} item(s), ₹{{4}}. Please open the Gloaro Mart vendor app to accept it.', ['GLM-2026-00012', 'Sri Balaji Stores', '3', '630.00']],
  ['vendor_reroute_offer', 'vendor_reroute_offer', 'Order {{1}} near you is available: {{2}} item(s), ₹{{3}}. Accept it by {{4}} in the Gloaro Mart vendor app.', ['GLM-2026-00012', '3', '630.00', '6:45 PM']],
  ['vendor_rfq_invite', 'vendor_rfq_invite', 'You have been invited by {{1}} to quote on {{2}} ({{3}}). Quotes close on {{4}}.', ['Gloaro Cafe Pvt Ltd', 'Cafe supplies', 'RFQ-2026-00004', '18 Oct']],
  ['vendor_po_issued', 'vendor_po_issued', 'Purchase order {{1}} for ₹{{2}} has been issued to you by {{3}}. Please acknowledge it in the Gloaro Mart vendor app.', ['PO-2026-00007', '5,59,700.00', 'Gloaro Cafe Pvt Ltd']],
  ['vendor_settlement_paid', 'vendor_settlement_paid', 'Your Gloaro Mart settlement of ₹{{1}} for {{2}} has been paid. Bank reference (UTR): {{3}}.', ['12,480.00', '6–12 Oct', 'HDFC0000123456']],
  ['vendor_kyc_status', 'vendor_kyc_status', 'Your Gloaro Mart shop verification is {{1}}. Note from our team: {{2}}. Open the vendor app for details.', ['approved', 'welcome aboard']],
  ['business_credit_due', 'business_credit_due', 'A payment of ₹{{1}} on the Gloaro Mart credit account of {{2}} is due on {{3}}.', ['12,000.00', 'Gloaro Cafe Pvt Ltd', '30 Oct']],
  ['delivery_assigned', 'delivery_assigned', 'New delivery for you: order {{1}}, pick up from {{2}}, deliver to {{3}}. Cash to collect: ₹{{4}}.', ['GLM-2026-00012', 'Sri Balaji Stores', 'Anna Nagar', '630.00']],
];

async function seedDraftTemplates(db = pool) {
  let added = 0;
  for (const [name, purpose, body, examples] of DRAFTS) {
    const { rowCount } = await db.query(
      `INSERT INTO whatsapp_templates (name, language, category, body_text, body_examples, purpose)
       VALUES ($1, 'en', 'UTILITY', $2, $3, $4) ON CONFLICT (name, language) DO NOTHING`,
      [name, body, JSON.stringify(examples), purpose]
    );
    added += rowCount;
  }
  return added;
}

module.exports = {
  TemplateError, LANGUAGES, CATEGORIES, DRAFTS, variablesIn, validate, toMetaComponents, render, submit, sync, removeOnMeta, seedDraftTemplates,
};
