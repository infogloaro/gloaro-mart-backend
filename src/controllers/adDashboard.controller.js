const pool = require('../config/db');
const { toCsv } = require('../services/csv');

/**
 * Admin → Ad Promotions dashboard and exports. Money comes from ad_ledger
 * (revenue, refunds and commission kept apart); reach from ad_stats_daily.
 * A date range is whole days in India time; the default is the last 30 days.
 */

const DAY = 86400000;
const isoDay = (d) => d.toISOString().slice(0, 10);

/** [from, to] as IST days, and the timestamps that bound them. */
function readRange(q) {
  const today = isoDay(new Date(Date.now() + 5.5 * 3600000));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from : isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY));
  if (from > to) return null;
  if ((Date.parse(to) - Date.parse(from)) / DAY > 366) return null;
  return { from, to, fromTs: `${from}T00:00:00+05:30`, toTs: new Date(Date.parse(`${to}T00:00:00+05:30`) + DAY).toISOString() };
}

const band = (h) => (h < 24 ? 'hourly' : h < 168 ? 'daily' : h < 720 ? 'weekly' : 'monthly');

async function dashboard(req, res) {
  const r = readRange(req.query);
  if (!r) return res.status(400).json({ message: 'Give from ≤ to as YYYY-MM-DD, at most a year apart.' });
  const P = [r.fromTs, r.toTs];

  const [counts, shops, money, pending, reach, redemptions, perCampaign, daily] = await Promise.all([
    pool.query('SELECT status, COUNT(*)::int AS n FROM ad_campaigns GROUP BY status'),
    pool.query(
      `SELECT (SELECT COUNT(*)::int FROM vendor_profiles WHERE status = 'approved') AS shops,
              (SELECT COUNT(DISTINCT vendor_id)::int FROM ad_campaigns WHERE status NOT IN ('draft', 'rejected', 'cancelled')
                 AND starts_at < $2 AND ends_at > $1) AS advertising`,
      P
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE entry = 'ad_revenue'), 0)::bigint AS revenue,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry = 'ad_refund'), 0)::bigint AS refunds,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry = 'ad_commission'), 0)::bigint AS commission,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry IN ('ad_tax', 'ad_tax_refund')), 0)::bigint AS tax
       FROM ad_ledger WHERE occurred_at >= $1 AND occurred_at < $2`,
      P
    ),
    pool.query(
      `SELECT (SELECT COALESCE(SUM(amount_cents), 0) FROM ad_payments WHERE status = 'pending')::bigint AS payments,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM ad_refunds WHERE status = 'pending')::bigint AS refunds`
    ),
    pool.query(
      `SELECT COALESCE(SUM(impressions), 0)::bigint AS impressions, COALESCE(SUM(clicks), 0)::bigint AS clicks,
              COALESCE(SUM(enquiries), 0)::bigint AS enquiries, COALESCE(SUM(orders), 0)::bigint AS orders,
              COALESCE(SUM(order_value_cents), 0)::bigint AS order_value
       FROM ad_stats_daily WHERE day >= $1::date AND day <= $2::date`,
      [r.from, r.to]
    ),
    // Orders that used the discount an ad advertises, placed while the ad ran.
    pool.query(
      `SELECT c.id AS campaign_id, COUNT(DISTINCT oc.order_id)::int AS n
       FROM ad_campaigns c JOIN order_campaigns oc ON oc.campaign_id = c.discount_campaign_id
       JOIN orders o ON o.id = oc.order_id AND o.status <> 'cancelled'
       WHERE c.discount_campaign_id IS NOT NULL AND o.created_at >= GREATEST(c.starts_at, $1) AND o.created_at < LEAST(c.ends_at, $2)
       GROUP BY c.id`,
      P
    ),
    // Per campaign: its money in the range and its reach, to split by level, duration, slot and region.
    pool.query(
      `SELECT c.id, c.reference, c.title, c.level, c.hours, c.placements, c.price_snapshot, c.vendor_id, c.status, vp.business_name,
              COALESCE(m.revenue, 0)::bigint AS revenue, COALESCE(m.commission, 0)::bigint AS commission,
              COALESCE(s.impressions, 0)::bigint AS impressions, COALESCE(s.clicks, 0)::bigint AS clicks,
              COALESCE(s.orders, 0)::bigint AS orders, COALESCE(s.order_value, 0)::bigint AS order_value,
              (SELECT json_agg(json_build_object('name', ar.name, 'level', ar.level)) FROM ad_campaign_regions cr
                 JOIN ad_regions ar ON ar.id = cr.region_id WHERE cr.campaign_id = c.id) AS regions
       FROM ad_campaigns c JOIN vendor_profiles vp ON vp.id = c.vendor_id
       LEFT JOIN (SELECT campaign_id, SUM(amount_cents) FILTER (WHERE entry IN ('ad_revenue', 'ad_refund')) AS revenue,
                         SUM(amount_cents) FILTER (WHERE entry = 'ad_commission') AS commission
                  FROM ad_ledger WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY campaign_id) m ON m.campaign_id = c.id
       LEFT JOIN (SELECT campaign_id, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(orders) AS orders,
                         SUM(order_value_cents) AS order_value
                  FROM ad_stats_daily WHERE day >= $3::date AND day <= $4::date GROUP BY campaign_id) s ON s.campaign_id = c.id
       WHERE m.campaign_id IS NOT NULL OR s.campaign_id IS NOT NULL`,
      [...P, r.from, r.to]
    ),
    pool.query(
      `SELECT d::date AS day,
              COALESCE((SELECT SUM(amount_cents) FROM ad_ledger l WHERE l.entry IN ('ad_revenue', 'ad_refund')
                 AND (l.occurred_at AT TIME ZONE 'Asia/Kolkata')::date = d::date), 0)::bigint AS revenue,
              COALESCE((SELECT SUM(amount_cents) FROM ad_ledger l WHERE l.entry = 'ad_commission'
                 AND (l.occurred_at AT TIME ZONE 'Asia/Kolkata')::date = d::date), 0)::bigint AS commission,
              COALESCE((SELECT SUM(impressions) FROM ad_stats_daily s WHERE s.day = d::date), 0)::bigint AS impressions,
              COALESCE((SELECT SUM(clicks) FROM ad_stats_daily s WHERE s.day = d::date), 0)::bigint AS clicks
       FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY d`,
      [r.from, r.to]
    ),
  ]);

  const statusCount = (s) => counts.rows.find((x) => x.status === s)?.n ?? 0;
  const redeemed = new Map(redemptions.rows.map((x) => [x.campaign_id, x.n]));
  const add = (map, key, label, amount) => {
    const cur = map.get(key) ?? { key, label, revenueCents: 0 };
    cur.revenueCents += amount;
    map.set(key, cur);
  };
  const byLevel = new Map();
  const byBand = new Map();
  const byPlacement = new Map();
  const byRegion = new Map();
  const byShop = new Map();
  for (const c of perCampaign.rows) {
    const revenue = Number(c.revenue);
    add(byLevel, c.level, c.level, revenue);
    add(byBand, band(c.hours), band(c.hours), revenue);
    // A booking's revenue is shared out by what each slot cost in its quote.
    const lines = (c.price_snapshot?.lines ?? []).filter((l) => l.kind === 'placement');
    const lineTotal = lines.reduce((n, l) => n + l.amountCents, 0);
    const slots = c.placements ?? [];
    for (const k of slots) {
      const line = lines.find((l) => l.placement === k);
      const share = lineTotal > 0 && line ? line.amountCents / lineTotal : 1 / slots.length;
      add(byPlacement, k, k, Math.round(revenue * share));
    }
    const regions = c.regions ?? [];
    for (const g of regions) add(byRegion, `${g.level}:${g.name}`, g.name, Math.round(revenue / regions.length));
    const shop = byShop.get(c.vendor_id) ?? { vendorId: c.vendor_id, name: c.business_name, revenueCents: 0, commissionCents: 0, campaigns: 0, clicks: 0, orders: 0 };
    shop.revenueCents += revenue;
    shop.commissionCents += Number(c.commission);
    shop.campaigns += 1;
    shop.clicks += Number(c.clicks);
    shop.orders += Number(c.orders);
    byShop.set(c.vendor_id, shop);
  }
  const sorted = (m) => [...m.values()].sort((a, b) => b.revenueCents - a.revenueCents);
  const regionLevel = new Map(perCampaign.rows.flatMap((c) => (c.regions ?? []).map((g) => [`${g.level}:${g.name}`, g.level])));
  const imp = Number(reach.rows[0].impressions);
  const clk = Number(reach.rows[0].clicks);
  const m = money.rows[0];

  res.json({
    range: { from: r.from, to: r.to },
    kpis: {
      totalShops: shops.rows[0].shops,
      shopsAdvertising: shops.rows[0].advertising,
      campaigns: {
        total: counts.rows.reduce((n, x) => n + x.n, 0),
        live: statusCount('live'),
        scheduled: statusCount('scheduled'),
        pendingApproval: statusCount('pending_approval'),
        pendingPayment: statusCount('pending_payment'),
        completed: statusCount('completed'),
        rejected: statusCount('rejected'),
        cancelled: statusCount('cancelled'),
      },
      revenueCents: Number(m.revenue) + Number(m.refunds),
      grossRevenueCents: Number(m.revenue),
      refundsCents: -Number(m.refunds),
      commissionCents: Number(m.commission),
      taxCents: Number(m.tax),
      pendingPaymentsCents: Number(pending.rows[0].payments),
      refundsPendingCents: Number(pending.rows[0].refunds),
      impressions: imp,
      clicks: clk,
      ctr: imp ? clk / imp : null,
      enquiries: Number(reach.rows[0].enquiries),
      orders: Number(reach.rows[0].orders),
      orderValueCents: Number(reach.rows[0].order_value),
      conversionRate: clk ? Number(reach.rows[0].orders) / clk : null,
      redemptions: [...redeemed.values()].reduce((n, x) => n + x, 0),
    },
    series: daily.rows.map((d) => ({
      date: isoDay(new Date(d.day)), revenueCents: Number(d.revenue), commissionCents: Number(d.commission),
      impressions: Number(d.impressions), clicks: Number(d.clicks),
    })),
    byLevel: sorted(byLevel),
    byDuration: ['hourly', 'daily', 'weekly', 'monthly'].map((k) => byBand.get(k) ?? { key: k, label: k, revenueCents: 0 }),
    byPlacement: sorted(byPlacement),
    byRegion: sorted(byRegion).slice(0, 10).map((x) => ({ ...x, level: regionLevel.get(x.key) })),
    topShops: [...byShop.values()].sort((a, b) => b.revenueCents + b.commissionCents - (a.revenueCents + a.commissionCents)).slice(0, 10),
    topCampaigns: perCampaign.rows
      .map((c) => ({
        id: c.id, reference: c.reference, title: c.title, shopName: c.business_name, status: c.status,
        revenueCents: Number(c.revenue), commissionCents: Number(c.commission), impressions: Number(c.impressions), clicks: Number(c.clicks),
        ctr: Number(c.impressions) ? Number(c.clicks) / Number(c.impressions) : null, orders: Number(c.orders), redemptions: redeemed.get(c.id) ?? 0,
      }))
      .sort((a, b) => b.revenueCents + b.commissionCents - (a.revenueCents + a.commissionCents) || b.clicks - a.clicks)
      .slice(0, 10),
  });
}

// Spreadsheets run a cell that starts with = + - @ as a formula; a shop name never should.
const safe = (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v);
const money = (c) => (Number(c) / 100).toFixed(2);

/** CSV of campaigns (with their results) or of the ad ledger, for the range. */
async function exportCsv(req, res) {
  const r = readRange(req.query);
  if (!r) return res.status(400).json({ message: 'Give from ≤ to as YYYY-MM-DD, at most a year apart.' });
  const type = req.query.type ?? 'campaigns';
  let csv;
  if (type === 'ledger') {
    const { rows } = await pool.query(
      `SELECT l.occurred_at, l.entry, l.amount_cents, l.note, c.reference, c.title, vp.business_name, i.invoice_number
       FROM ad_ledger l JOIN ad_campaigns c ON c.id = l.campaign_id JOIN vendor_profiles vp ON vp.id = l.vendor_id
       LEFT JOIN ad_invoices i ON i.payment_id = l.payment_id
       WHERE l.occurred_at >= $1 AND l.occurred_at < $2 ORDER BY l.occurred_at, l.id`,
      [r.fromTs, r.toTs]
    );
    const headers = ['Date', 'Entry', 'Amount (INR)', 'Campaign', 'Title', 'Shop', 'Invoice', 'Note'];
    csv = toCsv(headers, rows.map((x) => ({
      Date: new Date(x.occurred_at).toISOString(), Entry: x.entry, 'Amount (INR)': money(x.amount_cents), Campaign: x.reference,
      Title: safe(x.title), Shop: safe(x.business_name), Invoice: x.invoice_number ?? '', Note: safe(x.note ?? ''),
    })));
  } else if (type === 'campaigns') {
    const { rows } = await pool.query(
      `SELECT c.*, vp.business_name,
              (SELECT string_agg(ar.name, '; ') FROM ad_campaign_regions cr JOIN ad_regions ar ON ar.id = cr.region_id WHERE cr.campaign_id = c.id) AS regions,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM ad_payments p WHERE p.campaign_id = c.id AND p.status = 'paid') AS paid,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM ad_refunds f WHERE f.campaign_id = c.id) AS refunded,
              (SELECT COALESCE(SUM(impressions), 0) FROM ad_stats_daily s WHERE s.campaign_id = c.id) AS impressions,
              (SELECT COALESCE(SUM(clicks), 0) FROM ad_stats_daily s WHERE s.campaign_id = c.id) AS clicks,
              (SELECT COALESCE(SUM(orders), 0) FROM ad_stats_daily s WHERE s.campaign_id = c.id) AS orders,
              (SELECT COALESCE(SUM(commission_cents), 0) FROM ad_stats_daily s WHERE s.campaign_id = c.id) AS commission
       FROM ad_campaigns c JOIN vendor_profiles vp ON vp.id = c.vendor_id
       WHERE c.starts_at < $2 AND c.ends_at > $1 ORDER BY c.starts_at, c.id`,
      [r.fromTs, r.toTs]
    );
    const headers = ['Reference', 'Title', 'Shop', 'Status', 'Model', 'Reach', 'Regions', 'Placements', 'Starts', 'Ends', 'Hours',
      'Total (INR)', 'Paid (INR)', 'Refunded (INR)', 'Impressions', 'Clicks', 'Orders', 'Ad commission (INR)'];
    csv = toCsv(headers, rows.map((c) => ({
      Reference: c.reference, Title: safe(c.title), Shop: safe(c.business_name), Status: c.status, Model: c.model, Reach: c.level,
      Regions: safe(c.regions ?? ''), Placements: (c.placements ?? []).join('; '), Starts: new Date(c.starts_at).toISOString(),
      Ends: new Date(c.ends_at).toISOString(), Hours: c.hours, 'Total (INR)': money(c.total_cents), 'Paid (INR)': money(c.paid),
      'Refunded (INR)': money(c.refunded), Impressions: c.impressions, Clicks: c.clicks, Orders: c.orders, 'Ad commission (INR)': money(c.commission),
    })));
  } else {
    return res.status(400).json({ message: 'type is campaigns or ledger.' });
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ads-${type}-${r.from}-to-${r.to}.csv"`);
  res.send(`﻿${csv}`);
}

