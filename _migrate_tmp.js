const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_lWR9GyUCez4D@ep-crimson-rain-aypi0ljq-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

let sql = fs.readFileSync('schema.sql', 'utf8');

// Make CREATE TABLE/INDEX idempotent
sql = sql.replace(/CREATE TABLE(?!\s+IF\s+NOT\s+EXISTS)/gi, 'CREATE TABLE IF NOT EXISTS');
sql = sql.replace(/CREATE INDEX(?!\s+IF\s+NOT\s+EXISTS)/gi, 'CREATE INDEX IF NOT EXISTS');
sql = sql.replace(/CREATE UNIQUE INDEX(?!\s+IF\s+NOT\s+EXISTS)/gi, 'CREATE UNIQUE INDEX IF NOT EXISTS');

// Split on semicolons that end a statement (naive but good enough for DDL)
const statements = sql
  .split(/;\s*\n/)
  .map(s => s.trim())
  .filter(s => s.length > 0);

(async () => {
  let ok = 0, skipped = 0, failed = 0;
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      ok++;
    } catch (e) {
      const msg = e.message;
      // Harmless "already exists" errors
      if (msg.includes('already exists') || msg.includes('does not exist') && stmt.toUpperCase().includes('DROP')) {
        skipped++;
      } else {
        failed++;
        console.error(`FAILED: ${msg}\n  Statement: ${stmt.substring(0, 120)}...\n`);
      }
    }
  }
  console.log(`\nDone. ${ok} succeeded, ${skipped} skipped (already exist), ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
})();
