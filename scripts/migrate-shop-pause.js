/** Applies the shop pause & busy schema (VD2). Safe to run more than once. */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");

const MARKER = "-- ===== SHOP PAUSE & BUSY (VD2) =====";

/** The VD2 section of schema.sql, up to the next section or the end. */
function section() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("Shop pause schema marker not found");
  const next = schema.indexOf("-- =====", start + MARKER.length);
  return schema.slice(start, next === -1 ? undefined : next);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(section());
    await client.query("COMMIT");
    console.log("Shop pause & busy migration applied.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Shop pause & busy migration failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { section };
