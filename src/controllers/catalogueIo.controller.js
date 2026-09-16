const pool = require('../config/db');
const { parseCsv, toCsv } = require('../services/csv');
const { applyMovement, refreshProductMirrors } = require('../services/inventory');

/**
 * CSV import and export for products, variants and inventory.
 *
 * The file arrives as text in a JSON body rather than multipart: the panel reads
 * it with FileReader, which keeps a file-upload dependency and its temp-file
 * handling out of the server for what is ultimately a string.
 *
 * Every import runs inside one transaction and is rolled back unless it is
 * applied for real, so a dry run costs exactly what the real thing costs and
 * therefore tells the truth about it — a validate pass that only checked shapes
 * would still miss the constraint that fails on row 400.
 */

const TYPES = ['products', 'variants', 'inventory'];

// Exported and re-imported unchanged, so a round trip is a no-op. Columns the
// import ignores are still exported, because a human reading the file needs
// them to know which row is which.
const COLUMNS = {
  products: [
    'id', 'sku', 'name', 'category', 'brand', 'price', 'mrp', 'stock',
    'gst_percent', 'moq', 'is_active', 'moderation_status', 'vendor_id', 'vendor_name',
  ],
  variants: [
    'variant_id', 'product_id', 'product_name', 'label', 'sku', 'price', 'mrp',
    'is_active', 'sort_order', 'available_qty',
  ],
  inventory: [
    'inventory_id', 'product_id', 'product_name', 'variant_id', 'variant_label',
    'sku', 'vendor_id', 'vendor_name', 'available_qty', 'low_stock_threshold', 'reserved_qty',
  ],
};

/** Rupees in the file, integer cents in the database. */
function toCents(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}

function fromCents(cents) {
  return cents == null ? '' : (cents / 100).toFixed(2);
}

function toInt(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/** Accepts what a spreadsheet actually puts in a boolean column. */
function toBool(value) {
  if (value === '' || value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'active'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'inactive'].includes(v)) return false;
  return undefined;
}

// ── Export ──

async function exportCsv(req, res) {
  const type = req.query.type;
  if (!TYPES.includes(type)) {
    return res.status(400).json({ message: `type must be one of ${TYPES.join(', ')}` });
  }
  const vendorId = req.query.vendorId ? Number(req.query.vendorId) : null;

  let rows;
  if (type === 'products') {
    const { rows: products } = await pool.query(
      `SELECT p.id, p.sku, p.name, p.category, b.name AS brand, p.price_cents, p.mrp_cents,
              p.stock_quantity, p.gst_rate_percent, p.moq, p.is_active, p.moderation_status,
              p.vendor_id, vp.business_name AS vendor_name
       FROM products p
       JOIN vendor_profiles vp ON vp.id = p.vendor_id
       LEFT JOIN brands b ON b.id = p.brand_id
       WHERE ($1::int IS NULL OR p.vendor_id = $1)
       ORDER BY p.id`,
      [vendorId]
    );
    rows = products.map((p) => ({
      id: p.id,
      sku: p.sku ?? '',
      name: p.name,
      category: p.category ?? '',
      brand: p.brand ?? '',
      price: fromCents(p.price_cents),
      mrp: fromCents(p.mrp_cents),
      stock: p.stock_quantity,
      gst_percent: p.gst_rate_percent,
      moq: p.moq,
      is_active: p.is_active,
      moderation_status: p.moderation_status,
      vendor_id: p.vendor_id,
      vendor_name: p.vendor_name,
    }));
  } else if (type === 'variants') {
    const { rows: variants } = await pool.query(
      `SELECT v.id AS variant_id, v.product_id, p.name AS product_name, v.sku,
              v.price_cents, v.mrp_cents, v.is_active, v.sort_order, i.available_qty,
              (SELECT string_agg(av.value, ' / ' ORDER BY a.sort_order, av.sort_order)
               FROM variant_attribute_values vav
               JOIN attribute_values av ON av.id = vav.attribute_value_id
               JOIN product_attributes a ON a.id = av.attribute_id
               WHERE vav.variant_id = v.id) AS label
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN inventory i ON i.variant_id = v.id
       WHERE ($1::int IS NULL OR p.vendor_id = $1)
       ORDER BY v.product_id, v.sort_order, v.id`,
      [vendorId]
    );
    rows = variants.map((v) => ({
      variant_id: v.variant_id,
      product_id: v.product_id,
      product_name: v.product_name,
      label: v.label ?? '',
      sku: v.sku ?? '',
      price: fromCents(v.price_cents),
      mrp: fromCents(v.mrp_cents),
      is_active: v.is_active,
      sort_order: v.sort_order,
      available_qty: v.available_qty ?? '',
    }));
  } else {
    const { rows: inventory } = await pool.query(
      `SELECT i.id AS inventory_id, i.product_id, p.name AS product_name, i.variant_id,
              i.vendor_id, vp.business_name AS vendor_name, i.available_qty,
              i.low_stock_threshold, i.reserved_qty,
              COALESCE(v.sku, p.sku) AS sku,
              (SELECT string_agg(av.value, ' / ' ORDER BY a.sort_order, av.sort_order)
               FROM variant_attribute_values vav
               JOIN attribute_values av ON av.id = vav.attribute_value_id
               JOIN product_attributes a ON a.id = av.attribute_id
               WHERE vav.variant_id = i.variant_id) AS variant_label
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       JOIN vendor_profiles vp ON vp.id = i.vendor_id
       LEFT JOIN product_variants v ON v.id = i.variant_id
       WHERE ($1::int IS NULL OR i.vendor_id = $1)
       ORDER BY i.id`,
      [vendorId]
    );
    rows = inventory.map((i) => ({
      inventory_id: i.inventory_id,
      product_id: i.product_id,
      product_name: i.product_name,
      variant_id: i.variant_id ?? '',
      variant_label: i.variant_label ?? '',
      sku: i.sku ?? '',
      vendor_id: i.vendor_id,
      vendor_name: i.vendor_name,
      available_qty: i.available_qty,
      low_stock_threshold: i.low_stock_threshold,
      reserved_qty: i.reserved_qty,
    }));
  }

  const csv = toCsv(COLUMNS[type], rows);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gloaro-${type}-${stamp}.csv"`);
  res.send(csv);
}

