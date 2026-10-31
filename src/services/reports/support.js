/**
 * RP11 — Reviews & support reports: all reviews, low-rated products,
 * reported reviews, support tickets and a support summary.
 *
 * Reviews live in two places: vendor_reviews (moderated shop and product
 * reviews, the current flow) and product_reviews (the older quick product
 * rating). Both are listed; the older ones show as published.
 */
const { F } = require('./sales');

const and = (w) => (w.length ? `AND ${w.join(' AND ')}` : '');
const NAME = (alias) => `COALESCE(NULLIF(TRIM(${alias}.full_name), ''), ${alias}.email)`;

/** Every review with the same columns, from both tables. */
const ALL_REVIEWS = `
  SELECT vr.id, 'vr' AS src, vr.target AS kind, vr.vendor_id, vr.product_id, vr.user_id, vr.rating, vr.title, vr.comment,
         vr.status, vr.vendor_reply, vr.created_at
  FROM vendor_reviews vr
  UNION ALL
  SELECT pr.id, 'pr', 'product', p.vendor_id, pr.product_id, pr.user_id, pr.rating, NULL, pr.comment,
         'published', NULL, pr.created_at
  FROM product_reviews pr JOIN products p ON p.id = pr.product_id`;

const reviews = {
  key: 'reviews',
  group: 'support',
  title: 'Product & shop reviews',
  description: 'Every review written in the range: product or shop, customer, stars, comment, moderation status, shop reply and reports.',
  keywords: ['reviews', 'ratings', 'stars', 'feedback', 'comments', 'moderation'],
  filters: [
    {
      key: 'kind',
      label: 'Review of',
      type: 'select',
      options: [
        { value: 'product', label: 'Products' },
        { value: 'vendor', label: 'Shops' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'published', label: 'Published' },
        { value: 'pending', label: 'Waiting moderation' },
        { value: 'rejected', label: 'Rejected' },
      ],
    },
    F.shop,
    { key: 'maxRating', label: 'Stars at most', type: 'number', outer: 'rating', op: 'lte' },
    { key: 'minRating', label: 'Stars at least', type: 'number', outer: 'rating', op: 'gte' },
    {
      key: 'replied',
      label: 'Shop replied',
      type: 'select',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'Not yet' },
      ],
      outer: 'replied',
    },
  ],
  columns: [
    { key: 'written_at', label: 'Written', type: 'datetime' },
    { key: 'kind', label: 'Of', type: 'status' },
    { key: 'product', label: 'Product', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'rating', label: 'Stars', type: 'int' },
    { key: 'comment', label: 'Review', type: 'text', search: true },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'replied', label: 'Replied', type: 'status' },
    { key: 'reports', label: 'Reported', type: 'int' },
  ],
  defaultSort: { key: 'written_at', dir: 'desc' },
  summary: [
    { key: 'reviews', label: 'Reviews', type: 'int', sql: 'COUNT(*)' },
    { key: 'average', label: 'Average', type: 'number', sql: `ROUND(AVG(r.rating) FILTER (WHERE r.status = 'published'), 1)` },
    { key: 'low', label: '1–2★', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.rating <= 2)' },
    { key: 'waiting', label: 'Waiting moderation', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'pending')` },
    { key: 'replied', label: 'Shop replied', type: 'percent', sql: `ROUND(100.0 * COUNT(*) FILTER (WHERE r.replied = 'yes') / NULLIF(COUNT(*), 0), 1)` },
  ],
  notes: 'Average counts published reviews only. Reported = times customers flagged the review (shop and product reviews in the moderated flow).',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.kind) w.push(`a.kind = ${p(f.kind)}`);
    if (f.status) w.push(`a.status = ${p(f.status)}`);
    if (f.shop != null) w.push(`a.vendor_id = ${p(f.shop)}`);
    return `
      SELECT a.created_at AS written_at, CASE a.kind WHEN 'vendor' THEN 'shop' ELSE a.kind END AS kind,
             pr.name AS product, v.business_name AS shop, ${NAME('u')} AS customer, a.rating,
             NULLIF(CONCAT_WS(' — ', a.title, a.comment), '') AS comment, a.status,
             CASE WHEN a.vendor_reply IS NOT NULL THEN 'yes' ELSE 'no' END AS replied,
             CASE WHEN a.src = 'vr' THEN (SELECT COUNT(*) FROM review_reports rr WHERE rr.review_id = a.id) ELSE 0 END AS reports
      FROM (${ALL_REVIEWS}) a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN vendor_profiles v ON v.id = a.vendor_id
      LEFT JOIN products pr ON pr.id = a.product_id
      WHERE ${inRange('a.created_at')} ${and(w)}`;
  },
};

const lowRated = {
  key: 'low-rated-products',
  group: 'support',
  title: 'Low-rated products',
  description: 'Products whose average from reviews written in the range is at or below a level, with 1–2★ count and the latest comment.',
  keywords: ['bad reviews', 'low rating', 'poor quality', 'complaints', 'worst products'],
  filters: [
    {
      key: 'below',
      label: 'Average at most',
      type: 'select',
      default: '3',
      options: [
        { value: '2', label: '2★' },
        { value: '3', label: '3★' },
        { value: '4', label: '4★' },
      ],
    },
    { key: 'minReviews', label: 'At least N reviews', type: 'number', outer: 'reviews', op: 'gte' },
    F.shop,
    F.category,
  ],
  columns: [
    { key: 'product', label: 'Product', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'category', label: 'Category', type: 'text', search: true },
    { key: 'reviews', label: 'Reviews', type: 'int' },
    { key: 'average', label: 'Average', type: 'number' },
    { key: 'low', label: '1–2★', type: 'int' },
    { key: 'latest', label: 'Latest comment', type: 'text', search: true },
    { key: 'is_live', label: 'In the app', type: 'status' },
  ],
  defaultSort: { key: 'average', dir: 'asc' },
  summary: [
    { key: 'products', label: 'Products', type: 'int', sql: 'COUNT(*)' },
    { key: 'live', label: 'Still in the app', type: 'int', sql: `COUNT(*) FILTER (WHERE r.is_live = 'yes')` },
    { key: 'low', label: '1–2★ reviews', type: 'int', sql: 'COALESCE(SUM(r.low), 0)' },
  ],
  notes: 'Published product reviews written in the range.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`pr.vendor_id = ${p(f.shop)}`);
    if (f.category) w.push(`LOWER(pr.category) = LOWER(${p(f.category)})`);
    return `
      SELECT pr.name AS product, v.business_name AS shop, COALESCE(NULLIF(TRIM(pr.category), ''), 'Other') AS category,
             COUNT(*) AS reviews, ROUND(AVG(a.rating), 1) AS average, COUNT(*) FILTER (WHERE a.rating <= 2) AS low,
             (ARRAY_AGG(a.comment ORDER BY a.created_at DESC) FILTER (WHERE NULLIF(TRIM(a.comment), '') IS NOT NULL))[1] AS latest,
             CASE WHEN pr.is_active AND pr.moderation_status = 'approved' THEN 'yes' ELSE 'no' END AS is_live
      FROM (${ALL_REVIEWS}) a
      JOIN products pr ON pr.id = a.product_id
      JOIN vendor_profiles v ON v.id = pr.vendor_id
      WHERE a.kind = 'product' AND a.status = 'published' AND ${inRange('a.created_at')} ${and(w)}
      GROUP BY pr.id, pr.name, v.business_name, pr.category, pr.is_active, pr.moderation_status
      HAVING AVG(a.rating) <= ${p(Number(f.below))}`;
  },
};

const reportedReviews = {
  key: 'reported-reviews',
  group: 'support',
  title: 'Reported reviews',
  description: 'Reviews customers flagged in the range: the review, why it was flagged, and whether the report was upheld or dismissed.',
  keywords: ['flagged reviews', 'abuse', 'fake reviews', 'review reports', 'spam'],
  filters: [
    {
      key: 'resolution',
      label: 'Outcome',
      type: 'select',
      options: [
        { value: 'open', label: 'Not handled yet' },
        { value: 'upheld', label: 'Upheld (review taken down)' },
        { value: 'dismissed', label: 'Dismissed' },
      ],
      outer: 'outcome',
    },
    F.shop,
  ],
  columns: [
    { key: 'reported_at', label: 'Reported', type: 'datetime' },
    { key: 'reason', label: 'Reason', type: 'text', search: true },
    { key: 'reporter', label: 'Reported by', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'rating', label: 'Stars', type: 'int' },
    { key: 'review', label: 'Review', type: 'text', search: true },
    { key: 'outcome', label: 'Outcome', type: 'status' },
    { key: 'handled_by', label: 'Handled by', type: 'text' },
    { key: 'handled_at', label: 'Handled', type: 'datetime' },
  ],
  defaultSort: { key: 'reported_at', dir: 'desc' },
  summary: [
    { key: 'reports', label: 'Reports', type: 'int', sql: 'COUNT(*)' },
    { key: 'open', label: 'Not handled', type: 'int', sql: `COUNT(*) FILTER (WHERE r.outcome = 'open')` },
    { key: 'upheld', label: 'Upheld', type: 'int', sql: `COUNT(*) FILTER (WHERE r.outcome = 'upheld')` },
  ],
  sql: ({ f, p, inRange }) => `
    SELECT rr.created_at AS reported_at, rr.reason, ${NAME('u')} AS reporter, v.business_name AS shop, vr.rating,
           NULLIF(CONCAT_WS(' — ', vr.title, vr.comment), '') AS review, COALESCE(rr.resolution, 'open') AS outcome,
           ${NAME('h')} AS handled_by, rr.resolved_at AS handled_at
    FROM review_reports rr
    JOIN vendor_reviews vr ON vr.id = rr.review_id
    JOIN vendor_profiles v ON v.id = vr.vendor_id
    JOIN users u ON u.id = rr.user_id
    LEFT JOIN users h ON h.id = rr.resolved_by
    WHERE ${inRange('rr.created_at')} ${f.shop != null ? `AND vr.vendor_id = ${p(f.shop)}` : ''}`,
};

const TICKET_STATUS = [
  { value: 'open', label: 'Open' },
  { value: 'pending_customer', label: 'Waiting for customer' },
  { value: 'pending_vendor', label: 'Waiting for shop' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];
const TICKET_CATEGORY = ['order', 'payment', 'delivery', 'vendor', 'product', 'account', 'other'].map((value) => ({
  value,
  label: value === 'vendor' ? 'Shop' : value.charAt(0).toUpperCase() + value.slice(1),
}));
const PRIORITY = ['low', 'normal', 'high', 'urgent'].map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));
const OPEN = `('open', 'pending_customer', 'pending_vendor')`;
/** Ticket SLA, per ticket: met / missed / due / no target. */
const SLA = (col, due) => `CASE WHEN t.${due} IS NULL THEN 'no target'
  WHEN t.${col} IS NOT NULL THEN CASE WHEN t.${col} <= t.${due} THEN 'met' ELSE 'missed' END
  WHEN now() > t.${due} THEN 'missed' ELSE 'due' END`;

const ticketWhere = (f, p) => {
  const w = [];
  if (f.status) w.push(`t.status = ${p(f.status)}`);
  if (f.category) w.push(`t.category = ${p(f.category)}`);
  if (f.priority) w.push(`t.priority = ${p(f.priority)}`);
  if (f.requester) w.push(`t.requester_type = ${p(f.requester)}`);
  if (f.shop != null) w.push(`t.vendor_id = ${p(f.shop)}`);
  return w;
};
const TICKET_FILTERS = [
  { key: 'status', label: 'Status', type: 'select', options: TICKET_STATUS },
  { key: 'category', label: 'About', type: 'select', options: TICKET_CATEGORY },
  { key: 'priority', label: 'Priority', type: 'select', options: PRIORITY },
  {
    key: 'requester',
    label: 'Raised by',
    type: 'select',
    options: [
      { value: 'customer', label: 'Customer' },
      { value: 'vendor', label: 'Shop' },
    ],
  },
  F.shop,
];

const tickets = {
  key: 'support-tickets',
  group: 'support',
  title: 'Support tickets',
  description: 'Every ticket opened in the range: who raised it, about what, priority, status, who has it, first response and resolution times against target.',
  keywords: ['support', 'tickets', 'helpdesk', 'complaints', 'sla', 'customer service'],
  filters: [...TICKET_FILTERS, { key: 'assignee', label: 'Assigned to contains', type: 'text', outer: 'assignee', op: 'ilike' }],
  columns: [
    { key: 'reference', label: 'Ticket', type: 'text', search: true },
    { key: 'opened_at', label: 'Opened', type: 'datetime' },
    { key: 'requester', label: 'Raised by', type: 'text', search: true },
    { key: 'requester_type', label: 'Who', type: 'status' },
    { key: 'subject', label: 'Subject', type: 'text', search: true },
    { key: 'category', label: 'About', type: 'status' },
    { key: 'priority', label: 'Priority', type: 'status' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'assignee', label: 'Assigned to', type: 'text', search: true },
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'first_response_hours', label: 'First reply (h)', type: 'number' },
    { key: 'first_response_sla', label: 'Reply target', type: 'status' },
    { key: 'resolution_hours', label: 'Resolved in (h)', type: 'number' },
    { key: 'resolution_sla', label: 'Resolve target', type: 'status' },
  ],
  defaultSort: { key: 'opened_at', dir: 'desc' },
  summary: [
    { key: 'tickets', label: 'Tickets', type: 'int', sql: 'COUNT(*)' },
    { key: 'open', label: 'Still open', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status IN ${OPEN})` },
    { key: 'avg_first', label: 'Avg first reply (h)', type: 'number', sql: 'ROUND(AVG(r.first_response_hours), 1)' },
    { key: 'avg_resolve', label: 'Avg resolve (h)', type: 'number', sql: 'ROUND(AVG(r.resolution_hours), 1)' },
    { key: 'missed', label: 'Missed a target', type: 'int', sql: `COUNT(*) FILTER (WHERE r.first_response_sla = 'missed' OR r.resolution_sla = 'missed')` },
  ],
  notes: 'Times are in hours from opening. A target is "missed" once its due time passes without a reply / resolution, even if the ticket is still open.',
  sql: ({ f, p, inRange }) => `
    SELECT t.reference, t.created_at AS opened_at, ${NAME('u')} AS requester, t.requester_type, t.subject, t.category,
           t.priority, t.status, ${NAME('ag')} AS assignee, t.order_id,
           ROUND((EXTRACT(EPOCH FROM (t.first_responded_at - t.created_at)) / 3600)::numeric, 1) AS first_response_hours,
           ${SLA('first_responded_at', 'first_response_due_at')} AS first_response_sla,
           ROUND((EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600)::numeric, 1) AS resolution_hours,
           ${SLA('resolved_at', 'resolution_due_at')} AS resolution_sla
    FROM support_tickets t
    JOIN users u ON u.id = t.requester_user_id
    LEFT JOIN users ag ON ag.id = t.assignee_id
    WHERE ${inRange('t.created_at')} ${and(ticketWhere(f, p))}`,
};

