/**
 * RP12 — Platform & admin reports: admin audit log, admin activity,
 * payment gateway log, WhatsApp message log, sign-in codes, and app usage.
 *
 * There is no login history table (only one-time sign-in codes) and the app
 * doesn't send its version, so "login history" is the sign-in codes report
 * and "app version usage" is app usage by platform and language.
 */
const and = (w) => (w.length ? `AND ${w.join(' AND ')}` : '');
const NAME = (alias) => `COALESCE(NULLIF(TRIM(${alias}.full_name), ''), ${alias}.email)`;
const short = (col) => `LEFT(${col}::text, 300)`;

const auditLog = {
  key: 'audit-log',
  group: 'platform',
  title: 'Admin audit log',
  description: 'Every change made in the admin console in the range: who, what, which module and record, and the before / after values.',
  keywords: ['audit', 'admin log', 'activity log', 'who changed', 'history', 'security'],
  filters: [
    { key: 'admin', label: 'Admin contains', type: 'text', outer: 'admin', op: 'ilike' },
    { key: 'module', label: 'Module contains', type: 'text', outer: 'module', op: 'ilike' },
    { key: 'action', label: 'Action contains', type: 'text', outer: 'action', op: 'ilike' },
  ],
  columns: [
    { key: 'at', label: 'When', type: 'datetime' },
    { key: 'admin', label: 'Admin', type: 'text', search: true },
    { key: 'action', label: 'Action', type: 'text', search: true },
    { key: 'module', label: 'Module', type: 'text', search: true },
    { key: 'record', label: 'Record', type: 'text', search: true },
    { key: 'before', label: 'Before', type: 'text', search: true },
    { key: 'after', label: 'After', type: 'text', search: true },
  ],
  defaultSort: { key: 'at', dir: 'desc' },
  summary: [
    { key: 'changes', label: 'Changes', type: 'int', sql: 'COUNT(*)' },
    { key: 'admins', label: 'Admins', type: 'int', sql: 'COUNT(DISTINCT r.admin)' },
    { key: 'modules', label: 'Modules', type: 'int', sql: 'COUNT(DISTINCT r.module)' },
    { key: 'top_module', label: 'Busiest module', type: 'text', sql: 'mode() WITHIN GROUP (ORDER BY r.module)' },
  ],
  notes: 'Before / after are cut to 300 characters here; Settings & Admin → Admin Logs shows them in full.',
  sql: ({ inRange }) => `
    SELECT l.created_at AS at, COALESCE(${NAME('u')}, 'System') AS admin, l.action, l.module,
           NULLIF(CONCAT_WS(' #', l.entity_type, l.entity_id::text), '') AS record,
           ${short('l.previous_value')} AS before, ${short('l.new_value')} AS after
    FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id
    WHERE ${inRange('l.created_at')}`,
};

const ACTIVITY_GROUPS = {
  admin: `COALESCE(${NAME('u')}, 'System')`,
  module: 'l.module',
  day: `to_char(l.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`,
};

const adminActivity = {
  key: 'admin-activity',
  group: 'platform',
  title: 'Admin activity',
  description: 'How much each admin (or module, or day) changed in the range: changes, modules / admins involved, first and last change.',
  keywords: ['staff activity', 'admin usage', 'team activity', 'who is active'],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      default: 'admin',
      options: [
        { value: 'admin', label: 'Admin' },
        { value: 'module', label: 'Module' },
        { value: 'day', label: 'Day' },
      ],
    },
  ],
  columns: [
    { key: 'name', label: 'Group', type: 'text', search: true },
    { key: 'changes', label: 'Changes', type: 'int' },
    { key: 'modules', label: 'Modules', type: 'int' },
    { key: 'admins', label: 'Admins', type: 'int' },
    { key: 'first_at', label: 'First change', type: 'datetime' },
    { key: 'last_at', label: 'Last change', type: 'datetime' },
  ],
  defaultSort: { key: 'changes', dir: 'desc' },
  summary: [
    { key: 'changes', label: 'Changes', type: 'int', sql: 'COALESCE(SUM(r.changes), 0)' },
    { key: 'groups', label: 'Groups', type: 'int', sql: 'COUNT(*)' },
  ],
  sql: ({ f, inRange }) => `
    SELECT ${ACTIVITY_GROUPS[f.groupBy]} AS name, COUNT(*) AS changes, COUNT(DISTINCT l.module) AS modules,
           COUNT(DISTINCT l.actor_user_id) AS admins, MIN(l.created_at) AS first_at, MAX(l.created_at) AS last_at
    FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id
    WHERE ${inRange('l.created_at')}
    GROUP BY 1`,
};

