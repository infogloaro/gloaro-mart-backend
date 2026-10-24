const pool = require('../config/db');
const whatsapp = require('./whatsapp');
const templates = require('./whatsappTemplates');

/**
 * Automatic WhatsApp order updates (schema PHASE 51). Runs on the WhatsApp
 * sweep (server.js): finds order events since each rule was switched on,
 * fills the rule's template from the order, and queues one message per event.
 *
 * Who gets it: the customer, on the WhatsApp number they ordered from (the
 * bot links it to their account), else their account's phone — and only when
 * they've opted in. A copy goes to the mobile number on the delivery address
 * unless that number wrote STOP (WP2). Shop alerts (audience 'shop') go to
 * the shop owner's phone unless they wrote STOP. Plan: docs/whatsapp-plan.md §5.
 *
 * With Meta a rule sends once its template is approved; with UltraMsg, which
 * sends plain text, any template that isn't disabled will do.
 */

// Events older than this are never sent: a late "out for delivery" is worse than none.
const MAX_AGE_HOURS = 6;
const BATCH = 200;
const PAID = "('successful', 'partially_refunded', 'refunded')";

const rupees = (cents) => (Number(cents) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (d) =>
  d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
const firstName = (name) => (name ? String(name).trim().split(/\s+/)[0] : null) || 'there';
const METHOD = { upi: 'UPI account', card: 'card', netbanking: 'bank account', wallet: 'wallet' };

// Recipient columns every source selects, as u_*.
const RECIPIENT = `u.id AS u_id, u.full_name AS u_name, u.phone_number AS u_phone, u.whatsapp_phone AS u_wa,
  u.whatsapp_opt_in AS u_opt_in, u.whatsapp_opt_out_at AS u_opt_out`;
const REF = "COALESCE(cg.reference, 'GLM-ORDER-' || o.id)";
// The mobile number on the delivery address (WP2): it gets a copy too.
// Checkout writes the snapshot in camelCase (mobileNumber); older rows may say mobile_number.
const ADDR = (alias) =>
  `COALESCE(${alias}.delivery_address_snapshot->>'mobileNumber', ${alias}.delivery_address_snapshot->>'mobile_number') AS addr_mobile`;
// Every line of a purchase, shop by shop, for the itemised bill.
const ITEMS = `(SELECT json_build_object(
     'lines', json_agg(json_build_object('shop', vp.business_name, 'name', oi.product_name_snapshot, 'qty', oi.quantity,
                                         'price', oi.unit_price_cents) ORDER BY o.id, oi.id),
     'charges', (SELECT json_build_object(
         'gst', COALESCE(SUM(o2.gst_cents), 0),
         'delivery', COALESCE(SUM(o2.delivery_charge_cents), 0),
         'discount', COALESCE(SUM(o2.discount_cents + o2.campaign_discount_cents + o2.points_discount_cents), 0))
       FROM orders o2 WHERE o2.checkout_group_id = cg.id AND o2.status <> 'cancelled'))
   FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN vendor_profiles vp ON vp.id = o.vendor_id
   WHERE o.checkout_group_id = cg.id AND o.status <> 'cancelled') AS items`;

/** The itemised bill under "Order placed", for providers that send plain text. */
function bill(r) {
  const lines = r.items?.lines ?? [];
  if (!lines.length) return null;
  const out = ['*Your bill*'];
  let shop = null;
  for (const l of lines) {
    if (l.shop !== shop) {
      shop = l.shop;
      out.push(`_${shop}_`);
    }
    out.push(`• ${l.qty} × ${l.name} — ₹${rupees(l.qty * l.price)}`);
  }
  const c = r.items.charges ?? {};
  if (Number(c.gst)) out.push(`GST — ₹${rupees(c.gst)}`);
  if (Number(c.delivery)) out.push(`Delivery — ₹${rupees(c.delivery)}`);
  if (Number(c.discount)) out.push(`Discount — −₹${rupees(c.discount)}`);
  out.push(`*Total — ₹${rupees(r.payable_cents)}*`);
  return out.join('\n');
}
const NOT_SENT = (key) => `NOT EXISTS (SELECT 1 FROM whatsapp_messages w WHERE w.dedupe_key = ${key})`;
const RECENT = (col) => `${col} > GREATEST($1::timestamptz, now() - interval '${MAX_AGE_HOURS} hours')`;

/** A status change on a shop's order, with what the templates need. */
const statusSource = (toStatus, prefix) => `
  SELECT h.id AS source_id, '${prefix}:order:' || o.id AS dedupe_key, o.id AS order_id, o.checkout_group_id AS group_id,
         ${REF} AS ref, vp.business_name AS shop, o.total_cents, o.payment_method, o.estimated_delivery_at,
         o.delivery_partner_name, o.delivery_partner_phone, p.status AS payment_status, ${ADDR('o')},
         (SELECT row_to_json(s) FROM (SELECT partner_name, partner_phone, estimated_delivery_at FROM shipments
            WHERE order_id = o.id ORDER BY id DESC LIMIT 1) s) AS shipment,
         ${RECIPIENT}
  FROM order_status_history h
  JOIN orders o ON o.id = h.order_id
  JOIN users u ON u.id = o.user_id
  JOIN vendor_profiles vp ON vp.id = o.vendor_id
  LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
  LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
  WHERE h.to_status = '${toStatus}' AND ${RECENT('h.created_at')} AND ${NOT_SENT(`'${prefix}:order:' || o.id`)}
  ORDER BY h.id LIMIT ${BATCH}`;

const paidOnline = (r) => !['cod', 'credit'].includes(r.payment_method) && ['successful', 'partially_refunded', 'refunded'].includes(r.payment_status);

/**
 * Each event: who it's for, the values its template is filled with ({{1}},
 * {{2}}… in order), and where it comes from. `values` returning null means
 * the event doesn't apply to that row (it's left alone, not logged).
 */
const EVENTS = [
  {
    key: 'order_placed',
    label: 'Order placed',
    description: 'Once per purchase, for orders placed in the app; on UltraMsg with the itemised bill. Bot orders are confirmed by the bot in the chat.',
    template: 'order_placed',
    enabledByDefault: true,
    variables: ['Customer first name', 'Order reference', 'Order total (₹)'],
    sql: `
      SELECT cg.id AS source_id, 'order_placed:group:' || cg.id AS dedupe_key, NULL::int AS order_id, cg.id AS group_id,
             cg.reference AS ref, cg.total_cents, cg.payment_method, p.status AS payment_status, ${RECIPIENT}, ${ADDR('cg')},
             ${ITEMS},
             (SELECT COALESCE(SUM(o.total_cents) FILTER (WHERE o.status <> 'cancelled'), 0) FROM orders o WHERE o.checkout_group_id = cg.id) AS payable_cents
      FROM checkout_groups cg
      JOIN users u ON u.id = cg.user_id
      LEFT JOIN payments p ON p.checkout_group_id = cg.id
      WHERE ${RECENT('cg.created_at')} AND ${NOT_SENT("'order_placed:group:' || cg.id")}
        AND (cg.payment_method IN ('cod', 'credit') OR p.status IN ${PAID})
        -- The bot already confirmed these in the chat; replacements aren't purchases.
        AND NOT EXISTS (SELECT 1 FROM orders o JOIN platforms pl ON pl.id = o.sales_channel_id
                        WHERE o.checkout_group_id = cg.id AND pl.slug = 'whatsapp_bot')
        AND EXISTS (SELECT 1 FROM orders o WHERE o.checkout_group_id = cg.id AND o.replacement_of_order_id IS NULL)
      ORDER BY cg.id LIMIT ${BATCH}`,
    values: (r) => [firstName(r.u_name), r.ref, rupees(r.payable_cents)],
    details: bill,
  },
  {
    key: 'order_confirmed',
    label: 'Shop confirmed',
    description: 'When a shop accepts its part of the order.',
    template: 'order_confirmed',
    enabledByDefault: true,
    variables: ['Order reference', 'Shop name', 'Expected delivery'],
    sql: statusSource('confirmed', 'order_confirmed'),
    values: (r) => [r.ref, r.shop, when(r.shipment?.estimated_delivery_at ?? r.estimated_delivery_at) ?? 'soon'],
  },
  {
    key: 'order_out_for_delivery',
    label: 'Out for delivery',
    description: 'With the delivery partner’s name and phone.',
    template: 'order_out_for_delivery',
    enabledByDefault: true,
    variables: ['Order reference', 'Delivery partner name', 'Delivery partner phone'],
    sql: statusSource('out_for_delivery', 'order_out_for_delivery'),
    values: (r) => [
      r.ref,
      r.shipment?.partner_name || r.delivery_partner_name || 'our delivery partner',
      r.shipment?.partner_phone || r.delivery_partner_phone || 'in the app',
    ],
  },
  {
    key: 'order_delivered',
    label: 'Delivered',
    description: 'With a nudge to rate the order.',
    template: 'order_delivered',
    enabledByDefault: true,
    variables: ['Order reference'],
    sql: statusSource('delivered', 'order_delivered'),
    values: (r) => [r.ref],
  },
  {
    key: 'order_cancelled',
    label: 'Cancelled (paid online)',
    description: 'When a paid order is cancelled: the refund that was started.',
    template: 'order_cancelled',
    enabledByDefault: true,
    variables: ['Order reference', 'Refund amount (₹)', 'Refund days'],
    sql: statusSource('cancelled', 'order_cancelled'),
    values: (r) => (paidOnline(r) ? [r.ref, rupees(r.total_cents), '5–7'] : null),
  },
  {
    key: 'order_cancelled_cod',
    label: 'Cancelled (cash on delivery)',
    description: 'When a COD or credit order is cancelled: nothing is due.',
    template: 'order_cancelled_cod',
    enabledByDefault: true,
    variables: ['Order reference', 'Shop name'],
    sql: statusSource('cancelled', 'order_cancelled_cod'),
    // An online checkout that was never paid wasn't an order the customer expects news of.
    values: (r) => (['cod', 'credit'].includes(r.payment_method) ? [r.ref, r.shop] : null),
  },
  {
    key: 'refund_completed',
    label: 'Refund completed',
    description: 'When the money has gone back.',
    template: 'refund_completed',
    enabledByDefault: true,
    variables: ['Amount (₹)', 'Order reference', 'Where it went'],
    sql: `
      SELECT rf.id AS source_id, 'refund_completed:refund:' || rf.id AS dedupe_key, rf.order_id, p.checkout_group_id AS group_id,
             COALESCE(cg.reference, 'GLM-ORDER-' || rf.order_id) AS ref, rf.amount_cents, p.method, ${RECIPIENT}, ${ADDR('ro')}
      FROM refunds rf
      LEFT JOIN orders ro ON ro.id = rf.order_id
      JOIN payments p ON p.id = rf.payment_id
      JOIN users u ON u.id = p.user_id
      LEFT JOIN checkout_groups cg ON cg.id = p.checkout_group_id
      WHERE rf.status = 'completed' AND ${RECENT('rf.updated_at')} AND ${NOT_SENT("'refund_completed:refund:' || rf.id")}
      ORDER BY rf.id LIMIT ${BATCH}`,
    values: (r) => [rupees(r.amount_cents), r.ref, METHOD[r.method] ?? 'original payment method'],
  },
  {
    key: 'return_pickup',
    label: 'Return pickup scheduled',
    description: 'When a pickup is booked for a return.',
    template: 'return_pickup',
    enabledByDefault: false,
    variables: ['Order reference', 'Pickup date'],
    sql: `
      SELECT e.id AS source_id, 'return_pickup:return:' || r.id AS dedupe_key, o.id AS order_id, o.checkout_group_id AS group_id,
             ${REF} AS ref, r.pickup_scheduled_at, ${RECIPIENT}, ${ADDR('o')}
      FROM order_return_events e
      JOIN order_returns r ON r.id = e.return_id
      JOIN orders o ON o.id = r.order_id
      JOIN users u ON u.id = o.user_id
      LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
      WHERE e.status = 'pickup_scheduled' AND ${RECENT('e.created_at')} AND ${NOT_SENT("'return_pickup:return:' || r.id")}
      ORDER BY e.id LIMIT ${BATCH}`,
    values: (r) => [r.ref, when(r.pickup_scheduled_at) ?? 'soon'],
  },
  {
    key: 'invoice_ready',
    label: 'Invoice ready',
    description: 'When the tax invoice is issued (on delivery); on UltraMsg with the invoice PDF attached.',
    template: 'invoice_ready',
    enabledByDefault: false,
    variables: ['Invoice number', 'Order reference'],
    sql: `
      SELECT i.id AS source_id, 'invoice_ready:invoice:' || i.id AS dedupe_key, o.id AS order_id, o.checkout_group_id AS group_id,
             ${REF} AS ref, i.id AS invoice_id, i.invoice_number, ${RECIPIENT}, ${ADDR('o')}
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      JOIN users u ON u.id = o.user_id
      LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
      WHERE i.status = 'issued' AND ${RECENT('i.created_at')} AND ${NOT_SENT("'invoice_ready:invoice:' || i.id")}
      ORDER BY i.id LIMIT ${BATCH}`,
    values: (r) => [r.invoice_number, r.ref],
    attachment: (r) => ({ type: 'invoice', id: r.invoice_id }),
  },
  {
    key: 'shop_new_order',
    label: 'New order (to the shop)',
    description: 'To the shop owner’s phone when an order for their shop comes in (COD, or once paid online).',
    template: 'shop_new_order',
    audience: 'shop',
    enabledByDefault: false,
    variables: ['Order reference', 'Shop name', 'Number of items', 'Order total (₹)'],
    sql: `
      SELECT o.id AS source_id, 'shop_new_order:order:' || o.id AS dedupe_key, o.id AS order_id, o.checkout_group_id AS group_id,
             ${REF} AS ref, vp.business_name AS shop, o.total_cents,
             (SELECT COALESCE(SUM(oi.quantity), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
             ${RECIPIENT}
      FROM orders o
      JOIN vendor_profiles vp ON vp.id = o.vendor_id
      JOIN users u ON u.id = vp.user_id
      LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
      LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
      WHERE ${RECENT('o.created_at')} AND ${NOT_SENT("'shop_new_order:order:' || o.id")}
        AND o.status <> 'cancelled' AND o.replacement_of_order_id IS NULL
        AND (o.payment_method IN ('cod', 'credit') OR p.status IN ${PAID})
      ORDER BY o.id LIMIT ${BATCH}`,
    values: (r) => [r.ref, r.shop, String(r.item_count), rupees(r.total_cents)],
  },
];
const BY_KEY = new Map(EVENTS.map((e) => [e.key, e]));

/** Rules start as the plan says: the main order updates on, the rest off. */
async function seedRules(db = pool) {
  for (const e of EVENTS) {
    await db.query(
      `INSERT INTO whatsapp_event_rules (event, enabled, template_name, enabled_at)
       VALUES ($1, $2, $3, CASE WHEN $2 THEN now() END) ON CONFLICT (event) DO NOTHING`,
      [e.key, e.enabledByDefault, e.template]
    );
  }
}

/**
 * The number to send to and whether we may, or why not. A customer who has
 * never been on WhatsApp with us (an app customer before opting in) is left
 * out quietly rather than logged on every order.
 */
function recipient(r, audience = 'customer') {
  const phone = r.u_wa || whatsapp.normalizePhone(r.u_phone);
  // A shop's own order alerts: their business, sent unless they wrote STOP.
  if (audience === 'shop') {
    if (r.u_opt_out) return { skip: 'The shop owner wrote STOP.' };
    return phone ? { phone } : { skip: 'The shop owner has no phone number.' };
  }
  if (r.u_opt_in && phone) return { phone };
  if (!r.u_wa && !r.u_opt_out) return { quiet: true };
  if (!phone) return { skip: 'The customer has no phone number.' };
  return { skip: r.u_opt_out ? 'The customer wrote STOP.' : 'The customer has not opted in to WhatsApp updates.' };
}

/**
 * One pass: every enabled rule whose template can be sent (approved by Meta,
 * or any but disabled on UltraMsg). Nothing runs while the provider in use
 * isn't connected or its platform isn't Active — those events wait (up to
 * MAX_AGE_HOURS) instead of piling up as failures.
 */
async function dispatch() {
  const conn = await whatsapp.loadConnection();
  try {
    whatsapp.assertReady(conn);
  } catch {
    return { queued: 0, skipped: 0, paused: 'not_connected' };
  }
  if (conn.platformStatus !== 'active') return { queued: 0, skipped: 0, paused: 'inactive' };

  const { rows: rules } = await pool.query(
    `SELECT r.*, t.id AS t_id, t.status AS t_status, t.body_text, t.buttons, t.name AS t_name, t.language AS t_language
     FROM whatsapp_event_rules r
     JOIN whatsapp_templates t ON t.name = r.template_name AND t.language = r.language
     WHERE r.enabled AND ${conn.needsApproval ? "t.status = 'approved'" : "t.status <> 'disabled'"}`
  );
  const out = { queued: 0, skipped: 0 };
  for (const rule of rules) {
    const event = BY_KEY.get(rule.event);
    if (!event) continue;
    const template = { id: rule.t_id, name: rule.t_name, language: rule.t_language, status: rule.t_status, body_text: rule.body_text, buttons: rule.buttons };
    const needed = templates.variablesIn(template.body_text).length;
    const { rows } = await pool.query(event.sql, [rule.enabled_at]);
    for (const r of rows) {
      const values = event.values(r);
      if (!values) continue;
      const base = { dedupeKey: r.dedupe_key, orderId: r.order_id, groupId: r.group_id, userId: r.u_id, event: event.key };
      if (values.length !== needed) {
        await logSkip({ ...base, phone: r.u_wa ?? null, template, reason: `The template needs ${needed} value(s); this event gives ${values.length}.` });
        out.skipped += 1;
        continue;
      }
      // The bill and the invoice PDF go only where plain text and files can (UltraMsg).
      const extra = conn.needsApproval ? {} : { details: event.details?.(r) ?? null, attachment: event.attachment?.(r) ?? null };
      const send = async (phone, keys) => {
        try {
          const m = await whatsapp.enqueue(pool, { phone, template, variables: values.map(clean), approvedOnly: conn.needsApproval, ...extra, ...keys });
          if (m) out.queued += 1;
        } catch (err) {
          if (!(err instanceof whatsapp.WhatsAppError)) throw err;
          await logSkip({ ...keys, phone, template, reason: err.message });
          out.skipped += 1;
        }
      };
      const who = recipient(r, event.audience);
      if (who.phone) await send(who.phone, base);
      else if (who.skip) {
        await logSkip({ ...base, phone: r.u_wa ?? null, template, reason: who.skip });
        out.skipped += 1;
      }
      // A copy to the delivery address's mobile, when it's another number (or the
      // account's own one wasn't used) — unless that number wrote STOP.
      if (event.audience !== 'shop') {
        const addr = whatsapp.normalizePhone(r.addr_mobile);
        if (addr && addr !== who.phone && !(await optedOut(addr))) await send(addr, { ...base, dedupeKey: `${r.dedupe_key}:addr` });
      }
    }
  }
  return out;
}

/** A number that wrote STOP, on any account it's linked to or stored on. */
async function optedOut(phone) {
  const { rows } = await pool.query(
    `SELECT 1 FROM users WHERE whatsapp_opt_out_at IS NOT NULL
       AND (whatsapp_phone = $1::varchar OR right(regexp_replace(COALESCE(phone_number, ''), '\\D', '', 'g'), 10) = right($1::varchar, 10))
     LIMIT 1`,
    [phone]
  );
  return rows.length > 0;
}

// Meta refuses values with line breaks, tabs or long runs of spaces.
const clean = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1024) || '—';

