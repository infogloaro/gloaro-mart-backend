/**
 * RP1 — Sales & orders reports.
 *
 * "A sale" is the same rule as the shop's own reports (vendorReports) and
 * Admin → Analytics: free replacements never count, and an online order only
 * counts once it is paid. Cancelled orders are counted apart, never in sales.
 * The order list is the exception — it shows every order, paid or not, with
 * its payment status, so unpaid and failed checkouts can be found.
 */

const PAID = `(o.payment_method IN ('cod', 'credit') OR EXISTS (
  SELECT 1 FROM payments pm
  WHERE pm.checkout_group_id = o.checkout_group_id
    AND pm.status IN ('successful', 'refunded', 'partially_refunded')))`;

// Where the order goes; pickup orders and very old ones fall back to the saved address.
const CITY = `COALESCE(NULLIF(TRIM(o.delivery_address_snapshot->>'city'), ''), a.city)`;
const PINCODE = `COALESCE(NULLIF(TRIM(o.delivery_address_snapshot->>'pincode'), ''), a.pincode)`;
const UNITS = `(SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id)`;
// New = the customer's first order that wasn't cancelled.
const IS_NEW = `NOT EXISTS (
  SELECT 1 FROM orders o2
  WHERE o2.user_id = o.user_id AND o2.id <> o.id AND o2.created_at < o.created_at
    AND o2.replacement_of_order_id IS NULL AND o2.status <> 'cancelled')`;

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'packed', label: 'Packed' },
  { value: 'out_for_delivery', label: 'Out for delivery' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
];
const PAYMENT_OPTIONS = [
  { value: 'cod', label: 'Cash on delivery' },
  { value: 'online_any', label: 'Any online payment' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'netbanking', label: 'Netbanking' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'online', label: 'Online (Razorpay)' },
  { value: 'credit', label: 'Business credit' },
];
const PARTNER_OPTIONS = [
  { value: 'gokart', label: 'GoKart (local)' },
  { value: 'shiprocket', label: 'Shiprocket (courier)' },
  { value: 'manual', label: 'Shop delivers' },
  { value: 'pickup', label: 'Customer pickup' },
];

const F = {
  shop: { key: 'shop', label: 'Shop', type: 'shop' },
  category: { key: 'category', label: 'Category', type: 'category' },
  brand: { key: 'brand', label: 'Brand', type: 'brand' },
  city: { key: 'city', label: 'City', type: 'city' },
  pincode: { key: 'pincode', label: 'Pincode', type: 'text' },
  payment: { key: 'payment', label: 'Payment mode', type: 'select', options: PAYMENT_OPTIONS },
  status: { key: 'status', label: 'Order status', type: 'select', options: STATUS_OPTIONS },
  partner: { key: 'partner', label: 'Delivery partner', type: 'select', options: PARTNER_OPTIONS },
};

/** WHERE clauses for the shared order filters the report uses. */
function orderWhere(f, p) {
  const w = [];
  if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
  if (f.city) w.push(`LOWER(${CITY}) = LOWER(${p(f.city)})`);
  if (f.pincode) w.push(`${PINCODE} LIKE ${p(`${f.pincode.replace(/\D/g, '')}%`)}`);
  if (f.status) w.push(`o.status = ${p(f.status)}`);
  if (f.payment === 'online_any') w.push(`o.payment_method NOT IN ('cod', 'credit')`);
  else if (f.payment) w.push(`o.payment_method = ${p(f.payment)}`);
  if (f.partner === 'pickup') w.push(`o.delivery_method = 'pickup'`);
  else if (f.partner) w.push(`o.fulfilment_partner = ${p(f.partner)}`);
  if (f.category) {
    w.push(`EXISTS (SELECT 1 FROM order_items ci JOIN products cp ON cp.id = ci.product_id
                    WHERE ci.order_id = o.id AND LOWER(cp.category) = LOWER(${p(f.category)}))`);
  }
  return w.length ? `AND ${w.join(' AND ')}` : '';
}

