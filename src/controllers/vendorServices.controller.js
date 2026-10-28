const pool = require('../config/db');

/**
 * A shop's own services for Near Me → Services (NS5). Mounted on the vendor
 * portal router, so req.vendorId is the signed-in shop.
 *   GET    /api/vendor/services            → { items, max, categories }
 *   POST   /api/vendor/services            { categoryId, title, description?, priceType, priceCents?, priceMaxCents?,
 *                                            visitFeeCents?, durationMinutes?, atHome, atShop, images[], videoUrl? }
 *   PATCH  /api/vendor/services/:id        (same fields, all optional) + status: 'active' | 'paused'
 *   DELETE /api/vendor/services/:id
 * Pictures are paths the shop uploaded first (POST /api/vendors/uploads).
 * A service Gloaro hid stays hidden: the shop can edit it but not show it.
 */

const MAX_SERVICES = 30;
const MAX_IMAGES = 6;
const PRICE_TYPES = ['fixed', 'from', 'range', 'per_hour', 'on_request'];
const IMAGE_PATH = /^\/uploads\/vendors\/[\w.-]+\.(jpg|jpeg|png|webp)$/;
const YOUTUBE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]{11}(?:[?&#][^\s]*)?$/;
const MAX_PRICE_CENTS = 10_000_000 * 100; // ₹1 crore

const COLUMNS = {
  categoryId: 'category_id', title: 'title', description: 'description', priceType: 'price_type',
  priceCents: 'price_cents', priceMaxCents: 'price_max_cents', visitFeeCents: 'visit_fee_cents',
  durationMinutes: 'duration_minutes', atHome: 'at_home', atShop: 'at_shop', images: 'images', videoUrl: 'video_url',
};

const SELECT = `
  SELECT s.id, s.category_id, s.title, s.description, s.price_type, s.price_cents, s.price_max_cents,
         s.visit_fee_cents, s.duration_minutes, s.at_home, s.at_shop, s.images, s.video_url,
         s.status, s.hidden_reason, s.sort_order, s.created_at, s.updated_at,
         c.name AS category_name, c.slug AS category_slug, c.is_active AS category_active
  FROM vendor_services s JOIN service_categories c ON c.id = s.category_id`;

/** Validates the fields sent; merged with [current] for the cross-field rules. */
function readService(body, current) {
  const errors = [];
  const out = {};
  const has = (k) => body[k] !== undefined;
  const cents = (k, label) => {
    if (!has(k)) return;
    if (body[k] === null || body[k] === '') return void (out[k] = null);
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0 || n > MAX_PRICE_CENTS) errors.push(`${label} must be a whole amount in paise between 0 and ₹1 crore.`);
    out[k] = n;
  };

  if (has('categoryId')) {
    const n = Number.parseInt(body.categoryId, 10);
    if (!Number.isInteger(n)) errors.push('Pick a category.');
    out.categoryId = n;
  }
  if (has('title')) {
    const t = String(body.title ?? '').trim();
    if (t.length < 3 || t.length > 80) errors.push('The title must be 3 to 80 characters.');
    out.title = t;
  }
  if (has('description')) {
    const d = String(body.description ?? '').trim();
    if (d.length > 1500) errors.push('The description must be at most 1500 characters.');
    out.description = d || null;
  }
  if (has('priceType')) {
    if (!PRICE_TYPES.includes(body.priceType)) errors.push(`Price type must be one of ${PRICE_TYPES.join(', ')}.`);
    out.priceType = body.priceType;
  }
  cents('priceCents', 'Price');
  cents('priceMaxCents', 'Highest price');
  cents('visitFeeCents', 'Visit fee');
  if (has('durationMinutes')) {
    if (body.durationMinutes === null || body.durationMinutes === '') out.durationMinutes = null;
    else {
      const n = Number(body.durationMinutes);
      if (!Number.isInteger(n) || n < 5 || n > 10080) errors.push('Duration must be 5 minutes to 7 days.');
      out.durationMinutes = n;
    }
  }
  for (const k of ['atHome', 'atShop']) if (has(k)) out[k] = body[k] === true;
  if (has('images')) {
    const list = Array.isArray(body.images) ? body.images.map((u) => String(u).trim()).filter(Boolean) : null;
    if (!list) errors.push('images must be a list.');
    else if (list.length > MAX_IMAGES) errors.push(`At most ${MAX_IMAGES} photos.`);
    else if (!list.every((u) => IMAGE_PATH.test(u))) errors.push('Upload each photo first (it is saved under /uploads/vendors).');
    out.images = [...new Set(list ?? [])];
  }
  if (has('videoUrl')) {
    const v = String(body.videoUrl ?? '').trim();
    if (v && (v.length > 300 || !YOUTUBE.test(v))) {
      errors.push('The video must be a YouTube link (youtube.com/watch?v=…, youtu.be/… or youtube.com/shorts/…).');
    }
    out.videoUrl = v || null;
  }

  // Cross-field rules on the result.
  const next = { ...current, ...out };
  const type = next.priceType ?? 'on_request';
  if (type === 'on_request') {
    // No price is kept for a service priced on request, so none can show.
    out.priceCents = null;
    out.priceMaxCents = null;
  } else {
    if (next.priceCents == null) errors.push('Enter the price.');
    if (type === 'range') {
      if (next.priceMaxCents == null) errors.push('Enter the highest price of the range.');
      else if (next.priceCents != null && next.priceMaxCents < next.priceCents) errors.push('The highest price must not be below the lowest.');
    } else if (has('priceType') || next.priceMaxCents != null) {
      out.priceMaxCents = null;
    }
  }
  if (next.atHome === false && next.atShop === false) errors.push('Say where it is done: at the customer’s home, at your shop, or both.');
  return { errors, out };
}

async function categoryOk(id) {
  const { rows } = await pool.query('SELECT is_active FROM service_categories WHERE id = $1', [id]);
  return rows[0]?.is_active === true;
}

async function list(req, res) {
  const [{ rows }, { rows: categories }] = await Promise.all([
    pool.query(`${SELECT} WHERE s.vendor_id = $1 ORDER BY s.sort_order, s.created_at`, [req.vendorId]),
    pool.query(
      `SELECT id, slug, name, name_ta, name_hi, group_key, icon_key, image_url
       FROM service_categories WHERE is_active ORDER BY sort_order, name`
    ),
  ]);
  res.json({ items: rows, max: MAX_SERVICES, maxImages: MAX_IMAGES, categories });
}

async function create(req, res) {
  const body = req.body || {};
  const { errors, out } = readService(
    { atHome: true, atShop: false, priceType: 'on_request', images: [], ...body },
    {}
  );
  if (body.categoryId === undefined) errors.unshift('Pick a category.');
  if (body.title === undefined) errors.unshift('Enter a title.');
  if (errors.length) return res.status(400).json({ message: errors.join(' '), errors });
  if (!(await categoryOk(out.categoryId))) return res.status(400).json({ message: 'That category is not available.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One shop's adds are taken one at a time so the limit holds.
    await client.query('SELECT id FROM vendor_profiles WHERE id = $1 FOR UPDATE', [req.vendorId]);
    const { rows: [{ count }] } = await client.query('SELECT COUNT(*)::int AS count FROM vendor_services WHERE vendor_id = $1', [req.vendorId]);
    if (count >= MAX_SERVICES) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `A shop can list up to ${MAX_SERVICES} services. Delete one first.` });
    }
    const keys = Object.keys(out);
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO vendor_services (vendor_id, sort_order, ${keys.map((k) => COLUMNS[k]).join(', ')})
       VALUES ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      [req.vendorId, count, ...keys.map((k) => out[k])]
    );
    await client.query('COMMIT');
    const { rows } = await pool.query(`${SELECT} WHERE s.id = $1`, [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function owned(req) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query(`${SELECT} WHERE s.id = $1 AND s.vendor_id = $2`, [id, req.vendorId]);
  return rows[0] ?? null;
}

async function update(req, res) {
  const current = await owned(req);
  if (!current) return res.status(404).json({ message: 'Service not found' });
  const body = req.body || {};
  const { errors, out } = readService(body, {
    priceType: current.price_type, priceCents: current.price_cents, priceMaxCents: current.price_max_cents,
    atHome: current.at_home, atShop: current.at_shop,
  });
  let status;
  if (body.status !== undefined) {
    if (!['active', 'paused'].includes(body.status)) errors.push("status must be 'active' or 'paused'.");
    else if (current.status === 'hidden') errors.push(`Gloaro Mart hid this service: ${current.hidden_reason ?? 'no reason given'}. Contact support to show it again.`);
    else status = body.status;
  }
  if (errors.length) return res.status(400).json({ message: errors.join(' '), errors });
  if (out.categoryId !== undefined && out.categoryId !== current.category_id && !(await categoryOk(out.categoryId))) {
    return res.status(400).json({ message: 'That category is not available.' });
  }
  const params = [current.id];
  const sets = Object.entries(out).map(([k, v]) => `${COLUMNS[k]} = $${params.push(v)}`);
  if (status) sets.push(`status = $${params.push(status)}`);
  if (!sets.length) return res.json(current);
  await pool.query(`UPDATE vendor_services SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  const { rows } = await pool.query(`${SELECT} WHERE s.id = $1`, [current.id]);
  res.json(rows[0]);
}

async function remove(req, res) {
  const current = await owned(req);
  if (!current) return res.status(404).json({ message: 'Service not found' });
  await pool.query('DELETE FROM vendor_services WHERE id = $1', [current.id]);
  res.status(204).send();
}

module.exports = { list, create, update, remove, readService, MAX_SERVICES, MAX_IMAGES };
