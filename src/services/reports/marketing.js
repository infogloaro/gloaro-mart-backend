/**
 * RP9 — Marketing reports: ad performance, offer (discount) campaigns,
 * WhatsApp messages, in-app notifications, shop messages to followers, and
 * referral-code signups.
 *
 * Coupon redemption is under Payments & money (Coupon & discount usage).
 * Banners have no tap tracking, so there is no banner-clicks report.
 */
const { PAID, F } = require('./sales');

const and = (w) => (w.length ? `AND ${w.join(' AND ')}` : '');
const DAYS = (ctx) => `${ctx.p(ctx.range.from)}::date AND ${ctx.p(ctx.range.to)}::date`;

const AD_STATUS = ['draft', 'pending_payment', 'pending_approval', 'scheduled', 'live', 'paused', 'completed', 'rejected', 'cancelled']
  .map((value) => ({ value, label: value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) }));

const ads = {
  key: 'ad-performance',
  group: 'marketing',
  title: 'Ad performance',
  description: 'Each ad campaign in the range: impressions, taps, tap rate, enquiries, orders, order value, commission and what the shop paid.',
  keywords: ['ads', 'advertising', 'sponsored', 'impressions', 'clicks', 'ctr', 'roi', 'promotions'],
  filters: [
    F.shop,
    { key: 'status', label: 'Campaign status', type: 'select', options: AD_STATUS },
    {
      key: 'model',
      label: 'Pricing',
      type: 'select',
      options: [
        { value: 'fixed', label: 'Fixed fee' },
        { value: 'commission', label: 'Commission on sales' },
        { value: 'fixed_commission', label: 'Fixed + commission' },
        { value: 'package', label: 'Package' },
      ],
    },
    { key: 'placement', label: 'Placement', type: 'text' },
  ],
  columns: [
    { key: 'reference', label: 'Campaign', type: 'text', search: true },
    { key: 'title', label: 'Title', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'model', label: 'Pricing', type: 'status' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'impressions', label: 'Impressions', type: 'int' },
    { key: 'clicks', label: 'Taps', type: 'int' },
    { key: 'ctr', label: 'Tap rate', type: 'percent' },
    { key: 'enquiries', label: 'Enquiries', type: 'int' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'order_value', label: 'Order value', type: 'money' },
    { key: 'commission', label: 'Commission', type: 'money' },
    { key: 'paid', label: 'Shop paid', type: 'money' },
  ],
  defaultSort: { key: 'impressions', dir: 'desc' },
  summary: [
    { key: 'impressions', label: 'Impressions', type: 'int', sql: 'COALESCE(SUM(r.impressions), 0)' },
    { key: 'clicks', label: 'Taps', type: 'int', sql: 'COALESCE(SUM(r.clicks), 0)' },
    { key: 'ctr', label: 'Tap rate', type: 'percent', sql: 'ROUND(100.0 * SUM(r.clicks) / NULLIF(SUM(r.impressions), 0), 2)' },
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'order_value', label: 'Order value', type: 'money', sql: 'COALESCE(SUM(r.order_value), 0)' },
    { key: 'revenue', label: 'Ad revenue', type: 'money', sql: 'COALESCE(SUM(r.commission + r.paid), 0)' },
  ],
  notes: 'Counts are for the range (taps marked "don\'t bill" in Ad Tap Review are already taken out). Shop paid = ad payments marked paid in the range. Campaigns with no activity and no payment in the range are left out.',
  sql: (ctx) => {
    const { f, p, inRange } = ctx;
    const w = [];
    if (f.shop != null) w.push(`c.vendor_id = ${p(f.shop)}`);
    if (f.status) w.push(`c.status = ${p(f.status)}`);
    if (f.model) w.push(`c.model = ${p(f.model)}`);
    const placement = f.placement ? `AND s.placement ILIKE ${p(`%${f.placement}%`)}` : '';
    return `
      WITH st AS (
        SELECT s.campaign_id, SUM(s.impressions) AS impressions, SUM(s.clicks) AS clicks, SUM(s.enquiries) AS enquiries,
               SUM(s.orders) AS orders, SUM(s.order_value_cents) AS order_value, SUM(s.commission_cents) AS commission
        FROM ad_stats_daily s WHERE s.day BETWEEN ${DAYS(ctx)} ${placement} GROUP BY s.campaign_id
      ),
      pay AS (
        SELECT campaign_id, SUM(amount_cents) AS paid FROM ad_payments
        WHERE status = 'paid' AND ${inRange('COALESCE(paid_at, created_at)')} GROUP BY campaign_id
      )
      SELECT c.reference, c.title, v.business_name AS shop, c.model, c.status,
             COALESCE(st.impressions, 0) AS impressions, COALESCE(st.clicks, 0) AS clicks,
             ROUND(100.0 * st.clicks / NULLIF(st.impressions, 0), 2) AS ctr,
             COALESCE(st.enquiries, 0) AS enquiries, COALESCE(st.orders, 0) AS orders,
             COALESCE(st.order_value, 0) AS order_value, COALESCE(st.commission, 0) AS commission,
             COALESCE(pay.paid, 0) AS paid
      FROM ad_campaigns c
      JOIN vendor_profiles v ON v.id = c.vendor_id
      LEFT JOIN st ON st.campaign_id = c.id
      LEFT JOIN pay ON pay.campaign_id = c.id
      WHERE (st.campaign_id IS NOT NULL OR pay.campaign_id IS NOT NULL) ${and(w)}`;
  },
};

