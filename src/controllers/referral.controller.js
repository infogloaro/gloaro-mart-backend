const pool = require('../config/db');

const STATUS_VALUES = ['pending', 'converted', 'declined'];

async function getMyChapterId(userId) {
  const { rows } = await pool.query('SELECT chapter_id FROM chapter_memberships WHERE user_id = $1', [userId]);
  return rows[0]?.chapter_id || null;
}

async function createReferral(req, res) {
  const { receivingUserId, note, estimatedValueCents } = req.body || {};
  if (!receivingUserId) return res.status(400).json({ message: 'receivingUserId is required' });
  if (receivingUserId === req.user.id) {
    return res.status(400).json({ message: 'You cannot refer yourself' });
  }

  const chapterId = await getMyChapterId(req.user.id);
  if (!chapterId) return res.status(403).json({ message: 'Join a chapter first' });

  const { rows: memberRows } = await pool.query(
    'SELECT 1 FROM chapter_memberships WHERE user_id = $1 AND chapter_id = $2',
    [receivingUserId, chapterId]
  );
  if (!memberRows[0]) {
    return res.status(400).json({ message: 'That member is not in your chapter' });
  }

  const { rows } = await pool.query(
    `INSERT INTO referrals (chapter_id, referring_user_id, receiving_user_id, note, estimated_value_cents)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [chapterId, req.user.id, receivingUserId, note || null, estimatedValueCents ?? 0]
  );
  res.status(201).json(rows[0]);
}

async function listByChapter(req, res) {
  const { rows } = await pool.query(
    `SELECT r.*, ru.full_name AS referring_user_name, rv.full_name AS receiving_user_name
     FROM referrals r
     JOIN users ru ON ru.id = r.referring_user_id
     JOIN users rv ON rv.id = r.receiving_user_id
     WHERE r.chapter_id = $1
     ORDER BY r.created_at DESC`,
    [req.params.chapterId]
  );
  res.json(rows);
}

async function listSentByMe(req, res) {
  const { rows } = await pool.query(
    `SELECT r.*, ru.full_name AS referring_user_name, rv.full_name AS receiving_user_name
     FROM referrals r
     JOIN users ru ON ru.id = r.referring_user_id
     JOIN users rv ON rv.id = r.receiving_user_id
     WHERE r.referring_user_id = $1
     ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
}

async function listReceivedByMe(req, res) {
  const { rows } = await pool.query(
    `SELECT r.*, ru.full_name AS referring_user_name, rv.full_name AS receiving_user_name
     FROM referrals r
     JOIN users ru ON ru.id = r.referring_user_id
     JOIN users rv ON rv.id = r.receiving_user_id
     WHERE r.receiving_user_id = $1
     ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
}

async function updateStatus(req, res) {
  const { status } = req.body || {};
  if (!STATUS_VALUES.includes(status)) {
    return res.status(400).json({ message: `status must be one of ${STATUS_VALUES.join(', ')}` });
  }
  const { rows } = await pool.query(
    'UPDATE referrals SET status = $3, updated_at = now() WHERE id = $1 AND receiving_user_id = $2 RETURNING *',
    [req.params.id, req.user.id, status]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Referral not found' });
  res.json(rows[0]);
}

module.exports = { createReferral, listByChapter, listSentByMe, listReceivedByMe, updateStatus };
