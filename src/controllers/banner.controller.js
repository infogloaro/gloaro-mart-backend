const pool = require('../config/db');

// Where a banner is rendered in the app. 'home' is the carousel; the card_*
// placements are the background of one section card on the Mart home screen,
// and only the newest active one of each is used.
const PLACEMENTS = ['home', 'card_shop', 'card_b2b', 'card_nearme'];

// ── Public ──

async function listActiveBanners(req, res) {
  const placement = req.query.placement || 'home';
  if (!PLACEMENTS.includes(placement)) {
    return res.status(400).json({ message: `placement must be one of: ${PLACEMENTS.join(', ')}` });
  }
  const { rows } = await pool.query(
    `SELECT id, title, subtitle, image_data, link_url, sort_order, placement
     FROM banners WHERE is_active = true AND placement = $1
     ORDER BY sort_order ASC, created_at ASC`,
    [placement]
  );
  res.json(rows);
}

// ── Admin ──

async function listAllBanners(req, res) {
  const { rows } = await pool.query('SELECT * FROM banners ORDER BY sort_order ASC, created_at ASC');
  res.json(rows);
}

async function createBanner(req, res) {
  const { title, subtitle, imageData, linkUrl, sortOrder, placement } = req.body || {};
  if (!imageData || !imageData.startsWith('data:image/')) {
    return res.status(400).json({ message: 'imageData must be a base64 image data URI' });
  }
  if (placement && !PLACEMENTS.includes(placement)) {
    return res.status(400).json({ message: `placement must be one of: ${PLACEMENTS.join(', ')}` });
  }
  const { rows } = await pool.query(
    `INSERT INTO banners (title, subtitle, image_data, link_url, sort_order, placement)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [title || null, subtitle || null, imageData, linkUrl || null, sortOrder ?? 0, placement || 'home']
  );
  res.status(201).json(rows[0]);
}

async function updateBanner(req, res) {
  const { title, subtitle, imageData, linkUrl, sortOrder, isActive, placement } = req.body || {};
  if (placement && !PLACEMENTS.includes(placement)) {
    return res.status(400).json({ message: `placement must be one of: ${PLACEMENTS.join(', ')}` });
  }
  const { rows } = await pool.query(
    `UPDATE banners SET
      title = COALESCE($2, title),
      subtitle = COALESCE($3, subtitle),
      image_data = COALESCE($4, image_data),
      link_url = COALESCE($5, link_url),
      sort_order = COALESCE($6, sort_order),
      is_active = COALESCE($7, is_active),
      placement = COALESCE($8, placement)
     WHERE id = $1 RETURNING *`,
    [req.params.id, title, subtitle, imageData, linkUrl, sortOrder, isActive, placement]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Banner not found' });
  res.json(rows[0]);
}

async function deleteBanner(req, res) {
  const { rows } = await pool.query('DELETE FROM banners WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Banner not found' });
  res.status(204).send();
}

module.exports = {
  listActiveBanners,
  listAllBanners,
  createBanner,
  updateBanner,
  deleteBanner,
};
