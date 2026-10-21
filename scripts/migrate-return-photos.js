/** Adds the customer's photos to return requests. Safe to run more than once. */
require('dotenv').config();
const pool = require('../src/config/db');

async function main() {
  await pool.query(`ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]'::jsonb`);
  console.log('Return photos migration applied.');
  await pool.end();
}

main().catch((error) => {
  console.error('Return photos migration failed:', error.message);
  process.exitCode = 1;
});
