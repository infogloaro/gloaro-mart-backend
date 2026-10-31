/**
 * RP4 — Delivery reports: partners (GoKart vs Shiprocket vs shop), delivery
 * time and delays, failed deliveries, delivery by pincode, and delivery fees.
 *
 * A shipment is one delivery attempt; a re-attempt is a new shipment
 * (previous_shipment_id), so attempts and orders are counted apart. Pickup
 * orders have no shipment and are left out.
 */
const { PAID, CITY, PINCODE, F } = require('./sales');

const PARTNER = `COALESCE(s.provider, o.fulfilment_partner, 'manual')`;
const PARTNER_LABEL = (col) => `CASE ${col} WHEN 'gokart' THEN 'GoKart (local)' WHEN 'shiprocket' THEN 'Shiprocket (courier)'
  WHEN 'manual' THEN 'Shop delivers' ELSE ${col} END`;
const PARTNER_FILTER = {
  key: 'partner',
  label: 'Delivery partner',
  type: 'select',
  options: [
    { value: 'gokart', label: 'GoKart (local)' },
    { value: 'shiprocket', label: 'Shiprocket (courier)' },
    { value: 'manual', label: 'Shop delivers' },
  ],
};
const MODE_FILTER = {
  key: 'mode',
  label: 'Distance',
  type: 'select',
  options: [
    { value: 'local', label: 'Local (within the radius)' },
    { value: 'courier', label: 'Courier (beyond it)' },
  ],
};
const ACTIVE = `('created', 'picked_up', 'in_transit', 'out_for_delivery')`;
const HOURS = `ROUND((EXTRACT(EPOCH FROM (s.delivered_at - COALESCE(s.dispatched_at, s.created_at))) / 3600)::numeric, 1)`;
const PUNCTUALITY = `CASE
  WHEN s.estimated_delivery_at IS NULL THEN 'no eta'
  WHEN s.delivered_at IS NOT NULL THEN CASE WHEN s.delivered_at <= s.estimated_delivery_at THEN 'on time' ELSE 'late' END
  WHEN s.status IN ${ACTIVE} AND now() > s.estimated_delivery_at THEN 'overdue'
  WHEN s.status IN ${ACTIVE} THEN 'in progress'
  ELSE 'not delivered' END`;

/** Shipments created in the range with their order, after the shared filters. */
function shipmentWhere({ f, p, inRange }) {
  const w = [inRange('s.created_at')];
  if (f.shop != null) w.push(`s.vendor_id = ${p(f.shop)}`);
  if (f.partner) w.push(`${PARTNER} = ${p(f.partner)}`);
  if (f.mode) w.push(`o.delivery_mode = ${p(f.mode)}`);
  if (f.city) w.push(`LOWER(${CITY}) = LOWER(${p(f.city)})`);
  if (f.pincode) w.push(`${PINCODE} LIKE ${p(`${f.pincode.replace(/\D/g, '')}%`)}`);
  return w.join(' AND ');
}
const SHIPMENTS = `
  FROM shipments s
  JOIN orders o ON o.id = s.order_id
  JOIN vendor_profiles v ON v.id = s.vendor_id
  LEFT JOIN addresses a ON a.id = o.address_id`;

