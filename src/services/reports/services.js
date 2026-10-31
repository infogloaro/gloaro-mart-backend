/**
 * RP10 — Near Me services reports: service requests, bookings, providers
 * (response time and completion), service reviews, and demand by category.
 *
 * A provider is a shop (NS); a request is a shop enquiry with topic
 * 'service'; a booking is a timed slot (service_bookings).
 */
const { F } = require('./sales');

const and = (w) => (w.length ? `AND ${w.join(' AND ')}` : '');
const NAME = (alias) => `COALESCE(NULLIF(TRIM(${alias}.full_name), ''), ${alias}.email)`;
const CATEGORY = { key: 'serviceCategory', label: 'Service type', type: 'text', outer: 'category', op: 'ilike' };
const SHOP_CITY = { key: 'city', label: 'Provider city', type: 'city' };
/** Minutes from a request to the provider's first reply. */
const FIRST_REPLY = `(SELECT MIN(m.created_at) FROM shop_enquiry_messages m WHERE m.enquiry_id = e.id AND m.author_role = 'vendor')`;

const requests = {
  key: 'service-requests',
  group: 'services',
  title: 'Service requests',
  description: 'Every Near Me service request: customer, provider, service, preferred date and slot, at home or not, reply time and status.',
  keywords: ['service request', 'enquiry', 'near me', 'leads', 'plumber', 'electrician', 'home service'],
  filters: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'open', label: 'Waiting for the provider' },
        { value: 'answered', label: 'Provider replied' },
        { value: 'done', label: 'Marked done' },
        { value: 'closed', label: 'Closed' },
      ],
      outer: 'status',
    },
    F.shop,
    SHOP_CITY,
    CATEGORY,
  ],
  columns: [
    { key: 'reference', label: 'Request', type: 'text', search: true },
    { key: 'asked_at', label: 'Asked', type: 'datetime' },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'provider', label: 'Provider', type: 'text', search: true },
    { key: 'service', label: 'Service', type: 'text', search: true },
    { key: 'category', label: 'Type', type: 'text', search: true },
    { key: 'preferred', label: 'Preferred', type: 'text' },
    { key: 'at_home', label: 'Visit', type: 'status' },
    { key: 'reply_minutes', label: 'Minutes to reply', type: 'number' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  defaultSort: { key: 'asked_at', dir: 'desc' },
  summary: [
    { key: 'requests', label: 'Requests', type: 'int', sql: 'COUNT(*)' },
    { key: 'replied', label: 'Replied', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.reply_minutes IS NOT NULL)' },
    { key: 'waiting', label: 'Waiting', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'open')` },
    { key: 'done', label: 'Done', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'done')` },
    { key: 'avg_reply', label: 'Avg minutes to reply', type: 'number', sql: 'ROUND(AVG(r.reply_minutes), 1)' },
  ],
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`e.vendor_id = ${p(f.shop)}`);
    if (f.city) w.push(`LOWER(v.city) = LOWER(${p(f.city)})`);
    return `
      SELECT e.reference, e.created_at AS asked_at, ${NAME('u')} AS customer, v.business_name AS provider,
             COALESCE(e.service_title, s.title) AS service, sc.name AS category,
             NULLIF(CONCAT_WS(' · ', to_char(e.preferred_date, 'DD Mon'), e.preferred_slot), '') AS preferred,
             CASE WHEN e.visit_address IS NOT NULL THEN 'at home' ELSE 'at shop' END AS at_home,
             ROUND((EXTRACT(EPOCH FROM (${FIRST_REPLY} - e.created_at)) / 60)::numeric, 1) AS reply_minutes,
             CASE WHEN e.service_done_at IS NOT NULL THEN 'done' ELSE e.status END AS status
      FROM shop_enquiries e
      JOIN vendor_profiles v ON v.id = e.vendor_id
      JOIN users u ON u.id = e.user_id
      LEFT JOIN vendor_services s ON s.id = e.service_id
      LEFT JOIN service_categories sc ON sc.id = s.category_id
      WHERE e.topic = 'service' AND ${inRange('e.created_at')} ${and(w)}`;
  },
};

