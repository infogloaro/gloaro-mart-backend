/**
 * RP8 — Customers reports: customer list, new vs repeat, top customers,
 * customers by place, inactive customers and customer growth.
 *
 * "Ordered" uses real orders: paid, not cancelled, not a free replacement. A
 * customer's place is their default address (else their latest one); an
 * order's place is where it was delivered.
 */
const { PAID, CITY, PINCODE } = require('./sales');

const and = (w) => (w.length ? `AND ${w.join(' AND ')}` : '');
const NAME = `COALESCE(NULLIF(TRIM(u.full_name), ''), u.email)`;
const SALE = `o.replacement_of_order_id IS NULL AND o.status <> 'cancelled' AND ${PAID}`;
/** Each customer's home place: default address, else the latest one. */
const HOME = `LEFT JOIN LATERAL (
  SELECT ad.city, ad.district, ad.pincode FROM addresses ad
  WHERE ad.user_id = u.id AND ad.is_active ORDER BY ad.is_default DESC, ad.id DESC LIMIT 1
) home ON TRUE`;
/** All-time orders per customer. */
const LIFETIME = `
  SELECT o.user_id, COUNT(*) AS orders, SUM(o.total_cents) AS spent, MIN(o.created_at) AS first_order, MAX(o.created_at) AS last_order
  FROM orders o WHERE ${SALE} GROUP BY o.user_id`;
const CITY_FILTER = { key: 'city', label: 'City', type: 'city' };

const customerList = {
  key: 'customer-list',
  group: 'customers',
  title: 'Customer list',
  description: 'Customers who joined in the range, with contact, place, orders, money spent, last order, language, WhatsApp, wallet and points.',
  keywords: ['customers', 'users', 'buyers', 'contacts', 'export customers', 'phone list'],
  filters: [
    CITY_FILTER,
    { key: 'pincode', label: 'Pincode', type: 'text' },
    {
      key: 'ordered',
      label: 'Has ordered',
      type: 'select',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'Not yet' },
      ],
    },
    {
      key: 'language',
      label: 'App language',
      type: 'select',
      options: [
        { value: 'en', label: 'English' },
        { value: 'ta', label: 'Tamil' },
        { value: 'hi', label: 'Hindi' },
      ],
    },
    {
      key: 'whatsapp',
      label: 'WhatsApp updates',
      type: 'select',
      options: [
        { value: 'yes', label: 'Opted in' },
        { value: 'no', label: 'Not opted in' },
      ],
    },
  ],
  columns: [
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'email', label: 'Email', type: 'text', search: true },
    { key: 'phone', label: 'Phone', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'pincode', label: 'Pincode', type: 'text', search: true },
    { key: 'joined', label: 'Joined', type: 'datetime' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'spent', label: 'Spent', type: 'money' },
    { key: 'last_order', label: 'Last order', type: 'datetime' },
    { key: 'language', label: 'Language', type: 'text' },
    { key: 'whatsapp', label: 'WhatsApp', type: 'status' },
    { key: 'wallet', label: 'Wallet', type: 'money' },
    { key: 'points', label: 'Points', type: 'int' },
  ],
  defaultSort: { key: 'joined', dir: 'desc' },
  summary: [
    { key: 'customers', label: 'Customers', type: 'int', sql: 'COUNT(*)' },
    { key: 'ordered', label: 'Have ordered', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.orders > 0)' },
    { key: 'spent', label: 'Spent (all time)', type: 'money', sql: 'COALESCE(SUM(r.spent), 0)' },
    { key: 'whatsapp', label: 'WhatsApp opted in', type: 'int', sql: `COUNT(*) FILTER (WHERE r.whatsapp = 'opted in')` },
  ],
  notes: 'By the date they joined. Orders and spent are all-time (paid, not cancelled). City / pincode = the customer\'s default address.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.city) w.push(`LOWER(home.city) = LOWER(${p(f.city)})`);
    if (f.pincode) w.push(`home.pincode LIKE ${p(`${f.pincode.replace(/\D/g, '')}%`)}`);
    if (f.ordered === 'yes') w.push('lt.orders > 0');
    if (f.ordered === 'no') w.push('lt.user_id IS NULL');
    if (f.language) w.push(`COALESCE(u.preferred_language, 'en') = ${p(f.language)}`);
    if (f.whatsapp === 'yes') w.push('u.whatsapp_opt_in');
    if (f.whatsapp === 'no') w.push('NOT u.whatsapp_opt_in');
    return `
      SELECT ${NAME} AS customer, u.email, u.phone_number AS phone, home.city, home.pincode, u.created_at AS joined,
             COALESCE(lt.orders, 0) AS orders, COALESCE(lt.spent, 0) AS spent, lt.last_order,
             CASE COALESCE(u.preferred_language, 'en') WHEN 'en' THEN 'English' WHEN 'ta' THEN 'Tamil' WHEN 'hi' THEN 'Hindi'
                  ELSE u.preferred_language END AS language,
             CASE WHEN u.whatsapp_opt_in THEN 'opted in' ELSE '—' END AS whatsapp,
             cw.balance_cents AS wallet, ra.balance_points AS points
      FROM users u
      ${HOME}
      LEFT JOIN (${LIFETIME}) lt ON lt.user_id = u.id
      LEFT JOIN customer_wallets cw ON cw.user_id = u.id
      LEFT JOIN reward_accounts ra ON ra.user_id = u.id
      WHERE u.role = 'customer' AND ${inRange('u.created_at')} ${and(w)}`;
  },
};

