/**
 * Applies the product moderation section of schema.sql.
 *
 *   node scripts/migrate-product-moderation.js
 *
 * Grandfathers every existing product as 'approved' — see the note in
 * schema.sql. Re-running is safe and will not approve a pending product.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== PRODUCT MODERATION (PHASE 17) =====';

async function report(label) {
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'products' AND column_name = 'moderation_status'`
  );
  const present = cols.length === 1;

  let counts = null;
  if (present) {
    const { rows } = await pool.query(
      `SELECT moderation_status, COUNT(*)::int AS n FROM products GROUP BY moderation_status ORDER BY 1`
    );
    counts = rows;
  }

  console.log(`\n${label}`);
  console.log(`  ${present ? '[x]' : '[ ]'} column products.moderation_status`);
  if (counts) {
    for (const row of counts) console.log(`      ${row.moderation_status.padEnd(9)} ${row.n}`);
  }
  return present;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const start = schema.indexOf(MARKER);
  if (start === -1) {
    console.error('Could not find the product moderation marker in schema.sql — nothing to run.');
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
  console.log(ok ? '\nModeration queue ready.\n' : '\nSomething is still missing — check above.\n');
  process.exit(ok ? 0 : 1);
}

main();
