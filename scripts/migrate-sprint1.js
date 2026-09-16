/**
 * Applies only the Sprint 1 section of schema.sql.
 *
 *   node scripts/migrate-sprint1.js
 *
 * schema.sql is the full history of the database and its early statements are
 * not idempotent (`CREATE TABLE users` would fail on an existing database), so
 * running the whole file is not an option. This slices out the Sprint 1 block,
 * which is written with IF NOT EXISTS throughout, and runs it in one
 * transaction — either the whole migration lands or none of it does.
 *
 * Also avoids needing psql on PATH.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== SPRINT 1: ADDRESS BOOK & SERVICEABILITY (PHASE 1) =====';
const TABLES = ['addresses', 'vendor_service_areas', 'vendor_delivery_rules'];
const ORDER_COLUMNS = ['address_id', 'delivery_address_snapshot', 'delivery_charge_cents', 'delivery_method'];

async function report(label) {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES]
  );
  const { rows: columns } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'orders' AND column_name = ANY($1)`,
    [ORDER_COLUMNS]
  );
  console.log(`\n${label}`);
  for (const t of TABLES) {
    console.log(`  ${tables.some((r) => r.table_name === t) ? '[x]' : '[ ]'} table  ${t}`);
  }
  for (const c of ORDER_COLUMNS) {
    console.log(`  ${columns.some((r) => r.column_name === c) ? '[x]' : '[ ]'} column orders.${c}`);
  }
  return tables.length === TABLES.length && columns.length === ORDER_COLUMNS.length;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const start = schema.indexOf(MARKER);
  if (start === -1) {
    console.error('Could not find the Sprint 1 marker in schema.sql — nothing to run.');
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
    if (err.code === '42704' && /cube|earthdistance|ll_to_earth/i.test(err.message)) {
      console.error(
        '\n  The cube/earthdistance extensions are missing and your database user\n' +
          '  cannot create them. Radius service areas need these. Ask your provider\n' +
          '  to enable them, or use pincode rules only for now.'
      );
    }
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const ok = await report('After:');
  await pool.end();
  console.log(ok ? '\nAll Sprint 1 objects present.\n' : '\nSome objects are still missing — check the errors above.\n');
  process.exit(ok ? 0 : 1);
}

main();
