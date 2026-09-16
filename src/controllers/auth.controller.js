const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../middleware/auth');

const VALID_ROLES = ['customer', 'vendor'];

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
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, tokenVersion: user.token_version },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token });
}

async function forgotPassword(req, res) {
  const { email } = req.body || {};
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );
  }
  // Always respond the same way whether or not the email exists, to avoid leaking account existence.
  res.json({ message: 'If that email exists, a reset link has been sent' });
}

module.exports = { signup, login, forgotPassword };
