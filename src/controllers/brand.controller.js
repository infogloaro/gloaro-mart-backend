const pool = require('../config/db');

// Display name -> URL-safe key. Kept deterministic so two admins typing the same
// brand name collide on the unique index instead of creating a near-duplicate.
function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Public ──

async function listActiveBrands(req, res) {
  const { rows } = await pool.query(
    `SELECT id, name, slug, logo_url, sort_order
     FROM brands WHERE is_active = true
     ORDER BY sort_order ASC, name ASC`
  );
  res.json(rows);
}

// ── Admin ──

async function listAllBrands(req, res) {
  const { rows } = await pool.query(
    `SELECT b.*, COUNT(p.id)::int AS product_count
     FROM brands b
     LEFT JOIN products p ON p.brand_id = b.id
     GROUP BY b.id
     ORDER BY b.sort_order ASC, b.name ASC`
  );
  res.json(rows);
}

async function createBrand(req, res) {
  const { name, slug, logoUrl, description, sortOrder, isActive } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: 'name is required' });
  }
  const finalSlug = slugify(slug || name);
  if (!finalSlug) {
    return res.status(400).json({ message: 'slug must contain at least one letter or number' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO brands (name, slug, logo_url, description, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [String(name).trim(), finalSlug, logoUrl || null, description || null, sortOrder ?? 0, isActive ?? true]
    );
    res.status(201).json({ ...rows[0], product_count: 0 });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A brand with this name or slug already exists' });
    }
    throw err;
  }
}

async function updateBrand(req, res) {
  const { name, slug, logoUrl, description, sortOrder, isActive } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ message: 'name must be a non-empty string' });
  }

  // The slug only moves when it is sent explicitly — renaming a brand must not
  // silently break links and filters that already point at the old slug.
  let nextSlug = null;
  if (slug !== undefined) {
    nextSlug = slugify(slug);
    if (!nextSlug) return res.status(400).json({ message: 'slug must contain at least one letter or number' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE brands SET
        name = COALESCE($2, name),
        slug = COALESCE($3, slug),
        logo_url = CASE WHEN $4::boolean THEN $5 ELSE logo_url END,
        description = CASE WHEN $6::boolean THEN $7 ELSE description END,
        sort_order = COALESCE($8, sort_order),
        is_active = COALESCE($9, is_active),
        updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        name === undefined ? null : name.trim(),
        nextSlug,
        logoUrl !== undefined,
        logoUrl || null,
        description !== undefined,
        description || null,
        sortOrder ?? null,
        isActive ?? null,
      ]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Brand not found' });

    const { rows: usage } = await pool.query('SELECT COUNT(*)::int AS count FROM products WHERE brand_id = $1', [
      rows[0].id,
    ]);
    res.json({ ...rows[0], product_count: usage[0].count });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A brand with this name or slug already exists' });
    }
    throw err;
  }
}

// products.brand_id is ON DELETE SET NULL, which would quietly unbrand a whole
// catalogue. Block the delete while products still use it and let the admin
// deactivate instead — same rule as categories.
async function deleteBrand(req, res) {
  const { rows: existing } = await pool.query('SELECT name FROM brands WHERE id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ message: 'Brand not found' });

  const { rows: usage } = await pool.query('SELECT COUNT(*)::int AS count FROM products WHERE brand_id = $1', [
    req.params.id,
  ]);
  if (usage[0].count > 0) {
    return res.status(409).json({
      message: `${usage[0].count} product(s) still use "${existing[0].name}". Move them to another brand first, or deactivate this one instead.`,
    });
  }

  await pool.query('DELETE FROM brands WHERE id = $1', [req.params.id]);
  res.status(204).send();
}

module.exports = {
  listActiveBrands,
  listAllBrands,
  createBrand,
  updateBrand,
  deleteBrand,
};
