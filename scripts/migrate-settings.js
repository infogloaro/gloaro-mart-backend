/**
 * Applies only the platform settings section of schema.sql.
 *
 *   node scripts/migrate-settings.js
 *
 * Same slice-and-run approach as the other migration scripts: the block is
 * written with IF NOT EXISTS / ON CONFLICT throughout and runs in one
 * transaction, so re-running it is safe.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== PLATFORM SETTINGS (GENERAL SETTINGS) =====';

async function report(label) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'platform_settings'`
  );
  const present = rows.length === 1;
  let seeded = false;
  if (present) {
    const { rows: settings } = await pool.query('SELECT id FROM platform_settings WHERE id = 1');
    seeded = settings.length === 1;
  }
  console.log(`\n${label}`);
  console.log(`  ${present ? '[x]' : '[ ]'} table  platform_settings`);
  console.log(`  ${seeded ? '[x]' : '[ ]'} row    id = 1`);
  return present && seeded;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const start = schema.indexOf(MARKER);
  if (start === -1) {
    console.error('Could not find the platform settings marker in schema.sql — nothing to run.');
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
  console.log(ok ? '\nSettings row ready.\n' : '\nSomething is still missing — check the errors above.\n');
  process.exit(ok ? 0 : 1);
}

main();
