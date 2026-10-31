/**
 * RP6 — Products & inventory reports.
 *
 * Stock follows the shop's own inventory report (vendorReportInventory, VD19):
 * one row per inventory row, so each variant counts on its own, and value is
 * at the selling price — the schema has no cost price, so there is no profit
 * report. A sale is the usual rule (paid, not cancelled, not a free
 * replacement). Stock reports are a snapshot of now, so they have no dates.
 */
const { PAID, F } = require('./sales');

const and = (w) => (w.length ? `AND ${w.join(' AND ')}` : '');
const VARIANT_LABEL = `(SELECT string_agg(av.value, ' / ' ORDER BY a.sort_order, av.sort_order)
  FROM variant_attribute_values vav
  JOIN attribute_values av ON av.id = vav.attribute_value_id
  JOIN product_attributes a ON a.id = av.attribute_id
  WHERE vav.variant_id = i.variant_id)`;
const PRICE = `CASE WHEN i.variant_id IS NULL THEN p.price_cents ELSE COALESCE(pv.price_cents, p.price_cents) END`;
const STOCK = `CASE WHEN i.available_qty <= 0 THEN 'out of stock' WHEN i.available_qty <= i.low_stock_threshold THEN 'low' ELSE 'in stock' END`;

/** Units sold per product / variant; `where` limits the orders (e.g. a time window). */
const SOLD = (where = '') => `
  SELECT oi.product_id, oi.variant_id, SUM(oi.quantity) AS units, COUNT(DISTINCT o.id) AS orders,
         SUM(oi.quantity * oi.unit_price_cents) AS sales, MAX(o.created_at) AS last_sold
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  WHERE o.replacement_of_order_id IS NULL AND o.status <> 'cancelled' AND ${PAID} ${where}
  GROUP BY oi.product_id, oi.variant_id`;
const SOLD_JOIN = `s.product_id = i.product_id AND s.variant_id IS NOT DISTINCT FROM i.variant_id`;

/** Product filters shared by the stock reports (p = products, i = inventory). */
function productWhere(f, p) {
  const w = [];
  if (f.shop != null) w.push(`i.vendor_id = ${p(f.shop)}`);
  if (f.category) w.push(`LOWER(p.category) = LOWER(${p(f.category)})`);
  if (f.brand != null) w.push(`p.brand_id = ${p(f.brand)}`);
  if (f.active === 'yes') w.push(`p.is_active AND p.moderation_status = 'approved'`);
  if (f.active === 'no') w.push(`NOT (p.is_active AND p.moderation_status = 'approved')`);
  return w;
}
const ACTIVE = {
  key: 'active',
  label: 'Shown in the app',
  type: 'select',
  options: [
    { value: 'yes', label: 'Yes (active and approved)' },
    { value: 'no', label: 'No (off or not approved)' },
  ],
};
const STOCK_COLUMNS = [
  { key: 'product', label: 'Product', type: 'text', search: true },
  { key: 'variant', label: 'Variant', type: 'text', search: true },
  { key: 'sku', label: 'SKU', type: 'text', search: true },
  { key: 'shop', label: 'Shop', type: 'text', search: true },
  { key: 'category', label: 'Category', type: 'text', search: true },
];
const STOCK_FROM = `
  FROM inventory i
  JOIN products p ON p.id = i.product_id
  JOIN vendor_profiles v ON v.id = i.vendor_id
  LEFT JOIN product_variants pv ON pv.id = i.variant_id
  LEFT JOIN brands b ON b.id = p.brand_id`;
const STOCK_SELECT = `p.name AS product, ${VARIANT_LABEL} AS variant, COALESCE(pv.sku, p.sku) AS sku,
  v.business_name AS shop, COALESCE(NULLIF(TRIM(p.category), ''), 'Other') AS category`;

