/** Applies the Ad Promotions schema (pricing, campaigns and on) and seeds the sample price list. Safe to run more than once. */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");
const { seedAdPricing } = require("../src/services/adSeeds");

const MARKER = "-- ===== AD PROMOTIONS — PRICING (PHASE 52) =====";

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("Ad Promotions schema marker not found");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schema.slice(start));
    await seedAdPricing(client);
    await client.query("COMMIT");
    console.log("Ad Promotions migration applied (sample price list seeded where empty).");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Ad Promotions migration failed:", error.message);
  process.exitCode = 1;
});
