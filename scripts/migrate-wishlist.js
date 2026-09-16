/**
 * Applies only the "Wishlist" section of schema.sql.
 *
 *   node scripts/migrate-wishlist.js
 *
 * schema.sql is the full history of the database and its early statements are
 * not idempotent, so running the whole file is not an option. This slices out
 * the one block and runs it in a single transaction — either the whole
 * migration lands or none of it does.
 *
 * Safe to re-run: every statement in the block is IF NOT EXISTS.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== WISHLIST (PHASE 13) =====';

/** The block starting at `marker`, up to the next section banner. */
function sliceBlock(schema, marker) {
  const start = schema.indexOf(marker);
  if (start === -1) return null;
  const next = schema.indexOf('\n-- ===== ', start + marker.length);
  return next === -1 ? schema.slice(start) : schema.slice(start, next);
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const block = sliceBlock(schema, MARKER);
  if (!block) {
    console.error(`Could not find "${MARKER}" in schema.sql`);
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(block);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('wishlist_items')
     ORDER BY table_name`
  );
  console.log('Tables present:', rows.map((r) => r.table_name).join(', ') || '(none)');
  await pool.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
