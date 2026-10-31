/**
 * RP2 — Payments & money reports: payment modes, online payments, refunds,
 * shop settlements, commission, the customer wallet and reward points
 * ledgers, and coupon usage.
 */
const { PAID, F, orderWhere } = require('./sales');

const METHOD_LABEL = (col) => `CASE ${col}
  WHEN 'cod' THEN 'Cash on delivery' WHEN 'upi' THEN 'UPI' WHEN 'card' THEN 'Card'
  WHEN 'netbanking' THEN 'Netbanking' WHEN 'wallet' THEN 'Wallet' WHEN 'online' THEN 'Online (Razorpay)'
  WHEN 'credit' THEN 'Business credit' ELSE ${col} END`;
const CUSTOMER = `COALESCE(NULLIF(TRIM(u.full_name), ''), u.email)`;

const ONLINE_METHODS = [
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'netbanking', label: 'Netbanking' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'online', label: 'Online (Razorpay)' },
];
const MIN_AMOUNT = (outer) => ({ key: 'minAmount', label: 'Min amount (₹)', type: 'number', money: true, outer, op: 'gte' });
const MAX_AMOUNT = (outer) => ({ key: 'maxAmount', label: 'Max amount (₹)', type: 'number', money: true, outer, op: 'lte' });
const and = (w) => (w.length ? `AND ${w.join(' AND ')}` : '');

const paymentModes = {
  key: 'payment-modes',
  group: 'payments',
  title: 'COD vs online',
  description: 'Orders and sales by payment mode, with unpaid online checkouts and cancellations.',
  keywords: ['cash on delivery', 'cod', 'upi', 'payment method', 'online payment', 'mode'],
  filters: [F.shop, F.category, F.city],
  columns: [
    { key: 'method', label: 'Payment mode', type: 'text', search: true },
    { key: 'orders', label: 'Orders placed', type: 'int' },
    { key: 'paid_orders', label: 'Paid orders', type: 'int' },
    { key: 'unpaid', label: 'Not paid', type: 'int' },
    { key: 'cancelled', label: 'Cancelled', type: 'int' },
    { key: 'sales', label: 'Sales', type: 'money' },
    { key: 'aov', label: 'Avg order', type: 'money' },
    { key: 'share', label: 'Share of sales', type: 'percent' },
  ],
  defaultSort: { key: 'sales', dir: 'desc' },
  summary: [
    { key: 'orders', label: 'Orders placed', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'sales', label: 'Sales', type: 'money', sql: 'COALESCE(SUM(r.sales), 0)' },
    {
      key: 'cod_share',
      label: 'COD share of sales',
      type: 'percent',
      sql: `ROUND(100.0 * COALESCE(SUM(r.sales) FILTER (WHERE r.method = 'Cash on delivery'), 0) / NULLIF(SUM(r.sales), 0), 1)`,
    },
    { key: 'unpaid', label: 'Online, not paid', type: 'int', sql: 'COALESCE(SUM(r.unpaid), 0)' },
  ],
  notes: 'Sales = paid orders that weren\'t cancelled. "Not paid" = online checkouts whose payment never succeeded.',
  sql: ({ f, p, inRange }) => `
    WITH o AS (
      SELECT o.*, ${PAID} AS paid
      FROM orders o LEFT JOIN addresses a ON a.id = o.address_id
      WHERE o.replacement_of_order_id IS NULL AND ${inRange('o.created_at')} ${orderWhere(f, p)}
    )
    SELECT ${METHOD_LABEL('o.payment_method')} AS method,
           COUNT(*) AS orders,
           COUNT(*) FILTER (WHERE o.paid AND o.status <> 'cancelled') AS paid_orders,
           COUNT(*) FILTER (WHERE NOT o.paid) AS unpaid,
           COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled,
           COALESCE(SUM(o.total_cents) FILTER (WHERE o.paid AND o.status <> 'cancelled'), 0) AS sales,
           COALESCE(ROUND(AVG(o.total_cents) FILTER (WHERE o.paid AND o.status <> 'cancelled')), 0) AS aov,
           COALESCE(ROUND(100.0 * SUM(o.total_cents) FILTER (WHERE o.paid AND o.status <> 'cancelled')
             / NULLIF(SUM(SUM(o.total_cents) FILTER (WHERE o.paid AND o.status <> 'cancelled')) OVER (), 0), 1), 0) AS share
    FROM o GROUP BY o.payment_method`,
};

