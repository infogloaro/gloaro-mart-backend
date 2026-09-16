const pool = require('../config/db');

// ── Public ──

async function listActiveCategories(req, res) {
  const { rows } = await pool.query(
    'SELECT id, name, icon_key, sort_order FROM categories WHERE is_active = true ORDER BY sort_order ASC, name ASC'
  );
  res.json(rows);
}

// ── Admin ──

async function listAllCategories(req, res) {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, name ASC');
  res.json(rows);
}

async function createCategory(req, res) {
  const { name, iconKey, sortOrder } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'name is required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO categories (name, icon_key, sort_order) VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), iconKey || 'other', sortOrder ?? 0]
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
  const { name, iconKey, sortOrder, isActive } = req.body || {};
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
        is_active = COALESCE($5, is_active)
       WHERE id = $1 RETURNING *`,
      [req.params.id, nextName, iconKey, sortOrder, isActive]
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

module.exports = {
  listActiveCategories,
  listAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
};
