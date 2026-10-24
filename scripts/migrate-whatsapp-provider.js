/** Applies WHATSAPP PROVIDER (PHASE WP1) only and seeds the new draft template and rule. Safe to run more than once. */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");
const { seedDraftTemplates } = require("../src/services/whatsappTemplates");
const { seedRules } = require("../src/services/whatsappEvents");

const MARKER = "-- ===== WHATSAPP PROVIDER (PHASE WP1) =====";
const NEXT = "\n-- ===== ";

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("WP1 schema marker not found");
  const end = schema.indexOf(NEXT, start + MARKER.length);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schema.slice(start, end === -1 ? undefined : end));
    const added = await seedDraftTemplates(client);
    await seedRules(client);
    await client.query("COMMIT");
    console.log(`WhatsApp provider migration applied (${added} draft template(s) added, event rules seeded).`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("WhatsApp provider migration failed:", error.message);
  process.exitCode = 1;
});
