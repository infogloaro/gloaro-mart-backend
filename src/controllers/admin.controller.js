const pool = require('../config/db');
const { STATUS_FLOW, recordStatusChange } = require('./order.controller');
const { creditWalletForOrder } = require('./wallet.controller');
const { settleCodForOrder } = require('./payment.controller');
const { attachTiers } = require('./product.controller');
const { settleStockForOrder, setSimpleStock } = require('../services/inventory');
const { bumpMetrics, metricsForTransition } = require('../services/matching');
const { recordAudit } = require('../services/auditLog');

const ALL_ORDER_STATUSES = [...STATUS_FLOW, 'cancelled'];
const USER_ROLES = ['customer', 'vendor', 'admin'];

// Paged list endpoints return { items, total, page, pageSize } rather than a bare
// array, so the admin UI can page instead of silently truncating at a hard LIMIT.
function parsePaging(req, defaultPageSize = 25) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// ── Users ──

async function listUsers(req, res) {
  const { role, q } = req.query;
  const { page, pageSize, offset } = parsePaging(req);
  const conditions = [];
  const params = [];
  if (role) {
    params.push(role);
    conditions.push(`role = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(email ILIKE $${params.length} OR full_name ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM users ${where}`, params);
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone_number, role, created_at FROM users ${where}
     ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  res.json({ items: rows, total: countRows[0].total, page, pageSize });
}

async function updateUserRole(req, res) {
  const { role } = req.body || {};
  if (!USER_ROLES.includes(role)) {
    return res.status(400).json({ message: `role must be one of ${USER_ROLES.join(', ')}` });
  }
  // Without this an admin can strip their own access and lock themselves out.
  if (Number(req.params.id) === req.user.id && role !== 'admin') {
    return res.status(400).json({ message: 'You cannot change your own role' });
  }

  const { rows: beforeRows } = await pool.query('SELECT id, full_name, email, role FROM users WHERE id = $1', [req.params.id]);
  if (!beforeRows[0]) return res.status(404).json({ message: 'User not found' });
  const { rows } = await pool.query(
    'UPDATE users SET role = $2 WHERE id = $1 RETURNING id, full_name, email, phone_number, role, created_at',
    [req.params.id, role]
  );
  if (!rows[0]) return res.status(404).json({ message: 'User not found' });
  await recordAudit({
    actorUserId: req.user.id,
    action: 'user.role_changed',
    module: 'customers',
    entityType: 'user',
    entityId: rows[0].id,
    previousValue: { role: beforeRows[0].role },
    newValue: { role: rows[0].role },
  });
  res.json(rows[0]);
}

async function getUser(req, res) {
  const { rows } = await pool.query(
    'SELECT id, full_name, email, phone_number, role, created_at FROM users WHERE id = $1',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'User not found' });
  const { rows: vendorRows } = await pool.query('SELECT * FROM vendor_profiles WHERE user_id = $1', [req.params.id]);
  res.json({ ...rows[0], vendorProfile: vendorRows[0] || null });
}

// ── Vendor approval ──

async function listVendors(req, res) {
  const { status } = req.query;
  const { rows } = await pool.query(
    `SELECT vp.*, u.email, u.full_name
     FROM vendor_profiles vp
     JOIN users u ON u.id = vp.user_id
     WHERE ($1::text IS NULL OR vp.status = $1)
     ORDER BY vp.created_at DESC`,
    [status || null]
  );
  res.json(rows);
}

async function updateVendorStatus(req, res) {
  const { status } = req.body || {};
  if (!['approved', 'rejected', 'suspended'].includes(status)) {
    return res.status(400).json({ message: "status must be 'approved', 'rejected', or 'suspended'" });
  }
  const { rows: beforeRows } = await pool.query('SELECT id, status FROM vendor_profiles WHERE id = $1', [req.params.id]);
  if (!beforeRows[0]) return res.status(404).json({ message: 'Vendor not found' });
  const { rows } = await pool.query('UPDATE vendor_profiles SET status = $2 WHERE id = $1 RETURNING *', [
    req.params.id,
    status,
  ]);
  if (!rows[0]) return res.status(404).json({ message: 'Vendor not found' });
  await recordAudit({
    actorUserId: req.user.id,
    action: 'vendor.status_changed',
    module: 'vendors',
    entityType: 'vendor',
    entityId: rows[0].id,
    previousValue: { status: beforeRows[0].status },
    newValue: { status: rows[0].status },
  });
  res.json(rows[0]);
}

