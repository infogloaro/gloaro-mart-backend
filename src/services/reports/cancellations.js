/**
 * RP5 — Cancellations & returns reports.
 *
 * Cancelled orders follow the shop's own report (vendorReportCancellations,
 * VD21): an order counts when it went to "cancelled" (order_status_history),
 * who cancelled it is the approved cancellation request, else whoever moved
 * it. A return covers the whole order (there are no per-item returns).
 */
const { REASONS } = require('../cancellations');
const { CITY, F } = require('./sales');

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;
const labelCase = (col, map, fallback = col) =>
  `CASE ${col} ${Object.entries(map).map(([k, v]) => `WHEN ${sqlText(k)} THEN ${sqlText(v)}`).join(' ')} ELSE ${fallback} END`;

const RETURN_REASONS = {
  damaged: 'Damaged',
  wrong_item: 'Wrong item',
  not_as_described: 'Not as described',
  missing_items: 'Missing items',
  other: 'Other',
};
const WHO_OPTIONS = [
  { value: 'customer', label: 'Customer' },
  { value: 'vendor', label: 'Shop' },
  { value: 'admin', label: 'Admin' },
  { value: 'system', label: 'System (not accepted in time, unpaid…)' },
];
const CANCEL_REASON_OPTIONS = Object.entries(REASONS).map(([value, label]) => ({ value, label }));
const and = (w) => (w.length ? `AND ${w.join(' AND ')}` : '');

/** When each cancelled order was cancelled, by whom, why and at what stage. */
const CANCELLED = `
  SELECT o.*,
         COALESCE(h.created_at, o.updated_at) AS cancelled_at,
         COALESCE(oc.requested_by, h.actor_role, 'system') AS who,
         oc.reason_code, oc.reason_note, COALESCE(oc.order_status_at_request, h.from_status) AS stage,
         oc.fee_cents, oc.refund_cents
  FROM orders o
  LEFT JOIN LATERAL (
    SELECT hh.created_at, hh.actor_role, hh.from_status FROM order_status_history hh
    WHERE hh.order_id = o.id AND hh.to_status = 'cancelled' ORDER BY hh.id DESC LIMIT 1
  ) h ON TRUE
  LEFT JOIN LATERAL (
    SELECT * FROM order_cancellations c
    WHERE c.order_id = o.id AND c.status IN ('approved', 'auto_approved') ORDER BY c.id DESC LIMIT 1
  ) oc ON TRUE
  WHERE o.status = 'cancelled' AND o.replacement_of_order_id IS NULL`;

