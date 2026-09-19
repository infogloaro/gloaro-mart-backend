const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const { PERMISSIONS, PERMISSION_KEYS, SUPER_ADMIN } = require('../services/permissions');
const { loadStaffContext } = require('../middleware/rbac');
const { revokeSessions } = require('../services/sessions');
const { sendMail } = require('../services/mailer');

const NOTICE_EMAIL = 'infogloaro@gmail.com';
const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * Staff accounts and the roles they hold.
 *
 * The guard rails here all protect one thing: that somebody is always able to
 * administer the platform. Every refusal below is a way the last super admin
 * could otherwise be removed by accident.
 */

const SELECT_STAFF = `
  SELECT u.id, u.full_name, u.email, u.phone_number, u.created_at,
         r.id AS role_id, r.slug AS role_slug, r.name AS role_name
  FROM users u
  LEFT JOIN staff_roles r ON r.id = u.staff_role_id
  WHERE u.role = 'admin'`;

/** What the signed-in admin may do — the panel hides menus from this. */
async function getMe(req, res) {
  const staff = req.staff ?? (await loadStaffContext(req.user.id));
  res.json({
    userId: req.user.id,
    email: req.user.email,
    role: staff.role,
    isSuperAdmin: staff.isSuperAdmin,
    // A super admin holds everything by definition, so send the full list rather
    // than an empty one the panel would read as "no access".
    permissions: staff.isSuperAdmin ? PERMISSIONS.map((p) => p.key) : [...staff.permissions],
  });
}

function listPermissions(req, res) {
  res.json(PERMISSIONS);
}

async function listRoles(req, res) {
  const { rows } = await pool.query(
    `SELECT r.*,
            COALESCE(ARRAY_AGG(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions,
            (SELECT COUNT(*)::int FROM users u WHERE u.staff_role_id = r.id) AS member_count
     FROM staff_roles r
     LEFT JOIN staff_role_permissions p ON p.role_id = r.id
     GROUP BY r.id
     ORDER BY r.is_system DESC, r.name ASC`
  );
  res.json(rows);
}

function validatePermissions(list) {
  if (!Array.isArray(list)) return 'permissions must be a list';
  const unknown = list.filter((p) => !PERMISSION_KEYS.has(p));
  if (unknown.length > 0) return `Unknown permission: ${unknown.join(', ')}`;
  return null;
}

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function createRole(req, res) {
  const { name, description, permissions = [] } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ message: 'A role name is required' });

  const error = validatePermissions(permissions);
  if (error) return res.status(400).json({ message: error });

  const slug = slugify(name);
  if (slug === SUPER_ADMIN) {
    return res.status(400).json({ message: 'That name is reserved for the built-in super admin role.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO staff_roles (name, slug, description) VALUES ($1, $2, $3) RETURNING id`,
      [name.trim(), slug, description?.trim() || null]
    );
    for (const permission of permissions) {
      await client.query('INSERT INTO staff_role_permissions (role_id, permission) VALUES ($1, $2)', [
        rows[0].id,
        permission,
      ]);
    }
    await client.query('COMMIT');
    res.status(201).json({ id: rows[0].id, slug });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ message: 'A role with that name already exists.' });
    throw err;
  } finally {
    client.release();
  }
}