async function updateVendor(req, res) {
  const { businessName, businessType, gstNumber, addressLine, city, state, pincode, latitude, longitude } =
    req.body || {};
  if (businessType && !['b2b', 'b2c', 'both'].includes(businessType)) {
    return res.status(400).json({ message: "businessType must be 'b2b', 'b2c', or 'both'" });
  }
  // The map pin decides whether a shop is visible at all: nearby search skips
  // vendors with a null latitude, so a wrong or missing pin hides the shop from
  // every customer. Admins must be able to correct it.
  if (latitude != null && (Number.isNaN(Number(latitude)) || Number(latitude) < -90 || Number(latitude) > 90)) {
    return res.status(400).json({ message: 'latitude must be between -90 and 90' });
  }
  if (longitude != null && (Number.isNaN(Number(longitude)) || Number(longitude) < -180 || Number(longitude) > 180)) {
    return res.status(400).json({ message: 'longitude must be between -180 and 180' });
  }
  if ((latitude == null) !== (longitude == null)) {
    return res.status(400).json({ message: 'latitude and longitude must be set together' });
  }
  const { rows } = await pool.query(
    `UPDATE vendor_profiles SET
      business_name = COALESCE($2, business_name),
      business_type = COALESCE($3, business_type),
      gst_number = COALESCE($4, gst_number),
      address_line = COALESCE($5, address_line),
      city = COALESCE($6, city),
      state = COALESCE($7, state),
      pincode = COALESCE($8, pincode),
      latitude = COALESCE($9, latitude),
      longitude = COALESCE($10, longitude)
     WHERE id = $1 RETURNING *`,
    [req.params.id, businessName, businessType, gstNumber, addressLine, city, state, pincode, latitude, longitude]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Vendor not found' });
  res.json(rows[0]);
}

// ── Orders (read-only, platform-wide) ──

async function listAllOrders(req, res) {
  const { status, vendorId, userId, from, to, city, q, groupRef } = req.query;
  const { page, pageSize, offset } = parsePaging(req);
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  }
  if (vendorId) {
    params.push(vendorId);
    conditions.push(`o.vendor_id = $${params.length}`);
  }
  if (userId) {
    params.push(userId);
    conditions.push(`o.user_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`o.created_at >= $${params.length}`);
  }
  if (to) {
    // Inclusive of the whole end day, so picking today returns today's orders.
    params.push(to);
    conditions.push(`o.created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  if (city) {
    params.push(city);
    conditions.push(`vp.city ILIKE $${params.length}`);
  }
  // Every order in one purchase, found from any one of their references.
  if (groupRef) {
    params.push(`%${groupRef}%`);
    conditions.push(`cg.reference ILIKE $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const like = `$${params.length}`;
    // Order number, group reference, customer or shop — one box for whatever
    // ops has to hand, including a GLM- reference pasted from a support ticket.
    conditions.push(
      `(u.full_name ILIKE ${like} OR u.email ILIKE ${like} OR vp.business_name ILIKE ${like}
        OR CAST(o.id AS TEXT) ILIKE ${like} OR cg.reference ILIKE ${like})`
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const joins = `JOIN users u ON u.id = o.user_id
     JOIN vendor_profiles vp ON vp.id = o.vendor_id
     LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id`;

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM orders o ${joins} ${where}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT o.*, u.full_name AS customer_name, u.email AS customer_email,
            vp.business_name AS vendor_name, vp.city AS vendor_city,
            cg.reference AS checkout_group_reference,
            (SELECT COUNT(*)::int FROM orders sib WHERE sib.checkout_group_id = o.checkout_group_id)
              AS checkout_group_order_count
     FROM orders o
     ${joins}
     ${where}
     ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  res.json({ items: rows, total: countRows[0].total, page, pageSize });
}

async function getAnyOrder(req, res) {
  const { rows } = await pool.query(
    `SELECT o.*, u.full_name AS customer_name, u.email AS customer_email, u.phone_number AS customer_phone,
            vp.business_name AS vendor_name, vp.city AS vendor_city,
            cg.reference AS checkout_group_reference,
            (SELECT COUNT(*)::int FROM orders sib WHERE sib.checkout_group_id = o.checkout_group_id)
              AS checkout_group_order_count
     FROM orders o
     JOIN users u ON u.id = o.user_id
     JOIN vendor_profiles vp ON vp.id = o.vendor_id
     LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
     WHERE o.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Order not found' });

  const { rows: items } = await pool.query(
    'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC',
    [req.params.id]
  );
  res.json({ ...rows[0], items });
}

async function updateOrderStatus(req, res) {
  const { status, deliveryPartnerName, deliveryPartnerPhone, estimatedDeliveryAt } = req.body || {};
  if (!ALL_ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ message: `status must be one of ${ALL_ORDER_STATUSES.join(', ')}` });
  }
  // Ops assign the courier from the admin panel, the same fields the vendor
  // endpoint already sets — otherwise an order can reach 'out_for_delivery'
  // with no way for the customer to see who is bringing it.
  //
  // Update and history are one transaction, and the previous status is read
  // inside it — a concurrent vendor move would otherwise be logged as the
  // 'from' status of this one.
  const client = await pool.connect();
  let order;
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [
      req.params.id,
    ]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Order not found' });
    }
    const { rows } = await client.query(
      `UPDATE orders SET
        status = $2,
        delivery_partner_name = COALESCE($3, delivery_partner_name),
        delivery_partner_phone = COALESCE($4, delivery_partner_phone),
        estimated_delivery_at = COALESCE($5, estimated_delivery_at),
        updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, status, deliveryPartnerName || null, deliveryPartnerPhone || null, estimatedDeliveryAt || null]
    );
    order = rows[0];
    await recordStatusChange(client, {
      orderId: order.id,
      fromStatus: existing[0].status,
      toStatus: status,
      userId: req.user.id,
      actorRole: 'admin',
    });
    // The vendor is ranked on these whoever moved the status.
    const deltas = metricsForTransition(
      existing[0].status,
      status,
      (Date.now() - new Date(order.created_at).getTime()) / 60000
    );
    if (deltas) await bumpMetrics(client, order.vendor_id, deltas);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (status === 'delivered') {
    await creditWalletForOrder(order);
  }
  // Same rule as the vendor endpoint: a cancellation puts the stock back,
  // whether it was still held or already counted as sold.
  if (status === 'cancelled') {
    await settleStockForOrder(order.id, 'release', {
      userId: req.user.id,
      note: 'Order cancelled by an admin',
    });
  }
  if (status === 'delivered' || status === 'cancelled') {
    await settleCodForOrder(order.id);
  }
  res.json(order);
}

// ── Products (moderation, across all vendors) ──

async function listAllProducts(req, res) {
  const { vendorId, category, brandId, q, status } = req.query;
  const { page, pageSize, offset } = parsePaging(req);
  const conditions = [];
  const params = [];
  if (vendorId) {
    params.push(vendorId);
    conditions.push(`p.vendor_id = $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(`p.category = $${params.length}`);
  }
  if (brandId === 'none') {
    conditions.push('p.brand_id IS NULL');
  } else if (brandId) {
    params.push(brandId);
    conditions.push(`p.brand_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`p.name ILIKE $${params.length}`);
  }
  if (status === 'active' || status === 'inactive') {
    conditions.push(`p.is_active = ${status === 'active' ? 'true' : 'false'}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM products p JOIN vendor_profiles vp ON vp.id = p.vendor_id ${where}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT p.*, vp.business_name AS vendor_name, b.name AS brand_name
     FROM products p
     JOIN vendor_profiles vp ON vp.id = p.vendor_id
     LEFT JOIN brands b ON b.id = p.brand_id
     ${where}
     ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  res.json({ items: rows, total: countRows[0].total, page, pageSize });
}

async function getAnyProduct(req, res) {
  const { rows } = await pool.query(
    `SELECT p.*, vp.business_name AS vendor_name, b.name AS brand_name
     FROM products p
     JOIN vendor_profiles vp ON vp.id = p.vendor_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Product not found' });
  const [withTiers] = await attachTiers(rows);
  res.json(withTiers);
}

// Body key -> column, for the admin product writes below. Kept in one place so
// create and update accept exactly the same field names.
const PRODUCT_COLUMNS = {
  name: 'name',
  description: 'description',
  priceCents: 'price_cents',
  currency: 'currency',
  stockQuantity: 'stock_quantity',
  imageUrl: 'image_url',
  category: 'category',
  brandId: 'brand_id',
  isActive: 'is_active',
  gstRatePercent: 'gst_rate_percent',
  moq: 'moq',
};

// Only description, image_url, category and brand_id are nullable on products; sending an
// explicit null for anything else would violate the column's NOT NULL.
const NON_NULLABLE_PRODUCT_FIELDS = [
  'name',
  'priceCents',
  'currency',
  'stockQuantity',
  'isActive',
  'gstRatePercent',
  'moq',
];

// Returns an error string, or null when the supplied fields are all acceptable.
// Only validates keys that are actually present, so it serves PATCH as well as POST.
function validateProductFields(body) {
  for (const field of NON_NULLABLE_PRODUCT_FIELDS) {
    if (field in body && body[field] == null) {
      return `${field} cannot be null`;
    }
  }
  if ('currency' in body && (typeof body.currency !== 'string' || !body.currency.trim())) {
    return 'currency must be a non-empty string';
  }
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim())) {
    return 'name must be a non-empty string';
  }
  if ('priceCents' in body && (!Number.isInteger(body.priceCents) || body.priceCents < 0)) {
    return 'priceCents must be a non-negative integer';
  }
  if ('stockQuantity' in body && (!Number.isInteger(body.stockQuantity) || body.stockQuantity < 0)) {
    return 'stockQuantity must be a non-negative integer';
  }
  if (
    'gstRatePercent' in body &&
    (!Number.isFinite(Number(body.gstRatePercent)) || Number(body.gstRatePercent) < 0 || Number(body.gstRatePercent) > 100)
  ) {
    return 'gstRatePercent must be between 0 and 100';
  }
  if ('moq' in body && (!Number.isInteger(body.moq) || body.moq < 1)) {
    return 'moq must be an integer of at least 1';
  }
  if ('isActive' in body && typeof body.isActive !== 'boolean') {
    return 'isActive must be a boolean';
  }
  // null is allowed and means "unbranded" — anything else must be a real brand id.
  if ('brandId' in body && body.brandId !== null && (!Number.isInteger(body.brandId) || body.brandId < 1)) {
    return 'brandId must be a positive integer or null';
  }
  return null;
}

// The FK would raise a 23503 the error handler reports as a 500; check first so
// the admin gets a message that names the problem.
async function brandMissing(brandId) {
  if (brandId == null) return false;
  const { rows } = await pool.query('SELECT 1 FROM brands WHERE id = $1', [brandId]);
  return !rows[0];
}

async function createAnyProduct(req, res) {
  const body = req.body || {};
  const { vendorId } = body;
  if (!Number.isInteger(vendorId)) {
    return res.status(400).json({ message: 'vendorId is required' });
  }
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ message: 'name is required' });
  }
  if (!Number.isInteger(body.priceCents) || body.priceCents < 0) {
    return res.status(400).json({ message: 'a valid priceCents is required' });
  }
  const invalid = validateProductFields(body);
  if (invalid) return res.status(400).json({ message: invalid });

  const { rows: vendorRows } = await pool.query('SELECT business_name FROM vendor_profiles WHERE id = $1', [vendorId]);
  if (!vendorRows[0]) return res.status(404).json({ message: 'Vendor not found' });

  if (await brandMissing(body.brandId)) return res.status(404).json({ message: 'Brand not found' });

  // Product and stock row in one transaction, exactly as the vendor endpoint
  // does it — a product with no stock row cannot be reserved against.
  const client = await pool.connect();
  let product;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO products
         (vendor_id, name, description, price_cents, currency, stock_quantity, image_url, category, brand_id, is_active, gst_rate_percent, moq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        vendorId,
        body.name.trim(),
        body.description || null,
        body.priceCents,
        body.currency || 'INR',
        body.stockQuantity ?? 0,
        body.imageUrl || null,
        body.category || null,
        body.brandId ?? null,
        body.isActive ?? true,
        body.gstRatePercent ?? 0,
        body.moq ?? 1,
      ]
    );
    product = rows[0];
    await setSimpleStock(client, {
      productId: product.id,
      vendorId,
      targetQty: product.stock_quantity ?? 0,
      actorRole: 'admin',
      userId: req.user.id,
      note: 'Opening stock',
    });
    if (product.image_url && product.image_url.trim()) {
      await client.query(
        `INSERT INTO product_media (product_id, media_type, url, is_primary, sort_order)
         VALUES ($1, 'image', $2, true, 0)`,
        [product.id, product.image_url]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ ...product, vendor_name: vendorRows[0].business_name, tiers: [] });
}

async function updateAnyProduct(req, res) {
  const body = req.body || {};
  const invalid = validateProductFields(body);
  if (invalid) return res.status(400).json({ message: invalid });

  if ('brandId' in body && (await brandMissing(body.brandId))) {
    return res.status(404).json({ message: 'Brand not found' });
  }

  // Build the SET list from the keys actually sent, so an explicit null clears a
  // nullable column instead of being swallowed by COALESCE.
  const assignments = [];
  const params = [req.params.id];
  for (const [key, column] of Object.entries(PRODUCT_COLUMNS)) {
    if (!(key in body)) continue;
    // stock_quantity is a mirror of the stock row since Sprint 4. Writing it
    // here would leave no movement explaining the change and would be undone by
    // the next refresh, so it is applied below instead.
    if (key === 'stockQuantity') continue;
    params.push(key === 'name' ? body[key].trim() : body[key]);
    assignments.push(`${column} = $${params.length}`);
  }
  const setsStock = 'stockQuantity' in body;
  if (assignments.length === 0 && !setsStock) {
    return res.status(400).json({ message: 'No updatable fields supplied' });
  }

  const client = await pool.connect();
  let product;
  try {
    await client.query('BEGIN');
    if (assignments.length > 0) {
      const { rows } = await client.query(
        `UPDATE products SET ${assignments.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        params
      );
      product = rows[0];
    } else {
      const { rows } = await client.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
      product = rows[0];
    }
    if (!product) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Product not found' });
    }
    if (setsStock) {
      await setSimpleStock(client, {
        productId: product.id,
        vendorId: product.vendor_id,
        targetQty: body.stockQuantity,
        actorRole: 'admin',
        userId: req.user.id,
        note: 'Stock updated from the admin panel',
      });
      const { rows: fresh } = await client.query('SELECT * FROM products WHERE id = $1', [product.id]);
      product = fresh[0];
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }

  res.json(product);
}

// Order items reference products with ON DELETE RESTRICT, so a product that has
// ever been ordered can only be retired (is_active = false), never removed.
async function deleteAnyProduct(req, res) {
  const { rows: ordered } = await pool.query('SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1', [
    req.params.id,
  ]);

  if (ordered[0]) {
    const { rows } = await pool.query(
      'UPDATE products SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Product not found' });
    return res.json({
      deleted: false,
      message: 'This product appears in past orders, so it was deactivated instead of deleted.',
    });
  }

  const { rows } = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Product not found' });
  res.json({ deleted: true, message: 'Product deleted.' });
}

async function setAnyProductTiers(req, res) {
  const { rows: productRows } = await pool.query('SELECT id FROM products WHERE id = $1', [req.params.id]);
  if (!productRows[0]) return res.status(404).json({ message: 'Product not found' });

  const tiers = Array.isArray(req.body?.tiers) ? req.body.tiers : [];
  for (const tier of tiers) {
    if (!Number.isInteger(tier.minQuantity) || tier.minQuantity < 1 || !Number.isInteger(tier.unitPriceCents)) {
      return res.status(400).json({ message: 'Each tier requires a valid minQuantity and unitPriceCents' });
    }
    if (tier.unitPriceCents < 0) {
      return res.status(400).json({ message: 'Tier unitPriceCents cannot be negative' });
    }
    if (tier.maxQuantity != null && (!Number.isInteger(tier.maxQuantity) || tier.maxQuantity < tier.minQuantity)) {
      return res.status(400).json({ message: 'Tier maxQuantity must be an integer no smaller than minQuantity' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM product_price_tiers WHERE product_id = $1', [req.params.id]);
    for (const tier of tiers) {
      await client.query(
        `INSERT INTO product_price_tiers (product_id, min_quantity, max_quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, tier.minQuantity, tier.maxQuantity ?? null, tier.unitPriceCents]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    'SELECT * FROM product_price_tiers WHERE product_id = $1 ORDER BY min_quantity ASC',
    [req.params.id]
  );
  res.json(rows);
}

// ── Platform coupons (offers) ──

async function createPlatformCoupon(req, res) {
  const { code, discountType, discountValue, minOrderValueCents, expiresAt } = req.body || {};
  if (!code || !['flat', 'percentage'].includes(discountType) || !(Number(discountValue) > 0)) {
    return res.status(400).json({ message: 'code, a valid discountType, and a positive discountValue are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons (vendor_id, code, discount_type, discount_value, min_order_value_cents, expires_at)
       VALUES (NULL, $1, $2, $3, $4, $5)
       RETURNING *`,
      [code.toUpperCase(), discountType, discountValue, minOrderValueCents ?? 0, expiresAt || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A platform coupon with this code already exists' });
    }
    throw err;
  }
}

async function listPlatformCoupons(req, res) {
  const { rows } = await pool.query('SELECT * FROM coupons WHERE vendor_id IS NULL ORDER BY created_at DESC');
  res.json(rows);
}

async function updatePlatformCoupon(req, res) {
  const { isActive, expiresAt } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE coupons SET
      is_active = COALESCE($2, is_active),
      expires_at = COALESCE($3, expires_at)
     WHERE id = $1 AND vendor_id IS NULL
     RETURNING *`,
    [req.params.id, isActive, expiresAt]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Platform coupon not found' });
  res.json(rows[0]);
}

async function deletePlatformCoupon(req, res) {
  const { rows } = await pool.query(
    'UPDATE coupons SET is_active = false WHERE id = $1 AND vendor_id IS NULL RETURNING id',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Platform coupon not found' });
  res.status(204).send();
}

// ── Reports ──

async function getPlatformSummary(req, res) {
  const [
    { rows: totalRow },
    { rows: dailyRows },
    { rows: volumeRow },
    { rows: topByRevenue },
    { rows: topByQty },
    { rows: userCountRows },
    { rows: vendorCountRows },
  ] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(total_cents), 0) AS total_revenue_cents, COUNT(*) AS delivered_order_count
       FROM orders WHERE status = 'delivered'`
    ),
    pool.query(
      `SELECT date_trunc('day', updated_at) AS day, SUM(total_cents) AS revenue_cents
       FROM orders WHERE status = 'delivered' AND updated_at >= now() - interval '30 days'
       GROUP BY 1 ORDER BY 1`
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS orders_last_30_days,
              COUNT(*) AS total_orders_all_time
       FROM orders`
    ),
    pool.query(
      `SELECT oi.product_id, oi.product_name_snapshot, SUM(oi.unit_price_cents * oi.quantity) AS revenue_cents
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status = 'delivered'
       GROUP BY oi.product_id, oi.product_name_snapshot
       ORDER BY revenue_cents DESC LIMIT 5`
    ),
    pool.query(
      `SELECT oi.product_id, oi.product_name_snapshot, SUM(oi.quantity) AS total_quantity
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status = 'delivered'
       GROUP BY oi.product_id, oi.product_name_snapshot
       ORDER BY total_quantity DESC LIMIT 5`
    ),
    pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE role = 'customer') AS customer_count,
        COUNT(*) FILTER (WHERE role = 'vendor') AS vendor_user_count
       FROM users`
    ),
    pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_count
       FROM vendor_profiles`
    ),
  ]);

  const revenueByDay = new Map(dailyRows.map((r) => [r.day.toISOString().slice(0, 10), Number(r.revenue_cents)]));
  const dailyRevenue = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyRevenue.push({ date: key, revenueCents: revenueByDay.get(key) || 0 });
  }

  res.json({
    totalRevenueCents: Number(totalRow[0].total_revenue_cents),
    deliveredOrderCount: Number(totalRow[0].delivered_order_count),
    ordersLast30Days: Number(volumeRow[0].orders_last_30_days),
    totalOrdersAllTime: Number(volumeRow[0].total_orders_all_time),
    dailyRevenue,
    topProductsByRevenue: topByRevenue.map((r) => ({
      productId: r.product_id,
      name: r.product_name_snapshot,
      revenueCents: Number(r.revenue_cents),
    })),
    topProductsByQuantity: topByQty.map((r) => ({
      productId: r.product_id,
      name: r.product_name_snapshot,
      quantity: Number(r.total_quantity),
    })),
    userCounts: {
      customers: Number(userCountRows[0].customer_count),
      vendors: Number(userCountRows[0].vendor_user_count),
    },
    vendorCounts: {
      pending: Number(vendorCountRows[0].pending_count),
      approved: Number(vendorCountRows[0].approved_count),
      rejected: Number(vendorCountRows[0].rejected_count),
    },
  });
}

module.exports = {
  listUsers,
  getUser,
  updateUserRole,
  listVendors,
  updateVendorStatus,
  updateVendor,
  listAllOrders,
  getAnyOrder,
  updateOrderStatus,
  listAllProducts,
  getAnyProduct,
  createAnyProduct,
  updateAnyProduct,
  deleteAnyProduct,
  setAnyProductTiers,
  createPlatformCoupon,
  listPlatformCoupons,
  updatePlatformCoupon,
  deletePlatformCoupon,
  getPlatformSummary,
};
