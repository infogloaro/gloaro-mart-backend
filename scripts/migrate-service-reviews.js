/** Applies the service reviews schema (NS9). Safe to run more than once. */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");

const MARKER = "-- ===== SERVICE REVIEWS (NS9) =====";

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("Service reviews schema marker not found");
  // To the next section's marker, or the end of the file.
  const next = schema.indexOf("\n-- ===== ", start + MARKER.length);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schema.slice(start, next === -1 ? undefined : next));
    await client.query("COMMIT");
    console.log("Service reviews migration applied.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Service reviews migration failed:", error.message);
  process.exitCode = 1;
});