const SUMMARY_GROUPS = {
  category: `CASE t.category WHEN 'vendor' THEN 'Shop' ELSE INITCAP(t.category) END`,
  priority: 'INITCAP(t.priority)',
  assignee: `COALESCE(${NAME('ag')}, 'Not assigned')`,
  requester: `CASE t.requester_type WHEN 'vendor' THEN 'Shops' ELSE 'Customers' END`,
  day: `to_char(t.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`,
};

const supportSummary = {
  key: 'support-summary',
  group: 'support',
  title: 'Support summary',
  description: 'Tickets by topic, priority, agent, who raised them or day: opened, still open, resolved, average reply and resolve times, targets met.',
  keywords: ['support kpi', 'agent performance', 'ticket volume', 'sla report', 'helpdesk summary'],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      default: 'category',
      options: [
        { value: 'category', label: 'About (topic)' },
        { value: 'priority', label: 'Priority' },
        { value: 'assignee', label: 'Assigned to' },
        { value: 'requester', label: 'Raised by' },
        { value: 'day', label: 'Day' },
      ],
    },
    ...TICKET_FILTERS.filter((x) => x.key !== 'status'),
  ],
  columns: [
    { key: 'name', label: 'Group', type: 'text', search: true },
    { key: 'tickets', label: 'Tickets', type: 'int' },
    { key: 'open', label: 'Still open', type: 'int' },
    { key: 'resolved', label: 'Resolved / closed', type: 'int' },
    { key: 'avg_first', label: 'Avg first reply (h)', type: 'number' },
    { key: 'avg_resolve', label: 'Avg resolve (h)', type: 'number' },
    { key: 'reply_target_met', label: 'Reply target met', type: 'percent' },
    { key: 'resolve_target_met', label: 'Resolve target met', type: 'percent' },
  ],
  defaultSort: { key: 'tickets', dir: 'desc' },
  summary: [
    { key: 'tickets', label: 'Tickets', type: 'int', sql: 'COALESCE(SUM(r.tickets), 0)' },
    { key: 'open', label: 'Still open', type: 'int', sql: 'COALESCE(SUM(r.open), 0)' },
    { key: 'resolved', label: 'Resolved / closed', type: 'int', sql: 'COALESCE(SUM(r.resolved), 0)' },
  ],
  notes: 'Target met = replied / resolved by the due time, out of tickets that had a target and are past it or done.',
  sql: ({ f, p, inRange }) => `
    WITH t AS (
      SELECT t.*, ${SLA('first_responded_at', 'first_response_due_at')} AS reply_sla,
             ${SLA('resolved_at', 'resolution_due_at')} AS resolve_sla
      FROM support_tickets t WHERE ${inRange('t.created_at')} ${and(ticketWhere(f, p))}
    )
    SELECT ${SUMMARY_GROUPS[f.groupBy]} AS name, COUNT(*) AS tickets,
           COUNT(*) FILTER (WHERE t.status IN ${OPEN}) AS open,
           COUNT(*) FILTER (WHERE t.status IN ('resolved', 'closed')) AS resolved,
           ROUND(AVG(EXTRACT(EPOCH FROM (t.first_responded_at - t.created_at)) / 3600)::numeric, 1) AS avg_first,
           ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600)::numeric, 1) AS avg_resolve,
           ROUND(100.0 * COUNT(*) FILTER (WHERE t.reply_sla = 'met') / NULLIF(COUNT(*) FILTER (WHERE t.reply_sla IN ('met', 'missed')), 0), 1) AS reply_target_met,
           ROUND(100.0 * COUNT(*) FILTER (WHERE t.resolve_sla = 'met') / NULLIF(COUNT(*) FILTER (WHERE t.resolve_sla IN ('met', 'missed')), 0), 1) AS resolve_target_met
    FROM t LEFT JOIN users ag ON ag.id = t.assignee_id
    GROUP BY 1`,
};

module.exports = { reports: [reviews, lowRated, reportedReviews, tickets, supportSummary] };