/** Paid, non-replacement orders in the range, with the filters applied. */
const salesOrders = ({ f, p, inRange }) => `
  SELECT o.*, ${UNITS} AS units
  FROM orders o
  LEFT JOIN addresses a ON a.id = o.address_id
  WHERE o.replacement_of_order_id IS NULL AND ${PAID} AND ${inRange('o.created_at')} ${orderWhere(f, p)}`;

const GROUP_BY_PERIOD = {
  key: 'groupBy',
  label: 'Group by',
  type: 'select',
  default: 'day',
  options: [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
  ],
};
const PERIOD_LABEL = { day: `'YYYY-MM-DD'`, week: `'"Week of" YYYY-MM-DD'`, month: `'YYYY-MM'` };

const salesSummary = {
  key: 'sales-summary',
  group: 'sales',
  title: 'Sales summary',
  description: 'Orders, discounts, delivery, GST and sales for each day, week or month. Empty days show as zero.',
  keywords: ['revenue', 'daily', 'monthly', 'weekly', 'turnover', 'income'],
  filters: [GROUP_BY_PERIOD, F.shop, F.category, F.city, F.payment],
  columns: [
    { key: 'period', label: 'Period', type: 'text' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'units', label: 'Items', type: 'int' },
    { key: 'gross', label: 'Item value', type: 'money' },
    { key: 'discount', label: 'Discounts', type: 'money' },
    { key: 'delivery', label: 'Delivery fees', type: 'money' },
    { key: 'gst', label: 'GST', type: 'money' },
    { key: 'sales', label: 'Sales', type: 'money' },
    { key: 'aov', label: 'Avg order', type: 'money' },
    { key: 'cancelled', label: 'Cancelled', type: 'int' },
  ],
  defaultSort: { key: 'period', dir: 'asc' },
  summary: [
    { key: 'orders', label: 'Orders', type: 'int', sql: 'SUM(r.orders)' },
    { key: 'sales', label: 'Sales', type: 'money', sql: 'SUM(r.sales)' },
    { key: 'aov', label: 'Avg order', type: 'money', sql: 'ROUND(SUM(r.sales)::numeric / NULLIF(SUM(r.orders), 0))' },
    { key: 'discount', label: 'Discounts', type: 'money', sql: 'SUM(r.discount)' },
    { key: 'gst', label: 'GST', type: 'money', sql: 'SUM(r.gst)' },
    { key: 'cancelled', label: 'Cancelled', type: 'int', sql: 'SUM(r.cancelled)' },
  ],
  notes: 'Sales = what customers paid (items − discounts + GST + delivery). Online orders count once paid; cancelled orders are left out of sales and counted under Cancelled.',
  sql: (ctx) => {
    const unit = ctx.f.groupBy; // checked against the options
    const step = `interval '1 ${unit}'`;
    return `
      WITH o AS (${salesOrders(ctx)}),
      periods AS (
        SELECT gs::date AS period
        FROM generate_series(date_trunc('${unit}', ${ctx.p(ctx.range.from)}::date), ${ctx.p(ctx.range.to)}::date, ${step}) gs
      ),
      byp AS (
        SELECT date_trunc('${unit}', o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS period,
               COUNT(*) FILTER (WHERE o.status <> 'cancelled') AS orders,
               SUM(o.units) FILTER (WHERE o.status <> 'cancelled') AS units,
               SUM(o.subtotal_cents) FILTER (WHERE o.status <> 'cancelled') AS gross,
               SUM(o.discount_cents) FILTER (WHERE o.status <> 'cancelled') AS discount,
               SUM(o.delivery_charge_cents) FILTER (WHERE o.status <> 'cancelled') AS delivery,
               SUM(o.gst_cents) FILTER (WHERE o.status <> 'cancelled') AS gst,
               SUM(o.total_cents) FILTER (WHERE o.status <> 'cancelled') AS sales,
               COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled
        FROM o GROUP BY 1
      )
      SELECT to_char(pr.period, ${PERIOD_LABEL[unit]}) AS period,
             COALESCE(b.orders, 0) AS orders, COALESCE(b.units, 0) AS units,
             COALESCE(b.gross, 0) AS gross, COALESCE(b.discount, 0) AS discount,
             COALESCE(b.delivery, 0) AS delivery, COALESCE(b.gst, 0) AS gst,
             COALESCE(b.sales, 0) AS sales,
             COALESCE(ROUND(b.sales::numeric / NULLIF(b.orders, 0)), 0) AS aov,
             COALESCE(b.cancelled, 0) AS cancelled
      FROM periods pr LEFT JOIN byp b ON b.period = pr.period`;
  },
};