const stockValue = {
  key: 'stock-value',
  group: 'inventory',
  title: 'Stock & stock value',
  description: 'Every item in stock right now: units on hand, reserved, price and stock value, with low / out-of-stock flags.',
  keywords: ['inventory', 'stock', 'stock value', 'on hand', 'warehouse', 'closing stock'],
  noDates: true,
  filters: [
    F.shop,
    F.category,
    F.brand,
    {
      key: 'stock',
      label: 'Stock',
      type: 'select',
      options: [
        { value: 'in stock', label: 'In stock' },
        { value: 'low', label: 'Running low' },
        { value: 'out of stock', label: 'Out of stock' },
      ],
      outer: 'stock',
    },
    ACTIVE,
  ],
  columns: [
    ...STOCK_COLUMNS,
    { key: 'brand', label: 'Brand', type: 'text', search: true },
    { key: 'price', label: 'Price', type: 'money' },
    { key: 'available', label: 'On hand', type: 'int' },
    { key: 'reserved', label: 'Reserved', type: 'int' },
    { key: 'value', label: 'Stock value', type: 'money' },
    { key: 'stock', label: 'Stock', type: 'status' },
  ],
  defaultSort: { key: 'value', dir: 'desc' },
  summary: [
    { key: 'items', label: 'Items', type: 'int', sql: 'COUNT(*)' },
    { key: 'units', label: 'Units on hand', type: 'int', sql: 'COALESCE(SUM(GREATEST(r.available, 0)), 0)' },
    { key: 'value', label: 'Stock value', type: 'money', sql: 'COALESCE(SUM(r.value), 0)' },
    { key: 'low', label: 'Running low', type: 'int', sql: `COUNT(*) FILTER (WHERE r.stock = 'low')` },
    { key: 'out', label: 'Out of stock', type: 'int', sql: `COUNT(*) FILTER (WHERE r.stock = 'out of stock')` },
  ],
  notes: 'Right now, not for a date range. Value = units on hand × selling price (there is no cost price yet). Running low = at or below the item\'s low-stock level.',
  sql: ({ f, p }) => `
    SELECT ${STOCK_SELECT}, b.name AS brand, ${PRICE} AS price,
           i.available_qty AS available, i.reserved_qty AS reserved,
           GREATEST(i.available_qty, 0) * ${PRICE} AS value, ${STOCK} AS stock
    ${STOCK_FROM}
    WHERE TRUE ${and(productWhere(f, p))}`,
};

const lowStock = {
  key: 'low-stock',
  group: 'inventory',
  title: 'Low & out of stock',
  description: 'Items out of stock or at / below their low-stock level, with last 30 days\' sales and days of stock left.',
  keywords: ['low stock', 'out of stock', 'reorder', 'restock', 'shortage'],
  noDates: true,
  filters: [
    F.shop,
    F.category,
    {
      key: 'stock',
      label: 'Show',
      type: 'select',
      options: [
        { value: 'out of stock', label: 'Out of stock only' },
        { value: 'low', label: 'Running low only' },
      ],
      outer: 'stock',
    },
    { key: 'below', label: 'Or below N units', type: 'number' },
    ACTIVE,
  ],
  columns: [
    ...STOCK_COLUMNS,
    { key: 'available', label: 'On hand', type: 'int' },
    { key: 'threshold', label: 'Low level', type: 'int' },
    { key: 'sold_30', label: 'Sold (30 days)', type: 'int' },
    { key: 'days_left', label: 'Days left', type: 'int' },
    { key: 'stock', label: 'Stock', type: 'status' },
  ],
  defaultSort: { key: 'days_left', dir: 'asc' },
  summary: [
    { key: 'items', label: 'Items', type: 'int', sql: 'COUNT(*)' },
    { key: 'out', label: 'Out of stock', type: 'int', sql: `COUNT(*) FILTER (WHERE r.stock = 'out of stock')` },
    { key: 'low', label: 'Running low', type: 'int', sql: `COUNT(*) FILTER (WHERE r.stock = 'low')` },
    { key: 'selling_out', label: 'Out but still selling', type: 'int', sql: `COUNT(*) FILTER (WHERE r.stock = 'out of stock' AND r.sold_30 > 0)` },
  ],
  notes: 'Days left = units on hand at the last 30 days\' selling pace (empty when nothing sold). "Or below N units" also lists items above their own low level but under N.',
  sql: ({ f, p }) => {
    const w = productWhere(f, p);
    const below = f.below != null ? `OR i.available_qty < ${p(f.below)}` : '';
    return `
      SELECT ${STOCK_SELECT}, i.available_qty AS available, i.low_stock_threshold AS threshold,
             COALESCE(s.units, 0) AS sold_30,
             CASE WHEN COALESCE(s.units, 0) > 0 THEN FLOOR(GREATEST(i.available_qty, 0) / (s.units / 30.0)) END AS days_left,
             ${STOCK} AS stock
      ${STOCK_FROM}
      LEFT JOIN (${SOLD(`AND o.created_at >= now() - interval '30 days'`)}) s ON ${SOLD_JOIN}
      WHERE (i.available_qty <= i.low_stock_threshold ${below}) ${and(w)}`;
  },
};