const PERIOD = {
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
const periods = (ctx) => {
  const unit = ctx.f.groupBy;
  return `SELECT gs::date AS period FROM generate_series(date_trunc('${unit}', ${ctx.p(ctx.range.from)}::date),
            ${ctx.p(ctx.range.to)}::date, interval '1 ${unit}') gs`;
};

const newVsRepeat = {
  key: 'new-vs-repeat',
  group: 'customers',
  title: 'New vs repeat customers',
  description: 'For each day, week or month: customers who ordered, how many were new or coming back, and what each group spent.',
  keywords: ['repeat customers', 'retention', 'returning', 'first order', 'loyal'],
  filters: [PERIOD, CITY_FILTER, { key: 'shop', label: 'Shop', type: 'shop' }],
  columns: [
    { key: 'period', label: 'Period', type: 'text' },
    { key: 'customers', label: 'Customers', type: 'int' },
    { key: 'new_customers', label: 'New', type: 'int' },
    { key: 'repeat_customers', label: 'Repeat', type: 'int' },
    { key: 'new_sales', label: 'New spent', type: 'money' },
    { key: 'repeat_sales', label: 'Repeat spent', type: 'money' },
    { key: 'repeat_share', label: 'Repeat share of sales', type: 'percent' },
  ],
  defaultSort: { key: 'period', dir: 'asc' },
  summary: [
    { key: 'new_sales', label: 'Spent by new', type: 'money', sql: 'COALESCE(SUM(r.new_sales), 0)' },
    { key: 'repeat_sales', label: 'Spent by repeat', type: 'money', sql: 'COALESCE(SUM(r.repeat_sales), 0)' },
    {
      key: 'repeat_share',
      label: 'Repeat share of sales',
      type: 'percent',
      sql: 'ROUND(100.0 * SUM(r.repeat_sales) / NULLIF(SUM(r.new_sales + r.repeat_sales), 0), 1)',
    },
  ],
  notes: 'New = the order is the customer\'s first real order ever; repeat = they had ordered before. A customer counts once per period, as new if any of their orders in it was their first.',
  sql: (ctx) => {
    const { f, p, inRange } = ctx;
    const unit = f.groupBy;
    const w = [];
    if (f.city) w.push(`LOWER(${CITY}) = LOWER(${p(f.city)})`);
    if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
    return `
      WITH ranked AS (
        SELECT o.id, o.user_id, o.total_cents, o.created_at, o.vendor_id, o.delivery_address_snapshot, o.address_id,
               ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY o.created_at, o.id) = 1 AS is_first
        FROM orders o WHERE ${SALE}
      ),
      o AS (
        SELECT o.*, date_trunc('${unit}', o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS period
        FROM ranked o LEFT JOIN addresses a ON a.id = o.address_id
        WHERE ${inRange('o.created_at')} ${and(w)}
      ),
      per AS (
        SELECT period, user_id, BOOL_OR(is_first) AS is_new, SUM(total_cents) AS spent FROM o GROUP BY period, user_id
      ),
      agg AS (
        SELECT period, COUNT(*) AS customers, COUNT(*) FILTER (WHERE is_new) AS new_customers,
               COUNT(*) FILTER (WHERE NOT is_new) AS repeat_customers,
               COALESCE(SUM(spent) FILTER (WHERE is_new), 0) AS new_sales,
               COALESCE(SUM(spent) FILTER (WHERE NOT is_new), 0) AS repeat_sales
        FROM per GROUP BY period
      )
      SELECT to_char(pr.period, ${PERIOD_LABEL[unit]}) AS period,
             COALESCE(agg.customers, 0) AS customers, COALESCE(agg.new_customers, 0) AS new_customers,
             COALESCE(agg.repeat_customers, 0) AS repeat_customers,
             COALESCE(agg.new_sales, 0) AS new_sales, COALESCE(agg.repeat_sales, 0) AS repeat_sales,
             ROUND(100.0 * agg.repeat_sales / NULLIF(agg.new_sales + agg.repeat_sales, 0), 1) AS repeat_share
      FROM (${periods(ctx)}) pr LEFT JOIN agg ON agg.period = pr.period`;
  },
};

const topCustomers = {
  key: 'top-customers',
  group: 'customers',
  title: 'Top customers',
  description: 'Customers by what they spent in the range: orders, spent, average order, shops used, first and last order.',
  keywords: ['top customers', 'vip', 'best customers', 'high value', 'big spenders'],
  filters: [
    CITY_FILTER,
    { key: 'shop', label: 'Shop', type: 'shop' },
    { key: 'minOrders', label: 'At least N orders', type: 'number', outer: 'orders', op: 'gte' },
    { key: 'minSpent', label: 'Spent at least (₹)', type: 'number', money: true, outer: 'spent', op: 'gte' },
  ],
  columns: [
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'phone', label: 'Phone', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'spent', label: 'Spent', type: 'money' },
    { key: 'aov', label: 'Avg order', type: 'money' },
    { key: 'shops', label: 'Shops used', type: 'int' },
    { key: 'first_order', label: 'First order', type: 'datetime' },
    { key: 'last_order', label: 'Last order', type: 'datetime' },
  ],
  defaultSort: { key: 'spent', dir: 'desc' },
  summary: [
    { key: 'customers', label: 'Customers', type: 'int', sql: 'COUNT(*)' },
    { key: 'spent', label: 'Spent', type: 'money', sql: 'COALESCE(SUM(r.spent), 0)' },
    { key: 'avg_spent', label: 'Avg per customer', type: 'money', sql: 'ROUND(AVG(r.spent))' },
    { key: 'multi', label: 'Ordered 2+ times', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.orders >= 2)' },
  ],
  notes: 'Orders in the range: paid, not cancelled. City = where the orders were delivered (the most common one).',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.city) w.push(`LOWER(${CITY}) = LOWER(${p(f.city)})`);
    if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
    return `
      SELECT ${NAME} AS customer, u.phone_number AS phone, mode() WITHIN GROUP (ORDER BY ${CITY}) AS city,
             COUNT(*) AS orders, SUM(o.total_cents) AS spent, ROUND(AVG(o.total_cents)) AS aov,
             COUNT(DISTINCT o.vendor_id) AS shops, MIN(o.created_at) AS first_order, MAX(o.created_at) AS last_order
      FROM orders o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN addresses a ON a.id = o.address_id
      WHERE ${SALE} AND ${inRange('o.created_at')} ${and(w)}
      GROUP BY u.id`;
  },
};