const PAYMENT_STATUS = [
  { value: 'successful', label: 'Successful' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'created', label: 'Started, not finished' },
  { value: 'processing', label: 'Processing' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'partially_refunded', label: 'Partly refunded' },
];

const onlinePayments = {
  key: 'online-payments',
  group: 'payments',
  title: 'Online payments (Razorpay)',
  description: 'Every online payment attempt: checkout, customer, shops, method, gateway id, status and amounts.',
  keywords: ['razorpay', 'transactions', 'gateway', 'failed payments', 'upi', 'card', 'payment id'],
  filters: [
    { key: 'status', label: 'Payment status', type: 'select', options: PAYMENT_STATUS },
    { key: 'method', label: 'Method', type: 'select', options: ONLINE_METHODS },
    F.shop,
    MIN_AMOUNT('amount'),
    MAX_AMOUNT('amount'),
  ],
  columns: [
    { key: 'payment_id', label: 'Payment #', type: 'int', search: true },
    { key: 'created_at', label: 'Started', type: 'datetime' },
    { key: 'checkout', label: 'Checkout', type: 'text', search: true },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'phone', label: 'Phone', type: 'text', search: true },
    { key: 'shops', label: 'Shops', type: 'text', search: true },
    { key: 'method', label: 'Method', type: 'text' },
    { key: 'instrument', label: 'Paid with', type: 'text' },
    { key: 'gateway_id', label: 'Gateway id', type: 'text', search: true },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'captured', label: 'Captured', type: 'money' },
    { key: 'refunded', label: 'Refunded', type: 'money' },
    { key: 'failure_reason', label: 'Failure reason', type: 'text', search: true },
  ],
  defaultSort: { key: 'created_at', dir: 'desc' },
  summary: [
    { key: 'payments', label: 'Payments', type: 'int', sql: 'COUNT(*)' },
    { key: 'successful', label: 'Successful', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status IN ('successful', 'refunded', 'partially_refunded'))` },
    { key: 'failed', label: 'Failed', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'failed')` },
    {
      key: 'success_rate',
      label: 'Success rate',
      type: 'percent',
      sql: `ROUND(100.0 * COUNT(*) FILTER (WHERE r.status IN ('successful', 'refunded', 'partially_refunded')) / NULLIF(COUNT(*), 0), 1)`,
    },
    { key: 'captured', label: 'Captured', type: 'money', sql: 'COALESCE(SUM(r.captured), 0)' },
    { key: 'refunded', label: 'Refunded', type: 'money', sql: 'COALESCE(SUM(r.refunded), 0)' },
  ],
  notes: 'One row per payment attempt for a checkout; a customer who retries shows twice. Cash and business-credit orders are not here (see COD vs online).',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.status) w.push(`pm.status = ${p(f.status)}`);
    if (f.method) w.push(`pm.method = ${p(f.method)}`);
    if (f.shop != null) w.push(`EXISTS (SELECT 1 FROM orders so WHERE so.checkout_group_id = pm.checkout_group_id AND so.vendor_id = ${p(f.shop)})`);
    return `
      SELECT pm.id AS payment_id, pm.created_at, cg.reference AS checkout, ${CUSTOMER} AS customer, u.phone_number AS phone,
             (SELECT string_agg(DISTINCT v.business_name, ', ') FROM orders so JOIN vendor_profiles v ON v.id = so.vendor_id
              WHERE so.checkout_group_id = pm.checkout_group_id) AS shops,
             ${METHOD_LABEL('pm.method')} AS method, pm.instrument, pm.provider_payment_id AS gateway_id, pm.status,
             pm.amount_cents AS amount, pm.amount_captured_cents AS captured, pm.amount_refunded_cents AS refunded,
             pm.failure_reason
      FROM payments pm
      JOIN checkout_groups cg ON cg.id = pm.checkout_group_id
      JOIN users u ON u.id = pm.user_id
      WHERE pm.method NOT IN ('cod', 'credit') AND ${inRange('pm.created_at')} ${and(w)}`;
  },
};