const deadStock = {
  key: 'dead-stock',
  group: 'inventory',
  title: 'Dead stock',
  description: 'Items with stock on hand that haven\'t sold in 30, 60 or 90 days, and the value tied up in them.',
  keywords: ['dead stock', 'slow moving', 'not selling', 'ageing', 'non moving'],
  noDates: true,
  filters: [
    {
      key: 'days',
      label: 'No sale in',
      type: 'select',
      default: '30',
      options: [
        { value: '30', label: '30 days' },
        { value: '60', label: '60 days' },
        { value: '90', label: '90 days' },
      ],
    },
    F.shop,
    F.category,
    F.brand,
  ],
  columns: [
    ...STOCK_COLUMNS,
    { key: 'available', label: 'On hand', type: 'int' },
    { key: 'value', label: 'Value tied up', type: 'money' },
    { key: 'last_sold', label: 'Last sold', type: 'date' },
    { key: 'days_idle', label: 'Days since a sale', type: 'int' },
  ],
  defaultSort: { key: 'value', dir: 'desc' },
  summary: [
    { key: 'items', label: 'Items', type: 'int', sql: 'COUNT(*)' },
    { key: 'units', label: 'Units', type: 'int', sql: 'COALESCE(SUM(r.available), 0)' },
    { key: 'value', label: 'Value tied up', type: 'money', sql: 'COALESCE(SUM(r.value), 0)' },
    { key: 'never', label: 'Never sold', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.last_sold IS NULL)' },
  ],
  notes: '"Days since a sale" counts from when the item was added if it has never sold. Value at selling price.',
  sql: ({ f, p }) => `
    SELECT ${STOCK_SELECT}, i.available_qty AS available, i.available_qty * ${PRICE} AS value,
           s.last_sold,
           (now()::date - COALESCE(s.last_sold, COALESCE(pv.created_at, p.created_at))::date) AS days_idle
    ${STOCK_FROM}
    LEFT JOIN (${SOLD()}) s ON ${SOLD_JOIN}
    WHERE i.available_qty > 0
      AND COALESCE(s.last_sold, COALESCE(pv.created_at, p.created_at)) < now() - (${p(Number(f.days))} * interval '1 day')
      ${and(productWhere(f, p))}`,
};