const offers = {
  key: 'offer-campaigns',
  group: 'marketing',
  title: 'Offer campaigns',
  description: 'Each discount campaign (Offers & Campaigns): orders it applied to in the range, discount given, who paid for it, and budget used.',
  keywords: ['offers', 'campaigns', 'discount campaign', 'sale', 'festival offer', 'budget'],
  filters: [
    {
      key: 'state',
      label: 'State',
      type: 'select',
      options: [
        { value: 'active', label: 'Active' },
        { value: 'paused', label: 'Paused' },
        { value: 'ended', label: 'Ended' },
        { value: 'draft', label: 'Draft' },
      ],
    },
    {
      key: 'funded',
      label: 'Paid for by',
      type: 'select',
      options: [
        { value: 'platform', label: 'Gloaro' },
        { value: 'vendor', label: 'Shops' },
        { value: 'shared', label: 'Shared' },
      ],
    },
  ],
  columns: [
    { key: 'name', label: 'Campaign', type: 'text', search: true },
    { key: 'scope', label: 'For', type: 'status' },
    { key: 'discount', label: 'Discount', type: 'text' },
    { key: 'funded_by', label: 'Paid by', type: 'status' },
    { key: 'state', label: 'State', type: 'status' },
    { key: 'starts_at', label: 'Starts', type: 'datetime' },
    { key: 'ends_at', label: 'Ends', type: 'datetime' },
    { key: 'shops', label: 'Shops in', type: 'int' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'order_value', label: 'Order value', type: 'money' },
    { key: 'discount_given', label: 'Discount given', type: 'money' },
    { key: 'platform_cost', label: 'Gloaro paid', type: 'money' },
    { key: 'shop_cost', label: 'Shops paid', type: 'money' },
    { key: 'budget_used', label: 'Budget used', type: 'percent' },
  ],
  defaultSort: { key: 'discount_given', dir: 'desc' },
  summary: [
    { key: 'campaigns', label: 'Campaigns', type: 'int', sql: 'COUNT(*)' },
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'discount', label: 'Discount given', type: 'money', sql: 'COALESCE(SUM(r.discount_given), 0)' },
    { key: 'platform', label: 'Gloaro paid', type: 'money', sql: 'COALESCE(SUM(r.platform_cost), 0)' },
  ],
  notes: 'Orders placed in the range that got the campaign discount (paid, not cancelled). Budget used is over the campaign\'s whole life, not just the range. Campaigns that overlap the range are listed even with no orders.',
  sql: ({ f, p, inRange, range }) => {
    const w = [];
    if (f.state) w.push(`c.state = ${p(f.state)}`);
    if (f.funded) w.push(`c.funded_by = ${p(f.funded)}`);
    const sale = `o.replacement_of_order_id IS NULL AND o.status <> 'cancelled' AND ${PAID}`;
    return `
      WITH used AS (
        SELECT oc.campaign_id, COUNT(*) AS orders, SUM(o.total_cents) AS order_value, SUM(oc.discount_cents) AS discount_given,
               SUM(oc.platform_cents) AS platform_cost, SUM(oc.vendor_cents) AS shop_cost
        FROM order_campaigns oc JOIN orders o ON o.id = oc.order_id
        WHERE ${sale} AND ${inRange('o.created_at')} GROUP BY oc.campaign_id
      ),
      life AS (
        SELECT oc.campaign_id, SUM(oc.discount_cents) AS spent
        FROM order_campaigns oc JOIN orders o ON o.id = oc.order_id WHERE o.status <> 'cancelled' GROUP BY oc.campaign_id
      )
      SELECT c.name, c.scope,
             CASE c.discount_type WHEN 'percentage' THEN c.discount_value::text || '% off'
                  WHEN 'flat' THEN '₹' || to_char(c.discount_value / 100.0, 'FM999999990.00') || ' off' ELSE 'Free delivery' END AS discount,
             c.funded_by, c.state, c.starts_at, c.ends_at,
             (SELECT COUNT(*) FROM campaign_participants cp WHERE cp.campaign_id = c.id AND cp.opted_in) AS shops,
             COALESCE(used.orders, 0) AS orders, COALESCE(used.order_value, 0) AS order_value,
             COALESCE(used.discount_given, 0) AS discount_given, COALESCE(used.platform_cost, 0) AS platform_cost,
             COALESCE(used.shop_cost, 0) AS shop_cost,
             ROUND(100.0 * life.spent / NULLIF(c.budget_cents, 0), 1) AS budget_used
      FROM campaigns c
      LEFT JOIN used ON used.campaign_id = c.id
      LEFT JOIN life ON life.campaign_id = c.id
      WHERE (used.campaign_id IS NOT NULL
             OR (c.starts_at < ((${p(range.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
                 AND c.ends_at >= (${p(range.from)}::date::timestamp AT TIME ZONE 'Asia/Kolkata')))
            ${and(w)}`;
  },
};