const REFUND_STATUS = [
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const refunds = {
  key: 'refunds',
  group: 'payments',
  title: 'Refunds',
  description: 'Refunds asked for in the range: order, customer, shop, reason, status and amount.',
  keywords: ['refund', 'money back', 'reversal', 'return refund'],
  filters: [
    { key: 'status', label: 'Refund status', type: 'select', options: REFUND_STATUS },
    F.shop,
    { key: 'payment', label: 'Paid by', type: 'select', options: ONLINE_METHODS.concat([{ value: 'cod', label: 'Cash on delivery' }]) },
    { key: 'reason', label: 'Reason contains', type: 'text', outer: 'reason', op: 'ilike' },
  ],
  columns: [
    { key: 'refund_id', label: 'Refund #', type: 'int', search: true },
    { key: 'requested_at', label: 'Asked', type: 'datetime' },
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'paid_by', label: 'Paid by', type: 'text' },
    { key: 'reason', label: 'Reason', type: 'text', search: true },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'gateway_id', label: 'Gateway refund id', type: 'text', search: true },
    { key: 'updated_at', label: 'Last change', type: 'datetime' },
    { key: 'amount', label: 'Amount', type: 'money' },
  ],
  defaultSort: { key: 'requested_at', dir: 'desc' },
  summary: [
    { key: 'refunds', label: 'Refunds', type: 'int', sql: 'COUNT(*)' },
    { key: 'amount', label: 'Asked', type: 'money', sql: 'COALESCE(SUM(r.amount), 0)' },
    { key: 'completed', label: 'Refunded', type: 'money', sql: `COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'completed'), 0)` },
    { key: 'open', label: 'Still open', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status IN ('pending', 'processing'))` },
    { key: 'failed', label: 'Failed', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'failed')` },
  ],
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.status) w.push(`rf.status = ${p(f.status)}`);
    if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
    if (f.payment) w.push(`COALESCE(pm.method, o.payment_method) = ${p(f.payment)}`);
    return `
      SELECT rf.id AS refund_id, rf.created_at AS requested_at, rf.order_id, ${CUSTOMER} AS customer,
             v.business_name AS shop, ${METHOD_LABEL('COALESCE(pm.method, o.payment_method)')} AS paid_by,
             rf.reason, rf.status, rf.provider_refund_id AS gateway_id, rf.updated_at, rf.amount_cents AS amount
      FROM refunds rf
      LEFT JOIN payments pm ON pm.id = rf.payment_id
      LEFT JOIN orders o ON o.id = rf.order_id
      LEFT JOIN vendor_profiles v ON v.id = o.vendor_id
      LEFT JOIN users u ON u.id = COALESCE(o.user_id, pm.user_id, rf.requested_by_user_id)
      WHERE ${inRange('rf.created_at')} ${and(w)}`;
  },
};

