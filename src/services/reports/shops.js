/**
 * RP7 — Shops (vendors) reports: the shop list, new shops, performance
 * ranking, visits & popularity, ratings, customers' reports of wrong shop
 * details, and how fast shops accept orders.
 *
 * There is no shop subscription / plan table yet (only commission plans), so
 * there is no subscription report.
 */
const { REASONS: INFO_REASONS } = require('../shopReports');
const { PAID, F } = require('./sales');

const and = (w) => (w.length ? `AND ${w.join(' AND ')}` : '');
const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;
const STATUS_OPTIONS = [
  { value: 'approved', label: 'Approved' },
  { value: 'pending', label: 'Waiting for approval' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'suspended', label: 'Suspended' },
];
const SHOP_CITY = { key: 'city', label: 'Shop city', type: 'city' };
const SHOP_TYPE = { key: 'shopType', label: 'Shop type contains', type: 'text', outer: 'shop_type', op: 'ilike' };
// A sale: paid, not cancelled, not a free replacement.
const SALE = `o.replacement_of_order_id IS NULL AND o.status <> 'cancelled' AND ${PAID}`;

/** Where clauses on vendor_profiles v for the shop filters. */
function shopWhere(f, p) {
  const w = [];
  if (f.shop != null) w.push(`v.id = ${p(f.shop)}`);
  if (f.city) w.push(`LOWER(v.city) = LOWER(${p(f.city)})`);
  if (f.district) w.push(`v.district ILIKE ${p(`%${f.district}%`)}`);
  if (f.pincode) w.push(`v.pincode LIKE ${p(`${f.pincode.replace(/\D/g, '')}%`)}`);
  if (f.status) w.push(`v.status = ${p(f.status)}`);
  return w;
}