const orderList = {
  key: 'orders',
  group: 'sales',
  title: 'Order list',
  description: 'Every order in the range with customer, shop, place, payment, delivery partner and status.',
  keywords: ['orders', 'order report', 'customer orders', 'unpaid', 'pending'],
  filters: [
    F.status,
    F.shop,
    F.payment,
    F.partner,
    F.city,
    F.pincode,
    {
      key: 'customerType',
      label: 'Customer type',
      type: 'select',
      options: [
        { value: 'new', label: 'New (first order)' },
        { value: 'repeat', label: 'Repeat' },
      ],
      outer: 'customer_type',
    },
    { key: 'minAmount', label: 'Min amount (₹)', type: 'number', money: true, outer: 'total', op: 'gte' },
    { key: 'maxAmount', label: 'Max amount (₹)', type: 'number', money: true, outer: 'total', op: 'lte' },
  ],
  columns: [
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'placed_at', label: 'Placed', type: 'datetime' },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'phone', label: 'Phone', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'pincode', label: 'Pincode', type: 'text', search: true },
    { key: 'units', label: 'Items', type: 'int' },
    { key: 'payment', label: 'Payment', type: 'status' },
    { key: 'payment_status', label: 'Paid?', type: 'status' },
    { key: 'delivery', label: 'Delivery', type: 'status' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'customer_type', label: 'Customer', type: 'status' },
    { key: 'total', label: 'Total', type: 'money' },
  ],
  defaultSort: { key: 'placed_at', dir: 'desc' },
  summary: [
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COUNT(*)' },
    { key: 'value', label: 'Order value', type: 'money', sql: 'COALESCE(SUM(r.total), 0)' },
    { key: 'delivered', label: 'Delivered', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'delivered')` },
    { key: 'cancelled', label: 'Cancelled', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'cancelled')` },
    { key: 'unpaid', label: 'Online, not paid', type: 'int', sql: `COUNT(*) FILTER (WHERE r.payment_status = 'not paid')` },
  ],
  notes: 'Shows every order, paid or not. Free replacement orders are on the Replacements page instead. "New" means the customer\'s first order that wasn\'t cancelled; cancelled orders are neither new nor repeat.',
  sql: ({ f, p, inRange }) => `
    SELECT o.id AS order_id, o.created_at AS placed_at,
           COALESCE(NULLIF(TRIM(u.full_name), ''), u.email) AS customer, u.phone_number AS phone,
           v.business_name AS shop, ${CITY} AS city, ${PINCODE} AS pincode, ${UNITS}::int AS units,
           o.payment_method AS payment,
           CASE WHEN o.payment_method IN ('cod', 'credit') THEN
                  CASE WHEN o.status = 'delivered' THEN 'collected' ELSE 'on delivery' END
                WHEN ${PAID} THEN 'paid' ELSE 'not paid' END AS payment_status,
           CASE WHEN o.delivery_method = 'pickup' THEN 'pickup' ELSE COALESCE(o.fulfilment_partner, '—') END AS delivery,
           o.status,
           CASE WHEN o.status = 'cancelled' THEN '—' WHEN ${IS_NEW} THEN 'new' ELSE 'repeat' END AS customer_type,
           o.total_cents AS total
    FROM orders o
    JOIN users u ON u.id = o.user_id
    JOIN vendor_profiles v ON v.id = o.vendor_id
    LEFT JOIN addresses a ON a.id = o.address_id
    WHERE o.replacement_of_order_id IS NULL AND ${inRange('o.created_at')} ${orderWhere(f, p)}`,
};

