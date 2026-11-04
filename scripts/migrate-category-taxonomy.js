/**
 * Category taxonomy (WORK_PLAN CT1): an admin-owned list of sub-categories per
 * category, and filters that apply to several categories at once (Size for
 * Men's, Women's and Kids' Fashion).
 *
 *   category_subcategories  one row per sub-category; products still store the
 *                           sub-category name in products.subcategory
 *   product_attributes.category_ids  every category the filter applies to
 *                           (category_id stays the main one)
 *
 * Safe to run again.
 *   node scripts/migrate-category-taxonomy.js
 */
require('dotenv').config();
const pool = require('../src/config/db');

async function main() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS category_subcategories (
        id SERIAL PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_category_subcategories_name ON category_subcategories(category_id, lower(name))`
    );
    await pool.query(`ALTER TABLE product_attributes ADD COLUMN IF NOT EXISTS category_ids INTEGER[]`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_attributes_category_ids ON product_attributes USING GIN (category_ids)`);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM category_subcategories`);
    console.log(`Migration complete. Sub-categories: ${rows[0].n}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
