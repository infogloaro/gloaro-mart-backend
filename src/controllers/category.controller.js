const pool = require('../config/db');

// ── Public ──

// The admin-defined sub-categories of each category, in order (CT1).
const SUBCATEGORIES = (activeOnly) => `COALESCE(
    (SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'sort_order', s.sort_order${activeOnly ? '' : ", 'is_active', s.is_active"})
                     ORDER BY s.sort_order, s.name)
     FROM category_subcategories s WHERE s.category_id = c.id${activeOnly ? ' AND s.is_active' : ''}),
    '[]') AS subcategories`;

async function listActiveCategories(req, res) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.icon_key, c.image_url, c.sort_order, ${SUBCATEGORIES(true)}
     FROM categories c WHERE c.is_active = true ORDER BY c.sort_order ASC, c.name ASC`
  );
  res.json(rows);
}

// ── Admin ──

async function listAllCategories(req, res) {
  const { rows } = await pool.query(
    `SELECT c.*, ${SUBCATEGORIES(false)},
            (SELECT COUNT(*)::int FROM products p WHERE p.category = c.name) AS product_count
     FROM categories c ORDER BY c.sort_order ASC, c.name ASC`
  );
  res.json(rows);
}

async function createCategory(req, res) {
  const { name, iconKey, imageUrl, sortOrder } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'name is required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO categories (name, icon_key, image_url, sort_order) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), iconKey || 'other', imageUrl || null, sortOrder ?? 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A category with this name already exists' });
    }
    throw err;
  }
}

async function updateCategory(req, res) {
  const { name, iconKey, imageUrl, sortOrder, isActive } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ message: 'name must be a non-empty string' });
  }

  const { rows: existing } = await pool.query('SELECT name FROM categories WHERE id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ message: 'Category not found' });

  const nextName = name === undefined ? null : name.trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE categories SET
        name = COALESCE($2, name),
        icon_key = COALESCE($3, icon_key),
        sort_order = COALESCE($4, sort_order),
        is_active = COALESCE($5, is_active),
        -- Sent as "" or null, the image is removed; left out, it is kept.
        image_url = CASE WHEN $6::boolean THEN $7 ELSE image_url END
       WHERE id = $1 RETURNING *`,
      [req.params.id, nextName, iconKey, sortOrder, isActive, imageUrl !== undefined, imageUrl || null]
    );
    // products.category stores the name, not the id, so a rename has to follow through.
    if (nextName && nextName !== existing[0].name) {
      await client.query('UPDATE products SET category = $1, updated_at = now() WHERE category = $2', [
        nextName,
        existing[0].name,
      ]);
    }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A category with this name already exists' });
    }
    throw err;
  } finally {
    client.release();
  }
}

// products.category holds the category *name* as free text, so there is no FK to
// protect us — check for users of the name before dropping the row.
async function deleteCategory(req, res) {
  const { rows: existing } = await pool.query('SELECT name FROM categories WHERE id = $1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ message: 'Category not found' });

  const { rows: usage } = await pool.query('SELECT COUNT(*)::int AS count FROM products WHERE category = $1', [
    existing[0].name,
  ]);
  if (usage[0].count > 0) {
    return res.status(409).json({
      message: `${usage[0].count} product(s) still use "${existing[0].name}". Move them to another category first, or deactivate this one instead.`,
    });
  }

  await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
  res.status(204).send();
}

// ── Admin: sub-categories (CT1) ──
// products.subcategory holds the name, like products.category, so a rename
// follows through to the category's products and a delete is refused while
// products still use it.

async function findSubcategory(req) {
  const { rows } = await pool.query(
    `SELECT s.name, c.name AS category FROM category_subcategories s JOIN categories c ON c.id = s.category_id
     WHERE s.id = $1 AND s.category_id = $2`,
    [req.params.subId, req.params.id]
  );
  return rows[0];
}

async function createSubcategory(req, res) {
  const { name, sortOrder } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ message: 'name is required' });
  const { rows: cat } = await pool.query('SELECT id FROM categories WHERE id = $1', [req.params.id]);
  if (!cat[0]) return res.status(404).json({ message: 'Category not found' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO category_subcategories (category_id, name, sort_order)
       VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM category_subcategories WHERE category_id = $1)))
       RETURNING *`,
      [req.params.id, name.trim(), sortOrder ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'This category already has a sub-category with this name' });
    throw err;
  }
}

async function updateSubcategory(req, res) {
  const { name, sortOrder, isActive } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ message: 'name must be a non-empty string' });
  }
  const existing = await findSubcategory(req);
  if (!existing) return res.status(404).json({ message: 'Sub-category not found' });
  const nextName = name === undefined ? null : name.trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE category_subcategories SET name = COALESCE($2, name), sort_order = COALESCE($3, sort_order),
         is_active = COALESCE($4, is_active)
       WHERE id = $1 RETURNING *`,
      [req.params.subId, nextName, sortOrder ?? null, isActive ?? null]
    );
    if (nextName && nextName !== existing.name) {
      await client.query(
        `UPDATE products SET subcategory = $1, updated_at = now() WHERE category = $2 AND lower(subcategory) = lower($3)`,
        [nextName, existing.category, existing.name]
      );
    }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ message: 'This category already has a sub-category with this name' });
    throw err;
  } finally {
    client.release();
  }
}

async function deleteSubcategory(req, res) {
  const existing = await findSubcategory(req);
  if (!existing) return res.status(404).json({ message: 'Sub-category not found' });
  const { rows: usage } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM products WHERE category = $1 AND lower(subcategory) = lower($2)',
    [existing.category, existing.name]
  );
  if (usage[0].count > 0) {
    return res.status(409).json({
      message: `${usage[0].count} product(s) still use "${existing.name}". Move them to another sub-category first, or hide this one instead.`,
    });
  }
  await pool.query('DELETE FROM category_subcategories WHERE id = $1', [req.params.subId]);
  res.status(204).send();
}

module.exports = {
  createSubcategory,
  updateSubcategory,
  deleteSubcategory,
  listActiveCategories,
  listAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
};