const SETTLEMENT_STATUS = [
  { value: 'draft', label: 'Draft' },
  { value: 'pending_approval', label: 'Waiting for approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'paid', label: 'Paid' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'failed', label: 'Payout failed' },
];

const settlements = {
  key: 'settlements',
  group: 'payments',
  title: 'Shop settlements & payouts',
  description: 'Each settlement run: period, orders, gross, commission, deductions, net payable, status and UTR.',
  keywords: ['payout', 'vendor payment', 'settlement', 'utr', 'net payable', 'bank'],
  filters: [F.shop, { key: 'status', label: 'Status', type: 'select', options: SETTLEMENT_STATUS }],
  columns: [
    { key: 'reference', label: 'Reference', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'period_start', label: 'From', type: 'date' },
    { key: 'period_end', label: 'To', type: 'date' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'gross', label: 'Gross', type: 'money' },
    { key: 'commission', label: 'Commission', type: 'money' },
    { key: 'deductions', label: 'Deductions', type: 'money' },
    { key: 'adjustment', label: 'Adjustment', type: 'money' },
    { key: 'net', label: 'Net payable', type: 'money' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'paid_at', label: 'Paid on', type: 'date' },
    { key: 'utr', label: 'UTR', type: 'text', search: true },
  ],
  defaultSort: { key: 'period_end', dir: 'desc' },
  summary: [
    { key: 'runs', label: 'Settlements', type: 'int', sql: 'COUNT(*)' },
    { key: 'gross', label: 'Gross', type: 'money', sql: 'COALESCE(SUM(r.gross), 0)' },
    { key: 'commission', label: 'Commission', type: 'money', sql: 'COALESCE(SUM(r.commission), 0)' },
    { key: 'net', label: 'Net payable', type: 'money', sql: 'COALESCE(SUM(r.net), 0)' },
    { key: 'paid', label: 'Paid out', type: 'money', sql: `COALESCE(SUM(r.net) FILTER (WHERE r.status = 'paid'), 0)` },
    { key: 'due', label: 'Still to pay', type: 'money', sql: `COALESCE(SUM(r.net) FILTER (WHERE r.status NOT IN ('paid', 'draft')), 0)` },
  ],
  notes: 'A settlement is in the range when its period ends in it. "Still to pay" leaves out drafts.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`s.vendor_id = ${p(f.shop)}`);
    if (f.status) w.push(`s.status = ${p(f.status)}`);
    return `
      SELECT s.reference, v.business_name AS shop, s.period_start, s.period_end, s.order_count AS orders,
             s.gross_cents AS gross, s.commission_cents AS commission, s.deduction_cents AS deductions,
             s.adjustment_cents AS adjustment, s.net_payable_cents AS net, s.status, s.paid_at, s.payout_utr AS utr
      FROM settlements s JOIN vendor_profiles v ON v.id = s.vendor_id
      WHERE ${inRange('(s.period_end::timestamp AT TIME ZONE \'Asia/Kolkata\')')} ${and(w)}`;
  },
};

const commission = {
  key: 'commission',
  group: 'payments',
  title: 'Commission earned',
  description: 'Commission per shop on delivered orders that are in a settlement, with the effective rate.',
  keywords: ['commission', 'platform fee', 'take rate', 'earnings', 'revenue share'],
  filters: [F.shop, { key: 'shopCity', label: 'Shop city', type: 'city' }, { key: 'status', label: 'Settlement status', type: 'select', options: SETTLEMENT_STATUS }],
  columns: [
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'shop_city', label: 'City', type: 'text', search: true },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'gross', label: 'Gross', type: 'money' },
    { key: 'commission', label: 'Commission', type: 'money' },
    { key: 'rate', label: 'Effective rate', type: 'percent' },
    { key: 'net', label: 'Shop gets', type: 'money' },
  ],
  defaultSort: { key: 'commission', dir: 'desc' },
  summary: [
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'gross', label: 'Gross', type: 'money', sql: 'COALESCE(SUM(r.gross), 0)' },
    { key: 'commission', label: 'Commission', type: 'money', sql: 'COALESCE(SUM(r.commission), 0)' },
    { key: 'rate', label: 'Effective rate', type: 'percent', sql: 'ROUND(100.0 * SUM(r.commission) / NULLIF(SUM(r.gross), 0), 1)' },
  ],
  notes: 'By delivery date. Orders not yet in a settlement run aren\'t counted until the run is made (Payments & Finance → Settlements).',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`s.vendor_id = ${p(f.shop)}`);
    if (f.shopCity) w.push(`LOWER(v.city) = LOWER(${p(f.shopCity)})`);
    if (f.status) w.push(`s.status = ${p(f.status)}`);
    return `
      SELECT v.business_name AS shop, v.city AS shop_city, COUNT(*) AS orders,
             SUM(so.gross_cents) AS gross, SUM(so.commission_cents) AS commission,
             ROUND(100.0 * SUM(so.commission_cents) / NULLIF(SUM(so.gross_cents), 0), 1) AS rate,
             SUM(so.net_cents) AS net
      FROM settlement_orders so
      JOIN settlements s ON s.id = so.settlement_id
      JOIN vendor_profiles v ON v.id = s.vendor_id
      WHERE ${inRange('so.delivered_at')} ${and(w)}
      GROUP BY v.id, v.business_name, v.city`;
  },
};