const WA_GROUPS = {
  template: `COALESCE(m.template_name, CASE WHEN m.kind = 'text' THEN 'Free text' ELSE '—' END)`,
  event: `COALESCE(m.event, 'Sent by hand')`,
  day: `to_char(m.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`,
};

const whatsapp = {
  key: 'whatsapp-messages',
  group: 'marketing',
  title: 'WhatsApp messages',
  description: 'WhatsApp messages sent in the range by template, event or day: sent, delivered, read, failed, and delivery / read rates.',
  keywords: ['whatsapp', 'messages', 'templates', 'delivery rate', 'read rate', 'ultramsg', 'notifications'],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      default: 'template',
      options: [
        { value: 'template', label: 'Template' },
        { value: 'event', label: 'Event (order placed, shipped…)' },
        { value: 'day', label: 'Day' },
      ],
    },
    {
      key: 'audience',
      label: 'Sent to',
      type: 'select',
      options: [
        { value: 'customer', label: 'Customers' },
        { value: 'vendor', label: 'Shops' },
      ],
    },
  ],
  columns: [
    { key: 'name', label: 'Group', type: 'text', search: true },
    { key: 'messages', label: 'Messages', type: 'int' },
    { key: 'delivered', label: 'Delivered', type: 'int' },
    { key: 'read', label: 'Read', type: 'int' },
    { key: 'failed', label: 'Failed', type: 'int' },
    { key: 'waiting', label: 'Queued / sending', type: 'int' },
    { key: 'delivery_rate', label: 'Delivery rate', type: 'percent' },
    { key: 'read_rate', label: 'Read rate', type: 'percent' },
    { key: 'top_error', label: 'Most common error', type: 'text' },
  ],
  defaultSort: { key: 'messages', dir: 'desc' },
  summary: [
    { key: 'messages', label: 'Messages', type: 'int', sql: 'COALESCE(SUM(r.messages), 0)' },
    { key: 'delivered', label: 'Delivered', type: 'int', sql: 'COALESCE(SUM(r.delivered), 0)' },
    { key: 'failed', label: 'Failed', type: 'int', sql: 'COALESCE(SUM(r.failed), 0)' },
    { key: 'delivery_rate', label: 'Delivery rate', type: 'percent', sql: 'ROUND(100.0 * SUM(r.delivered) / NULLIF(SUM(r.messages), 0), 1)' },
  ],
  notes: 'Messages sent out (not replies received, not skipped). Delivered includes read. A provider that doesn\'t report delivery (UltraMsg) leaves messages at "sent".',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.audience) w.push(`u.role = ${p(f.audience)}`);
    return `
      SELECT ${WA_GROUPS[f.groupBy]} AS name,
             COUNT(*) AS messages,
             COUNT(*) FILTER (WHERE m.status IN ('delivered', 'read') OR m.delivered_at IS NOT NULL) AS delivered,
             COUNT(*) FILTER (WHERE m.status = 'read' OR m.read_at IS NOT NULL) AS read,
             COUNT(*) FILTER (WHERE m.status = 'failed') AS failed,
             COUNT(*) FILTER (WHERE m.status IN ('queued', 'sending')) AS waiting,
             ROUND(100.0 * COUNT(*) FILTER (WHERE m.status IN ('delivered', 'read') OR m.delivered_at IS NOT NULL) / NULLIF(COUNT(*), 0), 1) AS delivery_rate,
             ROUND(100.0 * COUNT(*) FILTER (WHERE m.status = 'read' OR m.read_at IS NOT NULL) / NULLIF(COUNT(*), 0), 1) AS read_rate,
             mode() WITHIN GROUP (ORDER BY COALESCE(m.error_message, m.error_code)) FILTER (WHERE m.status = 'failed') AS top_error
      FROM whatsapp_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.direction = 'out' AND m.status <> 'skipped' AND ${inRange('m.created_at')} ${and(w)}
      GROUP BY 1`;
  },
};

