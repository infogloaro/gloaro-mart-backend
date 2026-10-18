const pool = require('../config/db');
const { actionFor, platformModuleKey, isPlatformPermission } = require('../services/permissions');

/**
 * Access to the Platform Registry for staff who are not super admin.
 *
 * The permission is per category (platform_<slug>.view|edit|delete) and the
 * category is not in the path, so it is looked up: from the platform being
 * touched, or from categoryId when one is being created or moved. Called by
 * requirePermission for the registry's path segments, never mounted on its own,
 * so a registry route can't be reached without passing through here.
 *
 * Categories themselves (create, rename, hide, delete) stay super admin only:
 * they define the permission modules, and a role able to add one could grant
 * itself a new area.
 */

const SEGMENTS = new Set(['platforms', 'platform-categories', 'platform-connectors', 'platform-health']);

/** Category slugs the staff member may view platforms in. */
function viewableCategorySlugs(staff) {
  const slugs = new Set();
  for (const key of staff.permissions) {
    const m = /^platform_(.+)\.view$/.exec(key);
    if (m) slugs.add(m[1]);
  }
  return slugs;
}

const holdsAny = (staff, action) =>
  [...staff.permissions].some((k) => isPlatformPermission(k) && k.endsWith(`.${action}`));

function refuse(res, message) {
  return res.status(403).json({ message });
}

async function categorySlugById(id) {
  const { rows } = await pool.query('SELECT slug FROM platform_categories WHERE id = $1', [Number(id)]);
  return rows[0]?.slug ?? null;
}

async function guardPlatformRegistry(req, res, next, staff) {
  const [segment, id, ...rest] = req.path.split('/').filter(Boolean);

  // The built-in connectors, and the health overview (filtered per category in
  // its controller): read-only, open to anyone who can view a category.
  if (segment === 'platform-connectors' || segment === 'platform-health') {
    return req.method === 'GET' && holdsAny(staff, 'view')
      ? next()
      : refuse(res, 'Your role has no access to the Platform Registry.');
  }

  if (segment === 'platform-categories') {
    if (req.method === 'GET' && holdsAny(staff, 'view')) return next();
    if (req.method === 'GET') return refuse(res, 'Your role has no access to the Platform Registry.');
    return refuse(res, 'Only a super admin can add or change Platform Registry categories.');
  }

  // /platforms — the list is filtered to what the role may see.
  if (!id) {
    if (req.method === 'GET') {
      return holdsAny(staff, 'view') ? next() : refuse(res, 'Your role has no access to the Platform Registry.');
    }
    if (req.method === 'POST') {
      const slug = await categorySlugById(req.body?.categoryId);
      if (!slug) return next(); // the controller answers "must be an existing category"
      const needed = `${platformModuleKey(slug)}.edit`;
      return staff.permissions.has(needed) ? next() : refuse(res, `Your role does not include '${needed}'.`);
    }
    return refuse(res, 'Not allowed.');
  }

  // /platforms/uploads — logo upload while editing any platform the role may edit.
  if (id === 'uploads') {
    return holdsAny(staff, 'edit') ? next() : refuse(res, 'Your role cannot edit any Platform Registry category.');
  }

  // /platforms/:id[/...]
  const { rows } = await pool.query(
    `SELECT c.slug FROM platforms p JOIN platform_categories c ON c.id = p.category_id WHERE p.id = $1`,
    [Number(id)],
  );
  if (!rows[0]) return next(); // the controller answers 404
  // Deleting the platform needs delete; everything else under it is a read or a change.
  const action = rest.length === 0 && req.method === 'DELETE' ? 'delete' : actionFor(req.method);
  const needed = `${platformModuleKey(rows[0].slug)}.${action}`;
  if (!staff.permissions.has(needed)) return refuse(res, `Your role does not include '${needed}'.`);

  // Moving a platform to another category needs edit there too.
  if (req.body?.categoryId !== undefined && rest.length === 0) {
    const target = await categorySlugById(req.body.categoryId);
    const neededThere = target && `${platformModuleKey(target)}.edit`;
    if (neededThere && !staff.permissions.has(neededThere)) {
      return refuse(res, `Your role does not include '${neededThere}'.`);
    }
  }
  next();
}

module.exports = { SEGMENTS, guardPlatformRegistry, viewableCategorySlugs };