const gatewayLog = {
  key: 'payment-gateway-log',
  group: 'platform',
  title: 'Payment gateway log',
  description: 'Every payment event in the range (created, captured, failed, refunded, webhooks…) with the checkout, amount and who or what caused it.',
  keywords: ['razorpay log', 'webhook', 'gateway events', 'payment log', 'transactions log', 'debug payments'],
  filters: [
    { key: 'event', label: 'Event contains', type: 'text', outer: 'event', op: 'ilike' },
    {
      key: 'actor',
      label: 'Caused by',
      type: 'select',
      options: ['customer', 'vendor', 'admin', 'system', 'gateway'].map((value) => ({
        value,
        label: value === 'vendor' ? 'Shop' : value === 'gateway' ? 'Gateway (webhook)' : value.charAt(0).toUpperCase() + value.slice(1),
      })),
    },
    {
      key: 'kind',
      label: 'Log',
      type: 'select',
      options: [
        { value: 'payment', label: 'Payments' },
        { value: 'refund', label: 'Refunds' },
      ],
    },
  ],
  columns: [
    { key: 'at', label: 'When', type: 'datetime' },
    { key: 'kind', label: 'Log', type: 'status' },
    { key: 'ref_id', label: 'Payment / refund #', type: 'int', search: true },
    { key: 'checkout', label: 'Checkout', type: 'text', search: true },
    { key: 'event', label: 'Event', type: 'text', search: true },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'actor', label: 'Caused by', type: 'status' },
    { key: 'by_user', label: 'User', type: 'text', search: true },
    { key: 'gateway_event', label: 'Gateway event id', type: 'text', search: true },
    { key: 'note', label: 'Note', type: 'text', search: true },
  ],
  defaultSort: { key: 'at', dir: 'desc' },
  summary: [
    { key: 'events', label: 'Events', type: 'int', sql: 'COUNT(*)' },
    { key: 'webhooks', label: 'From the gateway', type: 'int', sql: `COUNT(*) FILTER (WHERE r.actor = 'gateway')` },
    { key: 'failed', label: 'Failure events', type: 'int', sql: `COUNT(*) FILTER (WHERE r.event ILIKE '%fail%')` },
  ],
  sql: ({ f, p, inRange }) => {
    const actor = f.actor ? `AND t.actor_role = ${p(f.actor)}` : '';
    const pay = `
      SELECT t.created_at AS at, 'payment' AS kind, t.payment_id AS ref_id, cg.reference AS checkout, t.event, t.amount_cents AS amount,
             t.actor_role AS actor, ${NAME('u')} AS by_user, t.provider_event_id AS gateway_event, t.note
      FROM payment_transactions t
      JOIN payments pm ON pm.id = t.payment_id
      LEFT JOIN checkout_groups cg ON cg.id = pm.checkout_group_id
      LEFT JOIN users u ON u.id = t.changed_by_user_id
      WHERE ${inRange('t.created_at')} ${actor}`;
    const ref = `
      SELECT t.created_at AS at, 'refund' AS kind, t.refund_id AS ref_id, cg.reference AS checkout, t.event, t.amount_cents AS amount,
             t.actor_role AS actor, ${NAME('u')} AS by_user, t.provider_event_id AS gateway_event, t.note
      FROM refund_transactions t
      JOIN refunds rf ON rf.id = t.refund_id
      LEFT JOIN payments pm ON pm.id = rf.payment_id
      LEFT JOIN checkout_groups cg ON cg.id = pm.checkout_group_id
      LEFT JOIN users u ON u.id = t.changed_by_user_id
      WHERE ${inRange('t.created_at')} ${actor}`;
    if (f.kind === 'payment') return pay;
    if (f.kind === 'refund') return ref;
    return `${pay} UNION ALL ${ref}`;
  },
};