const partners = {
  key: 'delivery-partners',
  group: 'delivery',
  title: 'GoKart vs Shiprocket',
  description: 'Each delivery partner: shipments, delivered, failed, returned, success rate, time taken and on-time rate.',
  keywords: ['gokart', 'shiprocket', 'courier', 'delivery partner', 'logistics', 'success rate'],
  filters: [F.shop, F.city, MODE_FILTER],
  columns: [
    { key: 'partner', label: 'Partner', type: 'text', search: true },
    { key: 'shipments', label: 'Shipments', type: 'int' },
    { key: 'delivered', label: 'Delivered', type: 'int' },
    { key: 'in_progress', label: 'On the way', type: 'int' },
    { key: 'failed', label: 'Failed', type: 'int' },
    { key: 'returned', label: 'Returned', type: 'int' },
    { key: 'success_rate', label: 'Success rate', type: 'percent' },
    { key: 'avg_hours', label: 'Avg hours', type: 'number' },
    { key: 'on_time', label: 'On time', type: 'percent' },
    { key: 'avg_km', label: 'Avg km', type: 'number' },
    { key: 'cod', label: 'Cash to collect', type: 'money' },
  ],
  defaultSort: { key: 'shipments', dir: 'desc' },
  summary: [
    { key: 'shipments', label: 'Shipments', type: 'int', sql: 'COALESCE(SUM(r.shipments), 0)' },
    { key: 'delivered', label: 'Delivered', type: 'int', sql: 'COALESCE(SUM(r.delivered), 0)' },
    { key: 'failed', label: 'Failed or returned', type: 'int', sql: 'COALESCE(SUM(r.failed + r.returned), 0)' },
    {
      key: 'success_rate',
      label: 'Success rate',
      type: 'percent',
      sql: 'ROUND(100.0 * SUM(r.delivered) / NULLIF(SUM(r.delivered + r.failed + r.returned), 0), 1)',
    },
  ],
  notes: 'Success rate = delivered ÷ (delivered + failed + returned); shipments still on the way or cancelled don\'t count. Hours = dispatch (or booking) to delivery. On time = delivered by the promised time.',
  sql: (ctx) => `
    SELECT ${PARTNER_LABEL(PARTNER)} AS partner,
           COUNT(*) AS shipments,
           COUNT(*) FILTER (WHERE s.status = 'delivered') AS delivered,
           COUNT(*) FILTER (WHERE s.status IN ${ACTIVE}) AS in_progress,
           COUNT(*) FILTER (WHERE s.status = 'failed') AS failed,
           COUNT(*) FILTER (WHERE s.status = 'returned') AS returned,
           ROUND(100.0 * COUNT(*) FILTER (WHERE s.status = 'delivered')
                 / NULLIF(COUNT(*) FILTER (WHERE s.status IN ('delivered', 'failed', 'returned')), 0), 1) AS success_rate,
           ROUND(AVG(${HOURS}) FILTER (WHERE s.delivered_at IS NOT NULL), 1) AS avg_hours,
           ROUND(100.0 * COUNT(*) FILTER (WHERE s.delivered_at <= s.estimated_delivery_at)
                 / NULLIF(COUNT(*) FILTER (WHERE s.delivered_at IS NOT NULL AND s.estimated_delivery_at IS NOT NULL), 0), 1) AS on_time,
           ROUND(AVG(o.delivery_distance_km), 1) AS avg_km,
           COALESCE(SUM(s.cod_amount_cents), 0) AS cod
    ${SHIPMENTS}
    WHERE ${shipmentWhere(ctx)}
    GROUP BY ${PARTNER}`,
};