const cancelledOrders = {
  key: 'cancelled-orders',
  group: 'cancellations',
  title: 'Cancelled orders',
  description: 'Every order cancelled in the range: who cancelled it, why, at what stage, and the refund and fee.',
  keywords: ['cancel', 'cancellation', 'cancelled orders', 'reason', 'who cancelled'],
  filters: [
    { key: 'who', label: 'Cancelled by', type: 'select', options: WHO_OPTIONS },
    { key: 'reason', label: 'Reason', type: 'select', options: CANCEL_REASON_OPTIONS.concat([{ value: 'not_given', label: 'Not given' }]) },
    F.shop,
    F.payment,
    F.city,
  ],
  columns: [
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'placed_at', label: 'Placed', type: 'datetime' },
    { key: 'cancelled_at', label: 'Cancelled', type: 'datetime' },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'payment', label: 'Payment', type: 'status' },
    { key: 'stage', label: 'Stage when cancelled', type: 'status' },
    { key: 'who', label: 'Cancelled by', type: 'status' },
    { key: 'reason', label: 'Reason', type: 'text', search: true },
    { key: 'note', label: 'Note', type: 'text', search: true },
    { key: 'fee', label: 'Fee', type: 'money' },
    { key: 'refund', label: 'Refund', type: 'money' },
    { key: 'total', label: 'Order value', type: 'money' },
  ],
  defaultSort: { key: 'cancelled_at', dir: 'desc' },
  summary: [
    { key: 'orders', label: 'Cancelled orders', type: 'int', sql: 'COUNT(*)' },
    { key: 'value', label: 'Order value', type: 'money', sql: 'COALESCE(SUM(r.total), 0)' },
    { key: 'by_customer', label: 'By customers', type: 'int', sql: `COUNT(*) FILTER (WHERE r.who = 'customer')` },
    { key: 'by_shop', label: 'By shops', type: 'int', sql: `COUNT(*) FILTER (WHERE r.who = 'shop')` },
    { key: 'top_reason', label: 'Most common reason', type: 'text', sql: `mode() WITHIN GROUP (ORDER BY r.reason) FILTER (WHERE r.reason <> 'Not given')` },
    { key: 'fees', label: 'Fees charged', type: 'money', sql: 'COALESCE(SUM(r.fee), 0)' },
  ],
  notes: 'By the date the order was cancelled. "Cancelled by" is the approved cancellation request, else whoever moved the order to cancelled; System = not accepted in time or never paid.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.who) w.push(`c.who = ${p(f.who)}`);
    if (f.reason === 'not_given') w.push('c.reason_code IS NULL');
    else if (f.reason) w.push(`c.reason_code = ${p(f.reason)}`);
    if (f.shop != null) w.push(`c.vendor_id = ${p(f.shop)}`);
    if (f.payment === 'online_any') w.push(`c.payment_method NOT IN ('cod', 'credit')`);
    else if (f.payment) w.push(`c.payment_method = ${p(f.payment)}`);
    if (f.city) w.push(`LOWER(${CITY.replace(/\bo\./g, 'c.')}) = LOWER(${p(f.city)})`);
    return `
      SELECT c.id AS order_id, c.created_at AS placed_at, c.cancelled_at,
             COALESCE(NULLIF(TRIM(u.full_name), ''), u.email) AS customer, v.business_name AS shop,
             ${CITY.replace(/\bo\./g, 'c.')} AS city, c.payment_method AS payment, c.stage,
             CASE c.who WHEN 'vendor' THEN 'shop' ELSE c.who END AS who,
             ${labelCase('c.reason_code', REASONS, `'Not given'`)} AS reason, c.reason_note AS note,
             c.fee_cents AS fee, c.refund_cents AS refund, c.total_cents AS total
      FROM (${CANCELLED}) c
      JOIN users u ON u.id = c.user_id
      JOIN vendor_profiles v ON v.id = c.vendor_id
      LEFT JOIN addresses a ON a.id = c.address_id
      WHERE ${inRange('c.cancelled_at')} ${and(w)}`;
  },
};

