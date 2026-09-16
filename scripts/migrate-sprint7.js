/**
 * Applies only the Sprint 7 section of schema.sql.
 *
 *   node scripts/migrate-sprint7.js
 *
 * schema.sql is the full history of the database and its early statements are
 * not idempotent (`CREATE TABLE users` would fail on an existing database), so
 * running the whole file is not an option. This slices out the Sprint 7 block
 * and runs it in one transaction — either the whole migration lands or none of
 * it does.
 *
 * The slice stops at the next `-- ===== ` banner rather than at end of file, so
 * adding a Sprint 8 block below will not make this script quietly apply it.
 *
 * Safe to re-run: the constraints are dropped before they are added.
 *
 * Also avoids needing psql on PATH.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== SPRINT 7: ONLINE PAYMENTS, END TO END (PHASE 6) =====';
const ONLINE_METHODS = ['upi', 'card', 'netbanking', 'wallet'];

/** The block starting at `marker`, up to the next section banner. */
function sliceBlock(schema, marker) {
  const start = schema.indexOf(marker);
  if (start === -1) return null;
  const next = schema.indexOf('\n-- ===== ', start + marker.length);
  return next === -1 ? schema.slice(start) : schema.slice(start, next);
}

/**
 * Whether a table's payment_method CHECK admits an online method.
 *
 * Asked of the constraint rather than of information_schema: the point is not
 * that a constraint exists but that it permits what checkout is about to write.
 */
async function accepts(table) {
  const { rows } = await pool.query(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = $1 AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%payment_method%'`,
    [table]
  );
  if (rows.length === 0) return null;
  return ONLINE_METHODS.every((m) => rows.some((r) => r.def.includes(`'${m}'`)));
}

async function report(label) {
  const orders = await accepts('orders');
  const groups = await accepts('checkout_groups');

  const { rows: idx } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_indexes
     WHERE indexname = 'idx_inventory_reservations_expiring'`
  );

  const mark = (v) => (v === null ? '[ ]' : v ? '[x]' : '[ ]');
  console.log(`\n${label}`);
  console.log(`  ${mark(orders)} orders.payment_method accepts online methods`);
  console.log(`  ${mark(groups)} checkout_groups.payment_method accepts online methods`);
  console.log(`  ${idx[0].n === 1 ? '[x]' : '[ ]'} index idx_inventory_reservations_expiring`);

  return orders === true && groups === true && idx[0].n === 1;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const sql = sliceBlock(schema, MARKER);
  if (!sql) {
    console.error('Could not find the Sprint 7 marker in schema.sql — nothing to run.');
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
    if (err.code === '23514') {
      console.error('\n  An existing row already violates the new constraint — check payment_method values.');
    }
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const ok = await report('After:');
  await pool.end();
  console.log(ok ? '\nSprint 7 applied.\n' : '\nSomething is still missing — check the errors above.\n');
  process.exit(ok ? 0 : 1);
}

main();