const shopList = {
  key: 'shop-list',
  group: 'shops',
  title: 'Shop list & status',
  description: 'Every shop with place, type, status, verified / on hold, paused, products, followers and when it joined.',
  keywords: ['vendors', 'shops', 'sellers', 'vendor list', 'directory', 'verified', 'kyc'],
  noDates: true,
  filters: [
    { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
    {
      key: 'trust',
      label: 'Verified',
      type: 'select',
      options: [
        { value: 'verified', label: 'Verified' },
        { value: 'hold', label: 'Verified badge on hold' },
      ],
    },
    {
      key: 'open',
      label: 'Open now?',
      type: 'select',
      options: [
        { value: 'paused', label: 'Paused by the shop' },
        { value: 'busy', label: 'Busy (extra time)' },
      ],
    },
    SHOP_CITY,
    { key: 'pincode', label: 'Pincode', type: 'text' },
    SHOP_TYPE,
  ],
  columns: [
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'owner', label: 'Owner', type: 'text', search: true },
    { key: 'phone', label: 'Phone', type: 'text', search: true },
    { key: 'shop_type', label: 'Type', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'pincode', label: 'Pincode', type: 'text', search: true },
    { key: 'gstin', label: 'GSTIN', type: 'text', search: true },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'trust', label: 'Verified', type: 'status' },
    { key: 'open_state', label: 'Open?', type: 'status' },
    { key: 'products', label: 'Live products', type: 'int' },
    { key: 'followers', label: 'Followers', type: 'int' },
    { key: 'joined', label: 'Joined', type: 'date' },
  ],
  defaultSort: { key: 'shop', dir: 'asc' },
  summary: [
    { key: 'shops', label: 'Shops', type: 'int', sql: 'COUNT(*)' },
    { key: 'approved', label: 'Approved', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'approved')` },
    { key: 'pending', label: 'Waiting', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'pending')` },
    { key: 'suspended', label: 'Suspended', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'suspended')` },
    { key: 'paused', label: 'Paused now', type: 'int', sql: `COUNT(*) FILTER (WHERE r.open_state = 'paused')` },
  ],
  notes: 'Right now, not for a date range. Verified = approved and the badge isn\'t on hold. Live products = active and approved.',
  sql: ({ f, p }) => {
    const w = shopWhere(f, p);
    if (f.trust === 'verified') w.push(`v.status = 'approved' AND NOT v.verification_hold`);
    if (f.trust === 'hold') w.push('v.verification_hold');
    if (f.open === 'paused') w.push(`v.paused AND (v.paused_until IS NULL OR v.paused_until > now())`);
    if (f.open === 'busy') w.push('v.busy_until > now()');
    return `
      SELECT v.business_name AS shop, COALESCE(NULLIF(TRIM(u.full_name), ''), u.email) AS owner,
             COALESCE(NULLIF(TRIM(u.phone_number), ''), v.contact->>'phone') AS phone,
             COALESCE(NULLIF(TRIM(v.shop_category), ''), '—') AS shop_type, v.city, v.pincode, v.gst_number AS gstin, v.status,
             CASE WHEN v.verification_hold THEN 'on hold' WHEN v.status = 'approved' THEN 'verified' ELSE '—' END AS trust,
             CASE WHEN v.paused AND (v.paused_until IS NULL OR v.paused_until > now()) THEN 'paused'
                  WHEN v.busy_until > now() THEN 'busy' ELSE 'open' END AS open_state,
             (SELECT COUNT(*) FROM products pr WHERE pr.vendor_id = v.id AND pr.is_active AND pr.moderation_status = 'approved') AS products,
             (SELECT COUNT(*) FROM shop_follows sf WHERE sf.vendor_id = v.id) AS followers,
             v.created_at AS joined
      FROM vendor_profiles v JOIN users u ON u.id = v.user_id
      WHERE TRUE ${and(w)}`;
  },
};

const signups = {
  key: 'shop-signups',
  group: 'shops',
  title: 'New shop signups',
  description: 'Shops that joined in the range: status, KYC sent, how long approval took, and products listed so far.',
  keywords: ['new vendors', 'onboarding', 'signups', 'registrations', 'approval time'],
  filters: [{ key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS }, SHOP_CITY, SHOP_TYPE],
  columns: [
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'shop_type', label: 'Type', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'joined', label: 'Joined', type: 'datetime' },
    { key: 'kyc_sent', label: 'KYC sent', type: 'datetime' },
    { key: 'approved_at', label: 'Approved', type: 'datetime' },
    { key: 'days_to_approve', label: 'Days to approve', type: 'number' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'products', label: 'Products listed', type: 'int' },
  ],
  defaultSort: { key: 'joined', dir: 'desc' },
  summary: [
    { key: 'signups', label: 'New shops', type: 'int', sql: 'COUNT(*)' },
    { key: 'approved', label: 'Approved', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'approved')` },
    { key: 'pending', label: 'Waiting', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'pending')` },
    { key: 'avg_days', label: 'Avg days to approve', type: 'number', sql: 'ROUND(AVG(r.days_to_approve), 1)' },
  ],
  sql: ({ f, p, inRange }) => `
    SELECT v.business_name AS shop, COALESCE(NULLIF(TRIM(v.shop_category), ''), '—') AS shop_type, v.city,
           v.created_at AS joined, v.kyc_submitted_at AS kyc_sent, v.approved_at,
           ROUND((EXTRACT(EPOCH FROM (v.approved_at - v.created_at)) / 86400)::numeric, 1) AS days_to_approve,
           v.status, (SELECT COUNT(*) FROM products pr WHERE pr.vendor_id = v.id) AS products
    FROM vendor_profiles v
    WHERE ${inRange('v.created_at')} ${and(shopWhere(f, p))}`,
};

const performance = {
  key: 'shop-ranking',
  group: 'shops',
  title: 'Shop ranking',
  description: 'Shops ranked by sales in the range, with orders, cancel rate, rating, visitors and visitor → order rate.',
  keywords: ['top shops', 'best vendors', 'leaderboard', 'vendor performance', 'ranking'],
  filters: [SHOP_CITY, { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS }, SHOP_TYPE],
  columns: [
    { key: 'rank', label: 'Rank', type: 'int' },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'shop_type', label: 'Type', type: 'text' },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'sales', label: 'Sales', type: 'money' },
    { key: 'cancel_rate', label: 'Cancel rate', type: 'percent' },
    { key: 'rating', label: 'Rating', type: 'number' },
    { key: 'reviews', label: 'Reviews', type: 'int' },
    { key: 'visitors', label: 'Visitors', type: 'int' },
    { key: 'conversion', label: 'Visitor → order', type: 'percent' },
  ],
  defaultSort: { key: 'rank', dir: 'asc' },
  summary: [
    { key: 'shops', label: 'Shops', type: 'int', sql: 'COUNT(*)' },
    { key: 'selling', label: 'Shops with sales', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.orders > 0)' },
    { key: 'sales', label: 'Sales', type: 'money', sql: 'COALESCE(SUM(r.sales), 0)' },
    { key: 'top', label: 'Top shop', type: 'text', sql: '(ARRAY_AGG(r.shop ORDER BY r.rank) FILTER (WHERE r.orders > 0))[1]' },
  ],
  notes: 'Rank by sales (paid orders not cancelled), then orders. Rating = published shop reviews ever; visitors = distinct people who opened the shop page in the range.',
  sql: ({ f, p, inRange, range }) => {
    const days = `${p(range.from)}::date AND ${p(range.to)}::date`;
    return `
      WITH o AS (
        SELECT o.vendor_id,
               COUNT(*) FILTER (WHERE ${SALE}) AS orders,
               COALESCE(SUM(o.total_cents) FILTER (WHERE ${SALE}), 0) AS sales,
               COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled, COUNT(*) AS placed
        FROM orders o WHERE o.replacement_of_order_id IS NULL AND ${inRange('o.created_at')} GROUP BY o.vendor_id
      ),
      rv AS (SELECT vendor_id, ROUND(AVG(rating), 1) AS rating, COUNT(*) AS reviews FROM vendor_reviews
             WHERE target = 'vendor' AND status = 'published' GROUP BY vendor_id),
      vis AS (SELECT vendor_id, SUM(visitors) AS visitors FROM shop_visit_daily WHERE day BETWEEN ${days} GROUP BY vendor_id)
      SELECT RANK() OVER (ORDER BY COALESCE(o.sales, 0) DESC, COALESCE(o.orders, 0) DESC) AS rank,
             v.business_name AS shop, COALESCE(NULLIF(TRIM(v.shop_category), ''), '—') AS shop_type, v.city,
             COALESCE(o.orders, 0) AS orders, COALESCE(o.sales, 0) AS sales,
             ROUND(100.0 * o.cancelled / NULLIF(o.placed, 0), 1) AS cancel_rate,
             rv.rating, COALESCE(rv.reviews, 0) AS reviews, COALESCE(vis.visitors, 0) AS visitors,
             ROUND(100.0 * COALESCE(o.orders, 0) / NULLIF(vis.visitors, 0), 1) AS conversion
      FROM vendor_profiles v
      LEFT JOIN o ON o.vendor_id = v.id
      LEFT JOIN rv ON rv.vendor_id = v.id
      LEFT JOIN vis ON vis.vendor_id = v.id
      WHERE TRUE ${and(shopWhere(f, p))}`;
  },
};

const visits = {
  key: 'shop-visits',
  group: 'shops',
  title: 'Shop visits & popularity',
  description: 'How many people opened each shop in the range, signed-in visitors, followers gained, orders and visitor → order rate.',
  keywords: ['visits', 'footfall', 'popularity', 'most visited', 'trending', 'followers', 'locality'],
  filters: [SHOP_CITY, { key: 'district', label: 'District', type: 'text' }, { key: 'pincode', label: 'Pincode', type: 'text' }, F.shop],
  columns: [
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'pincode', label: 'Pincode', type: 'text', search: true },
    { key: 'visitors', label: 'Visitors', type: 'int' },
    { key: 'signed_in', label: 'Signed-in visitors', type: 'int' },
    { key: 'busiest_day', label: 'Busiest day', type: 'date' },
    { key: 'new_followers', label: 'New followers', type: 'int' },
    { key: 'followers', label: 'Followers now', type: 'int' },
    { key: 'orders', label: 'Orders', type: 'int' },
    { key: 'conversion', label: 'Visitor → order', type: 'percent' },
  ],
  defaultSort: { key: 'visitors', dir: 'desc' },
  summary: [
    { key: 'visitors', label: 'Visitors', type: 'int', sql: 'COALESCE(SUM(r.visitors), 0)' },
    { key: 'new_followers', label: 'New followers', type: 'int', sql: 'COALESCE(SUM(r.new_followers), 0)' },
    { key: 'orders', label: 'Orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'conversion', label: 'Visitor → order', type: 'percent', sql: 'ROUND(100.0 * SUM(r.orders) / NULLIF(SUM(r.visitors), 0), 1)' },
  ],
  notes: 'A visitor is counted once per shop per day (as in the app\'s Most visited section). Only shops with a visit, follower or order in the range are listed.',
  sql: ({ f, p, inRange, range }) => {
    const days = `${p(range.from)}::date AND ${p(range.to)}::date`;
    return `
      WITH vis AS (
        SELECT vendor_id, COUNT(*) AS visitors, COUNT(*) FILTER (WHERE user_id IS NOT NULL) AS signed_in
        FROM shop_views WHERE day BETWEEN ${days} GROUP BY vendor_id
      ),
      peak AS (
        SELECT DISTINCT ON (vendor_id) vendor_id, day FROM shop_visit_daily
        WHERE day BETWEEN ${days} AND visitors > 0 ORDER BY vendor_id, visitors DESC, day DESC
      ),
      fol AS (
        SELECT vendor_id, COUNT(*) AS followers, COUNT(*) FILTER (WHERE ${inRange('created_at')}) AS new_followers
        FROM shop_follows GROUP BY vendor_id
      ),
      o AS (SELECT o.vendor_id, COUNT(*) AS orders FROM orders o WHERE ${SALE} AND ${inRange('o.created_at')} GROUP BY o.vendor_id)
      SELECT v.business_name AS shop, v.city, v.pincode,
             COALESCE(vis.visitors, 0) AS visitors, COALESCE(vis.signed_in, 0) AS signed_in, to_char(peak.day, 'YYYY-MM-DD') AS busiest_day,
             COALESCE(fol.new_followers, 0) AS new_followers, COALESCE(fol.followers, 0) AS followers,
             COALESCE(o.orders, 0) AS orders,
             ROUND(100.0 * COALESCE(o.orders, 0) / NULLIF(vis.visitors, 0), 1) AS conversion
      FROM vendor_profiles v
      LEFT JOIN vis ON vis.vendor_id = v.id
      LEFT JOIN peak ON peak.vendor_id = v.id
      LEFT JOIN fol ON fol.vendor_id = v.id
      LEFT JOIN o ON o.vendor_id = v.id
      WHERE (vis.visitors > 0 OR fol.new_followers > 0 OR o.orders > 0) ${and(shopWhere(f, p))}`;
  },
};

const ratings = {
  key: 'shop-ratings',
  group: 'shops',
  title: 'Shop ratings',
  description: 'Shop reviews written in the range: average rating, 5★ and 1–2★ counts, reviews waiting for moderation and shop replies.',
  keywords: ['rating', 'reviews', 'stars', 'feedback', 'bad reviews', 'customer satisfaction'],
  filters: [
    SHOP_CITY,
    F.shop,
    { key: 'maxRating', label: 'Average at most', type: 'number', outer: 'rating', op: 'lte' },
    { key: 'minRating', label: 'Average at least', type: 'number', outer: 'rating', op: 'gte' },
  ],
  columns: [
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'reviews', label: 'Reviews', type: 'int' },
    { key: 'rating', label: 'Average', type: 'number' },
    { key: 'five', label: '5★', type: 'int' },
    { key: 'low', label: '1–2★', type: 'int' },
    { key: 'waiting', label: 'Waiting moderation', type: 'int' },
    { key: 'replied', label: 'Shop replied', type: 'percent' },
    { key: 'all_time', label: 'All-time average', type: 'number' },
  ],
  defaultSort: { key: 'reviews', dir: 'desc' },
  summary: [
    { key: 'reviews', label: 'Reviews', type: 'int', sql: 'COALESCE(SUM(r.reviews), 0)' },
    { key: 'rating', label: 'Average', type: 'number', sql: 'ROUND(SUM(r.rating * r.reviews) / NULLIF(SUM(r.reviews), 0), 1)' },
    { key: 'low', label: '1–2★ reviews', type: 'int', sql: 'COALESCE(SUM(r.low), 0)' },
    { key: 'waiting', label: 'Waiting moderation', type: 'int', sql: 'COALESCE(SUM(r.waiting), 0)' },
  ],
  notes: 'Shop reviews (not product reviews), written in the range. The average counts published reviews; waiting = not yet moderated.',
  sql: ({ f, p, inRange }) => `
    WITH rv AS (
      SELECT vendor_id,
             COUNT(*) FILTER (WHERE status = 'published') AS reviews,
             ROUND(AVG(rating) FILTER (WHERE status = 'published'), 1) AS rating,
             COUNT(*) FILTER (WHERE status = 'published' AND rating = 5) AS five,
             COUNT(*) FILTER (WHERE status = 'published' AND rating <= 2) AS low,
             COUNT(*) FILTER (WHERE status = 'pending') AS waiting,
             ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'published' AND vendor_reply IS NOT NULL)
                   / NULLIF(COUNT(*) FILTER (WHERE status = 'published'), 0), 1) AS replied
      FROM vendor_reviews WHERE target = 'vendor' AND ${inRange('created_at')} GROUP BY vendor_id
    ),
    allt AS (SELECT vendor_id, ROUND(AVG(rating), 1) AS all_time FROM vendor_reviews
             WHERE target = 'vendor' AND status = 'published' GROUP BY vendor_id)
    SELECT v.business_name AS shop, v.city, rv.reviews, rv.rating, rv.five, rv.low, rv.waiting, rv.replied, allt.all_time
    FROM rv JOIN vendor_profiles v ON v.id = rv.vendor_id LEFT JOIN allt ON allt.vendor_id = v.id
    WHERE TRUE ${and(shopWhere(f, p))}`,
};

const infoReports = {
  key: 'shop-info-reports',
  group: 'shops',
  title: 'Wrong shop info reports',
  description: 'Customers\' reports that a shop\'s details are wrong (closed, hours, address, phone, map, category, not real) and what was done.',
  keywords: ['report shop', 'incorrect info', 'wrong address', 'closed shop', 'fake shop', 'complaints'],
  filters: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'open', label: 'Open' },
        { value: 'resolved', label: 'Fixed' },
        { value: 'dismissed', label: 'Dismissed' },
      ],
    },
    { key: 'reason', label: 'Reason', type: 'select', options: INFO_REASONS.map((r) => ({ value: r.code, label: r.label })) },
    F.shop,
    SHOP_CITY,
  ],
  columns: [
    { key: 'reported_at', label: 'Reported', type: 'datetime' },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'reason', label: 'Reason', type: 'text' },
    { key: 'note', label: 'Customer note', type: 'text', search: true },
    { key: 'reporter', label: 'Reported by', type: 'text', search: true },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'resolved_by', label: 'Closed by', type: 'text', search: true },
    { key: 'resolved_at', label: 'Closed', type: 'datetime' },
    { key: 'days_open', label: 'Days open', type: 'number' },
  ],
  defaultSort: { key: 'reported_at', dir: 'desc' },
  summary: [
    { key: 'reports', label: 'Reports', type: 'int', sql: 'COUNT(*)' },
    { key: 'open', label: 'Open', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'open')` },
    { key: 'shops', label: 'Shops reported', type: 'int', sql: 'COUNT(DISTINCT r.shop)' },
    { key: 'top_reason', label: 'Most common reason', type: 'text', sql: 'mode() WITHIN GROUP (ORDER BY r.reason)' },
  ],
  sql: ({ f, p, inRange }) => {
    const w = shopWhere({ shop: f.shop, city: f.city }, p);
    if (f.status) w.push(`sr.status = ${p(f.status)}`);
    if (f.reason) w.push(`sr.reason = ${p(f.reason)}`);
    const label = `CASE sr.reason ${INFO_REASONS.map((r) => `WHEN ${sqlText(r.code)} THEN ${sqlText(r.label)}`).join(' ')} ELSE sr.reason END`;
    return `
      SELECT sr.created_at AS reported_at, v.business_name AS shop, v.city, ${label} AS reason, sr.note,
             COALESCE(NULLIF(TRIM(u.full_name), ''), u.email) AS reporter, sr.status,
             COALESCE(NULLIF(TRIM(a.full_name), ''), a.email) AS resolved_by, sr.resolved_at,
             ROUND((EXTRACT(EPOCH FROM (COALESCE(sr.resolved_at, now()) - sr.created_at)) / 86400)::numeric, 1) AS days_open
      FROM shop_reports sr
      JOIN vendor_profiles v ON v.id = sr.vendor_id
      LEFT JOIN users u ON u.id = sr.user_id
      LEFT JOIN users a ON a.id = sr.resolved_by
      WHERE ${inRange('sr.created_at')} ${and(w)}`;
  },
};

