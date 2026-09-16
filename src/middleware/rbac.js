const pool = require('../config/db');
const { SUPER_ADMIN, expand, requiredFor, actionFor } = require('../services/permissions');

/**
 * The second gate behind requireRole('admin').
 *
 * requireRole decides who may reach the admin API at all; this decides what they
 * may do once there. Mounted once on the admin router rather than repeated per
 * route, so a route added later is covered by the prefix rule automatically
 * instead of shipping unguarded because someone forgot a decorator.
 */

/** Loads a staff member's role and the permissions it holds. */
async function loadStaffContext(userId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.slug, r.name,
            COALESCE(ARRAY_AGG(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
     FROM users u
     LEFT JOIN staff_roles r ON r.id = u.staff_role_id
     LEFT JOIN staff_role_permissions p ON p.role_id = r.id
     WHERE u.id = $1
     GROUP BY r.id, r.slug, r.name`,
    [userId]
  );

  const row = rows[0];
  if (!row || !row.slug) return { role: null, isSuperAdmin: false, permissions: new Set() };

  return {
    role: { id: row.id, slug: row.slug, name: row.name },
    // Super admin is a property of the role, not a list of grants. Enumerating
    // its permissions in the table would mean topping that table up every time a
    // new key is added in code, and missing one would silently demote them.
    isSuperAdmin: row.slug === SUPER_ADMIN,
    permissions: expand(row.permissions),
  };
}

/** Attaches req.staff and refuses requests the role does not cover. */
async function requirePermission(req, res, next) {
  try {
    const staff = await loadStaffContext(req.user.id);
    req.staff = staff;

    if (staff.isSuperAdmin) return next();

    if (!staff.role) {
      return res.status(403).json({
        message: 'Your account has no staff role, so it cannot use the admin panel yet. Ask a super admin to assign one.',
      });
    }

    const needed = requiredFor(req.method, req.path);
    if (!needed) {
      // Unmapped path: fail closed. An admin route with no rule is an oversight,
      // and guessing in favour of access is how a support login ends up able to
      // change settings.
      return res.status(403).json({ message: 'This area is restricted to super admins.' });
    }

    if (!staff.permissions.has(needed)) {
      return res.status(403).json({ message: `Your role does not include '${needed}'.` });
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * The same gate for a module whose routes live outside the /api/admin router,
 * where there is no path prefix to match on. The module is named outright and
 * the action still comes from the method, so one line guards a whole router.
 */
function requirePermissionFor(moduleKey) {
  return async function guard(req, res, next) {
    try {
      const staff = await loadStaffContext(req.user.id);
      req.staff = staff;

      if (staff.isSuperAdmin) return next();

      if (!staff.role) {
        return res.status(403).json({
          message:
            'Your account has no staff role, so it cannot use the admin panel yet. Ask a super admin to assign one.',
        });
      }

      const needed = `${moduleKey}.${actionFor(req.method)}`;
      if (!staff.permissions.has(needed)) {
        return res.status(403).json({ message: `Your role does not include '${needed}'.` });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requirePermission, requirePermissionFor, loadStaffContext };
