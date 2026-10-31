const pool = require('../config/db');
const { healthFor } = require('./vendorHealth.controller');

/**
 * Admin views of the newer shop features (T20), all read-only:
 *
 * GET /api/admin/vendors/broadcasts?vendorId=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=
 *     Shop messages to followers (VD23).
 * GET /api/admin/vendors/paused
 *     Shops paused or busy right now (VD2).
 * GET /api/admin/vendors/health?status=
 *     Every shop's health score (VD29), lowest first, with its missing setup checks.
 *
 * The VD2 and VD23 migrations may not have run on this database yet; then the
 * answer is { ready: false } with empty rows, never a 500.
 */

// Postgres: undefined_table, undefined_column, undefined_function.
const NOT_MIGRATED = new Set(['42P01', '42703', '42883']);
const PAGE_SIZE = 50;

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

async function shopNames() {
  const { rows } = await pool.query('SELECT id, business_name AS name FROM vendor_profiles ORDER BY business_name, id');
  return rows;
}

async function listBroadcasts(req, res) {
  const { vendorId, from, to } = req.query;
  if (vendorId != null && vendorId !== '' && !/^\d+$/.test(String(vendorId))) return res.status(400).json({ message: 'vendorId must be a shop id' });
  if ((from && !isDay(from)) || (to && !isDay(to))) return res.status(400).json({ message: 'from and to are dates like 2026-10-31' });
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

  const where = [];
  const args = [];
  if (vendorId) where.push(`b.vendor_id = $${args.push(Number(vendorId))}`);
  // IST days, inclusive.
  if (from) where.push(`b.created_at >= ($${args.push(from)}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (to) where.push(`b.created_at < (($${args.push(to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const shops = await shopNames();
  try {
    const [{ rows }, { rows: t }] = await Promise.all([
      pool.query(
        `SELECT b.id, b.vendor_id, vp.business_name AS shop, b.title, b.message, b.offer_key, b.offer_text, b.recipients, b.created_at
         FROM shop_broadcasts b JOIN vendor_profiles vp ON vp.id = b.vendor_id
         ${W}
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
        args
      ),
      pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(b.recipients), 0)::int AS reach FROM shop_broadcasts b ${W}`, args),
    ]);
    res.json({
      ready: true,
      page,
      pageSize: PAGE_SIZE,
      total: t[0].n,
      totalReach: t[0].reach,
      shops,
      rows: rows.map((r) => ({
        id: r.id,
        vendorId: r.vendor_id,
        shop: r.shop,
        title: r.title,
        message: r.message,
        offerKey: r.offer_key,
        offerText: r.offer_text,
        reach: r.recipients,
        sentAt: r.created_at,
      })),
    });
  } catch (err) {
    if (!NOT_MIGRATED.has(err.code)) throw err;
    res.json({ ready: false, page, pageSize: PAGE_SIZE, total: 0, totalReach: 0, shops, rows: [] });
  }
}

async function listPausedShops(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT vp.id, vp.business_name AS shop, vp.status, vp.city,
              shop_paused_at(vp.id, now()) AS paused_now, vp.paused_until, vp.pause_note,
              shop_busy_minutes(vp.id, now()) AS busy_minutes, vp.busy_until
       FROM vendor_profiles vp
       WHERE shop_paused_at(vp.id, now()) OR shop_busy_minutes(vp.id, now()) > 0
       ORDER BY shop_paused_at(vp.id, now()) DESC, vp.business_name, vp.id`
    );
    res.json({
      ready: true,
      rows: rows.map((r) => ({
        vendorId: r.id,
        shop: r.shop,
        status: r.status,
        city: r.city,
        paused: r.paused_now,
        // null while paused = until the shop reopens itself.
        pausedUntil: r.paused_now ? r.paused_until : null,
        note: r.paused_now ? r.pause_note : null,
        busyExtraMinutes: r.busy_minutes,
        busyUntil: r.busy_minutes > 0 ? r.busy_until : null,
      })),
    });
  } catch (err) {
    if (!NOT_MIGRATED.has(err.code)) throw err;
    res.json({ ready: false, rows: [] });
  }
}

const STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
const HEALTH_BATCH = 5;

async function listShopHealth(req, res) {
  const status = req.query.status || null;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ message: `status is one of ${STATUSES.join(', ')}` });
  const { rows: shops } = await pool.query(
    `SELECT vp.id, vp.business_name AS shop, vp.status, vp.city FROM vendor_profiles vp
     WHERE $1::text IS NULL OR vp.status = $1 ORDER BY vp.id`,
    [status]
  );
  const rows = [];
  // The same two queries the shop's own Health page runs, a few shops at a
  // time so a long list doesn't wait on one round trip after another.
  const health = new Map();
  for (let i = 0; i < shops.length; i += HEALTH_BATCH) {
    const batch = shops.slice(i, i + HEALTH_BATCH);
    const done = await Promise.all(batch.map((s) => healthFor(s.id)));
    batch.forEach((s, j) => health.set(s.id, done[j]));
  }
  for (const s of shops) {
    const h = health.get(s.id);
    rows.push({
      vendorId: s.id,
      shop: s.shop,
      status: s.status,
      city: s.city,
      score: h.score,
      basedOnOrders: h.basedOnOrders,
      reliabilityPercent: h.reliabilityPercent,
      rating: h.rating,
      ordersTotal: h.orders.total,
      setupDone: h.setupDone,
      setupTotal: h.checks.length,
      missing: h.checks.filter((c) => !c.done).map((c) => ({ key: c.key, label: c.label, fix: c.fix })),
    });
  }
  rows.sort((a, b) => a.score - b.score || a.shop.localeCompare(b.shop));
  res.json({ rows });
}

module.exports = { listBroadcasts, listPausedShops, listShopHealth };