const walletLedger = {
  key: 'wallet-ledger',
  group: 'payments',
  title: 'Customer wallet ledger',
  description: 'Every credit and debit on customers’ wallets, with the balance after each.',
  keywords: ['wallet', 'top up', 'balance', 'ledger', 'credit', 'debit'],
  filters: [{ key: 'type', label: 'Entry', type: 'select', options: [{ value: 'credit', label: 'Credit (money in)' }, { value: 'debit', label: 'Debit (money out)' }] }],
  columns: [
    { key: 'entry_id', label: 'Entry #', type: 'int' },
    { key: 'created_at', label: 'When', type: 'datetime' },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'phone', label: 'Phone', type: 'text', search: true },
    { key: 'type', label: 'Entry', type: 'status' },
    { key: 'description', label: 'For', type: 'text', search: true },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'balance_after', label: 'Balance after', type: 'money' },
  ],
  defaultSort: { key: 'created_at', dir: 'desc' },
  summary: [
    { key: 'entries', label: 'Entries', type: 'int', sql: 'COUNT(*)' },
    { key: 'credit', label: 'Money in', type: 'money', sql: `COALESCE(SUM(r.amount) FILTER (WHERE r.type = 'credit'), 0)` },
    { key: 'debit', label: 'Money out', type: 'money', sql: `COALESCE(SUM(r.amount) FILTER (WHERE r.type = 'debit'), 0)` },
    { key: 'customers', label: 'Customers', type: 'int', sql: 'COUNT(DISTINCT r.customer_id)' },
  ],
  sql: ({ f, p, inRange }) => `
    SELECT t.id AS entry_id, t.created_at, ${CUSTOMER} AS customer, u.phone_number AS phone, u.id AS customer_id,
           t.type, t.description, t.amount_cents AS amount, t.balance_after_cents AS balance_after
    FROM customer_wallet_transactions t
    JOIN customer_wallets w ON w.id = t.wallet_id
    JOIN users u ON u.id = w.user_id
    WHERE ${inRange('t.created_at')} ${f.type ? `AND t.type = ${p(f.type)}` : ''}`,
};

const pointsLedger = {
  key: 'points-ledger',
  group: 'payments',
  title: 'Reward points ledger',
  description: 'Points earned, used, returned and adjusted, with their rupee value.',
  keywords: ['reward points', 'loyalty', 'points', 'redeem', 'earn'],
  filters: [
    {
      key: 'type',
      label: 'Entry',
      type: 'select',
      options: [
        { value: 'earn', label: 'Earned' },
        { value: 'redeem', label: 'Used on an order' },
        { value: 'redeem_refund', label: 'Given back (cancel / return)' },
        { value: 'earn_reversal', label: 'Earned points taken back' },
        { value: 'adjustment', label: 'Adjustment by admin' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'pending', label: 'Pending (order not delivered yet)' },
        { value: 'credited', label: 'Credited' },
        { value: 'void', label: 'Void' },
      ],
    },
  ],
  columns: [
    { key: 'entry_id', label: 'Entry #', type: 'int' },
    { key: 'created_at', label: 'When', type: 'datetime' },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'type', label: 'Entry', type: 'status' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'description', label: 'For', type: 'text', search: true },
    { key: 'points', label: 'Points', type: 'int' },
    { key: 'value', label: 'Value', type: 'money' },
    { key: 'balance_after', label: 'Balance after', type: 'int' },
  ],
  defaultSort: { key: 'created_at', dir: 'desc' },
  summary: [
    { key: 'added', label: 'Points added', type: 'int', sql: `COALESCE(SUM(r.points) FILTER (WHERE r.points > 0 AND r.status <> 'void'), 0)` },
    { key: 'used', label: 'Points used', type: 'int', sql: `COALESCE(-SUM(r.points) FILTER (WHERE r.type = 'redeem' AND r.status <> 'void'), 0)` },
    { key: 'used_value', label: 'Discount from points', type: 'money', sql: `COALESCE(SUM(r.value) FILTER (WHERE r.type = 'redeem' AND r.status <> 'void'), 0)` },
    { key: 'pending', label: 'Pending points', type: 'int', sql: `COALESCE(SUM(r.points) FILTER (WHERE r.status = 'pending'), 0)` },
  ],
  notes: 'Used points show as negative. Earned points stay pending until the order is delivered.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.type) w.push(`t.type = ${p(f.type)}`);
    if (f.status) w.push(`t.status = ${p(f.status)}`);
    return `
      SELECT t.id AS entry_id, t.created_at, ${CUSTOMER} AS customer, t.type, t.status, t.order_id, t.description,
             t.points, t.value_cents AS value, t.balance_after
      FROM reward_transactions t JOIN users u ON u.id = t.user_id
      WHERE ${inRange('t.created_at')} ${and(w)}`;
  },
};