async function updateRole(req, res) {
  const { name, description, permissions } = req.body || {};
  if (permissions !== undefined) {
    const error = validatePermissions(permissions);
    if (error) return res.status(400).json({ message: error });
  }

  const { rows: existing } = await pool.query('SELECT * FROM staff_roles WHERE id = $1', [req.params.id]);
  const role = existing[0];
  if (!role) return res.status(404).json({ message: 'Role not found' });

  // Super admin is defined by its slug in code, so editing its permission list
  // would have no effect — refusing is more honest than accepting a no-op.
  if (role.is_system && permissions !== undefined) {
    return res.status(400).json({ message: 'The super admin role always has every permission and cannot be restricted.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE staff_roles SET name = COALESCE($2, name), description = COALESCE($3, description),
              updated_at = now() WHERE id = $1`,
      [role.id, name?.trim() ?? null, description?.trim() ?? null]
    );

    if (permissions !== undefined) {
      // Replace rather than diff: the request carries the whole intended set, so
      // a permission missing from it is a revocation.
      await client.query('DELETE FROM staff_role_permissions WHERE role_id = $1', [role.id]);
      for (const permission of permissions) {
        await client.query('INSERT INTO staff_role_permissions (role_id, permission) VALUES ($1, $2)', [
          role.id,
          permission,
        ]);
      }
    }

    await client.query('COMMIT');
    res.json({ id: role.id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteRole(req, res) {
  const { rows } = await pool.query('SELECT * FROM staff_roles WHERE id = $1', [req.params.id]);
  const role = rows[0];
  if (!role) return res.status(404).json({ message: 'Role not found' });
  if (role.is_system) {
    return res.status(400).json({ message: 'The super admin role cannot be deleted.' });
  }

  const { rows: members } = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE staff_role_id = $1', [role.id]);
  if (members[0].n > 0) {
    return res.status(409).json({
      message: `${members[0].n} staff member${members[0].n === 1 ? ' still holds' : 's still hold'} this role. Move them first.`,
    });
  }

  await pool.query('DELETE FROM staff_roles WHERE id = $1', [role.id]);
  res.status(204).end();
}

async function listStaff(req, res) {
  const { rows } = await pool.query(`${SELECT_STAFF} ORDER BY u.created_at ASC`);
  res.json(rows);
}

/** Promotes an existing user, or creates one outright. */
async function createStaff(req, res) {
  const { email, fullName, password, roleId } = req.body || {};
  if (!email?.trim()) return res.status(400).json({ message: 'An email is required' });

  const roleIdNum = roleId ? Number(roleId) : null;
  if (roleIdNum) {
    const { rows } = await pool.query('SELECT 1 FROM staff_roles WHERE id = $1', [roleIdNum]);
    if (!rows[0]) return res.status(400).json({ message: 'That role does not exist' });
  }

  const { rows: existing } = await pool.query('SELECT id, role FROM users WHERE email = $1', [email.trim()]);

  if (existing[0]) {
    // Promotion path: the account already exists, so its password is its own
    // business and is deliberately left alone.
    await pool.query(`UPDATE users SET role = 'admin', staff_role_id = $2 WHERE id = $1`, [existing[0].id, roleIdNum]);
    const { rows } = await pool.query(`${SELECT_STAFF} AND u.id = $1`, [existing[0].id]);
    return res.status(200).json(rows[0]);
  }

  if (!password || String(password).length < 8) {
    return res.status(400).json({ message: 'A password of at least 8 characters is required for a new account' });
  }
  if (!fullName?.trim()) return res.status(400).json({ message: 'A name is required for a new account' });

  const hash = await bcrypt.hash(String(password), 10);
  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, password_hash, role, staff_role_id)
     VALUES ($1, $2, $3, 'admin', $4) RETURNING id`,
    [fullName.trim(), email.trim(), hash, roleIdNum]
  );
  const { rows: created } = await pool.query(`${SELECT_STAFF} AND u.id = $1`, [rows[0].id]);
  res.status(201).json(created[0]);
}

/** Guards the one thing that must stay true: somebody can still administer. */
async function assertNotLastSuperAdmin(userId, { message }) {
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
     JOIN staff_roles r ON r.id = u.staff_role_id
     WHERE r.slug = $1 AND u.role = 'admin'`,
    [SUPER_ADMIN]
  );
  const supers = rows.map((r) => r.id);
  if (supers.length === 1 && supers[0] === Number(userId)) {
    const err = new Error(message);
    err.status = 400;
    throw err;
  }
}

async function updateStaff(req, res) {
  const { roleId } = req.body || {};
  const targetId = Number(req.params.id);

  const { rows: target } = await pool.query(`${SELECT_STAFF} AND u.id = $1`, [targetId]);
  if (!target[0]) return res.status(404).json({ message: 'Staff member not found' });

  const roleIdNum = roleId == null || roleId === '' ? null : Number(roleId);

  // The lock-out guard throws rather than returns, so that it reads as one line
  // at each call site. Caught here and turned into its own status — without
  // this it reaches the global handler and the operator is told 'Internal
  // server error' for what is really a deliberate, explainable refusal.
  try {
    if (roleIdNum) {
      const { rows } = await pool.query('SELECT slug FROM staff_roles WHERE id = $1', [roleIdNum]);
      if (!rows[0]) return res.status(400).json({ message: 'That role does not exist' });

      if (rows[0].slug !== SUPER_ADMIN) {
        await assertNotLastSuperAdmin(targetId, {
          message: 'This is the only super admin. Give somebody else that role before changing this one.',
        });
      }
    } else {
      await assertNotLastSuperAdmin(targetId, {
        message: 'This is the only super admin. Give somebody else that role before removing this one.',
      });
    }
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }

  await pool.query('UPDATE users SET staff_role_id = $2 WHERE id = $1', [targetId, roleIdNum]);
  const { rows } = await pool.query(`${SELECT_STAFF} AND u.id = $1`, [targetId]);
  res.json(rows[0]);
}

/** Revokes admin access. The account survives as a customer. */
async function revokeStaff(req, res) {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ message: 'You cannot revoke your own admin access.' });
  }

  const { rows: target } = await pool.query(`${SELECT_STAFF} AND u.id = $1`, [targetId]);
  if (!target[0]) return res.status(404).json({ message: 'Staff member not found' });

  try {
    await assertNotLastSuperAdmin(targetId, {
      message: 'This is the only super admin. Give somebody else that role first.',
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  }

  await pool.query(`UPDATE users SET role = 'customer', staff_role_id = NULL WHERE id = $1`, [targetId]);
  // A revoked admin's existing token still says role: 'admin' — that field is
  // baked into the JWT from login and is never rechecked against the users
  // table. Without this, someone just revoked would keep the panel open until
  // their token expired on its own, up to 7 days later.
  await revokeSessions(targetId);
  res.status(204).end();
}

/** Sets a staff member's password and ends every session already open on the account. */
async function resetStaffPassword(req, res) {
  const targetId = Number(req.params.id);
  const { password } = req.body || {};
  if (!password || String(password).length < 8) {
    return res.status(400).json({ message: 'A password of at least 8 characters is required.' });
  }

  const { rows } = await pool.query(`${SELECT_STAFF} AND u.id = $1`, [targetId]);
  if (!rows[0]) return res.status(404).json({ message: 'Staff member not found' });

  const hash = await bcrypt.hash(String(password), 10);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [targetId, hash]);
  // The whole point of a super admin resetting someone's password is usually
  // "get them out now" — a compromised account, an offboarding, a mistake.
  // Leaving their old token valid until it expires would defeat that.
  await revokeSessions(targetId);
  res.status(204).end();
}

/**
 * Step 1 of a signed-in admin's own password change: verify the current
 * password, stage the new one (hashed) against a one-time code, and mail
 * that code to the company inbox rather than the admin themself — the point
 * is a second party has to see it before the change takes effect.
 */
async function requestMyPasswordOtp(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ message: 'A new password of at least 8 characters is required.' });
  }
  if (!currentPassword) {
    return res.status(400).json({ message: 'Enter your current password.' });
  }

  const { rows } = await pool.query('SELECT email, password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Account not found' });

  const matches = await bcrypt.compare(String(currentPassword), rows[0].password_hash);
  if (!matches) return res.status(400).json({ message: 'Current password is incorrect.' });

  const otp = crypto.randomInt(100000, 1000000).toString();
  const [otpHash, newPasswordHash] = await Promise.all([
    bcrypt.hash(otp, 10),
    bcrypt.hash(String(newPassword), 10),
  ]);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  // Mailed before the code is staged: an OTP nobody can read is worse than no
  // OTP at all, because the next attempt would then find a pending row and the
  // operator would be chasing a code that never arrived.
  try {
    await sendMail({
      to: NOTICE_EMAIL,
      subject: 'Gloaro Mart admin — password change OTP',
      text: `${rows[0].email} requested a password change on the Gloaro Mart admin console.\n\nOTP: ${otp}\n\nThis code expires in 10 minutes. Ignore this email if you did not expect it.`,
    });
  } catch (err) {
    console.error('[mail] OTP send failed:', err.message);
    return res.status(502).json({
      message: `Could not email the OTP to ${NOTICE_EMAIL}. The password was not changed. Check the mail settings and try again.`,
    });
  }

  await pool.query(
    `INSERT INTO admin_password_otps (user_id, otp_hash, new_password_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [req.user.id, otpHash, newPasswordHash, expiresAt]
  );

  res.status(202).json({ message: `OTP sent to ${NOTICE_EMAIL}. Enter it below within 10 minutes.` });
}

/** Step 2: the OTP mailed out above confirms the change and ends every session, including this one. */
async function confirmMyPasswordOtp(req, res) {
  const { otp } = req.body || {};
  if (!otp) return res.status(400).json({ message: 'Enter the OTP.' });

  const { rows } = await pool.query(
    `SELECT id, otp_hash, new_password_hash FROM admin_password_otps
     WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.id]
  );
  const pending = rows[0];
  if (!pending) {
    return res.status(400).json({ message: 'No pending request or the OTP has expired. Start again.' });
  }

  const matches = await bcrypt.compare(String(otp), pending.otp_hash);
  if (!matches) return res.status(400).json({ message: 'Incorrect OTP.' });

  const { rows: userRows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);

  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, pending.new_password_hash]);
  await pool.query('UPDATE admin_password_otps SET consumed_at = NOW() WHERE id = $1', [pending.id]);
  await revokeSessions(req.user.id);

  // The password is already changed by this point, so a failed courtesy notice
  // must not report failure — telling the operator it went wrong would send
  // them back to the old password that no longer works.
  try {
    await sendMail({
      to: NOTICE_EMAIL,
      subject: 'Gloaro Mart admin — password changed',
      text: `The password for ${userRows[0]?.email ?? 'an admin account'} was just changed on the Gloaro Mart admin console. All of that account's sessions have been signed out.`,
    });
  } catch (err) {
    console.error('[mail] password-changed notice failed:', err.message);
  }

  res.status(204).end();
}

module.exports = {
  getMe,
  requestMyPasswordOtp,
  confirmMyPasswordOtp,
  listPermissions,
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  listStaff,
  createStaff,
  updateStaff,
  revokeStaff,
  resetStaffPassword,
};
