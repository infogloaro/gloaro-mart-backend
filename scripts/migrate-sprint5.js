/**
 * Applies only the Sprint 5 section of schema.sql.
 *
 *   node scripts/migrate-sprint5.js
 *
 * schema.sql is the full history of the database and its early statements are
 * not idempotent (`CREATE TABLE users` would fail on an existing database), so
 * running the whole file is not an option. This slices out the Sprint 5 block,
 * which is written with IF NOT EXISTS throughout, and runs it in one
 * transaction — either the whole migration lands or none of it does.
 *
 * The slice stops at the next `-- ===== ` banner rather than at end of file, so
 * adding a Sprint 6 block below will not make this script quietly apply it.
 *
 * Safe to re-run: the backfill skips vendors that already have a metrics row.
 *
 * Also avoids needing psql on PATH.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== SPRINT 5: LOCATION-BASED VENDOR MATCHING ENGINE (PHASE 3) =====';
const TABLES = [
  'vendor_matching_weights',
  'vendor_performance_metrics',
  'vendor_matching_logs',
  'order_assignment_history',
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

  const { rows: col } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'products' AND column_name = 'match_key'`
  );

  // A vendor with no metrics row scores neutral rather than badly, so this is
  // not fatal — but it means the backfill did not reach them.
  let unmeasured = null;
  if (has('vendor_performance_metrics')) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vendor_profiles vp
       WHERE NOT EXISTS (SELECT 1 FROM vendor_performance_metrics m WHERE m.vendor_id = vp.id)`
    );
    unmeasured = rows[0].n;
  }

  console.log(`\n${label}`);
  console.log(`  ${col[0].n === 1 ? '[x]' : '[ ]'} column products.match_key`);
  for (const t of TABLES) {
    console.log(`  ${has(t) ? '[x]' : '[ ]'} table  ${t}`);
  }
  console.log(`  ${unmeasured === null ? '[ ]' : unmeasured === 0 ? '[x]' : '[!]'} vendors without a metrics row: ${unmeasured ?? 'n/a'}`);

  return tables.length === TABLES.length && col[0].n === 1 && unmeasured === 0;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const sql = sliceBlock(schema, MARKER);
  if (!sql) {
    console.error('Could not find the Sprint 5 marker in schema.sql — nothing to run.');
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
    if (err.code === '42P01' && /inventory/.test(err.message)) {
      console.error('\n  inventory is missing — run `npm run migrate:sprint4` first.');
    }
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const ok = await report('After:');
  await pool.end();
  console.log(ok ? '\nAll Sprint 5 objects present.\n' : '\nSome objects are still missing — check the errors above.\n');
  process.exit(ok ? 0 : 1);
}

main();
