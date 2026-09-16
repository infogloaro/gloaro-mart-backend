const pool = require('../config/db');

// Admin-side management of the chapter hierarchy (states → districts → chapters),
// plus read-only views of referrals and vendor wallets. The member-facing versions
// of these reads live in org/referral/wallet.controller.js and stay scoped to the
// caller; everything here is platform-wide.

const REFERRAL_STATUSES = ['pending', 'converted', 'declined'];

// ── States ──

async function listStates(req, res) {
  const { rows } = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM districts d WHERE d.state_id = s.id) AS district_count
     FROM states s
     ORDER BY s.name ASC`
  );
  res.json(rows);
}

async function updateState(req, res) {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ message: 'name is required' });
  try {
    const { rows } = await pool.query('UPDATE states SET name = $2 WHERE id = $1 RETURNING *', [
      req.params.id,
      name.trim(),
    ]);
    if (!rows[0]) return res.status(404).json({ message: 'State not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A state with this name already exists' });
    throw err;
  }
}

// districts cascade from states, so deleting a populated state would silently take
// its whole subtree (and the chapters people belong to) with it.
async function deleteState(req, res) {
  const { rows: usage } = await pool.query('SELECT COUNT(*)::int AS count FROM districts WHERE state_id = $1', [
    req.params.id,
  ]);
  if (usage[0].count > 0) {
    return res.status(409).json({ message: `Remove this state's ${usage[0].count} district(s) first.` });
  }
  const { rows } = await pool.query('DELETE FROM states WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'State not found' });
  res.status(204).send();
}

// ── Districts ──

async function listDistricts(req, res) {
  const { stateId } = req.query;
  const { rows } = await pool.query(
    `SELECT d.*, s.name AS state_name,
            (SELECT COUNT(*)::int FROM chapters c WHERE c.district_id = d.id) AS chapter_count
     FROM districts d
     JOIN states s ON s.id = d.state_id
     WHERE ($1::int IS NULL OR d.state_id = $1)
     ORDER BY s.name ASC, d.name ASC`,
    [stateId ? Number(stateId) : null]
  );
  res.json(rows);
}

