/**
 * Applies the commission plans and vendor KYC sections of schema.sql.
 *
 *   node scripts/migrate-vendor-modules.js
 *
 * Same slice-and-run approach as the other migration scripts: both blocks are
 * written with IF NOT EXISTS throughout and run in one transaction, so
 * re-running is safe.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== VENDOR COMMISSION PLANS (PHASE 9) =====';

const TABLES = ['commission_plans', 'vendor_documents'];

async function report(label) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES]
  );
  const present = new Set(rows.map((r) => r.table_name));

  let globalRule = false;
  if (present.has('commission_plans')) {
    const { rows: plans } = await pool.query("SELECT id FROM commission_plans WHERE scope = 'global'");
    globalRule = plans.length === 1;
  }

  console.log(`\n${label}`);
  for (const t of TABLES) {
    console.log(`  ${present.has(t) ? '[x]' : '[ ]'} table  ${t}`);
  }
  console.log(`  ${globalRule ? '[x]' : '[ ]'} row    commission_plans (global fallback)`);

  return TABLES.every((t) => present.has(t)) && globalRule;
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const start = schema.indexOf(MARKER);
  if (start === -1) {
    console.error('Could not find the commission plans marker in schema.sql — nothing to run.');
    process.exit(1);
  }
  // Both sections sit at the end of the file, so one slice covers them.
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
  console.log(ok ? '\nVendor commission and KYC tables ready.\n' : '\nSomething is still missing — check above.\n');
  process.exit(ok ? 0 : 1);
}

main();