const delays = {
  key: 'delivery-times',
  group: 'delivery',
  title: 'Delivery time & delays',
  description: 'Every shipment with dispatch, promised and delivered times, hours taken and how late it was.',
  keywords: ['late delivery', 'delay', 'eta', 'sla', 'overdue', 'turnaround', 'delivery time'],
  filters: [
    {
      key: 'punctuality',
      label: 'On time?',
      type: 'select',
      options: [
        { value: 'on time', label: 'On time' },
        { value: 'late', label: 'Delivered late' },
        { value: 'overdue', label: 'Overdue (not delivered, past ETA)' },
        { value: 'in progress', label: 'On the way' },
        { value: 'no eta', label: 'No promised time' },
      ],
      outer: 'punctuality',
    },
    PARTNER_FILTER,
    F.shop,
    F.city,
    F.pincode,
  ],
  columns: [
    { key: 'tracking', label: 'Tracking #', type: 'text', search: true },
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'partner', label: 'Partner', type: 'text' },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'pincode', label: 'Pincode', type: 'text', search: true },
    { key: 'km', label: 'Km', type: 'number' },
    { key: 'dispatched_at', label: 'Dispatched', type: 'datetime' },
    { key: 'promised_at', label: 'Promised by', type: 'datetime' },
    { key: 'delivered_at', label: 'Delivered', type: 'datetime' },
    { key: 'hours', label: 'Hours taken', type: 'number' },
    { key: 'late_hours', label: 'Hours late', type: 'number' },
    { key: 'punctuality', label: 'On time?', type: 'status' },
  ],
  defaultSort: { key: 'late_hours', dir: 'desc' },
  summary: [
    { key: 'shipments', label: 'Shipments', type: 'int', sql: 'COUNT(*)' },
    {
      key: 'on_time',
      label: 'On time',
      type: 'percent',
      sql: `ROUND(100.0 * COUNT(*) FILTER (WHERE r.punctuality = 'on time') / NULLIF(COUNT(*) FILTER (WHERE r.punctuality IN ('on time', 'late')), 0), 1)`,
    },
    { key: 'late', label: 'Delivered late', type: 'int', sql: `COUNT(*) FILTER (WHERE r.punctuality = 'late')` },
    { key: 'overdue', label: 'Overdue now', type: 'int', sql: `COUNT(*) FILTER (WHERE r.punctuality = 'overdue')` },
    { key: 'avg_hours', label: 'Avg hours', type: 'number', sql: 'ROUND(AVG(r.hours), 1)' },
  ],
  notes: 'Hours taken = dispatch (or booking, if never marked dispatched) to delivery. Hours late counts overdue shipments up to now.',
  sql: (ctx) => `
    SELECT s.tracking_number AS tracking, s.order_id, v.business_name AS shop, ${PARTNER_LABEL(PARTNER)} AS partner,
           ${CITY} AS city, ${PINCODE} AS pincode, o.delivery_distance_km AS km,
           s.dispatched_at, s.estimated_delivery_at AS promised_at, s.delivered_at, ${HOURS} AS hours,
           CASE WHEN s.estimated_delivery_at IS NULL THEN NULL
                ELSE GREATEST(ROUND((EXTRACT(EPOCH FROM (COALESCE(s.delivered_at,
                       CASE WHEN s.status IN ${ACTIVE} THEN now() END) - s.estimated_delivery_at)) / 3600)::numeric, 1), 0) END AS late_hours,
           ${PUNCTUALITY} AS punctuality
    ${SHIPMENTS}
    WHERE ${shipmentWhere(ctx)}`,
};

const FAILED_STATUS = {
  key: 'status',
  label: 'Problem',
  type: 'select',
  options: [
    { value: 'failed', label: 'Delivery failed' },
    { value: 'returned', label: 'Returned to shop' },
    { value: 'booking', label: 'Courier booking failed' },
  ],
};

const failed = {
  key: 'failed-deliveries',
  group: 'delivery',
  title: 'Failed deliveries',
  description: 'Shipments that failed, came back to the shop, or couldn\'t be booked with the courier — with the reason.',
  keywords: ['failed delivery', 'rto', 'returned', 'undelivered', 'booking failed', 'ndr'],
  filters: [
    FAILED_STATUS,
    PARTNER_FILTER,
    F.shop,
    F.city,
    { key: 'reason', label: 'Reason contains', type: 'text', outer: 'reason', op: 'ilike' },
  ],
  columns: [
    { key: 'tracking', label: 'Tracking #', type: 'text', search: true },
    { key: 'order_id', label: 'Order #', type: 'int', search: true },
    { key: 'created_at', label: 'Booked', type: 'datetime' },
    { key: 'shop', label: 'Shop', type: 'text', search: true },
    { key: 'partner', label: 'Partner', type: 'text' },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'pincode', label: 'Pincode', type: 'text', search: true },
    { key: 'attempts', label: 'Attempts', type: 'int' },
    { key: 'problem', label: 'Problem', type: 'status' },
    { key: 'reason', label: 'Reason', type: 'text', search: true },
    { key: 'updated_at', label: 'Last update', type: 'datetime' },
    { key: 'cod', label: 'Cash to collect', type: 'money' },
  ],
  defaultSort: { key: 'created_at', dir: 'desc' },
  summary: [
    { key: 'total', label: 'Problems', type: 'int', sql: 'COUNT(*)' },
    { key: 'failed', label: 'Failed', type: 'int', sql: `COUNT(*) FILTER (WHERE r.problem = 'failed')` },
    { key: 'returned', label: 'Returned', type: 'int', sql: `COUNT(*) FILTER (WHERE r.problem = 'returned')` },
    { key: 'booking', label: 'Booking failed', type: 'int', sql: `COUNT(*) FILTER (WHERE r.problem = 'booking failed')` },
    {
      key: 'top_reason',
      label: 'Most common reason',
      type: 'text',
      sql: `mode() WITHIN GROUP (ORDER BY r.reason) FILTER (WHERE r.reason <> '—')`,
    },
  ],
  notes: 'One row per shipment. A shipment that was re-sent shows once for each failed attempt.',
  sql: (ctx) => {
    // Checked against the options, so it can go into the SQL as is.
    const which = {
      failed: `s.status = 'failed'`,
      returned: `s.status = 'returned'`,
      booking: `s.booking_status = 'failed'`,
    };
    const problem = ctx.f.status ? which[ctx.f.status] : `(s.status IN ('failed', 'returned') OR s.booking_status = 'failed')`;
    return `
      SELECT s.tracking_number AS tracking, s.order_id, s.created_at, v.business_name AS shop,
             ${PARTNER_LABEL(PARTNER)} AS partner, ${CITY} AS city, ${PINCODE} AS pincode, s.attempt_count AS attempts,
             CASE WHEN s.status IN ('failed', 'returned') THEN s.status ELSE 'booking failed' END AS problem,
             COALESCE(NULLIF(TRIM(s.failure_reason), ''), NULLIF(TRIM(s.booking_error), ''), '—') AS reason,
             s.updated_at, s.cod_amount_cents AS cod
      ${SHIPMENTS}
      WHERE ${problem} AND ${shipmentWhere(ctx)}`;
  },
};