// ── Import ──

/**
 * Updates a product row. Creating products is deliberately not supported: a new
 * listing needs a vendor, a category and moderation, and a spreadsheet row that
 * silently creates a live product is the wrong default for a bulk tool.
 */
async function importProductRow(client, record, results) {
  const id = toInt(record.id);
  if (!id) return results.push({ line: record.__line, status: 'error', message: 'id is required — bulk import updates existing products, it does not create them' });

  const price = toCents(record.price);
  const mrp = toCents(record.mrp);
  const stock = toInt(record.stock);
  const moq = toInt(record.moq);
  const isActive = toBool(record.is_active);

  if (Number.isNaN(price)) return results.push({ line: record.__line, status: 'error', message: 'price is not a valid amount' });
  if (Number.isNaN(mrp)) return results.push({ line: record.__line, status: 'error', message: 'mrp is not a valid amount' });
  if (Number.isNaN(stock)) return results.push({ line: record.__line, status: 'error', message: 'stock must be a whole number' });
  if (isActive === undefined) return results.push({ line: record.__line, status: 'error', message: 'is_active must be true or false' });

  const { rows: current } = await client.query('SELECT * FROM products WHERE id = $1', [id]);
  const before = current[0];
  if (!before) return results.push({ line: record.__line, status: 'error', message: `No product with id ${id}` });

  // Read-compare-write rather than a blind UPDATE, so a row the file did not
  // actually change is reported as unchanged. A dry run whose count is inflated
  // by no-op rows tells the operator nothing about what the real run will do.
  const next = {
    name: record.name?.trim() || before.name,
    sku: record.sku?.trim() || before.sku,
    category: record.category?.trim() || before.category,
    price_cents: price ?? before.price_cents,
    mrp_cents: mrp ?? before.mrp_cents,
    stock_quantity: stock ?? before.stock_quantity,
    moq: moq ?? before.moq,
    is_active: isActive ?? before.is_active,
  };

  const changed = Object.keys(next).filter((k) => String(next[k] ?? '') !== String(before[k] ?? ''));
  if (changed.length === 0) {
    return results.push({ line: record.__line, status: 'unchanged', message: before.name });
  }

  await client.query(
    `UPDATE products SET name = $2, sku = $3, category = $4, price_cents = $5,
            mrp_cents = $6, stock_quantity = $7, moq = $8, is_active = $9, updated_at = now()
     WHERE id = $1`,
    [id, next.name, next.sku, next.category, next.price_cents, next.mrp_cents, next.stock_quantity, next.moq, next.is_active]
  );
  results.push({ line: record.__line, status: 'updated', message: `${before.name} — ${changed.join(', ')}` });
}