const couponUsage = {
  key: 'coupon-usage',
  group: 'payments',
  title: 'Coupon & discount usage',
  description: 'Each coupon used in the range: who runs it, times used, customers, discount given and order value.',
  keywords: ['coupon', 'promo code', 'discount', 'voucher', 'redemption'],
  filters: [
    F.shop,
    {
      key: 'discountType',
      label: 'Discount type',
      type: 'select',
      options: [
        { value: 'flat', label: 'Flat ₹ off' },
        { value: 'percentage', label: '% off' },
        { value: 'free_delivery', label: 'Free delivery' },
      ],
    },
    F.city,
  ],
  columns: [
    { key: 'code', label: 'Code', type: 'text', search: true },
    { key: 'run_by', label: 'Run by', type: 'text', search: true },
    { key: 'discount_type', label: 'Type', type: 'status' },
    { key: 'uses', label: 'Times used', type: 'int' },
    { key: 'customers', label: 'Customers', type: 'int' },
    { key: 'discount', label: 'Discount given', type: 'money' },
    { key: 'avg_discount', label: 'Avg discount', type: 'money' },
    { key: 'order_value', label: 'Order value', type: 'money' },
  ],
  defaultSort: { key: 'uses', dir: 'desc' },
  summary: [
    { key: 'coupons', label: 'Coupons used', type: 'int', sql: 'COUNT(*)' },
    { key: 'uses', label: 'Times used', type: 'int', sql: 'COALESCE(SUM(r.uses), 0)' },
    { key: 'discount', label: 'Discount given', type: 'money', sql: 'COALESCE(SUM(r.discount), 0)' },
    { key: 'order_value', label: 'Order value', type: 'money', sql: 'COALESCE(SUM(r.order_value), 0)' },
  ],
  notes: 'Paid orders that weren\'t cancelled. Discount given is the coupon\'s part only — offers (campaigns) and reward points are left out.',
  sql: ({ f, p, inRange }) => `
    SELECT COALESCE(o.coupon_code_snapshot, c.code) AS code,
           CASE WHEN c.vendor_id IS NULL THEN 'Gloaro (platform)' ELSE cv.business_name END AS run_by,
           c.discount_type,
           COUNT(*) AS uses, COUNT(DISTINCT o.user_id) AS customers,
           SUM(GREATEST(o.discount_cents - o.campaign_discount_cents - o.points_discount_cents, 0)) AS discount,
           ROUND(AVG(GREATEST(o.discount_cents - o.campaign_discount_cents - o.points_discount_cents, 0))) AS avg_discount,
           SUM(o.total_cents) AS order_value
    FROM orders o
    LEFT JOIN coupons c ON c.id = o.coupon_id
    LEFT JOIN vendor_profiles cv ON cv.id = c.vendor_id
    LEFT JOIN addresses a ON a.id = o.address_id
    WHERE (o.coupon_id IS NOT NULL OR o.coupon_code_snapshot IS NOT NULL)
      AND o.replacement_of_order_id IS NULL AND o.status <> 'cancelled' AND ${PAID}
      AND ${inRange('o.created_at')} ${orderWhere(f, p)}
      ${f.discountType ? `AND c.discount_type = ${p(f.discountType)}` : ''}
    GROUP BY 1, 2, 3`,
};

module.exports = {
  reports: [paymentModes, onlinePayments, refunds, settlements, commission, walletLedger, pointsLedger, couponUsage],
};