const byPincode = {
  key: 'delivery-by-pincode',
  group: 'delivery',
  title: 'Delivery by pincode',
  description: 'Delivery orders by pincode: delivered, failed, average time, average distance, fees and partners used.',
  keywords: ['pincode', 'area', 'locality', 'zone', 'serviceability', 'where'],
  filters: [F.city, PARTNER_FILTER, F.shop, MODE_FILTER],
  columns: [
    { key: 'pincode', label: 'Pincode', type: 'text', search: true },
    { key: 'city', label: 'City', type: 'text', search: true },
    { key: 'orders', label: 'Delivery orders', type: 'int' },
    { key: 'delivered', label: 'Delivered', type: 'int' },
    { key: 'failed', label: 'Failed / returned', type: 'int' },
    { key: 'avg_hours', label: 'Avg hours', type: 'number' },
    { key: 'avg_km', label: 'Avg km', type: 'number' },
    { key: 'fees', label: 'Delivery fees', type: 'money' },
    { key: 'partners', label: 'Partners', type: 'text' },
  ],
  defaultSort: { key: 'orders', dir: 'desc' },
  summary: [
    { key: 'pincodes', label: 'Pincodes', type: 'int', sql: 'COUNT(*)' },
    { key: 'orders', label: 'Delivery orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'delivered', label: 'Delivered', type: 'int', sql: 'COALESCE(SUM(r.delivered), 0)' },
    { key: 'fees', label: 'Delivery fees', type: 'money', sql: 'COALESCE(SUM(r.fees), 0)' },
  ],
  notes: 'Orders for delivery (not pickup) placed in the range, paid and not cancelled. Delivered / failed use each order\'s latest shipment.',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
    if (f.city) w.push(`LOWER(${CITY}) = LOWER(${p(f.city)})`);
    if (f.mode) w.push(`o.delivery_mode = ${p(f.mode)}`);
    if (f.partner) w.push(`${PARTNER} = ${p(f.partner)}`);
    return `
      SELECT COALESCE(${PINCODE}, '—') AS pincode, MIN(${CITY}) AS city,
             COUNT(*) AS orders,
             COUNT(*) FILTER (WHERE s.status = 'delivered' OR o.status = 'delivered') AS delivered,
             COUNT(*) FILTER (WHERE s.status IN ('failed', 'returned')) AS failed,
             ROUND(AVG(${HOURS}) FILTER (WHERE s.delivered_at IS NOT NULL), 1) AS avg_hours,
             ROUND(AVG(o.delivery_distance_km), 1) AS avg_km,
             SUM(o.delivery_charge_cents) AS fees,
             string_agg(DISTINCT ${PARTNER_LABEL(PARTNER)}, ', ') AS partners
      FROM orders o
      LEFT JOIN addresses a ON a.id = o.address_id
      LEFT JOIN LATERAL (
        SELECT * FROM shipments sx WHERE sx.order_id = o.id ORDER BY sx.created_at DESC, sx.id DESC LIMIT 1
      ) s ON TRUE
      WHERE o.delivery_method = 'delivery' AND o.replacement_of_order_id IS NULL AND o.status <> 'cancelled'
        AND ${PAID} AND ${inRange('o.created_at')} ${w.length ? `AND ${w.join(' AND ')}` : ''}
      GROUP BY 1`;
  },
};

