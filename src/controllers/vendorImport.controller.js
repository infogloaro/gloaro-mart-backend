const pool = require('../config/db');
const { setSimpleStock } = require('../services/inventory');

/**
 * VD14: add or change many products at once from a spreadsheet the shop
 * pasted (the app parses it into rows).
 *
 * POST /api/vendor/products/import { rows: [...], dryRun }
 *
 * A row matches an existing product of the shop by SKU, or else by its exact
 * name; otherwise it's a new product (which waits for Gloaro Mart's review,
 * like one added by hand). An empty cell leaves that field as it is. A dry run
 * says what each row would do; a real run applies every row in one
 * transaction — any problem and nothing changes.
 */

const MAX_ROWS = 500;
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const text = (v) => (blank(v) ? undefined : String(v).trim());

/** "₹1,299.50" / "1299.5" → 129950 paise; undefined when blank; NaN when not a price. */
function paise(v) {
  if (blank(v)) return undefined;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}

function wholeNumber(v) {
  if (blank(v)) return undefined;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

function yesNo(v) {
  if (blank(v)) return undefined;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'on', 'live'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'off', 'hidden'].includes(s)) return false;
  return null;
}

/** One row checked: { fields, errors } with fields in database terms. */
function checkRow(raw, categories) {
  const errors = [];
  const f = {
    sku: text(raw.sku),
    name: text(raw.name),
    priceCents: paise(raw.price),
    mrpCents: paise(raw.mrp),
    stock: wholeNumber(raw.stock),
    category: text(raw.category),
    subcategory: text(raw.subcategory),
    description: text(raw.description),
    hsnCode: text(raw.hsn),
    gst: blank(raw.gst) ? undefined : Number(String(raw.gst).replace('%', '').trim()),
    moq: wholeNumber(raw.moq),
    imageUrl: text(raw.imageUrl),
    isActive: yesNo(raw.active),
  };
  if (f.name && f.name.length > 200) errors.push('Name is longer than 200 letters');
  if (Number.isNaN(f.priceCents)) errors.push('Price is not a number');
  if (Number.isNaN(f.mrpCents)) errors.push('MRP is not a number');
  if (f.mrpCents != null && f.priceCents != null && !Number.isNaN(f.mrpCents) && f.mrpCents < f.priceCents) errors.push('MRP is below the price');
  if (Number.isNaN(f.stock)) errors.push('Stock must be a whole number');
  if (Number.isNaN(f.moq) || f.moq === 0) errors.push('Minimum order must be a whole number from 1');
  if (f.gst !== undefined && !GST_RATES.includes(f.gst)) errors.push(`GST must be one of ${GST_RATES.join(', ')}`);
  if (f.hsnCode && !/^\d{4,8}$/.test(f.hsnCode)) errors.push('HSN code is 4–8 digits');
  if (f.imageUrl && !/^(https?:\/\/|\/uploads\/)/.test(f.imageUrl)) errors.push('Photo must be a web link (https://…)');
  if (f.isActive === null) errors.push('On sale must be yes or no');
  if (f.category) {
    const known = categories.get(f.category.toLowerCase());
    if (known) f.category = known;
    else errors.push(`Unknown category "${f.category}"`);
  }
  return { fields: f, errors };
}

