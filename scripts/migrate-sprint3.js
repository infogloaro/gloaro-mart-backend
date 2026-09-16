/**
 * Applies only the Sprint 3 section of schema.sql.
 *
 *   node scripts/migrate-sprint3.js
 *
 * schema.sql is the full history of the database and its early statements are
 * not idempotent (`CREATE TABLE users` would fail on an existing database), so
 * running the whole file is not an option. This slices out the Sprint 3 block,
 * which is written with IF NOT EXISTS throughout, and runs it in one
 * transaction — either the whole migration lands or none of it does.
 *
 * The slice stops at the next `-- ===== ` banner rather than at end of file, so
 * adding a Sprint 4 block below will not make this script quietly apply it.
 *
 * Safe to re-run: the backfill skips groups that already have a payment.
 *
 * Also avoids needing psql on PATH.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== SPRINT 3: PAYMENTS & REFUNDS (PHASE 6) =====';
const TABLES = ['payments', 'payment_attempts', 'payment_transactions', 'refunds', 'refund_transactions'];

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

  // A group without a payment would break every finance read downstream, so the
  // count is part of the report rather than something to discover later.
  let unpaid = null;
  if (tables.some((r) => r.table_name === 'payments')) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM checkout_groups cg
       WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.checkout_group_id = cg.id)`
    );
    unpaid = rows[0].n;
  }

  console.log(`\n${label}`);
  for (const t of TABLES) {
    console.log(`  ${tables.some((r) => r.table_name === t) ? '[x]' : '[ ]'} table  ${t}`);
  }
  console.log(`  ${unpaid === null ? '[ ]' : unpaid === 0 ? '[x]' : '[!]'} groups without a payment: ${unpaid ?? 'n/a'}`);

  return tables.length === TABLES.length && unpaid === 0;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const sql = sliceBlock(schema, MARKER);
  if (!sql) {
    console.error('Could not find the Sprint 3 marker in schema.sql — nothing to run.');
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
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const ok = await report('After:');
  await pool.end();
  console.log(ok ? '\nAll Sprint 3 objects present.\n' : '\nSome objects are still missing — check the errors above.\n');
  process.exit(ok ? 0 : 1);
}

main();
