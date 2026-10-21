/** Adds sign-in usernames to users. Safe to run more than once. */
require('dotenv').config();
const pool = require('../src/config/db');

async function main() {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username)) WHERE username IS NOT NULL');
  console.log('Usernames migration applied.');
  await pool.end();
}

main().catch((error) => {
  console.error('Usernames migration failed:', error.message);
  process.exitCode = 1;
});