/** Results for one campaign (its detail page). */
async function campaignStats(req, res) {
  const id = Number(req.params.id);
  const [{ rows: total }, { rows: byDay }, { rows: byPlacement }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(impressions), 0)::int AS impressions, COALESCE(SUM(clicks), 0)::int AS clicks, COALESCE(SUM(enquiries), 0)::int AS enquiries,
              COALESCE(SUM(orders), 0)::int AS orders, COALESCE(SUM(order_value_cents), 0)::bigint AS order_value,
              COALESCE(SUM(commission_cents), 0)::bigint AS commission
       FROM ad_stats_daily WHERE campaign_id = $1`,
      [id]
    ),
    pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks
       FROM ad_stats_daily WHERE campaign_id = $1 GROUP BY day ORDER BY day`,
      [id]
    ),
    pool.query(
      `SELECT placement, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks, SUM(orders)::int AS orders
       FROM ad_stats_daily WHERE campaign_id = $1 GROUP BY placement ORDER BY placement`,
      [id]
    ),
  ]);
  const t = total[0];
  res.json({
    impressions: t.impressions, clicks: t.clicks, enquiries: t.enquiries, ctr: t.impressions ? t.clicks / t.impressions : null,
    orders: t.orders, orderValueCents: Number(t.order_value), commissionCents: Number(t.commission),
    byDay: byDay.map((d) => ({ date: d.day, impressions: d.impressions, clicks: d.clicks })),
    byPlacement,
  });
}

module.exports = { dashboard, exportCsv, campaignStats };
