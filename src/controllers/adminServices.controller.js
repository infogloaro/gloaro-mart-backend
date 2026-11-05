const pool = require('../config/db');
const shopTrust = require('../services/shopTrust');

/**
 * Admin → Service categories and Services (NS4). Guarded by the Categories
 * module (permissions.js routes "service-categories", "services").
 *   GET    /api/admin/service-categories
 *   POST   /api/admin/service-categories { name, nameTa?, nameHi?, slug?, groupKey?, iconKey?, imageUrl?, sortOrder?, isActive? }
 *   PATCH  /api/admin/service-categories/:id (same fields, all optional; imageUrl "" or null removes it)
 *   DELETE /api/admin/service-categories/:id (409 while services use it)
 *   GET    /api/admin/services?status&categoryId&q
 *   PATCH  /api/admin/services/:id { status: 'active'|'hidden', hiddenReason? }
 */

// SV2: the prompt's ten groups (personal = beauty & wellness, gadgets = electronics & IT) plus daily help and other.
const GROUPS = ['vehicle', 'home', 'cleaning', 'personal', 'health', 'learning', 'events', 'moving', 'gadgets', 'pets', 'daily', 'other'];
const ICONS = [
  'car', 'bike', 'car_wash', 'ac', 'electrician', 'plumber', 'carpenter', 'painter', 'water', 'appliance',
  'pest', 'cleaning', 'mobile', 'laptop', 'salon', 'beauty', 'tailor', 'laundry', 'tuition', 'camera',
  'health', 'pet', 'other',
  // SV2
  'tyre', 'battery', 'towing', 'bathroom', 'sofa', 'spa', 'makeup', 'doctor', 'dental', 'lab', 'physio', 'nursing',
  'ambulance', 'music', 'dance', 'computer', 'language', 'video', 'dj', 'catering', 'decor', 'moving', 'truck', 'cctv',
  'wifi', 'pet_walk', 'vet',
];

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Checks the fields sent (all optional for a patch); returns errors and the clean values. */
function readCategory(body, { creating }) {
  const errors = [];
  const out = {};
  const text = (key, max, label) => {
    if (body[key] === undefined) return;
    const v = body[key] === null ? '' : String(body[key]).trim();
    if (v.length > max) errors.push(`${label} must be at most ${max} characters.`);
    out[key] = v || null;
  };
  text('name', 60, 'Name');
  text('nameTa', 80, 'Tamil name');
  text('nameHi', 80, 'Hindi name');
  if (creating && !out.name) errors.push('Enter a name.');
  else if (body.name !== undefined && !out.name) errors.push('Name cannot be empty.');
  if (body.slug !== undefined || creating) {
    const slug = slugify(body.slug || out.name || '');
    if (!slug) errors.push('The slug needs letters or numbers (English).');
    out.slug = slug;
  }
  if (body.groupKey !== undefined) {
    if (!GROUPS.includes(body.groupKey)) errors.push(`Group must be one of ${GROUPS.join(', ')}.`);
    out.groupKey = body.groupKey;
  }
  if (body.iconKey !== undefined) {
    if (!ICONS.includes(body.iconKey)) errors.push(`Icon must be one of ${ICONS.join(', ')}.`);
    out.iconKey = body.iconKey;
  }
  if (body.imageUrl !== undefined) {
    const v = body.imageUrl ? String(body.imageUrl).trim() : '';
    if (v && !/^(\/uploads\/|https:\/\/)/.test(v)) errors.push('The image must be an upload or an https link.');
    out.imageUrl = v || null;
  }
  if (body.sortOrder !== undefined) {
    const n = Number(body.sortOrder);
    if (!Number.isInteger(n) || n < 0) errors.push('Sort order must be a whole number of 0 or more.');
    out.sortOrder = n;
  }
  if (body.isActive !== undefined) out.isActive = body.isActive === true;
  // SV8: the category's own commission %, or null for the global plan's rate.
  if (body.commissionPercent !== undefined) {
    if (body.commissionPercent === null || body.commissionPercent === '') out.commissionPercent = null;
    else {
      const n = Number(body.commissionPercent);
      if (!Number.isFinite(n) || n < 0 || n > 100) errors.push('Commission is a percentage from 0 to 100, or empty for the default.');
      else out.commissionPercent = Math.round(n * 100) / 100;
    }
  }
  return { errors, out };
}

const CATEGORY_SELECT = `
  SELECT c.*, c.commission_percent::float AS commission_percent,
         (SELECT commission_percent::float FROM commission_plans WHERE scope = 'global' AND is_active ORDER BY id LIMIT 1) AS default_commission_percent,
         (SELECT COUNT(*)::int FROM vendor_services s WHERE s.category_id = c.id) AS service_count,
         (SELECT COUNT(DISTINCT s.vendor_id)::int FROM vendor_services s
            JOIN vendor_profiles vp ON vp.id = s.vendor_id
           WHERE s.category_id = c.id AND s.status = 'active' AND vp.status = 'approved') AS provider_count
  FROM service_categories c`;

async function listCategories(req, res) {
  const { rows } = await pool.query(`${CATEGORY_SELECT} ORDER BY c.sort_order, c.name`);
  res.json(rows);
}

