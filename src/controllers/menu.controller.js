const pool = require('../config/db');

const LINK_TYPES = ['section', 'category', 'vendor', 'url'];

// Public: what the app's drawer renders.
async function listActiveMenu(req, res) {
  const { rows } = await pool.query(
    'SELECT id, label, icon_key, link_type, link_value, sort_order FROM menu_items WHERE is_active = true ORDER BY sort_order ASC, id ASC'
  );
  res.json(rows);
}

// Admin: everything, including the disabled entries.
async function listAllMenu(req, res) {
  const { rows } = await pool.query('SELECT * FROM menu_items ORDER BY sort_order ASC, id ASC');
  res.json(rows);
}

function validate({ label, linkType, linkValue }) {
  if (!label || !label.trim()) return 'label is required';
  if (linkType && !LINK_TYPES.includes(linkType)) {
    return `linkType must be one of ${LINK_TYPES.join(', ')}`;
  }
  // A menu row that points nowhere renders as a dead tap in the app.
  if (linkType && linkType !== 'section' && !linkValue) {
    return `linkValue is required for a ${linkType} item`;
  }
  return null;
}

async function createMenuItem(req, res) {
  const { label, iconKey, linkType = 'section', linkValue, sortOrder = 0, isActive = true } = req.body || {};
  const problem = validate({ label, linkType, linkValue });
  if (problem) return res.status(400).json({ message: problem });

  const { rows } = await pool.query(
    `INSERT INTO menu_items (label, icon_key, link_type, link_value, sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [label.trim(), iconKey || null, linkType, linkValue || null, sortOrder, isActive]
  );
  res.status(201).json(rows[0]);
}

async function updateMenuItem(req, res) {
  const { label, iconKey, linkType, linkValue, sortOrder, isActive } = req.body || {};
  if (linkType && !LINK_TYPES.includes(linkType)) {
    return res.status(400).json({ message: `linkType must be one of ${LINK_TYPES.join(', ')}` });
  }
  const { rows } = await pool.query(
    `UPDATE menu_items SET
      label = COALESCE($2, label),
      icon_key = COALESCE($3, icon_key),
      link_type = COALESCE($4, link_type),
      link_value = COALESCE($5, link_value),
      sort_order = COALESCE($6, sort_order),
      is_active = COALESCE($7, is_active),
      updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      label != null ? String(label).trim() : null,
      iconKey ?? null,
      linkType ?? null,
      linkValue ?? null,
      sortOrder ?? null,
      isActive ?? null,
    ]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Menu item not found' });
  res.json(rows[0]);
}

async function deleteMenuItem(req, res) {
  await pool.query('DELETE FROM menu_items WHERE id = $1', [req.params.id]);
  res.status(204).send();
}

// Saves a whole drag-to-reorder in one call, so a half-applied order cannot be
// left behind if the admin closes the page mid-way.
async function reorderMenu(req, res) {
  const { order } = req.body || {};
  if (!Array.isArray(order)) {
    return res.status(400).json({ message: 'order must be an array of menu item ids' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i += 1) {
      await client.query('UPDATE menu_items SET sort_order = $2, updated_at = now() WHERE id = $1', [order[i], i]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const { rows } = await pool.query('SELECT * FROM menu_items ORDER BY sort_order ASC, id ASC');
  res.json(rows);
}

module.exports = {
  listActiveMenu,
  listAllMenu,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  reorderMenu,
};