const appNotifications = {
  key: 'app-notifications',
  group: 'marketing',
  title: 'App notifications',
  description: 'In-app notifications sent in the range by type: how many, to how many people, and how many were opened.',
  keywords: ['notifications', 'in-app', 'bell', 'alerts', 'opened', 'read rate'],
  filters: [
    {
      key: 'audience',
      label: 'Sent to',
      type: 'select',
      options: [
        { value: 'customer', label: 'Customers' },
        { value: 'vendor', label: 'Shops' },
        { value: 'admin', label: 'Admins' },
      ],
    },
  ],
  columns: [
    { key: 'type', label: 'Type', type: 'status', search: true },
    { key: 'sent', label: 'Sent', type: 'int' },
    { key: 'people', label: 'People', type: 'int' },
    { key: 'opened', label: 'Opened', type: 'int' },
    { key: 'open_rate', label: 'Open rate', type: 'percent' },
    { key: 'last_sent', label: 'Last sent', type: 'datetime' },
  ],
  defaultSort: { key: 'sent', dir: 'desc' },
  summary: [
    { key: 'sent', label: 'Sent', type: 'int', sql: 'COALESCE(SUM(r.sent), 0)' },
    { key: 'opened', label: 'Opened', type: 'int', sql: 'COALESCE(SUM(r.opened), 0)' },
    { key: 'open_rate', label: 'Open rate', type: 'percent', sql: 'ROUND(100.0 * SUM(r.opened) / NULLIF(SUM(r.sent), 0), 1)' },
  ],
  notes: 'Opened = marked read in the app.',
  sql: ({ f, p, inRange }) => `
    SELECT n.type, COUNT(*) AS sent, COUNT(DISTINCT n.user_id) AS people,
           COUNT(*) FILTER (WHERE n.read_at IS NOT NULL) AS opened,
           ROUND(100.0 * COUNT(*) FILTER (WHERE n.read_at IS NOT NULL) / NULLIF(COUNT(*), 0), 1) AS open_rate,
           MAX(n.created_at) AS last_sent
    FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE ${inRange('n.created_at')} ${f.audience ? `AND u.role = ${p(f.audience)}` : ''}
    GROUP BY n.type`,
};

