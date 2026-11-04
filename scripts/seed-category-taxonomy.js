/**
 * Seeds the category taxonomy (WORK_PLAN CT2) from scripts/data/category-taxonomy.js:
 * renames the first six categories, adds the rest (29, A–Z), their
 * sub-categories and every filter. Safe to run again: categories match by
 * name, sub-categories by name within their category, filters by code and
 * values by name. Nothing an admin added is removed; the two old catch-all
 * "Product type" filters are switched off, not deleted.
 *
 * With --move-products it also moves the live products into the new
 * categories (MOVES, worked out from their names on 2026-11-04). Run that
 * once; a second run would undo an admin's later move.
 *
 *   node scripts/migrate-category-taxonomy.js   # first
 *   node scripts/seed-category-taxonomy.js [--move-products]
 */
require('dotenv').config();
const pool = require('../src/config/db');
const { CATEGORIES, RENAMES, ATTRIBUTES, RETIRED, PRUNE, MOVES } = require('./data/category-taxonomy');

async function renameCategories(client) {
  for (const [from, to] of RENAMES) {
    const { rows } = await client.query('SELECT id FROM categories WHERE name = $1', [to]);
    if (rows[0]) continue; // already renamed
    const { rowCount } = await client.query('UPDATE categories SET name = $2 WHERE name = $1', [from, to]);
    if (!rowCount) continue;
    const moved = await client.query('UPDATE products SET category = $2, updated_at = now() WHERE category = $1', [from, to]);
    console.log(`  renamed ${from} → ${to} (${moved.rowCount} products)`);
  }
}

async function upsertCategories(client) {
  const ids = new Map();
  let order = 0;
  for (const c of CATEGORIES) {
    order += 10;
    // An existing row keeps its picture and its icon, unless the icon is the
    // generic "other" (Sports had it); the order follows A–Z.
    const { rows } = await client.query(
      `INSERT INTO categories (name, icon_key, sort_order) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET sort_order = EXCLUDED.sort_order, is_active = true,
         icon_key = CASE WHEN categories.icon_key = 'other' THEN EXCLUDED.icon_key ELSE categories.icon_key END
       RETURNING id`,
      [c.name, c.icon, order]
    );
    const categoryId = rows[0].id;
    ids.set(c.name, categoryId);
    // One round trip per category: Neon is far away, row-by-row takes minutes.
    await client.query(
      `INSERT INTO category_subcategories (category_id, name, sort_order)
       SELECT $1, s.name, s.ord * 10 FROM unnest($2::text[]) WITH ORDINALITY AS s(name, ord)
       ON CONFLICT (category_id, (lower(name))) DO UPDATE SET sort_order = EXCLUDED.sort_order, is_active = true`,
      [categoryId, c.subs]
    );
  }
  return ids;
}

async function upsertAttributes(client, categoryIds) {
  let order = 0;
  let values = 0;
  for (const a of ATTRIBUTES) {
    order += 10;
    const cats = a.cats ? a.cats.map((name) => {
      const id = categoryIds.get(name);
      if (id == null) throw new Error(`${a.code}: no category named ${name}`);
      return id;
    }) : null;
    const { rows } = await client.query(
      `INSERT INTO product_attributes (name, code, category_id, category_ids, input_type, is_variant_defining, sort_order, is_filter, filter_kind, unit, subcategories)
       VALUES ($1, $2, $3, $4, 'select', $5, $6, true, $7, $8, $9)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, category_id = EXCLUDED.category_id, category_ids = EXCLUDED.category_ids,
         is_variant_defining = EXCLUDED.is_variant_defining, sort_order = EXCLUDED.sort_order, is_filter = true,
         filter_kind = EXCLUDED.filter_kind, unit = EXCLUDED.unit, subcategories = EXCLUDED.subcategories, is_active = true
       RETURNING id`,
      [a.name, a.code, cats?.[0] ?? null, cats, a.variant === true, order, a.kind, a.unit ?? null, a.subs ?? null]
    );
    if (!a.values.length) continue;
    const pairs = a.values.map((entry) => (Array.isArray(entry) ? entry : [entry, null]));
    await client.query(
      `INSERT INTO attribute_values (attribute_id, value, sort_order, color_hex)
       SELECT $1, v.value, v.ord * 10, v.hex FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS v(value, hex, ord)
       ON CONFLICT (attribute_id, value) DO UPDATE SET sort_order = EXCLUDED.sort_order,
         color_hex = COALESCE(EXCLUDED.color_hex, attribute_values.color_hex)`,
      [rows[0].id, pairs.map((p) => p[0]), pairs.map((p) => p[1])]
    );
    values += pairs.length;
  }
  const retired = await client.query('UPDATE product_attributes SET is_active = false WHERE code = ANY($1) AND is_active', [RETIRED]);
  const prunePairs = Object.entries(PRUNE).flatMap(([code, list]) => list.map((value) => [code, value]));
  const pruned = await client.query(
    `DELETE FROM attribute_values av USING product_attributes a, unnest($1::text[], $2::text[]) AS x(code, value)
     WHERE a.id = av.attribute_id AND a.code = x.code AND av.value = x.value
       AND NOT EXISTS (SELECT 1 FROM product_attribute_values p WHERE p.attribute_value_id = av.id)
       AND NOT EXISTS (SELECT 1 FROM variant_attribute_values v WHERE v.attribute_value_id = av.id)`,
    [prunePairs.map((p) => p[0]), prunePairs.map((p) => p[1])]
  );
  return { values, retired: retired.rowCount, pruned: pruned.rowCount };
}

async function moveProducts(client) {
  const entries = Object.entries(MOVES);
  const { rowCount } = await client.query(
    `UPDATE products p SET category = m.category, subcategory = m.subcategory, updated_at = now()
     FROM unnest($1::int[], $2::text[], $3::text[]) AS m(id, category, subcategory)
     WHERE p.id = m.id`,
    [entries.map(([id]) => Number(id)), entries.map(([, v]) => v[0]), entries.map(([, v]) => v[1])]
  );
  return rowCount;
}

async function main() {
  const move = process.argv.includes('--move-products');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await renameCategories(client);
    const categoryIds = await upsertCategories(client);
    const subs = CATEGORIES.reduce((n, c) => n + c.subs.length, 0);
    console.log(`Categories: ${categoryIds.size}, sub-categories: ${subs}`);
    const { values, retired, pruned } = await upsertAttributes(client, categoryIds);
    console.log(`Filters: ${ATTRIBUTES.length} (${values} values), retired: ${retired}, old values removed: ${pruned}`);
    if (move) console.log(`Products moved: ${await moveProducts(client)} of ${Object.keys(MOVES).length}`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