const salesByShop = {
  key: 'sales-by-shop',
  group: 'sales',
  title: 'Sales by shop',
  description: 'Each shop’s orders, items, sales, average order and share of all sales.',
  keywords: ['vendor sales', 'shop revenue', 'top shops', 'seller'],
  filters: [
    { key: 'shopCity', label: 'Shop city', type: 'city' },
    F.category,
    F.payment,
    { key: 'minSales', label: 'Min sales (₹)', type: 'number', money: true, outer: 'sales', op: 'gte' },
  ],
  columns: [
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'shop_city', label: 'City', type: 'text', search: true },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'units', label: 'Items', type: 'int' },
    { key: 'sales', label: 'Sales', type: 'money' },
    { key: 'aov', label: 'Avg order', type: 'money' },
    { key: 'cancelled', label: 'Cancelled', type: 'int' },
    { key: 'share', label: 'Share of sales', type: 'percent' },
  ],
  defaultSort: { key: 'sales', dir: 'desc' },
  summary: [
    { key: 'shops', label: 'Shops with orders', type: 'int', sql: 'COUNT(*)' },
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'sales', label: 'Sales', type: 'money', sql: 'COALESCE(SUM(r.sales), 0)' },
  ],
  notes: 'Only shops with at least one order in the range are listed.',
  sql: (ctx) => {
    const { f, p } = ctx;
    const shopCity = f.shopCity ? `WHERE LOWER(v.city) = LOWER(${p(f.shopCity)})` : '';
    return `
      WITH o AS (${salesOrders(ctx)})
      SELECT v.business_name AS shop, v.city AS shop_city,
             COUNT(*) FILTER (WHERE o.status <> 'cancelled') AS orders,
             COALESCE(SUM(o.units) FILTER (WHERE o.status <> 'cancelled'), 0) AS units,
             COALESCE(SUM(o.total_cents) FILTER (WHERE o.status <> 'cancelled'), 0) AS sales,
             COALESCE(ROUND(SUM(o.total_cents) FILTER (WHERE o.status <> 'cancelled')::numeric
                            / NULLIF(COUNT(*) FILTER (WHERE o.status <> 'cancelled'), 0)), 0) AS aov,
             COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled,
             COALESCE(ROUND(100.0 * SUM(o.total_cents) FILTER (WHERE o.status <> 'cancelled')
                            / NULLIF(SUM(SUM(o.total_cents) FILTER (WHERE o.status <> 'cancelled')) OVER (), 0), 1), 0) AS share
      FROM o JOIN vendor_profiles v ON v.id = o.vendor_id
      ${shopCity}
      GROUP BY v.id, v.business_name, v.city`;
  },
};

/** Item lines of paid, non-cancelled orders in the range. */
const salesItems = (ctx) => `
  SELECT oi.*, o.vendor_id, o.id AS oid, pr.category AS p_category, pr.subcategory AS p_subcategory,
         pr.sku AS p_sku, pr.brand_id AS p_brand
  FROM (${salesOrders(ctx)}) o
  JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN products pr ON pr.id = oi.product_id
  WHERE o.status <> 'cancelled'`;

const salesByCategory = {
  key: 'sales-by-category',
  group: 'sales',
  title: 'Sales by category',
  description: 'Items sold and their value by category and sub-category.',
  keywords: ['category sales', 'department', 'subcategory'],
  filters: [F.shop, F.city, F.payment],
  columns: [
    { key: 'category', label: 'Category', type: 'text', search: true },
    { key: 'subcategory', label: 'Sub-category', type: 'text', search: true },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'units', label: 'Items', type: 'int' },
    { key: 'sales', label: 'Item value', type: 'money' },
    { key: 'share', label: 'Share', type: 'percent' },
  ],
  defaultSort: { key: 'sales', dir: 'desc' },
  summary: [
    { key: 'rows', label: 'Categories', type: 'int', sql: 'COUNT(*)' },
    { key: 'units', label: 'Items sold', type: 'int', sql: 'COALESCE(SUM(r.units), 0)' },
    { key: 'sales', label: 'Item value', type: 'money', sql: 'COALESCE(SUM(r.sales), 0)' },
  ],
  notes: 'Item value is price × quantity, before discounts, GST and delivery, so it won\'t match Sales in the summary report.',
  sql: (ctx) => `
    WITH i AS (${salesItems(ctx)})
    SELECT COALESCE(NULLIF(TRIM(i.p_category), ''), 'Other') AS category,
           COALESCE(NULLIF(TRIM(i.p_subcategory), ''), '—') AS subcategory,
           COUNT(DISTINCT i.oid) AS orders, SUM(i.quantity) AS units,
           SUM(i.unit_price_cents * i.quantity) AS sales,
           ROUND(100.0 * SUM(i.unit_price_cents * i.quantity) / NULLIF(SUM(SUM(i.unit_price_cents * i.quantity)) OVER (), 0), 1) AS share
    FROM i GROUP BY 1, 2`,
};