const CANCEL_STATUS = [
  { value: 'requested', label: 'Waiting for a decision' },
  { value: 'approved', label: 'Approved' },
  { value: 'auto_approved', label: 'Approved automatically' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

const cancellationRequests = {
  key: 'cancellation-requests',
  group: 'cancellations',
  title: 'Cancellation requests',
  description: 'Every request to cancel — approved, rejected, withdrawn or still waiting — with who decided and when.',
  keywords: ['cancellation request', 'rejected cancellation', 'pending cancellation', 'approval'],
  filters: [
    { key: 'status', label: 'Status', type: 'select', options: CANCEL_STATUS },
    { key: 'who', label: 'Asked by', type: 'select', options: WHO_OPTIONS },
    { key: 'reason', label: 'Reason', type: 'select', options: CANCEL_REASON_OPTIONS },
    F.shop,
  ],
  columns: [
    { key: 'reference', label: 'Request', type: 'text', search: true },
    { key: 'requested_at', label: 'Asked', type: 'datetime' },
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'who', label: 'Asked by', type: 'status' },
    { key: 'stage', label: 'Order stage', type: 'status' },
    { key: 'reason', label: 'Reason', type: 'text', search: true },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'decided_at', label: 'Decided', type: 'datetime' },
    { key: 'decided_by', label: 'Decided by', type: 'text', search: true },
    { key: 'hours_to_decide', label: 'Hours to decide', type: 'number' },
    { key: 'fee', label: 'Fee', type: 'money' },
    { key: 'refund', label: 'Refund', type: 'money' },
  ],
  defaultSort: { key: 'requested_at', dir: 'desc' },
  summary: [
    { key: 'requests', label: 'Requests', type: 'int', sql: 'COUNT(*)' },
    { key: 'approved', label: 'Approved', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status IN ('approved', 'auto_approved'))` },
    { key: 'rejected', label: 'Rejected', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'rejected')` },
    { key: 'waiting', label: 'Waiting', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'requested')` },
    { key: 'avg_hours', label: 'Avg hours to decide', type: 'number', sql: 'ROUND(AVG(r.hours_to_decide), 1)' },
  ],
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.status) w.push(`c.status = ${p(f.status)}`);
    if (f.who) w.push(`c.requested_by = ${p(f.who)}`);
    if (f.reason) w.push(`c.reason_code = ${p(f.reason)}`);
    if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
    return `
      SELECT c.reference, c.created_at AS requested_at, c.order_id, v.business_name AS shop,
             CASE c.requested_by WHEN 'vendor' THEN 'shop' ELSE c.requested_by END AS who,
             c.order_status_at_request AS stage, ${labelCase('c.reason_code', REASONS)} AS reason, c.status,
             c.decided_at, COALESCE(NULLIF(TRIM(d.full_name), ''), d.email) AS decided_by,
             ROUND((EXTRACT(EPOCH FROM (c.decided_at - c.created_at)) / 3600)::numeric, 1) AS hours_to_decide,
             c.fee_cents AS fee, c.refund_cents AS refund
      FROM order_cancellations c
      JOIN orders o ON o.id = c.order_id
      JOIN vendor_profiles v ON v.id = o.vendor_id
      LEFT JOIN users d ON d.id = c.decided_by
      WHERE ${inRange('c.created_at')} ${and(w)}`;
  },
};

const RETURN_STATUS = [
  { value: 'requested', label: 'Requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'pickup_scheduled', label: 'Pickup scheduled' },
  { value: 'picked_up', label: 'Picked up' },
  { value: 'received', label: 'Received by shop' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const returns = {
  key: 'returns',
  group: 'cancellations',
  title: 'Returns',
  description: 'Every return asked for: order, customer, shop, reason, refund or replacement, condition, status and refund.',
  keywords: ['return', 'rto', 'refund request', 'damaged', 'wrong item', 'replacement'],
  filters: [
    { key: 'status', label: 'Status', type: 'select', options: RETURN_STATUS },
    { key: 'reason', label: 'Reason', type: 'select', options: Object.entries(RETURN_REASONS).map(([value, label]) => ({ value, label })) },
    {
      key: 'resolution',
      label: 'Customer wants',
      type: 'select',
      options: [
        { value: 'refund', label: 'Refund' },
        { value: 'replacement', label: 'Replacement' },
      ],
    },
    F.shop,
    F.category,
  ],
  columns: [
    { key: 'return_id', label: 'Return #', type: 'int', search: true },
    { key: 'requested_at', label: 'Asked', type: 'datetime' },
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'reason', label: 'Reason', type: 'text' },
    { key: 'comment', label: 'Comment', type: 'text', search: true },
    { key: 'resolution', label: 'Wants', type: 'status' },
    { key: 'condition', label: 'Condition', type: 'status' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'order_value', label: 'Order value', type: 'money' },
    { key: 'refund', label: 'Refund approved', type: 'money' },
  ],
  defaultSort: { key: 'requested_at', dir: 'desc' },
  summary: [
    { key: 'returns', label: 'Returns', type: 'int', sql: 'COUNT(*)' },
    { key: 'open', label: 'Still open', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status IN ('requested', 'approved', 'pickup_scheduled', 'picked_up', 'received', 'disputed'))` },
    { key: 'refunded', label: 'Refunded', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'refunded')` },
    { key: 'rejected', label: 'Rejected', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'rejected')` },
    { key: 'refund', label: 'Refund approved', type: 'money', sql: 'COALESCE(SUM(r.refund), 0)' },
    { key: 'top_reason', label: 'Most common reason', type: 'text', sql: 'mode() WITHIN GROUP (ORDER BY r.reason)' },
  ],
  notes: 'A return covers the whole order. Category = the order has at least one item in that category.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.status) w.push(`rt.status = ${p(f.status)}`);
    if (f.reason) w.push(`rt.reason_code = ${p(f.reason)}`);
    if (f.resolution) w.push(`rt.resolution = ${p(f.resolution)}`);
    if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
    if (f.category) {
      w.push(`EXISTS (SELECT 1 FROM order_items ci JOIN products cp ON cp.id = ci.product_id
                      WHERE ci.order_id = o.id AND LOWER(cp.category) = LOWER(${p(f.category)}))`);
    }
    return `
      SELECT rt.id AS return_id, rt.created_at AS requested_at, rt.order_id,
             COALESCE(NULLIF(TRIM(u.full_name), ''), u.email) AS customer, v.business_name AS shop,
             ${labelCase('rt.reason_code', RETURN_REASONS)} AS reason, rt.comment, rt.resolution, rt.condition, rt.status,
             o.total_cents AS order_value, rt.approved_refund_cents AS refund
      FROM order_returns rt
      JOIN orders o ON o.id = rt.order_id
      JOIN users u ON u.id = rt.user_id
      JOIN vendor_profiles v ON v.id = o.vendor_id
      WHERE ${inRange('rt.created_at')} ${and(w)}`;
  },
};