const fastMovers = {
  key: 'fast-movers',
  group: 'inventory',
  title: 'Fast movers & stock cover',
  description: 'What sells fastest in the range, with stock on hand now and how many days it will last at that pace.',
  keywords: ['top sellers', 'best sellers', 'fast moving', 'velocity', 'stock cover', 'days of stock'],
  filters: [F.shop, F.category, F.brand],
  columns: [
    ...STOCK_COLUMNS,
    { key: 'units', label: 'Units sold', type: 'int' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'sales', label: 'Item value', type: 'money' },
    { key: 'per_day', label: 'Units / day', type: 'number' },
    { key: 'available', label: 'On hand now', type: 'int' },
    { key: 'days_left', label: 'Days of stock', type: 'int' },
  ],
  defaultSort: { key: 'units', dir: 'desc' },
  summary: [
    { key: 'items', label: 'Items sold', type: 'int', sql: 'COUNT(*)' },
    { key: 'units', label: 'Units sold', type: 'int', sql: 'COALESCE(SUM(r.units), 0)' },
    { key: 'sales', label: 'Item value', type: 'money', sql: 'COALESCE(SUM(r.sales), 0)' },
    { key: 'short', label: 'Under 7 days of stock', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.days_left < 7)' },
  ],
  notes: 'Units / day = units sold ÷ days in the range. Days of stock = on hand now ÷ units per day. Items without a stock row show no stock.',
  sql: ({ f, p, inRange, range }) => {
    const days = p(range.days);
    return `
      SELECT ${STOCK_SELECT}, s.units, s.orders, s.sales,
             ROUND(s.units::numeric / ${days}, 2) AS per_day,
             i.available_qty AS available,
             CASE WHEN i.id IS NOT NULL THEN FLOOR(GREATEST(i.available_qty, 0) / (s.units::numeric / ${days})) END AS days_left
      FROM (${SOLD(`AND ${inRange('o.created_at')}`)}) s
      JOIN products p ON p.id = s.product_id
      JOIN vendor_profiles v ON v.id = p.vendor_id
      LEFT JOIN product_variants pv ON pv.id = s.variant_id
      LEFT JOIN inventory i ON ${SOLD_JOIN}
      WHERE TRUE ${and(productWhere({ ...f, shop: null }, p))} ${f.shop != null ? `AND p.vendor_id = ${p(f.shop)}` : ''}`;
  },
};

const funnel = {
  key: 'product-funnel',
  group: 'inventory',
  title: 'Views vs carts vs sales',
  description: 'For each product: app views, add-to-carts, checkouts and units sold, with view → cart and cart → order rates.',
  keywords: ['conversion', 'funnel', 'product views', 'add to cart', 'analytics', 'popular'],
  filters: [F.shop, F.category, F.brand, { key: 'minViews', label: 'At least N views', type: 'number', outer: 'views', op: 'gte' }],
  columns: [
    { key: 'product', label: 'Product', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'category', label: 'Category', type: 'text', search: true },
    { key: 'views', label: 'Views', type: 'int' },
    { key: 'carts', label: 'Add to cart', type: 'int' },
    { key: 'checkouts', label: 'Checkouts', type: 'int' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'units', label: 'Units sold', type: 'int' },
    { key: 'view_to_cart', label: 'View → cart', type: 'percent' },
    { key: 'cart_to_order', label: 'Cart → order', type: 'percent' },
  ],
  defaultSort: { key: 'views', dir: 'desc' },
  summary: [
    { key: 'views', label: 'Views', type: 'int', sql: 'COALESCE(SUM(r.views), 0)' },
    { key: 'carts', label: 'Add to cart', type: 'int', sql: 'COALESCE(SUM(r.carts), 0)' },
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'view_to_cart', label: 'View → cart', type: 'percent', sql: 'ROUND(100.0 * SUM(r.carts) / NULLIF(SUM(r.views), 0), 1)' },
    { key: 'cart_to_order', label: 'Cart → order', type: 'percent', sql: 'ROUND(100.0 * SUM(r.orders) / NULLIF(SUM(r.carts), 0), 1)' },
  ],
  notes: 'Views, carts and checkouts come from the shopper app\'s analytics (Admin → Analytics); orders and units use paid orders that weren\'t cancelled. Products with no views and no sales are left out.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`p.vendor_id = ${p(f.shop)}`);
    if (f.category) w.push(`LOWER(p.category) = LOWER(${p(f.category)})`);
    if (f.brand != null) w.push(`p.brand_id = ${p(f.brand)}`);
    return `
      WITH ev AS (
        SELECT e.product_id,
               COUNT(*) FILTER (WHERE e.event = 'product_view') AS views,
               COUNT(*) FILTER (WHERE e.event = 'add_to_cart') AS carts,
               COUNT(*) FILTER (WHERE e.event = 'checkout_start') AS checkouts
        FROM analytics_events e
        WHERE e.product_id IS NOT NULL AND ${inRange('e.occurred_at')}
        GROUP BY e.product_id
      ),
      so AS (
        SELECT product_id, SUM(units) AS units, SUM(orders) AS orders
        FROM (${SOLD(`AND ${inRange('o.created_at')}`)}) x GROUP BY product_id
      )
      SELECT p.name AS product, v.business_name AS shop, COALESCE(NULLIF(TRIM(p.category), ''), 'Other') AS category,
             COALESCE(ev.views, 0) AS views, COALESCE(ev.carts, 0) AS carts, COALESCE(ev.checkouts, 0) AS checkouts,
             COALESCE(so.orders, 0) AS orders, COALESCE(so.units, 0) AS units,
             ROUND(100.0 * COALESCE(ev.carts, 0) / NULLIF(ev.views, 0), 1) AS view_to_cart,
             ROUND(100.0 * COALESCE(so.orders, 0) / NULLIF(ev.carts, 0), 1) AS cart_to_order
      FROM products p
      JOIN vendor_profiles v ON v.id = p.vendor_id
      LEFT JOIN ev ON ev.product_id = p.id
      LEFT JOIN so ON so.product_id = p.id
      WHERE (ev.product_id IS NOT NULL OR so.product_id IS NOT NULL) ${and(w)}`;
  },
};

