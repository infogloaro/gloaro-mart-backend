const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../middleware/auth');
const { revokeSessions } = require('../services/sessions');
const { sendMail } = require('../services/mailer');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const RESET_TTL_MS = 60 * 60 * 1000;

// Only the hash is stored, so a leaked table can't be used to reset accounts.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const VALID_ROLES = ['customer', 'vendor'];

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, tokenVersion: user.token_version },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function signup(req, res) {
  const { fullName, email, phoneNumber, password, role } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ message: 'Invalid email or password' });
  }
  const userRole = VALID_ROLES.includes(role) ? role : 'customer';
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      'INSERT INTO users (full_name, email, phone_number, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
      [fullName, email, phoneNumber, passwordHash, userRole]
    );
    res.status(201).json({ message: 'User created' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'User already exists' });
    }
    throw err;
  }
}

async function login(req, res) {
  const { email, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  res.json({ token: signToken(user) });
}

async function forgotPassword(req, res) {
  const { email } = req.body || {};
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, hashToken(token), expiresAt]
    );
    const base = process.env.RESET_URL_BASE;
    const link = base ? `${base}${base.includes('?') ? '&' : '?'}token=${token}` : null;
    try {
      await sendMail({
        to: email,
        subject: 'Reset your Gloaro Mart password',
        text: `${link ? `Open this link to reset your password:\n${link}\n\nOr use` : 'Use'} this reset code: ${token}\n\nIt expires in 1 hour. If you did not ask for this, ignore this email.`,
      });
    } catch (err) {
      // Failing here would reveal the email exists, so log it and answer the same way.
      console.error('[forgot-password] mail failed:', err.message);
    }
  }
  // Always respond the same way whether or not the email exists, to avoid leaking account existence.
  res.json({ message: 'If that email exists, a reset link has been sent' });
}

async function resetPassword(req, res) {
  const { token, password } = req.body || {};
  if (typeof token !== 'string' || !token || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ message: 'Invalid token or password' });
  }
  // One atomic claim, so a token can't be spent twice by concurrent requests.
  const claimed = await pool.query(
    `UPDATE password_reset_tokens SET used = true
      WHERE token = $1 AND used = false AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token)]
  );
  if (!claimed.rows[0]) {
    return res.status(400).json({ message: 'This reset link is invalid or has expired' });
  }
  const userId = claimed.rows[0].user_id;
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  await revokeSessions(userId);
  res.json({ message: 'Password updated. Please log in again.' });
}

const PROFILE_COLUMNS = 'id, full_name, email, phone_number, role, created_at';

function toProfile(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phoneNumber: row.phone_number,
    role: row.role,
    createdAt: row.created_at,
  };
}

async function getMe(req, res) {
  const { rows } = await pool.query(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
  if (!rows[0]) return res.status(404).json({ message: 'User not found' });
  res.json(toProfile(rows[0]));
}

/**
 * Only name and phone are editable here. Email is the login identity and role
 * is a permission, so neither can be changed by the account holder.
 */
async function updateMe(req, res) {
  const { fullName, phoneNumber } = req.body || {};
  const fields = [];
  const values = [];
  if (fullName !== undefined) {
    if (typeof fullName !== 'string' || !fullName.trim() || fullName.length > 100) {
      return res.status(400).json({ message: 'Invalid full name' });
    }
    values.push(fullName.trim());
    fields.push(`full_name = $${values.length}`);
  }
  if (phoneNumber !== undefined) {
    if (typeof phoneNumber !== 'string' || !/^\+?[0-9\s-]{7,15}$/.test(phoneNumber.trim())) {
      return res.status(400).json({ message: 'Invalid phone number' });
    }
    values.push(phoneNumber.trim());
    fields.push(`phone_number = $${values.length}`);
  }
  if (!fields.length) {
    return res.status(400).json({ message: 'Nothing to update' });
  }
  values.push(req.user.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING ${PROFILE_COLUMNS}`,
    values
  );
  if (!rows[0]) return res.status(404).json({ message: 'User not found' });
  res.json(toProfile(rows[0]));
}

