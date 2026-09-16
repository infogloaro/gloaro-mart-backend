const pool = require('../config/db');

/**
 * Vendor ownership guards.
 * Contracts per documents/SPRINT_8_VENDOR_PORTAL_SPEC.md §3.
 *
 * The Sprint 4 catalogue and inventory controllers already do everything a
 * vendor needs. The one thing they do not do is check who is asking, because
 * until now only admins could reach them.
 *
 * These guards sit in front of those same controllers rather than beside a
 * second copy of them. Two implementations would drift: the day someone fixes a
 * variant validation rule for admins, vendors would keep the bug.
 *
 * Every refusal is a 404, never a 403. Telling a vendor that product 91 exists
 * but belongs to someone else leaks the shape of the catalogue; telling them it
 * does not exist for them is both true and quiet.
 */

/** The vendor profile behind the signed-in user, or null. */
async function vendorProfileId(userId) {
  const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [userId]);
  return rows[0]?.id ?? null;
}

/**
 * Resolves req.vendorId once per request.
 *
 * Mounted on the whole vendor router, so no handler below has to remember to
 * look it up — forgetting that lookup is exactly how an ownership check gets
 * silently skipped.
 */
async function attachVendor(req, res, next) {
  const id = await vendorProfileId(req.user.id);
  if (!id) return res.status(404).json({ message: 'Vendor profile not found' });
  req.vendorId = id;
  next();
}

/** Refuses a product that is not this vendor's. */
async function requireOwnedProduct(req, res, next) {
  const { rows } = await pool.query('SELECT vendor_id FROM products WHERE id = $1', [req.params.id]);
  if (!rows[0] || rows[0].vendor_id !== req.vendorId) {
    return res.status(404).json({ message: 'Product not found' });
  }
  next();
}

/**
 * Refuses an inventory row that is not this vendor's.
 *
 * Checks inventory.vendor_id rather than joining back through the product: the
 * column is the stock's own owner, and a row whose product moved shops should
 * follow the product's vendor_id, not a stale copy.
 */
async function requireOwnedInventory(req, res, next) {
  const { rows } = await pool.query(
    `SELECT i.vendor_id FROM inventory i
     JOIN products p ON p.id = i.product_id
     WHERE i.id = $1 AND p.vendor_id = i.vendor_id`,
    [req.params.id]
  );
  if (!rows[0] || rows[0].vendor_id !== req.vendorId) {
    return res.status(404).json({ message: 'Inventory row not found' });
  }
  next();
}

/** Refuses a media row whose product is not this vendor's. */
async function requireOwnedMedia(req, res, next) {
  const { rows } = await pool.query(
    `SELECT p.vendor_id FROM product_media m
     JOIN products p ON p.id = m.product_id
     WHERE m.id = $1`,
    [req.params.id]
  );
  if (!rows[0] || rows[0].vendor_id !== req.vendorId) {
    return res.status(404).json({ message: 'Media not found' });
  }
  next();
}

module.exports = {
  vendorProfileId,
  attachVendor,
  requireOwnedProduct,
  requireOwnedInventory,
  requireOwnedMedia,
};