const response = {
  key: 'shop-response',
  group: 'shops',
  title: 'Shop response time',
  description: 'How fast each shop accepts new orders: average minutes, accepted within 5 / 15 minutes, and orders turned down or moved away.',
  keywords: ['acceptance', 'response time', 'accept rate', 'sla', 'turned down', 'reassigned'],
  filters: [SHOP_CITY, F.shop, { key: 'minOrders', label: 'At least N orders', type: 'number', outer: 'orders', op: 'gte' }],
  columns: [
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'orders', label: 'Orders received', type: 'int' },
    { key: 'accepted', label: 'Accepted', type: 'int' },
    { key: 'avg_minutes', label: 'Avg minutes to accept', type: 'number' },
    { key: 'within_5', label: 'Within 5 min', type: 'percent' },
    { key: 'within_15', label: 'Within 15 min', type: 'percent' },
    { key: 'turned_down', label: 'Turned down', type: 'int' },
    { key: 'not_accepted', label: 'Not accepted in time', type: 'int' },
  ],
  defaultSort: { key: 'avg_minutes', dir: 'desc' },
  summary: [
    { key: 'orders', label: 'Orders received', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'avg_minutes', label: 'Avg minutes (all)', type: 'number', sql: 'ROUND(SUM(r.avg_minutes * r.accepted) / NULLIF(SUM(r.accepted), 0), 1)' },
    { key: 'turned_down', label: 'Turned down', type: 'int', sql: 'COALESCE(SUM(r.turned_down), 0)' },
    { key: 'not_accepted', label: 'Not accepted in time', type: 'int', sql: 'COALESCE(SUM(r.not_accepted), 0)' },
  ],
  notes: 'Minutes from the order being placed to the shop confirming it. Turned down / not accepted = orders that moved from this shop to another (by the shop, or by the system after the accept window).',
  sql: ({ f, p, inRange }) => `
    WITH acc AS (
      SELECT o.vendor_id, o.id,
             (SELECT MIN(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'confirmed') AS confirmed_at,
             o.created_at
      FROM orders o WHERE o.replacement_of_order_id IS NULL AND ${inRange('o.created_at')}
    ),
    a AS (
      SELECT vendor_id, COUNT(*) AS orders, COUNT(confirmed_at) AS accepted,
             ROUND(AVG(EXTRACT(EPOCH FROM (confirmed_at - created_at)) / 60)::numeric, 1) AS avg_minutes,
             ROUND(100.0 * COUNT(*) FILTER (WHERE confirmed_at - created_at <= interval '5 minutes') / NULLIF(COUNT(confirmed_at), 0), 1) AS within_5,
             ROUND(100.0 * COUNT(*) FILTER (WHERE confirmed_at - created_at <= interval '15 minutes') / NULLIF(COUNT(confirmed_at), 0), 1) AS within_15
      FROM acc GROUP BY vendor_id
    ),
    moved AS (
      SELECT from_vendor_id AS vendor_id,
             COUNT(*) FILTER (WHERE actor_role = 'vendor') AS turned_down,
             COUNT(*) FILTER (WHERE actor_role = 'system') AS not_accepted
      FROM order_assignment_history WHERE ${inRange('created_at')} GROUP BY from_vendor_id
    )
    SELECT v.business_name AS shop, v.city, COALESCE(a.orders, 0) + COALESCE(m.turned_down, 0) + COALESCE(m.not_accepted, 0) AS orders,
           COALESCE(a.accepted, 0) AS accepted, a.avg_minutes, a.within_5, a.within_15,
           COALESCE(m.turned_down, 0) AS turned_down, COALESCE(m.not_accepted, 0) AS not_accepted
    FROM vendor_profiles v
    LEFT JOIN a ON a.vendor_id = v.id
    LEFT JOIN moved m ON m.vendor_id = v.id
    WHERE (a.orders > 0 OR m.vendor_id IS NOT NULL) ${and(shopWhere(f, p))}`,
};

module.exports = { reports: [shopList, signups, performance, visits, ratings, infoReports, response] };