const salesByProduct = {
  key: 'sales-by-product',
  group: 'sales',
  title: 'Sales by product',
  description: 'Every product sold: units, orders, value and average selling price.',
  keywords: ['product sales', 'top products', 'best sellers', 'sku', 'item wise'],
  filters: [F.shop, F.category, F.brand, F.city],
  columns: [
    { key: 'product', label: 'Product', type: 'text', search: true },
    { key: 'sku', label: 'SKU', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'category', label: 'Category', type: 'text', search: true },
    { key: 'brand', label: 'Brand', type: 'text', search: true },
    { key: 'units', label: 'Units', type: 'int' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'sales', label: 'Item value', type: 'money' },
    { key: 'avg_price', label: 'Avg price', type: 'money' },
  ],
  defaultSort: { key: 'sales', dir: 'desc' },
  summary: [
    { key: 'products', label: 'Products sold', type: 'int', sql: 'COUNT(*)' },
    { key: 'units', label: 'Units', type: 'int', sql: 'COALESCE(SUM(r.units), 0)' },
    { key: 'sales', label: 'Item value', type: 'money', sql: 'COALESCE(SUM(r.sales), 0)' },
  ],
  notes: 'Item value is price × quantity, before discounts, GST and delivery.',
  sql: (ctx) => {
    const { f, p } = ctx;
    // The order-level category filter keeps whole orders; here only that category's lines count.
    const w = [];
    if (f.category) w.push(`LOWER(i.p_category) = LOWER(${p(f.category)})`);
    if (f.brand != null) w.push(`i.p_brand = ${p(f.brand)}`);
    return `
      WITH i AS (${salesItems({ ...ctx, f: { ...f, category: null } })})
      SELECT MAX(i.product_name_snapshot) AS product, MAX(i.p_sku) AS sku, v.business_name AS shop,
             COALESCE(NULLIF(TRIM(MAX(i.p_category)), ''), 'Other') AS category, b.name AS brand,
             SUM(i.quantity) AS units, COUNT(DISTINCT i.oid) AS orders,
             SUM(i.unit_price_cents * i.quantity) AS sales,
             ROUND(SUM(i.unit_price_cents * i.quantity)::numeric / NULLIF(SUM(i.quantity), 0)) AS avg_price
      FROM i
      JOIN vendor_profiles v ON v.id = i.vendor_id
      LEFT JOIN brands b ON b.id = i.p_brand
      ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
      GROUP BY i.product_id, v.business_name, b.name`;
  },
};

const AOV_GROUPS = {
  shop: 'v.business_name',
  city: `COALESCE(${CITY}, '—')`,
  customer_type: `CASE WHEN ${IS_NEW} THEN 'New customers' ELSE 'Repeat customers' END`,
  payment: 'o.payment_method',
};