async function importProducts(req, res) {
  const vendorId = req.vendorId;
  const rows = req.body?.rows;
  const dryRun = req.body?.dryRun !== false;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ message: 'Send at least one row.' });
  if (rows.length > MAX_ROWS) return res.status(400).json({ message: `At most ${MAX_ROWS} rows at a time.` });

  const [{ rows: cats }, { rows: mine }] = await Promise.all([
    pool.query('SELECT name FROM categories WHERE is_active = true'),
    pool.query('SELECT id, name, sku FROM products WHERE vendor_id = $1', [vendorId]),
  ]);
  const categories = new Map(cats.map((c) => [c.name.toLowerCase(), c.name]));
  const bySku = new Map(mine.filter((p) => p.sku).map((p) => [p.sku.trim().toLowerCase(), p.id]));
  const byName = new Map();
  for (const p of mine) {
    const k = p.name.trim().toLowerCase();
    // Two products with the same name can't be told apart by name.
    byName.set(k, byName.has(k) ? null : p.id);
  }

  const seen = new Set();
  const report = rows.map((raw, i) => {
    const { fields, errors } = checkRow(raw || {}, categories);
    let productId = null;
    if (fields.sku) productId = bySku.get(fields.sku.toLowerCase()) ?? null;
    if (productId == null && fields.name) {
      const hit = byName.get(fields.name.toLowerCase());
      if (hit === null) errors.push('Two of your products have this name — add the SKU to say which');
      else if (hit != null) productId = hit;
    }
    const key = productId != null ? `id:${productId}` : `new:${(fields.sku || fields.name || '').toLowerCase()}`;
    if (key !== 'new:' && seen.has(key)) errors.push('This product is in the sheet twice');
    seen.add(key);
    if (productId == null) {
      if (!fields.name) errors.push('A new product needs a name');
      if (fields.priceCents == null) errors.push('A new product needs a price');
    }
    const action = errors.length ? 'error' : productId == null ? 'create' : 'update';
    return { line: i + 1, action, productId, name: fields.name ?? null, errors, fields };
  });

  const summary = {
    create: report.filter((r) => r.action === 'create').length,
    update: report.filter((r) => r.action === 'update').length,
    errors: report.filter((r) => r.action === 'error').length,
  };
  const out = (r) => ({ line: r.line, action: r.action, productId: r.productId, name: r.name, errors: r.errors });
  if (dryRun || summary.errors) {
    return res.status(dryRun ? 200 : 400).json({ dryRun, summary, rows: report.map(out), ...(dryRun ? {} : { message: 'Fix the rows with problems first; nothing was changed.' }) });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of report) {
      const f = r.fields;
      if (r.action === 'create') {
        const { rows: made } = await client.query(
          `INSERT INTO products (vendor_id, name, description, price_cents, currency, stock_quantity, image_url, category, gst_rate_percent, moq, subcategory, sku, hsn_code, mrp_cents, is_active)
           VALUES ($1, $2, $3, $4, 'INR', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
          [vendorId, f.name, f.description ?? null, f.priceCents, f.stock ?? 0, f.imageUrl ?? null, f.category ?? null, f.gst ?? 0, f.moq ?? 1,
            f.subcategory ?? null, f.sku ?? null, f.hsnCode ?? null, f.mrpCents ?? null, f.isActive ?? true]
        );
        const p = made[0];
        r.productId = p.id;
        // The same opening as a product added by hand: its stock row and primary photo.
        await setSimpleStock(client, { productId: p.id, vendorId, targetQty: p.stock_quantity ?? 0, userId: req.user.id, note: 'Opening stock (import)' });
        if (p.image_url) {
          await client.query(`INSERT INTO product_media (product_id, media_type, url, is_primary, sort_order) VALUES ($1, 'image', $2, true, 0)`, [p.id, p.image_url]);
        }
      } else {
        await client.query(
          `UPDATE products SET
             name = COALESCE($3, name), description = COALESCE($4, description), price_cents = COALESCE($5, price_cents),
             image_url = COALESCE($6, image_url), category = COALESCE($7, category), gst_rate_percent = COALESCE($8, gst_rate_percent),
             moq = COALESCE($9, moq), subcategory = COALESCE($10, subcategory), sku = COALESCE($11, sku), hsn_code = COALESCE($12, hsn_code),
             mrp_cents = COALESCE($13, mrp_cents), is_active = COALESCE($14, is_active), updated_at = now()
           WHERE id = $1 AND vendor_id = $2`,
          [r.productId, vendorId, f.name ?? null, f.description ?? null, f.priceCents ?? null, f.imageUrl ?? null, f.category ?? null, f.gst ?? null,
            f.moq ?? null, f.subcategory ?? null, f.sku ?? null, f.hsnCode ?? null, f.mrpCents ?? null, f.isActive ?? null]
        );
        if (f.stock != null) {
          await setSimpleStock(client, { productId: r.productId, vendorId, targetQty: f.stock, userId: req.user.id, note: 'Stock updated by import' });
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // A product sold by variant can't take a single stock number, for example.
    if (err.status) return res.status(err.status).json({ message: err.message, summary, rows: report.map(out) });
    throw err;
  } finally {
    client.release();
  }
  res.json({ dryRun: false, summary, rows: report.map(out) });
}

module.exports = { importProducts, checkRow, MAX_ROWS };