function duplicate(err, res) {
  if (err.code !== '23505') throw err;
  return res.status(409).json({ message: 'Another service category already uses this slug. Change the name or slug.' });
}

async function createCategory(req, res) {
  const { errors, out } = readCategory(req.body || {}, { creating: true });
  if (errors.length) return res.status(400).json({ message: errors.join(' '), errors });
  try {
    const { rows } = await pool.query(
      `INSERT INTO service_categories (slug, name, name_ta, name_hi, group_key, icon_key, image_url, sort_order, is_active, commission_percent)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'other'), COALESCE($6, 'other'), $7,
               COALESCE($8, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM service_categories)), COALESCE($9, true), $10)
       RETURNING id`,
      [out.slug, out.name, out.nameTa ?? null, out.nameHi ?? null, out.groupKey ?? null, out.iconKey ?? null,
        out.imageUrl ?? null, out.sortOrder ?? null, out.isActive ?? null, out.commissionPercent ?? null]
    );
    const { rows: [row] } = await pool.query(`${CATEGORY_SELECT} WHERE c.id = $1`, [rows[0].id]);
    res.status(201).json(row);
  } catch (err) {
    return duplicate(err, res);
  }
}

async function updateCategory(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ message: 'Service category not found' });
  const { errors, out } = readCategory(req.body || {}, { creating: false });
  if (errors.length) return res.status(400).json({ message: errors.join(' '), errors });
  const columns = {
    slug: 'slug', name: 'name', nameTa: 'name_ta', nameHi: 'name_hi', groupKey: 'group_key',
    iconKey: 'icon_key', imageUrl: 'image_url', sortOrder: 'sort_order', isActive: 'is_active', commissionPercent: 'commission_percent',
  };
  const params = [id];
  const sets = Object.entries(out).map(([k, v]) => `${columns[k]} = $${params.push(v)}`);
  if (!sets.length) return res.status(400).json({ message: 'Nothing to change.' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE service_categories SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
      params
    );
    if (!rowCount) return res.status(404).json({ message: 'Service category not found' });
    const { rows: [row] } = await pool.query(`${CATEGORY_SELECT} WHERE c.id = $1`, [id]);
    res.json(row);
  } catch (err) {
    return duplicate(err, res);
  }
}

async function deleteCategory(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  const { rows } = await pool.query(`${CATEGORY_SELECT} WHERE c.id = $1`, [Number.isInteger(id) ? id : 0]);
  if (!rows[0]) return res.status(404).json({ message: 'Service category not found' });
  if (rows[0].service_count > 0) {
    return res.status(409).json({
      message: `${rows[0].service_count} service(s) still use "${rows[0].name}". Deactivate it instead to hide it from the app.`,
    });
  }
  await pool.query('DELETE FROM service_categories WHERE id = $1', [id]);
  res.status(204).send();
}

async function listServices(req, res) {
  const params = [];
  const where = [];
  const push = (v) => `$${params.push(v)}`;
  if (req.query.status) {
    if (!['active', 'paused', 'hidden'].includes(req.query.status)) return res.status(400).json({ message: 'Unknown status' });
    where.push(`s.status = ${push(req.query.status)}`);
  }
  if (req.query.categoryId) where.push(`s.category_id = ${push(Number.parseInt(req.query.categoryId, 10) || 0)}`);
  // SV10: only services of verified shops.
  if (req.query.verified === 'true') where.push(shopTrust.verifiedSql('vp'));
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  if (q) {
    const like = push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(s.title ILIKE ${like} OR vp.business_name ILIKE ${like})`);
  }
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.price_type, s.price_cents, s.price_max_cents, s.visit_fee_cents, s.at_home, s.at_shop,
            s.images, s.video_url, s.status, s.hidden_reason, s.created_at, s.updated_at,
            c.id AS category_id, c.name AS category_name,
            vp.id AS vendor_id, vp.business_name AS vendor_name, vp.city AS vendor_city, vp.status AS vendor_status,
            (${shopTrust.verifiedSql('vp')}) AS vendor_verified
     FROM vendor_services s
     JOIN service_categories c ON c.id = s.category_id
     JOIN vendor_profiles vp ON vp.id = s.vendor_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY s.updated_at DESC
     LIMIT 200`,
    params
  );
  res.json(rows);
}

/** Hide a service from the app (with a reason the shop sees) or show it again. */
async function moderateService(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  const { status, hiddenReason } = req.body || {};
  if (!['active', 'hidden'].includes(status)) return res.status(400).json({ message: "status must be 'active' or 'hidden'" });
  const reason = String(hiddenReason ?? '').trim();
  if (status === 'hidden' && reason.length < 5) return res.status(400).json({ message: 'Say why it is hidden (at least 5 characters).' });
  if (reason.length > 300) return res.status(400).json({ message: 'The reason must be at most 300 characters.' });
  const { rows } = await pool.query(
    `UPDATE vendor_services SET status = $2, hidden_reason = $3, updated_at = now()
     WHERE id = $1 RETURNING id, status, hidden_reason`,
    [Number.isInteger(id) ? id : 0, status, status === 'hidden' ? reason : null]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Service not found' });
  res.json(rows[0]);
}

module.exports = { listCategories, createCategory, updateCategory, deleteCategory, listServices, moderateService, GROUPS, ICONS };