const whatsappLog = {
  key: 'whatsapp-log',
  group: 'platform',
  title: 'WhatsApp message log',
  description: 'Every WhatsApp message in the range, in and out: phone, person, template, event, status, error and retries.',
  keywords: ['whatsapp log', 'message log', 'failed messages', 'ultramsg', 'debug whatsapp'],
  filters: [
    {
      key: 'direction',
      label: 'Direction',
      type: 'select',
      options: [
        { value: 'out', label: 'Sent' },
        { value: 'in', label: 'Received' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'received', 'skipped'].map((value) => ({
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1),
      })),
    },
    { key: 'template', label: 'Template contains', type: 'text', outer: 'template', op: 'ilike' },
  ],
  columns: [
    { key: 'at', label: 'When', type: 'datetime' },
    { key: 'direction', label: 'Direction', type: 'status' },
    { key: 'phone', label: 'Phone', type: 'text', search: true },
    { key: 'person', label: 'Person', type: 'text', search: true },
    { key: 'template', label: 'Template', type: 'text', search: true },
    { key: 'event', label: 'Event', type: 'text', search: true },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'error', label: 'Error', type: 'text', search: true },
    { key: 'attempts', label: 'Tries', type: 'int' },
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
  ],
  defaultSort: { key: 'at', dir: 'desc' },
  summary: [
    { key: 'messages', label: 'Messages', type: 'int', sql: 'COUNT(*)' },
    { key: 'failed', label: 'Failed', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'failed')` },
    { key: 'received', label: 'Received', type: 'int', sql: `COUNT(*) FILTER (WHERE r.direction = 'in')` },
    { key: 'top_error', label: 'Most common error', type: 'text', sql: 'mode() WITHIN GROUP (ORDER BY r.error) FILTER (WHERE r.error IS NOT NULL)' },
  ],
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.direction) w.push(`m.direction = ${p(f.direction)}`);
    if (f.status) w.push(`m.status = ${p(f.status)}`);
    return `
      SELECT m.created_at AS at, CASE m.direction WHEN 'out' THEN 'sent' ELSE 'received' END AS direction,
             m.phone, ${NAME('u')} AS person, COALESCE(m.template_name, CASE WHEN m.kind = 'text' THEN 'Free text' END) AS template,
             m.event, m.status, NULLIF(CONCAT_WS(' ', m.error_code, m.error_message), '') AS error, m.attempts, m.order_id
      FROM whatsapp_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE ${inRange('m.created_at')} ${and(w)}`;
  },
};

const signinCodes = {
  key: 'signin-codes',
  group: 'platform',
  title: 'Sign-in & signup codes',
  description: 'One-time codes sent each day for signing up, signing in and KYC: sent, used, expired unused, and wrong tries.',
  keywords: ['otp', 'login', 'sign in', 'signup', 'login history', 'verification', 'sms'],
  filters: [
    {
      key: 'kind',
      label: 'Code for',
      type: 'select',
      options: [
        { value: 'signup', label: 'Signing up' },
        { value: 'login', label: 'Signing in' },
        { value: 'kyc', label: 'Shop KYC' },
        { value: 'admin', label: 'Admin password change' },
      ],
      outer: 'kind_key',
    },
  ],
  columns: [
    { key: 'day', label: 'Day', type: 'text' },
    { key: 'kind', label: 'Code for', type: 'text' },
    { key: 'sent', label: 'Sent', type: 'int' },
    { key: 'used', label: 'Used', type: 'int' },
    { key: 'expired', label: 'Expired unused', type: 'int' },
    { key: 'wrong_tries', label: 'Wrong tries', type: 'int' },
    { key: 'people', label: 'People', type: 'int' },
  ],
  defaultSort: { key: 'day', dir: 'desc' },
  summary: [
    { key: 'sent', label: 'Codes sent', type: 'int', sql: 'COALESCE(SUM(r.sent), 0)' },
    { key: 'used', label: 'Used', type: 'int', sql: 'COALESCE(SUM(r.used), 0)' },
    { key: 'use_rate', label: 'Use rate', type: 'percent', sql: 'ROUND(100.0 * SUM(r.used) / NULLIF(SUM(r.sent), 0), 1)' },
    { key: 'wrong', label: 'Wrong tries', type: 'int', sql: 'COALESCE(SUM(r.wrong_tries), 0)' },
  ],
  notes: 'There is no full login history yet; this counts the one-time codes. Password sign-ins without a code aren\'t recorded. People = distinct phone numbers / accounts.',
  sql: ({ inRange }) => {
    const day = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`;
    const part = (table, key, label, who, tries) => `
      SELECT ${day('created_at')} AS day, '${key}' AS kind_key, '${label}' AS kind, COUNT(*) AS sent,
             COUNT(*) FILTER (WHERE consumed_at IS NOT NULL) AS used,
             COUNT(*) FILTER (WHERE consumed_at IS NULL AND expires_at < now()) AS expired,
             ${tries ? 'COALESCE(SUM(attempts), 0)' : '0'} AS wrong_tries, COUNT(DISTINCT ${who}) AS people
      FROM ${table} WHERE ${inRange('created_at')} GROUP BY 1`;
    return [
      part('signup_otps', 'signup', 'Signing up', 'phone', true),
      part('login_otps', 'login', 'Signing in', 'user_id', true),
      part('kyc_otps', 'kyc', 'Shop KYC', 'user_id', true),
      part('admin_password_otps', 'admin', 'Admin password change', 'user_id', false),
    ].join(' UNION ALL ');
  },
};