const PLACE = {
  city: { name: `COALESCE(${CITY}, '—')`, label: 'City' },
  district: { name: `COALESCE(NULLIF(TRIM(o.delivery_address_snapshot->>'district'), ''), a.district, '—')`, label: 'District' },
  pincode: { name: `COALESCE(${PINCODE}, '—')`, label: 'Pincode' },
};

const byPlace = {
  key: 'customers-by-place',
  group: 'customers',
  title: 'Customers by city / pincode',
  description: 'Where customers order from: customers, new customers, orders, sales and average order per city, district or pincode.',
  keywords: ['city', 'pincode', 'district', 'location', 'geography', 'area', 'where customers are'],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      default: 'city',
      options: [
        { value: 'city', label: 'City' },
        { value: 'district', label: 'District' },
        { value: 'pincode', label: 'Pincode' },
      ],
    },
    CITY_FILTER,
    { key: 'shop', label: 'Shop', type: 'shop' },
  ],
  columns: [
    { key: 'place', label: 'Place', type: 'text', search: true },
    { key: 'customers', label: 'Customers', type: 'int' },
    { key: 'new_customers', label: 'New customers', type: 'int' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'sales', label: 'Sales', type: 'money' },
    { key: 'aov', label: 'Avg order', type: 'money' },
    { key: 'share', label: 'Share of sales', type: 'percent' },
  ],
  defaultSort: { key: 'sales', dir: 'desc' },
  summary: [
    { key: 'places', label: 'Places', type: 'int', sql: 'COUNT(*)' },
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'sales', label: 'Sales', type: 'money', sql: 'COALESCE(SUM(r.sales), 0)' },
  ],
  notes: 'By where orders were delivered, in the range (paid, not cancelled). New = the customer\'s first real order ever was in the range here. A customer who ordered to two places counts in both.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.city) w.push(`LOWER(${CITY}) = LOWER(${p(f.city)})`);
    if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
    return `
      WITH firsts AS (SELECT DISTINCT ON (o.user_id) o.id FROM orders o WHERE ${SALE} ORDER BY o.user_id, o.created_at, o.id)
      SELECT ${PLACE[f.groupBy].name} AS place,
             COUNT(DISTINCT o.user_id) AS customers,
             COUNT(DISTINCT o.user_id) FILTER (WHERE o.id IN (SELECT id FROM firsts)) AS new_customers,
             COUNT(*) AS orders, SUM(o.total_cents) AS sales, ROUND(AVG(o.total_cents)) AS aov,
             ROUND(100.0 * SUM(o.total_cents) / NULLIF(SUM(SUM(o.total_cents)) OVER (), 0), 1) AS share
      FROM orders o LEFT JOIN addresses a ON a.id = o.address_id
      WHERE ${SALE} AND ${inRange('o.created_at')} ${and(w)}
      GROUP BY 1`;
  },
};