async function logSkip({ dedupeKey, orderId, groupId, userId, event, phone, template, reason }) {
  await pool.query(
    `INSERT INTO whatsapp_messages (direction, phone, user_id, kind, template_id, template_name, language, status, skip_reason, event, dedupe_key, order_id, checkout_group_id)
     VALUES ('out', $1, $2, 'template', $3, $4, $5, 'skipped', $6, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [phone, userId, template.id, template.name, template.language, reason, event, dedupeKey, orderId, groupId]
  );
}

/** Whether the provider in use sends only Meta-approved templates. */
const needsApproval = async () => whatsapp.PROVIDERS[await whatsapp.currentProvider()].needsApproval;

/** Rules as the admin sees them, with whether each can actually send. */
async function listRules() {
  const approvalNeeded = await needsApproval();
  const { rows } = await pool.query(
    `SELECT r.*, t.id AS t_id, t.status AS t_status, t.body_text, t.body_examples,
            (SELECT COUNT(*) FILTER (WHERE m.status IN ('sent', 'delivered', 'read'))::int FROM whatsapp_messages m
              WHERE m.event = r.event AND m.created_at > now() - interval '7 days') AS sent_7d,
            (SELECT COUNT(*) FILTER (WHERE m.status = 'skipped')::int FROM whatsapp_messages m
              WHERE m.event = r.event AND m.created_at > now() - interval '7 days') AS skipped_7d,
            (SELECT COUNT(*) FILTER (WHERE m.status = 'failed')::int FROM whatsapp_messages m
              WHERE m.event = r.event AND m.created_at > now() - interval '7 days') AS failed_7d
     FROM whatsapp_event_rules r
     LEFT JOIN whatsapp_templates t ON t.name = r.template_name AND t.language = r.language`
  );
  const byEvent = new Map(rows.map((r) => [r.event, r]));
  return EVENTS.map((e) => {
    const r = byEvent.get(e.key);
    const count = r?.body_text ? templates.variablesIn(r.body_text).length : null;
    let problem = null;
    if (!r?.t_id) problem = `No template named ${r?.template_name ?? e.template} (${r?.language ?? 'en'}).`;
    else if (r.t_status === 'disabled') problem = 'The template is disabled.';
    else if (approvalNeeded && r.t_status !== 'approved') problem = `The template is ${r.t_status} — it sends once Meta approves it.`;
    else if (count !== e.variables.length) problem = `The template has ${count} variable(s); this event fills ${e.variables.length}.`;
    return {
      event: e.key,
      label: e.label,
      description: e.description,
      audience: e.audience ?? 'customer',
      variables: e.variables,
      enabled: r?.enabled ?? false,
      enabledAt: r?.enabled_at ?? null,
      templateName: r?.template_name ?? e.template,
      language: r?.language ?? 'en',
      templateStatus: r?.t_status ?? null,
      preview: r?.body_text ? templates.render(r.body_text, e.variables.map((v) => `[${v}]`)) : null,
      problem,
      sendsNow: Boolean(r?.enabled) && !problem,
      last7d: { sent: r?.sent_7d ?? 0, skipped: r?.skipped_7d ?? 0, failed: r?.failed_7d ?? 0 },
    };
  });
}

class RuleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Switching a rule on needs an approved template with exactly the values the
 * event fills; switching on starts the clock, so only events from now on send.
 */
async function updateRule({ event, enabled, templateName, language, userId }) {
  const def = BY_KEY.get(event);
  if (!def) throw new RuleError(404, 'Unknown event');
  const { rows: cur } = await pool.query('SELECT * FROM whatsapp_event_rules WHERE event = $1', [event]);
  const name = templateName ?? cur[0]?.template_name ?? def.template;
  const lang = language ?? cur[0]?.language ?? 'en';
  const on = enabled ?? cur[0]?.enabled ?? false;
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new RuleError(400, 'enabled is true or false');
  const { rows: t } = await pool.query('SELECT * FROM whatsapp_templates WHERE name = $1 AND language = $2', [name, lang]);
  if (!t[0]) throw new RuleError(400, `No template named ${name} (${lang}).`);
  if (on) {
    if (t[0].status === 'disabled') throw new RuleError(409, `${name} is disabled.`);
    if ((await needsApproval()) && t[0].status !== 'approved') {
      throw new RuleError(409, `${name} is ${t[0].status} — it can be switched on once Meta approves it (or switch WhatsApp to UltraMsg).`);
    }
    const count = templates.variablesIn(t[0].body_text).length;
    if (count !== def.variables.length) {
      throw new RuleError(409, `${name} has ${count} variable(s), but ${def.label} fills ${def.variables.length}: ${def.variables.join(', ')}.`);
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_event_rules (event, enabled, template_name, language, enabled_at, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $2 THEN now() END, $5, now())
     ON CONFLICT (event) DO UPDATE SET
       enabled = EXCLUDED.enabled, template_name = EXCLUDED.template_name, language = EXCLUDED.language,
       enabled_at = CASE WHEN EXCLUDED.enabled AND NOT whatsapp_event_rules.enabled THEN now()
                         WHEN EXCLUDED.enabled THEN whatsapp_event_rules.enabled_at ELSE NULL END,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [event, on, name, lang, userId]
  );
  return rows[0];
}

module.exports = { EVENTS, MAX_AGE_HOURS, RuleError, seedRules, dispatch, listRules, updateRule };