const approvals = {
  key: 'product-approvals',
  group: 'inventory',
  title: 'Products waiting for approval',
  description: 'Products sent for moderation: waiting, approved or rejected, how long they waited, and the reason given.',
  keywords: ['moderation', 'approval', 'pending products', 'rejected products', 'review queue'],
  noDates: true,
  filters: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      default: 'pending',
      options: [
        { value: 'pending', label: 'Waiting' },
        { value: 'rejected', label: 'Rejected' },
        { value: 'approved', label: 'Approved' },
      ],
    },
    F.shop,
    F.category,
  ],
  columns: [
    { key: 'product', label: 'Product', type: 'text', search: true },
    { key: 'sku', label: 'SKU', type: 'text', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'category', label: 'Category', type: 'text', search: true },
    { key: 'price', label: 'Price', type: 'money' },
    { key: 'submitted_at', label: 'Sent', type: 'datetime' },
    { key: 'waiting_days', label: 'Days waiting', type: 'int' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'decided_at', label: 'Decided', type: 'datetime' },
    { key: 'reason', label: 'Reason', type: 'text', search: true },
  ],
  defaultSort: { key: 'submitted_at', dir: 'asc' },
  summary: [
    { key: 'products', label: 'Products', type: 'int', sql: 'COUNT(*)' },
    { key: 'shops', label: 'Shops', type: 'int', sql: 'COUNT(DISTINCT r.shop)' },
    { key: 'oldest', label: 'Longest wait (days)', type: 'int', sql: 'MAX(r.waiting_days)' },
  ],
  notes: 'Days waiting runs to the decision, or to today while still waiting.',
  sql: ({ f, p }) => {
    const w = [`p.moderation_status = ${p(f.status)}`];
    if (f.shop != null) w.push(`p.vendor_id = ${p(f.shop)}`);
    if (f.category) w.push(`LOWER(p.category) = LOWER(${p(f.category)})`);
    return `
      SELECT p.name AS product, p.sku, v.business_name AS shop, COALESCE(NULLIF(TRIM(p.category), ''), 'Other') AS category,
             p.price_cents AS price, COALESCE(p.submitted_at, p.created_at) AS submitted_at,
             (COALESCE(p.moderated_at, now())::date - COALESCE(p.submitted_at, p.created_at)::date) AS waiting_days,
             p.moderation_status AS status, p.moderated_at AS decided_at, p.moderation_reason AS reason
      FROM products p JOIN vendor_profiles v ON v.id = p.vendor_id
      WHERE ${w.join(' AND ')}`;
  },
};

module.exports = { reports: [stockValue, lowStock, deadStock, fastMovers, funnel, approvals] };
