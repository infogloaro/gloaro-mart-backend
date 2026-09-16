/**
 * Applies only the Sprint 2 section of schema.sql.
 *
 *   node scripts/migrate-sprint2.js
 *
 * schema.sql is the full history of the database and its early statements are
 * not idempotent (`CREATE TABLE users` would fail on an existing database), so
 * running the whole file is not an option. This slices out the Sprint 2 block,
 * which is written with IF NOT EXISTS throughout, and runs it in one
 * transaction — either the whole migration lands or none of it does.
 *
 * The slice stops at the next `-- ===== ` banner rather than at end of file:
 * with Sprint 3 sitting below it, slicing to the end would make this script
 * quietly apply that migration too.
 *
 * Safe to re-run: the backfill is guarded on `checkout_group_id IS NULL`, so a
 * second run finds nothing to link and the NOT NULL constraint is already set.
 *
 * Also avoids needing psql on PATH.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== SPRINT 2: CHECKOUT GROUPS & ORDER STATUS HISTORY (PHASE 5) =====';
const TABLES = ['checkout_groups', 'order_status_history'];
const ORDER_COLUMNS = ['checkout_group_id'];

async function report(label) {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES]
  );
  const { rows: columns } = await pool.query(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name = 'orders' AND column_name = ANY($1)`,
    [ORDER_COLUMNS]
  );
  const { rows: seq } = await pool.query(
    `SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'checkout_group_ref_seq'`
  );

  // An order with no group would break every grouped read, so the count is part
  // of the report rather than something to discover later.
  let orphans = null;
  if (columns.length > 0) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE checkout_group_id IS NULL');
    orphans = rows[0].n;
  }

  console.log(`\n${label}`);
  console.log(`  ${seq.length ? '[x]' : '[ ]'} sequence checkout_group_ref_seq`);
  for (const t of TABLES) {
    console.log(`  ${tables.some((r) => r.table_name === t) ? '[x]' : '[ ]'} table    ${t}`);
  }
  for (const c of ORDER_COLUMNS) {
    const col = columns.find((r) => r.column_name === c);
    const notNull = col && col.is_nullable === 'NO';
    console.log(`  ${col ? '[x]' : '[ ]'} column   orders.${c}${col ? (notNull ? ' (NOT NULL)' : ' (nullable)') : ''}`);
  }
  console.log(`  ${orphans === null ? '[ ]' : orphans === 0 ? '[x]' : '[!]'} orders without a group: ${orphans ?? 'n/a'}`);

  return tables.length === TABLES.length && columns.length === ORDER_COLUMNS.length && seq.length === 1 && orphans === 0;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const start = schema.indexOf(MARKER);
  if (start === -1) {
    console.error('Could not find the Sprint 2 marker in schema.sql — nothing to run.');
    process.exit(1);
  }
  const next = schema.indexOf('\n-- ===== ', start + MARKER.length);
  const sql = next === -1 ? schema.slice(start) : schema.slice(start, next);

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
    if (err.code === '23502') {
      console.error(
        '\n  An order could not be linked to a group, so the NOT NULL constraint\n' +
          '  was refused. Check for orders whose user_id no longer exists.'
      );
    }
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const ok = await report('After:');
  await pool.end();
  console.log(ok ? '\nAll Sprint 2 objects present.\n' : '\nSome objects are still missing — check the errors above.\n');
  process.exit(ok ? 0 : 1);
}

main();
