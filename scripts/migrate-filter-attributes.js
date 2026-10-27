/**
 * Filter attributes (WORK_PLAN F3): the attribute registry becomes the
 * category filter definitions, and a product can carry attribute values of its
 * own (not only through variants).
 *
 *   product_attributes: is_filter (show in the app's filter page), filter_kind
 *   (chips | swatch | range | toggle), unit ("GB", "inch"), subcategories
 *   (NULL = whole category; else only when one of these sub-categories is
 *   chosen, e.g. Sleeve → Men / Women / Kids).
 *   attribute_values.color_hex: the swatch colour ("#0D4FD1") for swatch kinds.
 *   product_attribute_values: product-level values (Material: Cotton, RAM: 8 GB)
 *   for products with no variants — and for facts that don't vary by variant.
 *
 *   node scripts/migrate-filter-attributes.js
 */
require('dotenv').config();
const pool = require('../src/config/db');

async function main() {
  try {
    await pool.query(`ALTER TABLE product_attributes ADD COLUMN IF NOT EXISTS is_filter BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE product_attributes ADD COLUMN IF NOT EXISTS filter_kind TEXT NOT NULL DEFAULT 'chips'`);
    await pool.query(`ALTER TABLE product_attributes DROP CONSTRAINT IF EXISTS product_attributes_filter_kind_check`);
    await pool.query(
      `ALTER TABLE product_attributes ADD CONSTRAINT product_attributes_filter_kind_check
       CHECK (filter_kind IN ('chips', 'swatch', 'range', 'toggle'))`
    );
    await pool.query(`ALTER TABLE product_attributes ADD COLUMN IF NOT EXISTS unit TEXT`);
    await pool.query(`ALTER TABLE product_attributes ADD COLUMN IF NOT EXISTS subcategories TEXT[]`);
    await pool.query(`ALTER TABLE attribute_values ADD COLUMN IF NOT EXISTS color_hex TEXT`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS product_attribute_values (
         product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
         attribute_value_id INTEGER NOT NULL REFERENCES attribute_values(id) ON DELETE CASCADE,
         PRIMARY KEY (product_id, attribute_value_id)
       )`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_product_attribute_values_value ON product_attribute_values(attribute_value_id)`
    );
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM product_attributes) AS attributes,
              (SELECT count(*)::int FROM product_attribute_values) AS product_values`
    );
    console.log(`Migration complete. Attributes: ${rows[0].attributes}, product-level values: ${rows[0].product_values}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
