const pool = require('../config/db');

function likeParam(q) {
  return q ? `%${q}%` : null;
}

async function listStates(req, res) {
  const q = likeParam(req.query.q);
  const { rows } = await pool.query(
    `SELECT * FROM states WHERE ($1::text IS NULL OR name ILIKE $1) ORDER BY name ASC`,
    [q]
  );
  res.json(rows);
}

async function listDistricts(req, res) {
  const q = likeParam(req.query.q);
  const { rows } = await pool.query(
    `SELECT * FROM districts WHERE state_id = $1 AND ($2::text IS NULL OR name ILIKE $2) ORDER BY name ASC`,
    [req.params.stateId, q]
  );
  res.json(rows);
}

async function listChapters(req, res) {
  const q = likeParam(req.query.q);
  const { rows } = await pool.query(
    `SELECT * FROM chapters WHERE district_id = $1 AND ($2::text IS NULL OR name ILIKE $2) ORDER BY name ASC`,
    [req.params.districtId, q]
  );
  res.json(rows);
}

async function getChapter(req, res) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.district_id,
            d.name AS district_name, d.state_id,
            s.name AS state_name
     FROM chapters c
     JOIN districts d ON d.id = c.district_id
     JOIN states s ON s.id = d.state_id
     WHERE c.id = $1`,
    [req.params.chapterId]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Chapter not found' });
  res.json(rows[0]);
}

async function listChapterMembers(req, res) {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.full_name, u.email, cm.joined_at,
            vp.id AS vendor_id, vp.business_name, vp.business_type, vp.city, vp.gst_number
     FROM chapter_memberships cm
     JOIN users u ON u.id = cm.user_id
     LEFT JOIN vendor_profiles vp ON vp.user_id = cm.user_id
     WHERE cm.chapter_id = $1
     ORDER BY cm.joined_at ASC`,
    [req.params.chapterId]
  );
  res.json(rows);
}

async function createState(req, res) {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ message: 'name is required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO states (name, created_by) VALUES ($1, $2) RETURNING *',
      [name.trim(), req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A state with this name already exists' });
    throw err;
  }
}

async function createDistrict(req, res) {
  const { stateId, name } = req.body || {};
  if (!stateId || !name || !name.trim()) return res.status(400).json({ message: 'stateId and name are required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO districts (state_id, name, created_by) VALUES ($1, $2, $3) RETURNING *',
      [stateId, name.trim(), req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A district with this name already exists in this state' });
    throw err;
  }
}

async function createChapter(req, res) {
  const { districtId, name } = req.body || {};
  if (!districtId || !name || !name.trim()) return res.status(400).json({ message: 'districtId and name are required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO chapters (district_id, name, created_by) VALUES ($1, $2, $3) RETURNING *',
      [districtId, name.trim(), req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A chapter with this name already exists in this district' });
    throw err;
  }
}

async function getMyMembership(req, res) {
  const { rows } = await pool.query(
    `SELECT cm.*, c.name AS chapter_name, d.name AS district_name, s.name AS state_name
     FROM chapter_memberships cm
     JOIN chapters c ON c.id = cm.chapter_id
     JOIN districts d ON d.id = c.district_id
     JOIN states s ON s.id = d.state_id
     WHERE cm.user_id = $1`,
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Not a member of any chapter' });
  res.json(rows[0]);
}

async function joinChapter(req, res) {
  const { chapterId } = req.body || {};
  if (!chapterId) return res.status(400).json({ message: 'chapterId is required' });
  const { rows: chapterRows } = await pool.query('SELECT id FROM chapters WHERE id = $1', [chapterId]);
  if (!chapterRows[0]) return res.status(404).json({ message: 'Chapter not found' });

  const { rows } = await pool.query(
    `INSERT INTO chapter_memberships (user_id, chapter_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET chapter_id = EXCLUDED.chapter_id, joined_at = now()
     RETURNING *`,
    [req.user.id, chapterId]
  );
  res.status(201).json(rows[0]);
}

async function leaveChapter(req, res) {
  await pool.query('DELETE FROM chapter_memberships WHERE user_id = $1', [req.user.id]);
  res.status(204).send();
}

module.exports = {
  listStates,
  listDistricts,
  listChapters,
  getChapter,
  listChapterMembers,
  createState,
  createDistrict,
  createChapter,
  getMyMembership,
  joinChapter,
  leaveChapter,
};