const USAGE_GROUPS = {
  platform: `CASE e.platform WHEN 'android' THEN 'Android' WHEN 'ios' THEN 'iOS' WHEN 'web' THEN 'Web' ELSE 'Unknown' END`,
  language: `CASE WHEN e.user_id IS NULL THEN 'Not signed in' ELSE
    CASE COALESCE(u.preferred_language, 'en') WHEN 'en' THEN 'English' WHEN 'ta' THEN 'Tamil' WHEN 'hi' THEN 'Hindi' ELSE u.preferred_language END END`,
  day: `to_char(e.occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`,
};

const appUsage = {
  key: 'app-usage',
  group: 'platform',
  title: 'App usage',
  description: 'Shopper app sessions, signed-in people, product views, add-to-carts and orders by platform (Android / iOS / web), language or day.',
  keywords: ['app usage', 'android', 'ios', 'web', 'language', 'sessions', 'active users', 'tamil', 'hindi'],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      default: 'platform',
      options: [
        { value: 'platform', label: 'Platform' },
        { value: 'language', label: 'App language' },
        { value: 'day', label: 'Day' },
      ],
    },
    {
      key: 'platform',
      label: 'Platform',
      type: 'select',
      options: [
        { value: 'android', label: 'Android' },
        { value: 'ios', label: 'iOS' },
        { value: 'web', label: 'Web' },
      ],
    },
  ],
  columns: [
    { key: 'name', label: 'Group', type: 'text', search: true },
    { key: 'sessions', label: 'Sessions', type: 'int' },
    { key: 'people', label: 'Signed-in people', type: 'int' },
    { key: 'views', label: 'Product views', type: 'int' },
    { key: 'carts', label: 'Add to cart', type: 'int' },
    { key: 'orders', label: 'Orders placed', type: 'int' },
    { key: 'share', label: 'Share of sessions', type: 'percent' },
  ],
  defaultSort: { key: 'sessions', dir: 'desc' },
  summary: [
    { key: 'sessions', label: 'Sessions', type: 'int', sql: 'COALESCE(SUM(r.sessions), 0)' },
    { key: 'views', label: 'Product views', type: 'int', sql: 'COALESCE(SUM(r.views), 0)' },
    { key: 'orders', label: 'Orders placed', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
  ],
  notes: 'From the shopper app\'s analytics events (Admin → Analytics). Language is the signed-in person\'s chosen app language; the app doesn\'t report its version yet.',
  sql: ({ f, p, inRange }) => `
    SELECT ${USAGE_GROUPS[f.groupBy]} AS name,
           COUNT(DISTINCT e.session_id) AS sessions, COUNT(DISTINCT e.user_id) AS people,
           COUNT(*) FILTER (WHERE e.event = 'product_view') AS views,
           COUNT(*) FILTER (WHERE e.event = 'add_to_cart') AS carts,
           COUNT(*) FILTER (WHERE e.event = 'order_placed') AS orders,
           ROUND(100.0 * COUNT(DISTINCT e.session_id) / NULLIF(SUM(COUNT(DISTINCT e.session_id)) OVER (), 0), 1) AS share
    FROM analytics_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE ${inRange('e.occurred_at')} ${f.platform ? `AND e.platform = ${p(f.platform)}` : ''}
    GROUP BY 1`,
};

module.exports = { reports: [auditLog, adminActivity, gatewayLog, whatsappLog, signinCodes, appUsage] };
