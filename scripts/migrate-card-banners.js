/**
 * Adds a `placement` to banners so the same upload flow can fill more than the
 * home carousel. Existing rows are all home banners, which is why the column
 * defaults to 'home' — no backfill is needed.
 *
 *   npm run migrate:card-banners
 */
require('dotenv').config();
const pool = require('../src/config/db');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `ALTER TABLE banners
         ADD COLUMN IF NOT EXISTS placement TEXT NOT NULL DEFAULT 'home'`
    );

    // Guards the API's allow-list at the database level too, so a bad write
    // from anywhere fails loudly instead of producing a banner nothing renders.
    await client.query(`ALTER TABLE banners DROP CONSTRAINT IF EXISTS banners_placement_check`);
    await client.query(
      `ALTER TABLE banners ADD CONSTRAINT banners_placement_check
         CHECK (placement IN ('home', 'card_shop', 'card_b2b', 'card_nearme'))`
    );

    // The public read is always filtered by placement now.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_banners_placement_active_sort
         ON banners(placement, is_active, sort_order)`
    );

    await client.query('COMMIT');

    const { rows } = await client.query(
      `SELECT placement, count(*)::int AS count FROM banners GROUP BY placement ORDER BY placement`
    );
    console.log('Migration complete. Banners by placement:');
    if (rows.length === 0) console.log('  (none yet)');
    for (const r of rows) console.log(`  ${r.placement.padEnd(12)} ${r.count}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