/** Variants are updated, never created: a new one needs attribute values, which a flat row cannot express unambiguously. */
async function importVariantRow(client, record, results) {
  const id = toInt(record.variant_id);
  if (!id) return results.push({ line: record.__line, status: 'error', message: 'variant_id is required — variants are created under Product Variants, where attributes can be chosen' });

  const price = toCents(record.price);
  const mrp = toCents(record.mrp);
  const sortOrder = toInt(record.sort_order);
  const isActive = toBool(record.is_active);

  if (Number.isNaN(price)) return results.push({ line: record.__line, status: 'error', message: 'price is not a valid amount' });
  if (Number.isNaN(mrp)) return results.push({ line: record.__line, status: 'error', message: 'mrp is not a valid amount' });
  if (isActive === undefined) return results.push({ line: record.__line, status: 'error', message: 'is_active must be true or false' });

  const { rows: current } = await client.query('SELECT * FROM product_variants WHERE id = $1', [id]);
  const before = current[0];
  if (!before) return results.push({ line: record.__line, status: 'error', message: `No variant with id ${id}` });

  const next = {
    sku: record.sku?.trim() || before.sku,
    price_cents: price ?? before.price_cents,
    mrp_cents: mrp ?? before.mrp_cents,
    sort_order: sortOrder ?? before.sort_order,
    is_active: isActive ?? before.is_active,
  };

  const changed = Object.keys(next).filter((k) => String(next[k] ?? '') !== String(before[k] ?? ''));
  if (changed.length === 0) {
    return results.push({ line: record.__line, status: 'unchanged', message: `variant ${id}` });
  }

  await client.query(
    `UPDATE product_variants SET sku = $2, price_cents = $3, mrp_cents = $4, sort_order = $5, is_active = $6
     WHERE id = $1`,
    [id, next.sku, next.price_cents, next.mrp_cents, next.sort_order, next.is_active]
  );

  // Price mirrors on the parent product follow its variants, so a bulk price
  // change has to refresh them or the listing keeps quoting the old figure.
  await refreshProductMirrors(client, before.product_id);
  results.push({ line: record.__line, status: 'updated', message: `variant ${id} — ${changed.join(', ')}` });
}

/**
 * Sets stock to the figure in the file.
 *
 * Goes through applyMovement rather than writing available_qty, so the movement
 * log still explains every change — a bulk edit is exactly the kind of change
 * an audit trail exists for.
 */
async function importInventoryRow(client, record, results, userId) {
  const id = toInt(record.inventory_id);
  if (!id) return results.push({ line: record.__line, status: 'error', message: 'inventory_id is required' });

  const target = toInt(record.available_qty);
  const threshold = toInt(record.low_stock_threshold);
  if (Number.isNaN(target) || (target != null && target < 0)) {
    return results.push({ line: record.__line, status: 'error', message: 'available_qty must be zero or more' });
  }
  if (Number.isNaN(threshold) || (threshold != null && threshold < 0)) {
    return results.push({ line: record.__line, status: 'error', message: 'low_stock_threshold must be zero or more' });
  }

  const { rows } = await client.query('SELECT * FROM inventory WHERE id = $1 FOR UPDATE', [id]);
  const row = rows[0];
  if (!row) return results.push({ line: record.__line, status: 'error', message: `No inventory row with id ${id}` });

  if (threshold != null && threshold !== row.low_stock_threshold) {
    await client.query('UPDATE inventory SET low_stock_threshold = $2, updated_at = now() WHERE id = $1', [id, threshold]);
  }

  const delta = target == null ? 0 : target - row.available_qty;
  if (delta === 0) {
    return results.push({ line: record.__line, status: 'unchanged', message: `${row.available_qty} in stock` });
  }

  await applyMovement(client, {
    inventoryId: id,
    deltaAvailable: delta,
    reason: delta > 0 ? 'restocked' : 'adjusted',
    actorRole: 'admin',
    userId,
    note: 'Bulk CSV import',
  });
  results.push({ line: record.__line, status: 'updated', message: `${row.available_qty} → ${target}` });
}

async function importCsv(req, res) {
  const { type, csv, dryRun = true } = req.body || {};
  if (!TYPES.includes(type)) {
    return res.status(400).json({ message: `type must be one of ${TYPES.join(', ')}` });
  }
  if (typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ message: 'csv is required' });
  }

  const { headers, records } = parseCsv(csv);
  if (records.length === 0) {
    return res.status(400).json({ message: 'The file has a header row but no data rows.' });
  }
  if (records.length > 5000) {
    return res.status(400).json({ message: 'That file has more than 5000 rows — split it into smaller batches.' });
  }

  const keyColumn = type === 'products' ? 'id' : type === 'variants' ? 'variant_id' : 'inventory_id';
  if (!headers.includes(keyColumn)) {
    return res.status(400).json({ message: `The file needs a '${keyColumn}' column. Export first to get the right shape.` });
  }

  const results = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const record of records) {
      if (type === 'products') await importProductRow(client, record, results);
      else if (type === 'variants') await importVariantRow(client, record, results);
      else await importInventoryRow(client, record, results, req.user.id);
    }

    const errors = results.filter((r) => r.status === 'error').length;

    // All or nothing. A half-applied price list is worse than a rejected one:
    // the operator cannot tell which rows landed without diffing the catalogue.
    if (dryRun || errors > 0) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    res.json({
      type,
      dryRun: Boolean(dryRun),
      applied: !dryRun && errors === 0,
      total: results.length,
      updated: results.filter((r) => r.status === 'updated').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
      errors,
      rows: results,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ message: err.message });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { exportCsv, importCsv };
