const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const gate = require('../middleware/shopStaff');

/**
 * VD27: the owner's list of people who work in the shop. Owner-only (the
 * shopStaff gate refuses staff, and each handler checks ownership again).
 * Adding someone makes their login: a username the owner picks and a
 * temporary password shown once. Switching someone off, or a new password,
 * ends their open sessions (token_version).
 */
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9._]{2,29}$/;
const ROLES = ['manager', 'packer'];
const MAX_STAFF = 10;

const tempPassword = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);

async function ownedShop(userId) {
  const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1 ORDER BY id LIMIT 1', [userId]);
  return rows[0]?.id ?? null;
}

const json = (r) => ({
  id: r.id,
  userId: r.user_id,
  name: r.full_name,
  username: r.username,
  phone: r.phone_number,
  role: r.role,
  disabled: r.disabled_at != null,
  createdAt: r.created_at,
});

const LIST = `SELECT s.*, u.full_name, u.username, u.phone_number FROM vendor_staff s JOIN users u ON u.id = s.user_id`;

async function list(req, res) {
  const shop = await ownedShop(req.user.id);
  if (!shop) return res.status(403).json({ message: 'Only the shop owner can manage staff.' });
  const { rows } = await pool.query(`${LIST} WHERE s.vendor_id = $1 ORDER BY s.disabled_at NULLS FIRST, s.created_at`, [shop]);
  res.json({ items: rows.map(json), max: MAX_STAFF, roles: ROLES });
}

async function create(req, res) {
  const shop = await ownedShop(req.user.id);
  if (!shop) return res.status(403).json({ message: 'Only the shop owner can manage staff.' });
  const { name, username, phone, role } = req.body || {};
  const fullName = typeof name === 'string' ? name.trim() : '';
  if (!fullName || fullName.length > 80) return res.status(400).json({ message: 'Enter their name (up to 80 letters).' });
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    return res.status(400).json({ message: 'The username starts with a letter: 3–30 letters, numbers, dot or underscore.' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ message: `role must be one of ${ROLES.join(', ')}` });
  let ph = null;
  if (phone != null && String(phone).trim()) {
    const m = String(phone).replace(/[\s()-]/g, '').match(/^(?:\+?91|0)?([6-9]\d{9})$/);
    if (!m) return res.status(400).json({ message: 'The phone must be a 10-digit Indian mobile.' });
    ph = `+91${m[1]}`;
  }
  const { rows: count } = await pool.query('SELECT COUNT(*)::int AS n FROM vendor_staff WHERE vendor_id = $1 AND disabled_at IS NULL', [shop]);
  if (count[0].n >= MAX_STAFF) return res.status(409).json({ message: `A shop can have up to ${MAX_STAFF} staff logins.` });

  const uname = username.trim();
  const password = tempPassword();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: users } = await client.query(
      `INSERT INTO users (full_name, email, username, phone_number, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'vendor') RETURNING id`,
      [fullName, `${uname.toLowerCase()}.${shop}@staff.gloaro.invalid`, uname, ph, await bcrypt.hash(password, 10)]
    );
    const { rows } = await client.query(
      `INSERT INTO vendor_staff (vendor_id, user_id, role, added_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [shop, users[0].id, role, req.user.id]
    );
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${LIST} WHERE s.id = $1`, [rows[0].id]);
    res.status(201).json({ staff: json(full[0]), tempPassword: password });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ message: 'That username is taken. Try another.' });
    throw err;
  } finally {
    client.release();
  }
}

async function update(req, res) {
  const shop = await ownedShop(req.user.id);
  if (!shop) return res.status(403).json({ message: 'Only the shop owner can manage staff.' });
  const { rows: found } = await pool.query('SELECT * FROM vendor_staff WHERE id = $1 AND vendor_id = $2', [req.params.id, shop]);
  const staff = found[0];
  if (!staff) return res.status(404).json({ message: 'Staff member not found' });
  const { role, disabled, resetPassword } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ message: `role must be one of ${ROLES.join(', ')}` });
  if (disabled === false && staff.disabled_at) {
    const { rows: count } = await pool.query('SELECT COUNT(*)::int AS n FROM vendor_staff WHERE vendor_id = $1 AND disabled_at IS NULL', [shop]);
    if (count[0].n >= MAX_STAFF) return res.status(409).json({ message: `A shop can have up to ${MAX_STAFF} staff logins.` });
  }
  let password = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE vendor_staff SET role = COALESCE($2, role),
         disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN COALESCE(disabled_at, now()) ELSE NULL END
       WHERE id = $1`,
      [staff.id, role ?? null, typeof disabled === 'boolean' ? disabled : null]
    );
    if (resetPassword === true) {
      password = tempPassword();
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [staff.user_id, await bcrypt.hash(password, 10)]);
    }
    // Their open sessions end when switched off, given a new password, or moved to another role.
    if (disabled === true || resetPassword === true || (role && role !== staff.role)) {
      await client.query('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1', [staff.user_id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  gate.forget(staff.user_id);
  const { rows } = await pool.query(`${LIST} WHERE s.id = $1`, [staff.id]);
  res.json({ staff: json(rows[0]), ...(password ? { tempPassword: password } : {}) });
}

module.exports = { list, create, update, USERNAME_RE, MAX_STAFF };