const CHARGE_GROUPS = {
  shop: 'v.business_name',
  partner: PARTNER_LABEL(`COALESCE(o.fulfilment_partner, 'manual')`),
  city: `COALESCE(${CITY}, '—')`,
  mode: `CASE o.delivery_mode WHEN 'local' THEN 'Local' WHEN 'courier' THEN 'Courier' ELSE 'Not set' END`,
};

const charges = {
  key: 'delivery-charges',
  group: 'delivery',
  title: 'Delivery charges collected',
  description: 'Delivery fees customers paid, free deliveries and average fee by shop, partner, city or distance.',
  keywords: ['delivery fee', 'shipping charge', 'free delivery', 'delivery income'],
  filters: [
    {
      key: 'groupBy',
      label: 'Group by',
      type: 'select',
      default: 'shop',
      options: [
        { value: 'shop', label: 'Shop' },
        { value: 'partner', label: 'Delivery partner' },
        { value: 'city', label: 'City' },
        { value: 'mode', label: 'Local vs courier' },
      ],
    },
    F.shop,
    F.city,
    PARTNER_FILTER,
  ],
  columns: [
    { key: 'name', label: 'Group', type: 'text', search: true },
    { key: 'orders', label: 'Delivery orders', type: 'int' },
    { key: 'paid_delivery', label: 'Paid delivery', type: 'int' },
    { key: 'free_delivery', label: 'Free delivery', type: 'int' },
    { key: 'fees', label: 'Fees collected', type: 'money' },
    { key: 'avg_fee', label: 'Avg fee (paid)', type: 'money' },
    { key: 'avg_km', label: 'Avg km', type: 'number' },
  ],
  defaultSort: { key: 'fees', dir: 'desc' },
  summary: [
    { key: 'orders', label: 'Delivery orders', type: 'int', sql: 'COALESCE(SUM(r.orders), 0)' },
    { key: 'fees', label: 'Fees collected', type: 'money', sql: 'COALESCE(SUM(r.fees), 0)' },
    { key: 'free', label: 'Free deliveries', type: 'int', sql: 'COALESCE(SUM(r.free_delivery), 0)' },
    {
      key: 'free_share',
      label: 'Free share',
      type: 'percent',
      sql: 'ROUND(100.0 * SUM(r.free_delivery) / NULLIF(SUM(r.orders), 0), 1)',
    },
  ],
  notes: 'Orders for delivery placed in the range, paid and not cancelled. Free = no delivery fee charged (free-delivery offer, coupon or above the shop\'s free-delivery amount).',
  sql: ({ f, p, inRange }) => {
    const w = [];
    if (f.shop != null) w.push(`o.vendor_id = ${p(f.shop)}`);
    if (f.city) w.push(`LOWER(${CITY}) = LOWER(${p(f.city)})`);
    if (f.partner) w.push(`COALESCE(o.fulfilment_partner, 'manual') = ${p(f.partner)}`);
    return `
      SELECT ${CHARGE_GROUPS[f.groupBy]} AS name,
             COUNT(*) AS orders,
             COUNT(*) FILTER (WHERE o.delivery_charge_cents > 0) AS paid_delivery,
             COUNT(*) FILTER (WHERE o.delivery_charge_cents = 0) AS free_delivery,
             SUM(o.delivery_charge_cents) AS fees,
             ROUND(AVG(o.delivery_charge_cents) FILTER (WHERE o.delivery_charge_cents > 0)) AS avg_fee,
             ROUND(AVG(o.delivery_distance_km), 1) AS avg_km
      FROM orders o
      JOIN vendor_profiles v ON v.id = o.vendor_id
      LEFT JOIN addresses a ON a.id = o.address_id
      WHERE o.delivery_method = 'delivery' AND o.replacement_of_order_id IS NULL AND o.status <> 'cancelled'
        AND ${PAID} AND ${inRange('o.created_at')} ${w.length ? `AND ${w.join(' AND ')}` : ''}
      GROUP BY 1`;
  },
};

module.exports = { reports: [partners, delays, failed, byPincode, charges] };
