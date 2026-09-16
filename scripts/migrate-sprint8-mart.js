/**
 * Applies only the Sprint 8 section of schema.sql.
 *
 *   node scripts/migrate-sprint8-mart.js
 *
 * See migrate-sprint7.js for why this slices schema.sql instead of running it
 * whole, and why the slice stops at the next `-- ===== ` banner.
 *
 * Safe to re-run: every statement in the block is `ADD COLUMN IF NOT EXISTS`.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== SPRINT 8: MART TAB — SHOP DISCOVERY (PHASE 14) =====';

function sliceBlock(schema, marker) {
  const start = schema.indexOf(marker);
  if (start === -1) return null;
  const next = schema.indexOf('\n-- ===== ', start + marker.length);
  return next === -1 ? schema.slice(start) : schema.slice(start, next);
}

async function report(label) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'vendor_profiles'
       AND column_name IN ('description', 'logo_url', 'cover_image_url')`
  );
  const have = new Set(rows.map((r) => r.column_name));
  const columns = ['description', 'logo_url', 'cover_image_url'];
  console.log(`\n${label}`);
  for (const c of columns) console.log(`  ${have.has(c) ? '[x]' : '[ ]'} vendor_profiles.${c}`);
  return columns.every((c) => have.has(c));
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const sql = sliceBlock(schema, MARKER);
  if (!sql) {
    console.error('Could not find the Sprint 8 marker in schema.sql — nothing to run.');
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
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const ok = await report('After:');
  await pool.end();
  console.log(ok ? '\nSprint 8 applied.\n' : '\nSomething is still missing — check the errors above.\n');
  process.exit(ok ? 0 : 1);
}

main();