const bookings = {
  key: 'service-bookings',
  group: 'services',
  title: 'Service bookings',
  description: 'Every booked service slot: when, customer, provider, service, price, at home or not, status and who cancelled.',
  keywords: ['bookings', 'appointments', 'slots', 'schedule', 'service bookings'],
  filters: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['pending', 'accepted', 'in_progress', 'completed', 'rejected', 'cancelled'].map((value) => ({
        value,
        label: { pending: 'Waiting for the provider', in_progress: 'In progress' }[value] ?? value.charAt(0).toUpperCase() + value.slice(1),
      })),
    },
    F.shop,
    SHOP_CITY,
    CATEGORY,
    {
      key: 'where',
      label: 'Visit',
      type: 'select',
      options: [
        { value: 'home', label: 'At the customer\'s home' },
        { value: 'shop', label: 'At the shop' },
      ],
    },
  ],
  columns: [
    { key: 'reference', label: 'Booking', type: 'text', search: true },
    { key: 'slot', label: 'Slot', type: 'datetime' },
    { key: 'booked_at', label: 'Booked', type: 'datetime' },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'provider', label: 'Provider', type: 'text', search: true },
    { key: 'service', label: 'Service', type: 'text', search: true },
    { key: 'category', label: 'Type', type: 'text', search: true },
    { key: 'at_home', label: 'Visit', type: 'status' },
    { key: 'price', label: 'Price', type: 'money' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'cancelled_by', label: 'Cancelled by', type: 'status' },
  ],
  defaultSort: { key: 'slot', dir: 'desc' },
  summary: [
    { key: 'bookings', label: 'Bookings', type: 'int', sql: 'COUNT(*)' },
    { key: 'completed', label: 'Completed', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status = 'completed')` },
    { key: 'cancelled', label: 'Cancelled / rejected', type: 'int', sql: `COUNT(*) FILTER (WHERE r.status IN ('cancelled', 'rejected'))` },
    { key: 'value', label: 'Completed value', type: 'money', sql: `COALESCE(SUM(r.price) FILTER (WHERE r.status = 'completed'), 0)` },
  ],
  notes: 'By the slot\'s date. Price = the price shown when booked plus any visit fee ("from" and range prices use the lower amount; on-request has none).',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.status) w.push(`b.status = ${p(f.status)}`);
    if (f.shop != null) w.push(`b.vendor_id = ${p(f.shop)}`);
    if (f.city) w.push(`LOWER(v.city) = LOWER(${p(f.city)})`);
    if (f.where === 'home') w.push('b.at_home');
    if (f.where === 'shop') w.push('NOT b.at_home');
    return `
      SELECT b.reference, b.starts_at AS slot, b.created_at AS booked_at, ${NAME('u')} AS customer, v.business_name AS provider,
             b.service_title AS service, sc.name AS category,
             CASE WHEN b.at_home THEN 'at home' ELSE 'at shop' END AS at_home,
             CASE WHEN b.price_cents IS NULL THEN NULL ELSE b.price_cents + COALESCE(b.visit_fee_cents, 0) END AS price,
             b.status, CASE b.cancelled_by WHEN 'vendor' THEN 'provider' ELSE b.cancelled_by END AS cancelled_by
      FROM service_bookings b
      JOIN vendor_profiles v ON v.id = b.vendor_id
      JOIN users u ON u.id = b.user_id
      LEFT JOIN vendor_services s ON s.id = b.service_id
      LEFT JOIN service_categories sc ON sc.id = s.category_id
      WHERE ${inRange('b.starts_at')} ${and(w)}`;
  },
};

const providers = {
  key: 'service-providers',
  group: 'services',
  title: 'Service providers',
  description: 'Each provider: services listed, requests, reply rate and time, bookings, completion rate and rating.',
  keywords: ['providers', 'service partners', 'response time', 'completion rate', 'near me performance'],
  filters: [SHOP_CITY, F.shop, { key: 'minRequests', label: 'At least N requests', type: 'number', outer: 'requests', op: 'gte' }],
  columns: [
    { key: 'provider', label: 'Provider', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'services', label: 'Live services', type: 'int' },
    { key: 'requests', label: 'Requests', type: 'int' },
    { key: 'reply_rate', label: 'Replied', type: 'percent' },
    { key: 'avg_reply', label: 'Avg minutes to reply', type: 'number' },
    { key: 'bookings', label: 'Bookings', type: 'int' },
    { key: 'completed', label: 'Completed', type: 'int' },
    { key: 'completion_rate', label: 'Completion rate', type: 'percent' },
    { key: 'rating', label: 'Rating', type: 'number' },
    { key: 'reviews', label: 'Reviews', type: 'int' },
  ],
  defaultSort: { key: 'requests', dir: 'desc' },
  summary: [
    { key: 'providers', label: 'Providers', type: 'int', sql: 'COUNT(*)' },
    { key: 'requests', label: 'Requests', type: 'int', sql: 'COALESCE(SUM(r.requests), 0)' },
    { key: 'bookings', label: 'Bookings', type: 'int', sql: 'COALESCE(SUM(r.bookings), 0)' },
    { key: 'completion', label: 'Completion rate', type: 'percent', sql: 'ROUND(100.0 * SUM(r.completed) / NULLIF(SUM(r.bookings), 0), 1)' },
  ],
  notes: 'Requests and bookings in the range; live services and rating are now. Completion rate = completed ÷ all bookings (cancelled and rejected included). Providers with a live service or activity in the range are listed.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`v.id = ${p(f.shop)}`);
    if (f.city) w.push(`LOWER(v.city) = LOWER(${p(f.city)})`);
    return `
      WITH rq AS (
        SELECT e.vendor_id, COUNT(*) AS requests,
               COUNT(*) FILTER (WHERE ${FIRST_REPLY} IS NOT NULL) AS replied,
               AVG(EXTRACT(EPOCH FROM (${FIRST_REPLY} - e.created_at)) / 60) AS avg_reply
        FROM shop_enquiries e WHERE e.topic = 'service' AND ${inRange('e.created_at')} GROUP BY e.vendor_id
      ),
      bk AS (
        SELECT vendor_id, COUNT(*) AS bookings, COUNT(*) FILTER (WHERE status = 'completed') AS completed
        FROM service_bookings WHERE ${inRange('starts_at')} GROUP BY vendor_id
      ),
      sv AS (SELECT vendor_id, COUNT(*) AS services FROM vendor_services WHERE status = 'active' GROUP BY vendor_id),
      rv AS (SELECT vendor_id, ROUND(AVG(rating), 1) AS rating, COUNT(*) AS reviews FROM service_reviews GROUP BY vendor_id)
      SELECT v.business_name AS provider, v.city, COALESCE(sv.services, 0) AS services,
             COALESCE(rq.requests, 0) AS requests, ROUND(100.0 * rq.replied / NULLIF(rq.requests, 0), 1) AS reply_rate,
             ROUND(rq.avg_reply::numeric, 1) AS avg_reply,
             COALESCE(bk.bookings, 0) AS bookings, COALESCE(bk.completed, 0) AS completed,
             ROUND(100.0 * bk.completed / NULLIF(bk.bookings, 0), 1) AS completion_rate,
             rv.rating, COALESCE(rv.reviews, 0) AS reviews
      FROM vendor_profiles v
      LEFT JOIN rq ON rq.vendor_id = v.id
      LEFT JOIN bk ON bk.vendor_id = v.id
      LEFT JOIN sv ON sv.vendor_id = v.id
      LEFT JOIN rv ON rv.vendor_id = v.id
      WHERE (sv.services > 0 OR rq.requests > 0 OR bk.bookings > 0) ${and(w)}`;
  },
};

const reviews = {
  key: 'service-reviews',
  group: 'services',
  title: 'Service reviews',
  description: 'Reviews customers wrote for services in the range: provider, service, rating and comment.',
  keywords: ['service reviews', 'ratings', 'feedback', 'complaints', 'stars'],
  filters: [
    F.shop,
    CATEGORY,
    { key: 'maxRating', label: 'Rating at most', type: 'number', outer: 'rating', op: 'lte' },
  ],
  columns: [
    { key: 'written_at', label: 'Written', type: 'datetime' },
    { key: 'provider', label: 'Provider', type: 'text', search: true },
    { key: 'service', label: 'Service', type: 'text', search: true },
    { key: 'category', label: 'Type', type: 'text', search: true },
    { key: 'customer', label: 'Customer', type: 'text', search: true },
    { key: 'rating', label: 'Rating', type: 'int' },
    { key: 'comment', label: 'Comment', type: 'text', search: true },
  ],
  defaultSort: { key: 'written_at', dir: 'desc' },
  summary: [
    { key: 'reviews', label: 'Reviews', type: 'int', sql: 'COUNT(*)' },
    { key: 'average', label: 'Average', type: 'number', sql: 'ROUND(AVG(r.rating), 1)' },
    { key: 'low', label: '1–2★', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.rating <= 2)' },
    { key: 'five', label: '5★', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.rating = 5)' },
  ],
  sql: ({ f, p, inRange }) => `
    SELECT sr.created_at AS written_at, v.business_name AS provider, COALESCE(s.title, e.service_title) AS service,
           sc.name AS category, ${NAME('u')} AS customer, sr.rating, sr.comment
    FROM service_reviews sr
    JOIN vendor_profiles v ON v.id = sr.vendor_id
    JOIN users u ON u.id = sr.user_id
    LEFT JOIN shop_enquiries e ON e.id = sr.enquiry_id
    LEFT JOIN vendor_services s ON s.id = COALESCE(sr.service_id, e.service_id)
    LEFT JOIN service_categories sc ON sc.id = s.category_id
    WHERE ${inRange('sr.created_at')} ${f.shop != null ? `AND sr.vendor_id = ${p(f.shop)}` : ''}`,
};

const byCategory = {
  key: 'services-by-category',
  group: 'services',
  title: 'Demand by service type',
  description: 'For each service type (plumbing, AC repair, tuition…): providers, live services, requests, bookings, completed and rating.',
  keywords: ['service categories', 'demand', 'supply', 'gaps', 'popular services'],
  filters: [SHOP_CITY],
  columns: [
    { key: 'category', label: 'Service type', type: 'text', search: true },
    { key: 'group_name', label: 'Group', type: 'status' },
    { key: 'providers', label: 'Providers', type: 'int' },
    { key: 'services', label: 'Live services', type: 'int' },
    { key: 'requests', label: 'Requests', type: 'int' },
    { key: 'bookings', label: 'Bookings', type: 'int' },
    { key: 'completed', label: 'Completed', type: 'int' },
    { key: 'rating', label: 'Rating', type: 'number' },
  ],
  defaultSort: { key: 'requests', dir: 'desc' },
  summary: [
    { key: 'types', label: 'Service types', type: 'int', sql: 'COUNT(*)' },
    { key: 'no_provider', label: 'Types with no provider', type: 'int', sql: 'COUNT(*) FILTER (WHERE r.providers = 0)' },
    { key: 'requests', label: 'Requests', type: 'int', sql: 'COALESCE(SUM(r.requests), 0)' },
    { key: 'bookings', label: 'Bookings', type: 'int', sql: 'COALESCE(SUM(r.bookings), 0)' },
  ],
  notes: 'Every active service type is listed, even with no providers, so gaps show. Requests and bookings in the range; providers, services and rating are now.',
  sql: ({ f, p, inRange }) => {
    const city = f.city ? `AND LOWER(v.city) = LOWER(${p(f.city)})` : '';
    return `
      SELECT sc.name AS category, sc.group_key AS group_name,
             COUNT(DISTINCT s.vendor_id) FILTER (WHERE s.status = 'active') AS providers,
             COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'active') AS services,
             (SELECT COUNT(*) FROM shop_enquiries e JOIN vendor_services es ON es.id = e.service_id JOIN vendor_profiles v ON v.id = e.vendor_id
              WHERE e.topic = 'service' AND es.category_id = sc.id AND ${inRange('e.created_at')} ${city}) AS requests,
             (SELECT COUNT(*) FROM service_bookings b JOIN vendor_services bs ON bs.id = b.service_id JOIN vendor_profiles v ON v.id = b.vendor_id
              WHERE bs.category_id = sc.id AND ${inRange('b.starts_at')} ${city}) AS bookings,
             (SELECT COUNT(*) FROM service_bookings b JOIN vendor_services bs ON bs.id = b.service_id JOIN vendor_profiles v ON v.id = b.vendor_id
              WHERE bs.category_id = sc.id AND b.status = 'completed' AND ${inRange('b.starts_at')} ${city}) AS completed,
             (SELECT ROUND(AVG(sr.rating), 1) FROM service_reviews sr JOIN vendor_services rs ON rs.id = sr.service_id
              WHERE rs.category_id = sc.id) AS rating
      FROM service_categories sc
      LEFT JOIN vendor_services s ON s.category_id = sc.id
        AND s.vendor_id IN (SELECT v.id FROM vendor_profiles v WHERE TRUE ${city})
      WHERE sc.is_active
      GROUP BY sc.id, sc.name, sc.group_key`;
  },
};

module.exports = { reports: [requests, bookings, providers, reviews, byCategory] };