const RATE_GROUPS = {
  shop: { name: 'v.business_name', key: 'v.id' },
  category: { name: `COALESCE(NULLIF(TRIM(pr.category), ''), 'Other')`, key: `COALESCE(NULLIF(TRIM(pr.category), ''), 'Other')` },
  product: { name: 'MAX(oi.product_name_snapshot)', key: 'oi.product_id' },
};

const rates = {
  key: 'cancel-return-rate',
  group: 'cancellations',
  title: 'Cancellation & return rate',
  description: 'For each shop, category or product: orders, cancelled, delivered, returned, and the cancellation and return rates.',
  keywords: ['return rate', 'cancellation rate', 'quality', 'problem products', 'bad shops'],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      default: 'shop',
      options: [
        { value: 'shop', label: 'Shop' },
        { value: 'category', label: 'Category' },
        { value: 'product', label: 'Product' },
      ],
    },
    F.shop,
    F.category,
    { key: 'minOrders', label: 'At least N orders', type: 'number', outer: 'orders', op: 'gte' },
  ],
  columns: [
    { key: 'name', label: 'Group', type: 'text', search: true },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'cancelled', label: 'Cancelled', type: 'int' },
    { key: 'cancel_rate', label: 'Cancel rate', type: 'percent' },
    { key: 'delivered', label: 'Delivered', type: 'int' },
    { key: 'returned', label: 'Returned', type: 'int' },
    { key: 'return_rate', label: 'Return rate', type: 'percent' },
  ],
  defaultSort: { key: 'return_rate', dir: 'desc' },
  summary: [
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'cancel_rate', label: 'Cancel rate', type: 'percent', sql: 'ROUND(100.0 * SUM(r.cancelled) / NULLIF(SUM(r.orders), 0), 1)' },
    { key: 'return_rate', label: 'Return rate', type: 'percent', sql: 'ROUND(100.0 * SUM(r.returned) / NULLIF(SUM(r.delivered), 0), 1)' },
  ],
  notes: 'Orders placed in the range (free replacements left out). Cancel rate = cancelled ÷ orders; return rate = orders with a return request (not withdrawn) ÷ delivered orders. By category or product, an order counts once for each category / product in it, so groups don\'t add up to the shop totals.',
  sql: ({ f, p, inRange }) => {
    const g = RATE_GROUPS[f.groupBy];
    const byItems = f.groupBy !== 'shop';
    const w = [];
    if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
    if (f.category) {
      w.push(byItems
        ? `LOWER(pr.category) = LOWER(${p(f.category)})`
        : `EXISTS (SELECT 1 FROM order_items ci JOIN products cp ON cp.id = ci.product_id
                   WHERE ci.order_id = o.id AND LOWER(cp.category) = LOWER(${p(f.category)}))`);
    }
    const returned = `EXISTS (SELECT 1 FROM order_returns rt WHERE rt.order_id = o.id AND rt.status <> 'cancelled')`;
    return `
      SELECT ${g.name} AS name,
             COUNT(DISTINCT o.id) AS orders,
             COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'cancelled') AS cancelled,
             ROUND(100.0 * COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'cancelled') / NULLIF(COUNT(DISTINCT o.id), 0), 1) AS cancel_rate,
             COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered') AS delivered,
             COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered' AND ${returned}) AS returned,
             ROUND(100.0 * COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered' AND ${returned})
                   / NULLIF(COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered'), 0), 1) AS return_rate
      FROM orders o
      JOIN vendor_profiles v ON v.id = o.vendor_id
      ${byItems ? 'JOIN order_items oi ON oi.order_id = o.id LEFT JOIN products pr ON pr.id = oi.product_id' : ''}
      WHERE o.replacement_of_order_id IS NULL AND ${inRange('o.created_at')} ${and(w)}
      GROUP BY ${g.key}${f.groupBy === 'shop' ? ', v.business_name' : ''}`;
  },
};

module.exports = { reports: [cancelledOrders, cancellationRequests, returns, rates] };
