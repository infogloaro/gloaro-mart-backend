/** Applies the public offer moderation schema (SB6b). Safe to run more than once. */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");

const MARKER = "-- ===== PUBLIC OFFER MODERATION (SB6b) =====";

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("Public offer moderation schema marker not found");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schema.slice(start));
    await client.query("COMMIT");
    console.log("Public offer moderation migration applied.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Public offer moderation migration failed:", error.message);
  process.exitCode = 1;
});
