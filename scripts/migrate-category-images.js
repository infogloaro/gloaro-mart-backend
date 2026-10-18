/**
 * Adds an optional picture to each category. The app shows it on the category
 * tiles (Home, Categories, Mart, Near Me); without one it falls back to a photo
 * bundled for the category's icon_key, so no backfill is needed.
 *
 *   npm run migrate:category-images
 */
require('dotenv').config();
const pool = require('../src/config/db');

async function main() {
  try {
    await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url TEXT`);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total, count(image_url)::int AS with_image FROM categories`
    );
    console.log(`Migration complete. Categories: ${rows[0].total}, with an image: ${rows[0].with_image}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
