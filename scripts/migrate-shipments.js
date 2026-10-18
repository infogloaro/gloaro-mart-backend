/** Applies the shipments schema. Safe to run more than once. */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");

const MARKER = "-- ===== SHIPMENTS (PHASE 37) =====";

async function main() {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "schema.sql"),
    "utf8",
  );
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("Shipments schema marker not found");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schema.slice(start));
    await client.query("COMMIT");
    console.log("Shipments migration applied.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Shipments migration failed:", error.message);
  process.exitCode = 1;
});