async function updateDistrict(req, res) {
  const { name, stateId } = req.body || {};
  if (name !== undefined && (!name || !name.trim())) {
    return res.status(400).json({ message: 'name must be a non-empty string' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE districts SET name = COALESCE($2, name), state_id = COALESCE($3, state_id)
       WHERE id = $1 RETURNING *`,
      [req.params.id, name ? name.trim() : null, stateId ?? null]
    );
    if (!rows[0]) return res.status(404).json({ message: 'District not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A district with this name already exists in this state' });
    }
    if (err.code === '23503') return res.status(400).json({ message: 'That state does not exist' });
    throw err;
  }
}

async function deleteDistrict(req, res) {
  const { rows: usage } = await pool.query('SELECT COUNT(*)::int AS count FROM chapters WHERE district_id = $1', [
    req.params.id,
  ]);
  if (usage[0].count > 0) {
    return res.status(409).json({ message: `Remove this district's ${usage[0].count} chapter(s) first.` });
  }
  const { rows } = await pool.query('DELETE FROM districts WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'District not found' });
  res.status(204).send();
}

// ── Chapters ──

async function listChapters(req, res) {
  const { districtId, stateId } = req.query;
  const { rows } = await pool.query(
    `SELECT c.*, d.name AS district_name, d.state_id, s.name AS state_name,
            (SELECT COUNT(*)::int FROM chapter_memberships cm WHERE cm.chapter_id = c.id) AS member_count,
            (SELECT COUNT(*)::int FROM referrals r WHERE r.chapter_id = c.id) AS referral_count
     FROM chapters c
     JOIN districts d ON d.id = c.district_id
     JOIN states s ON s.id = d.state_id
     WHERE ($1::int IS NULL OR c.district_id = $1)
       AND ($2::int IS NULL OR d.state_id = $2)
     ORDER BY s.name ASC, d.name ASC, c.name ASC`,
    [districtId ? Number(districtId) : null, stateId ? Number(stateId) : null]
  );
  res.json(rows);
}

async function updateChapter(req, res) {
  const { name, districtId } = req.body || {};
  if (name !== undefined && (!name || !name.trim())) {
    return res.status(400).json({ message: 'name must be a non-empty string' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE chapters SET name = COALESCE($2, name), district_id = COALESCE($3, district_id)
       WHERE id = $1 RETURNING *`,
      [req.params.id, name ? name.trim() : null, districtId ?? null]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Chapter not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A chapter with this name already exists in this district' });
    }
    if (err.code === '23503') return res.status(400).json({ message: 'That district does not exist' });
    throw err;
  }
}

// chapter_memberships references chapters with ON DELETE RESTRICT, so this would
// fail at the database anyway — check first to return a useful message.
async function deleteChapter(req, res) {
  const { rows: usage } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM chapter_memberships WHERE chapter_id = $1',
    [req.params.id]
  );
  if (usage[0].count > 0) {
    return res.status(409).json({ message: `This chapter still has ${usage[0].count} member(s).` });
  }
  const { rows } = await pool.query('DELETE FROM chapters WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Chapter not found' });
  res.status(204).send();
}

async function listChapterMembers(req, res) {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.full_name, u.email, u.phone_number, u.role, cm.joined_at,
            vp.id AS vendor_id, vp.business_name, vp.business_type, vp.city, vp.status AS vendor_status
     FROM chapter_memberships cm
     JOIN users u ON u.id = cm.user_id
     LEFT JOIN vendor_profiles vp ON vp.user_id = cm.user_id
     WHERE cm.chapter_id = $1
     ORDER BY cm.joined_at ASC`,
    [req.params.id]
  );
  res.json(rows);
}

async function removeChapterMember(req, res) {
  const { rows } = await pool.query(
    'DELETE FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.params.userId]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Membership not found' });
  res.status(204).send();
}

// ── Referrals (platform-wide, read + status override) ──

async function listReferrals(req, res) {
  const { status, chapterId } = req.query;
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`r.status = $${params.length}`);
  }
  if (chapterId) {
    params.push(Number(chapterId));
    conditions.push(`r.chapter_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT r.*, ru.full_name AS referring_user_name, rv.full_name AS receiving_user_name,
            c.name AS chapter_name
     FROM referrals r
     JOIN users ru ON ru.id = r.referring_user_id
     JOIN users rv ON rv.id = r.receiving_user_id
     JOIN chapters c ON c.id = r.chapter_id
     ${where}
     ORDER BY r.created_at DESC LIMIT 300`,
    params
  );
  res.json(rows);
}

async function getReferralSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'converted')::int AS converted,
      COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
      COALESCE(SUM(estimated_value_cents) FILTER (WHERE status = 'converted'), 0)::int AS converted_value_cents
     FROM referrals`
  );
  res.json(rows[0]);
}

async function updateReferralStatus(req, res) {
  const { status } = req.body || {};
  if (!REFERRAL_STATUSES.includes(status)) {
    return res.status(400).json({ message: `status must be one of ${REFERRAL_STATUSES.join(', ')}` });
  }
  const { rows } = await pool.query(
    'UPDATE referrals SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [req.params.id, status]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Referral not found' });
  res.json(rows[0]);
}

// ── Vendor wallets (read-only; payouts are not modelled yet) ──

async function listWallets(req, res) {
  const { rows } = await pool.query(
    `SELECT vp.id AS vendor_id, vp.business_name, vp.status AS vendor_status,
            u.full_name AS owner_name, u.email AS owner_email,
            COALESCE(w.balance_cents, 0) AS balance_cents,
            w.updated_at
     FROM vendor_profiles vp
     JOIN users u ON u.id = vp.user_id
     LEFT JOIN vendor_wallets w ON w.vendor_id = vp.id
     ORDER BY COALESCE(w.balance_cents, 0) DESC, vp.business_name ASC`
  );
  res.json(rows);
}

async function getWalletTransactions(req, res) {
  const { rows: walletRows } = await pool.query('SELECT id FROM vendor_wallets WHERE vendor_id = $1', [
    req.params.vendorId,
  ]);
  // A vendor with no delivered orders has no wallet row yet — that is an empty
  // ledger, not an error.
  if (!walletRows[0]) return res.json([]);

  const { rows } = await pool.query(
    'SELECT * FROM wallet_transactions WHERE vendor_wallet_id = $1 ORDER BY created_at DESC LIMIT 200',
    [walletRows[0].id]
  );
  res.json(rows);
}

module.exports = {
  listStates,
  updateState,
  deleteState,
  listDistricts,
  updateDistrict,
  deleteDistrict,
  listChapters,
  updateChapter,
  deleteChapter,
  listChapterMembers,
  removeChapterMember,
  listReferrals,
  getReferralSummary,
  updateReferralStatus,
  listWallets,
  getWalletTransactions,
};