const inactive = {
  key: 'inactive-customers',
  group: 'customers',
  title: 'Inactive customers',
  description: 'Customers who haven\'t ordered in 30, 60 or 90 days — or never have — with what they spent before, to win them back.',
  keywords: ['inactive', 'lapsed', 'churn', 'win back', 'dormant', 'no orders'],
  noDates: true,
  filters: [
    {
      key: 'days',
      label: 'No order in',
      type: 'select',
      default: '30',
      options: [
        { value: '30', label: '30 days' },
        { value: '60', label: '60 days' },
        { value: '90', label: '90 days' },
      ],
    },
    {
      key: 'never',
      label: 'Include never ordered',
      type: 'select',
      default: 'yes',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No, only past buyers' },
      ],
    },
    CITY_FILTER,
    {
      key: 'whatsapp',
      label: 'WhatsApp updates',
      type: 'select',
      options: [{ value: 'yes', label: 'Opted in (can be messaged)' }],
    },
  ],
  columns: [
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'phone', label: 'Phone', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'joined', label: 'Joined', type: 'datetime' },
    { key: 'orders', label: 'Orders before', type: 'int' },
    { key: 'spent', label: 'Spent before', type: 'money' },
    { key: 'last_order', label: 'Last order', type: 'datetime' },
    { key: 'days_idle', label: 'Days since', type: 'int' },
    { key: 'whatsapp', label: 'WhatsApp', type: 'status' },
  ],
  defaultSort: { key: 'spent', dir: 'desc' },
  summary: [
    { key: 'customers', label: 'Inactive', type: 'int', sql: 'COUNT(*)' },
    { key: 'past_buyers', label: 'Past buyers', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.orders > 0)' },
    { key: 'never', label: 'Never ordered', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.orders = 0)' },
    { key: 'spent', label: 'They spent before', type: 'money', sql: 'COALESCE(SUM(r.spent), 0)' },
  ],
  notes: 'Right now. Days since = since the last order, or since joining for those who never ordered. Customers who joined inside the window and haven\'t ordered yet aren\'t counted as inactive.',
  sql: ({ f, p }) => {
    const days = `(${p(Number(f.days))} * interval '1 day')`;
    const w = [`COALESCE(lt.last_order, u.created_at) < now() - ${days}`];
    if (f.never === 'no') w.push('lt.user_id IS NOT NULL');
    if (f.city) w.push(`LOWER(home.city) = LOWER(${p(f.city)})`);
    if (f.whatsapp === 'yes') w.push('u.whatsapp_opt_in');
    return `
      SELECT ${NAME} AS customer, u.phone_number AS phone, home.city, u.created_at AS joined,
             COALESCE(lt.orders, 0) AS orders, COALESCE(lt.spent, 0) AS spent, lt.last_order,
             (now()::date - COALESCE(lt.last_order, u.created_at)::date) AS days_idle,
             CASE WHEN u.whatsapp_opt_in THEN 'opted in' ELSE '—' END AS whatsapp
      FROM users u
      ${HOME}
      LEFT JOIN (${LIFETIME}) lt ON lt.user_id = u.id
      WHERE u.role = 'customer' ${and(w)}`;
  },
};