const shopMessages = {
  key: 'shop-messages',
  group: 'marketing',
  title: 'Shop messages to followers',
  description: 'Messages and new-offer alerts each shop sent to its followers in the range, and how many people they reached.',
  keywords: ['broadcast', 'followers', 'shop messages', 'offer alerts', 'reach'],
  filters: [F.shop, { key: 'city', label: 'Shop city', type: 'city' }],
  columns: [
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'messages', label: 'Messages', type: 'int' },
    { key: 'message_reach', label: 'Message reach', type: 'int' },
    { key: 'offer_alerts', label: 'Offer alerts', type: 'int' },
    { key: 'alert_reach', label: 'Alert reach', type: 'int' },
    { key: 'followers', label: 'Followers now', type: 'int' },
    { key: 'last_sent', label: 'Last sent', type: 'datetime' },
  ],
  defaultSort: { key: 'message_reach', dir: 'desc' },
  summary: [
    { key: 'shops', label: 'Shops', type: 'int', sql: 'COUNT(*)' },
    { key: 'messages', label: 'Messages', type: 'int', sql: 'COALESCE(SUM(r.messages), 0)' },
    { key: 'alerts', label: 'Offer alerts', type: 'int', sql: 'COALESCE(SUM(r.offer_alerts), 0)' },
    { key: 'reach', label: 'People reached', type: 'int', sql: 'COALESCE(SUM(r.message_reach + r.alert_reach), 0)' },
  ],
  notes: 'Reach = followers each message or alert was sent to; one person reached twice counts twice.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`v.id = ${p(f.shop)}`);
    if (f.city) w.push(`LOWER(v.city) = LOWER(${p(f.city)})`);
    return `
      WITH b AS (SELECT vendor_id, COUNT(*) AS n, SUM(recipients) AS reach, MAX(created_at) AS last_at
                 FROM shop_broadcasts WHERE ${inRange('created_at')} GROUP BY vendor_id),
      a AS (SELECT vendor_id, COUNT(*) AS n, SUM(recipients) AS reach, MAX(sent_at) AS last_at
            FROM shop_offer_alerts WHERE ${inRange('sent_at')} GROUP BY vendor_id)
      SELECT v.business_name AS shop, v.city, COALESCE(b.n, 0) AS messages, COALESCE(b.reach, 0) AS message_reach,
             COALESCE(a.n, 0) AS offer_alerts, COALESCE(a.reach, 0) AS alert_reach,
             (SELECT COUNT(*) FROM shop_follows sf WHERE sf.vendor_id = v.id) AS followers,
             GREATEST(b.last_at, a.last_at) AS last_sent
      FROM vendor_profiles v LEFT JOIN b ON b.vendor_id = v.id LEFT JOIN a ON a.vendor_id = v.id
      WHERE (b.vendor_id IS NOT NULL OR a.vendor_id IS NOT NULL) ${and(w)}`;
  },
};

const referralCodes = {
  key: 'referral-signups',
  group: 'marketing',
  title: 'Referral code signups',
  description: 'Customers who signed up with a referral code in the range, by code: signups, how many ordered, and what they spent.',
  keywords: ['referral', 'invite', 'referral code', 'refer and earn', 'word of mouth'],
  filters: [{ key: 'ordered', label: 'Only codes whose signups ordered', type: 'select', options: [{ value: 'yes', label: 'Yes' }], outer: 'buyers_flag' }],
  columns: [
    { key: 'code', label: 'Code', type: 'text', search: true },
    { key: 'signups', label: 'Signups', type: 'int' },
    { key: 'buyers', label: 'Ordered', type: 'int' },
    { key: 'conversion', label: 'Signup → order', type: 'percent' },
    { key: 'spent', label: 'They spent', type: 'money' },
    { key: 'first_signup', label: 'First signup', type: 'datetime' },
    { key: 'last_signup', label: 'Last signup', type: 'datetime' },
  ],
  defaultSort: { key: 'signups', dir: 'desc' },
  summary: [
    { key: 'codes', label: 'Codes used', type: 'int', sql: 'COUNT(*)' },
    { key: 'signups', label: 'Signups', type: 'int', sql: 'COALESCE(SUM(r.signups), 0)' },
    { key: 'buyers', label: 'Ordered', type: 'int', sql: 'COALESCE(SUM(r.buyers), 0)' },
    { key: 'spent', label: 'They spent', type: 'money', sql: 'COALESCE(SUM(r.spent), 0)' },
  ],
  notes: 'The code typed at signup. Spent = all their real orders so far (paid, not cancelled). Business referrals between members are under Customers → Organisation.',
  sql: ({ inRange }) => `
    WITH spend AS (
      SELECT o.user_id, SUM(o.total_cents) AS spent FROM orders o
      WHERE o.replacement_of_order_id IS NULL AND o.status <> 'cancelled' AND ${PAID} GROUP BY o.user_id
    )
    SELECT UPPER(TRIM(u.referral_code_used)) AS code, COUNT(*) AS signups, COUNT(spend.user_id) AS buyers,
           ROUND(100.0 * COUNT(spend.user_id) / NULLIF(COUNT(*), 0), 1) AS conversion,
           COALESCE(SUM(spend.spent), 0) AS spent, MIN(u.created_at) AS first_signup, MAX(u.created_at) AS last_signup,
           CASE WHEN COUNT(spend.user_id) > 0 THEN 'yes' END AS buyers_flag
    FROM users u LEFT JOIN spend ON spend.user_id = u.id
    WHERE NULLIF(TRIM(u.referral_code_used), '') IS NOT NULL AND ${inRange('u.created_at')}
    GROUP BY 1`,
};

module.exports = { reports: [ads, offers, whatsapp, appNotifications, shopMessages, referralCodes] };