/**
 * Tokens are stateless, so logging out means bumping the account's token
 * version: this device's token and any other still-live one stop working.
 */
async function logout(req, res) {
  await revokeSessions(req.user.id);
  res.json({ message: 'Logged out' });
}

/**
 * Swaps a still-valid token for a fresh 7-day one. The new token is built from
 * the database row, not the old payload, so a role change is picked up here.
 * An expired or revoked token never reaches this — requireAuth rejects it.
 */
async function refresh(req, res) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(401).json({ message: 'Account no longer exists' });
  res.json({ token: signToken(rows[0]) });
}

/**
 * Step 1 of passwordless login: mails a 6-digit code. The response is the same
 * whether or not the email has an account, so this can't be used to probe for
 * accounts. Email only for now; an SMS channel can slot in beside sendMail.
 */
async function sendLoginOtp(req, res) {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ message: 'Email is required' });
  }
  const generic = { message: 'If that email has an account, an OTP has been sent' };
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim()]);
  const user = rows[0];
  if (!user) return res.json(generic);

  const recent = await pool.query(
    'SELECT 1 FROM login_otps WHERE user_id = $1 AND created_at > $2',
    [user.id, new Date(Date.now() - OTP_RESEND_MS)]
  );
  if (recent.rows[0]) {
    return res.status(429).json({ message: 'Please wait a minute before requesting another OTP' });
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  const otpHash = await bcrypt.hash(otp, 10);
  try {
    await sendMail({
      to: email.trim(),
      subject: 'Your Gloaro Mart login OTP',
      text: `Your login OTP is ${otp}\n\nIt expires in 10 minutes. If you did not ask for this, ignore this email.`,
    });
  } catch (err) {
    console.error('[login-otp] mail failed:', err.message);
    return res.status(502).json({ message: 'Could not send the OTP. Please try again.' });
  }
  // A new code replaces any still-open one, so only the latest can be used.
  await pool.query('UPDATE login_otps SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [user.id]);
  await pool.query(
    'INSERT INTO login_otps (user_id, otp_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, otpHash, new Date(Date.now() + OTP_TTL_MS)]
  );
  res.json(generic);
}

/** Step 2: a correct, unexpired code signs the user in and returns a token. */
async function verifyLoginOtp(req, res) {
  const { email, otp } = req.body || {};
  if (typeof email !== 'string' || !email.trim() || !otp) {
    return res.status(400).json({ message: 'Email and OTP are required' });
  }
  const invalid = () => res.status(401).json({ message: 'Invalid or expired OTP' });

  const { rows: users } = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim()]);
  const user = users[0];
  if (!user) return invalid();

  const { rows } = await pool.query(
    `SELECT id, otp_hash, attempts FROM login_otps
      WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  const pending = rows[0];
  if (!pending || pending.attempts >= OTP_MAX_ATTEMPTS) return invalid();

  if (!(await bcrypt.compare(String(otp), pending.otp_hash))) {
    await pool.query('UPDATE login_otps SET attempts = attempts + 1 WHERE id = $1', [pending.id]);
    return invalid();
  }
  // Claimed atomically so one code can't be spent twice by concurrent requests.
  const claimed = await pool.query(
    'UPDATE login_otps SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
    [pending.id]
  );
  if (!claimed.rows[0]) return invalid();
  res.json({ token: signToken(user) });
}

/**
 * Lightweight auth check the app calls before a purchase action.
 *
 * Returns { authenticated: true, user: { … } } when the caller has a valid,
 * non-revoked token, and { authenticated: false } otherwise. A 200 is always
 * returned — the caller decides what to do with the answer (redirect to login,
 * show a prompt, etc.).
 */
async function checkAuthStatus(req, res) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.json({ authenticated: false, message: 'Please login to continue your purchase.' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const { rows } = await pool.query(
      `SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`,
      [payload.id]
    );
    const user = rows[0];
    if (!user) {
      return res.json({ authenticated: false, message: 'Please login to continue your purchase.' });
    }
    if (payload.tokenVersion !== undefined && user.token_version !== payload.tokenVersion) {
      return res.json({ authenticated: false, message: 'Session expired. Please login again.' });
    }
    res.json({ authenticated: true, user: toProfile(user) });
  } catch {
    res.json({ authenticated: false, message: 'Please login to continue your purchase.' });
  }
}

/**
 * Changes the password while signed in. Every other session is revoked, and a
 * fresh token comes back so the device that made the change stays signed in.
 */
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ message: 'Current password and a new password of 8+ characters are required' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ message: 'New password must be different from the current one' });
  }
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ message: 'User not found' });
  if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
    return res.status(401).json({ message: 'Current password is incorrect' });
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await pool.query(
    'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING *',
    [passwordHash, req.user.id]
  );
  res.json({ message: 'Password changed', token: signToken(updated.rows[0]) });
}

const OPEN_ORDER_STATUSES = ['pending', 'confirmed', 'packed', 'out_for_delivery'];

/**
 * Deletes the caller's account, as the app stores require.
 *
 * Anonymized rather than removed: orders and payments reference the user and
 * must survive for the shops' and the platform's records (payments even block
 * a hard delete). Personal data is wiped, the login is made unusable, and the
 * person's private data (cart, wishlist, devices) and scrubs saved addresses is deleted.
 *
 * Customers only: a vendor or admin account owns live catalogue and settlement
 * data that has to be wound down by staff first.
 */
async function deleteMe(req, res) {
  const { password } = req.body || {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ message: 'Password is required to delete your account' });
  }
  const { rows } = await pool.query('SELECT id, role, password_hash FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (user.role !== 'customer') {
    return res.status(403).json({ message: 'Please contact support to close this account' });
  }
  if (!(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ message: 'Password is incorrect' });
  }
  const { rows: open } = await pool.query(
    'SELECT 1 FROM orders WHERE user_id = $1 AND status = ANY($2) LIMIT 1',
    [user.id, OPEN_ORDER_STATUSES]
  );
  if (open[0]) {
    return res.status(409).json({ message: 'You have orders in progress. Delete your account once they are delivered or cancelled.' });
  }

  const { rows: wallet } = await pool.query(
    'SELECT 1 FROM customer_wallets WHERE user_id = $1 AND balance_cents > 0',
    [user.id]
  );
  if (wallet[0]) {
    return res.status(409).json({ message: 'You still have money in your wallet. Please contact support to withdraw it before deleting your account.' });
  }

  const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of ['carts', 'wishlist_items', 'notifications', 'device_tokens', 'login_otps', 'password_reset_tokens']) {
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [user.id]);
    }
    // Past orders still point at these rows, so they are scrubbed and retired
    // rather than deleted. City, state and pincode stay for regional reporting.
    await client.query(
      `UPDATE addresses
          SET receiver_name = 'Deleted user', mobile_number = '', house_building = '',
              street = NULL, area = NULL, landmark = NULL, latitude = NULL, longitude = NULL,
              is_active = false, is_default = false, updated_at = now()
        WHERE user_id = $1`,
      [user.id]
    );
    await client.query(
      `UPDATE users
          SET full_name = NULL, phone_number = NULL,
              email = $2, password_hash = $3,
              token_version = token_version + 1
        WHERE id = $1`,
      [user.id, `deleted-${user.id}@deleted.invalid`, unusableHash]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ message: 'Your account has been deleted' });
}

module.exports = { deleteMe, changePassword, sendLoginOtp, verifyLoginOtp, checkAuthStatus, signup, login, forgotPassword, resetPassword, getMe, updateMe, logout, refresh };
