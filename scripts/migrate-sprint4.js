/**
 * Applies only the Sprint 4 section of schema.sql.
 *
 *   node scripts/migrate-sprint4.js
 *
 * schema.sql is the full history of the database and its early statements are
 * not idempotent (`CREATE TABLE users` would fail on an existing database), so
 * running the whole file is not an option. This slices out the Sprint 4 block,
 * which is written with IF NOT EXISTS throughout, and runs it in one
 * transaction — either the whole migration lands or none of it does.
 *
 * The slice stops at the next `-- ===== ` banner rather than at end of file, so
 * adding a Sprint 5 block below will not make this script quietly apply it.
 *
 * Safe to re-run: every backfill skips rows that already have what it creates.
 *
 * Also avoids needing psql on PATH.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== SPRINT 4: CATALOGUE FOUNDATION & INVENTORY (PHASE 2) =====';
const TABLES = [
  'product_variants',
  'product_attributes',
  'attribute_values',
  'variant_attribute_values',
  'product_media',
  'inventory',
  'inventory_movements',
  'inventory_reservations',
];

/** The block starting at `marker`, up to the next section banner. */
function sliceBlock(schema, marker) {
  const start = schema.indexOf(marker);
  if (start === -1) return null;
  const next = schema.indexOf('\n-- ===== ', start + marker.length);
  return next === -1 ? schema.slice(start) : schema.slice(start, next);
}

async function report(label) {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES]
  );
  const has = (t) => tables.some((r) => r.table_name === t);

  // A product without a stock row cannot be reserved against, so checkout would
  // start refusing it. The count is part of the report rather than something to
  // discover from a 409 in production.
  let unstocked = null;
  if (has('inventory')) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM products p
       WHERE NOT EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = p.id AND i.variant_id IS NULL)`
    );
    unstocked = rows[0].n;
  }

  let unimaged = null;
  if (has('product_media')) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM products p
       WHERE p.image_url IS NOT NULL AND btrim(p.image_url) <> ''
         AND NOT EXISTS (SELECT 1 FROM product_media m WHERE m.product_id = p.id AND m.is_primary)`
    );
    unimaged = rows[0].n;
  }

  console.log(`\n${label}`);
  for (const t of TABLES) {
    console.log(`  ${has(t) ? '[x]' : '[ ]'} table  ${t}`);
  }
  console.log(`  ${unstocked === null ? '[ ]' : unstocked === 0 ? '[x]' : '[!]'} products without a stock row: ${unstocked ?? 'n/a'}`);
  console.log(`  ${unimaged === null ? '[ ]' : unimaged === 0 ? '[x]' : '[!]'} images without a primary media row: ${unimaged ?? 'n/a'}`);

  return tables.length === TABLES.length && unstocked === 0 && unimaged === 0;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const sql = sliceBlock(schema, MARKER);
  if (!sql) {
    console.error('Could not find the Sprint 4 marker in schema.sql — nothing to run.');
    process.exit(1);
  }

  await report('Before:');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('\nMigration applied.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nMigration FAILED, nothing was changed:');
    console.error('  ', err.message);
    if (err.code === '42P01' && /checkout_groups/.test(err.message)) {
      console.error('\n  checkout_groups is missing — run `npm run migrate:sprint2` first.');
    }
    if (err.code === '42P01' && /categories/.test(err.message)) {
      console.error('\n  categories is missing — apply the admin modules block of schema.sql first.');
    }
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const ok = await report('After:');
  await pool.end();
  console.log(ok ? '\nAll Sprint 4 objects present.\n' : '\nSome objects are still missing — check the errors above.\n');
  process.exit(ok ? 0 : 1);
}

main();