const averageOrder = {
  key: 'average-order-value',
  group: 'sales',
  title: 'Average order value',
  description: 'Average, smallest and largest order by shop, city, customer type or payment mode.',
  keywords: ['aov', 'basket size', 'ticket size', 'average bill'],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      default: 'shop',
      options: [
        { value: 'shop', label: 'Shop' },
        { value: 'city', label: 'City' },
        { value: 'customer_type', label: 'New vs repeat' },
        { value: 'payment', label: 'Payment mode' },
      ],
    },
    F.shop,
    F.city,
  ],
  columns: [
    { key: 'name', label: 'Group', type: 'text', search: true },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'sales', label: 'Sales', type: 'money' },
    { key: 'aov', label: 'Avg order', type: 'money' },
    { key: 'min_order', label: 'Smallest', type: 'money' },
    { key: 'max_order', label: 'Largest', type: 'money' },
  ],
  defaultSort: { key: 'aov', dir: 'desc' },
  summary: [
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'sales', label: 'Sales', type: 'money', sql: 'COALESCE(SUM(r.sales), 0)' },
    { key: 'aov', label: 'Avg order (all)', type: 'money', sql: 'ROUND(SUM(r.sales)::numeric / NULLIF(SUM(r.orders), 0))' },
  ],
  notes: 'Paid orders that weren\'t cancelled.',
  sql: ({ f, p, inRange }) => `
    SELECT ${AOV_GROUPS[f.groupBy]} AS name,
           COUNT(*) AS orders, SUM(o.total_cents) AS sales,
           ROUND(AVG(o.total_cents)) AS aov, MIN(o.total_cents) AS min_order, MAX(o.total_cents) AS max_order
    FROM orders o
    JOIN vendor_profiles v ON v.id = o.vendor_id
    LEFT JOIN addresses a ON a.id = o.address_id
    WHERE o.replacement_of_order_id IS NULL AND o.status <> 'cancelled' AND ${PAID}
      AND ${inRange('o.created_at')} ${orderWhere(f, p)}
    GROUP BY 1`,
};

const peakTimes = {
  key: 'peak-times',
  group: 'sales',
  title: 'Peak hours & days',
  description: 'When customers order: orders and sales for each hour of the day or day of the week.',
  keywords: ['busy hours', 'rush', 'time of day', 'weekday', 'heatmap'],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      default: 'hour',
      options: [
        { value: 'hour', label: 'Hour of day' },
        { value: 'weekday', label: 'Day of week' },
      ],
    },
    F.shop,
    F.city,
  ],
  columns: [
    { key: 'slot_no', label: '#', type: 'int' },
    { key: 'slot', label: 'Time', type: 'text' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'sales', label: 'Sales', type: 'money' },
    { key: 'share', label: 'Share of orders', type: 'percent' },
  ],
  defaultSort: { key: 'slot_no', dir: 'asc' },
  summary: [
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'sales', label: 'Sales', type: 'money', sql: 'COALESCE(SUM(r.sales), 0)' },
    { key: 'busiest', label: 'Busiest slot', type: 'text', sql: `(ARRAY_AGG(r.slot ORDER BY r.orders DESC, r.slot_no) FILTER (WHERE r.orders > 0))[1]` },
  ],
  notes: 'India time. Paid orders that weren\'t cancelled.',
  sql: (ctx) => {
    const hour = ctx.f.groupBy === 'hour';
    const part = hour ? 'hour' : 'isodow';
    const slots = hour
      ? `SELECT h AS slot_no, lpad(h::text, 2, '0') || ':00–' || lpad(((h + 1) % 24)::text, 2, '0') || ':00' AS slot FROM generate_series(0, 23) h`
      : `SELECT d AS slot_no, (ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'])[d] AS slot FROM generate_series(1, 7) d`;
    return `
      WITH o AS (${salesOrders(ctx)}),
      byslot AS (
        SELECT EXTRACT(${part} FROM o.created_at AT TIME ZONE 'Asia/Kolkata')::int AS slot_no,
               COUNT(*) AS orders, SUM(o.total_cents) AS sales
        FROM o WHERE o.status <> 'cancelled' GROUP BY 1
      )
      SELECT s.slot_no, s.slot, COALESCE(b.orders, 0) AS orders, COALESCE(b.sales, 0) AS sales,
             COALESCE(ROUND(100.0 * b.orders / NULLIF(SUM(b.orders) OVER (), 0), 1), 0) AS share
      FROM (${slots}) s LEFT JOIN byslot b ON b.slot_no = s.slot_no`;
  },
};

module.exports = {
  reports: [salesSummary, orderList, salesByShop, salesByCategory, salesByProduct, averageOrder, peakTimes],
  // Shared with later report groups.
  PAID, CITY, PINCODE, UNITS, IS_NEW, F, orderWhere, salesOrders, STATUS_OPTIONS, PAYMENT_OPTIONS, PARTNER_OPTIONS,
};
