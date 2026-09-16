/**
 * Applies only the Phase 2 brands section of schema.sql.
 *
 *   node scripts/migrate-brands.js
 *
 * Same approach as migrate-sprint1.js: schema.sql is the full history of the
 * database and its early statements are not idempotent, so this slices out the
 * brands block — written with IF NOT EXISTS throughout — and runs it in one
 * transaction. Either the whole migration lands or none of it does.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== PHASE 2: BRANDS (CATALOGUE FOUNDATION) =====';
const TABLES = ['brands'];
const PRODUCT_COLUMNS = ['brand_id'];

async function report(label) {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES]
  );
  const { rows: columns } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'products' AND column_name = ANY($1)`,
    [PRODUCT_COLUMNS]
  );
  console.log(`\n${label}`);
  for (const t of TABLES) {
    console.log(`  ${tables.some((r) => r.table_name === t) ? '[x]' : '[ ]'} table  ${t}`);
  }
  for (const c of PRODUCT_COLUMNS) {
    console.log(`  ${columns.some((r) => r.column_name === c) ? '[x]' : '[ ]'} column products.${c}`);
  }
  return tables.length === TABLES.length && columns.length === PRODUCT_COLUMNS.length;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const start = schema.indexOf(MARKER);
  if (start === -1) {
    console.error('Could not find the brands marker in schema.sql — nothing to run.');
    process.exit(1);
  }
  const sql = schema.slice(start);

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
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const ok = await report('After:');
  await pool.end();
  console.log(ok ? '\nBrands objects present.\n' : '\nSome objects are still missing — check the errors above.\n');
  process.exit(ok ? 0 : 1);
}

main();
