/**
 * Adds a free-text sub-category to products (Fashion → Men / Women, Gadgets →
 * Mobiles / Laptops …). The app shows them as chips once a category is chosen,
 * and search filters by `subcategory` and returns `facets.subcategories`.
 * Products without one still show under "All".
 *
 *   node scripts/migrate-subcategories.js
 */
require('dotenv').config();
const pool = require('../src/config/db');

async function main() {
  try {
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_category_subcategory ON products(category, lower(subcategory))`);
    const { rows } = await pool.query(`SELECT count(*)::int AS total, count(subcategory)::int AS with_sub FROM products`);
    console.log(`Migration complete. Products: ${rows[0].total}, with a sub-category: ${rows[0].with_sub}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