const growth = {
  key: 'customer-growth',
  group: 'customers',
  title: 'Customer growth',
  description: 'Signups, first-time buyers and the running total of customers for each day, week or month.',
  keywords: ['growth', 'signups', 'registrations', 'acquisition', 'new users', 'cumulative'],
  filters: [PERIOD],
  columns: [
    { key: 'period', label: 'Period', type: 'text' },
    { key: 'signups', label: 'Signups', type: 'int' },
    { key: 'first_buyers', label: 'First-time buyers', type: 'int' },
    { key: 'total_customers', label: 'Customers so far', type: 'int' },
    { key: 'total_buyers', label: 'Buyers so far', type: 'int' },
  ],
  defaultSort: { key: 'period', dir: 'asc' },
  summary: [
    { key: 'signups', label: 'Signups', type: 'int', sql: 'COALESCE(SUM(r.signups), 0)' },
    { key: 'first_buyers', label: 'First-time buyers', type: 'int', sql: 'COALESCE(SUM(r.first_buyers), 0)' },
    { key: 'total', label: 'Customers now', type: 'int', sql: 'MAX(r.total_customers)' },
  ],
  notes: 'Running totals include everyone before the range. First-time buyer = the customer\'s first real order (paid, not cancelled).',
  sql: (ctx) => {
    const unit = ctx.f.groupBy;
    const trunc = (col) => `date_trunc('${unit}', ${col} AT TIME ZONE 'Asia/Kolkata')::date`;
    return `
      WITH pr AS (${periods(ctx)}),
      su AS (SELECT ${trunc('u.created_at')} AS period, COUNT(*) AS n FROM users u WHERE u.role = 'customer' GROUP BY 1),
      fb AS (SELECT ${trunc('MIN(o.created_at)')} AS period, o.user_id FROM orders o WHERE ${SALE} GROUP BY o.user_id),
      fbn AS (SELECT period, COUNT(*) AS n FROM fb GROUP BY period)
      SELECT to_char(pr.period, ${PERIOD_LABEL[unit]}) AS period,
             COALESCE(su.n, 0) AS signups, COALESCE(fbn.n, 0) AS first_buyers,
             (SELECT COALESCE(SUM(n), 0) FROM su s2 WHERE s2.period <= pr.period) AS total_customers,
             (SELECT COALESCE(SUM(n), 0) FROM fbn f2 WHERE f2.period <= pr.period) AS total_buyers
      FROM pr LEFT JOIN su ON su.period = pr.period LEFT JOIN fbn ON fbn.period = pr.period`;
  },
};

module.exports = { reports: [customerList, newVsRepeat, topCustomers, byPlace, inactive, growth] };
