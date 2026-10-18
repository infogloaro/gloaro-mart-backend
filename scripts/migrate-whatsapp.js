/** Applies the WhatsApp schema (PHASE 49 onwards, incl. bot access) and seeds the draft templates. Safe to run more than once. */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");
const { seedDraftTemplates } = require("../src/services/whatsappTemplates");
const { seedRules } = require("../src/services/whatsappEvents");

const MARKER = "-- ===== WHATSAPP (PHASE 49) =====";

async function main() {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "schema.sql"),
    "utf8",
  );
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("WhatsApp schema marker not found");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schema.slice(start));
    const added = await seedDraftTemplates(client);
    await seedRules(client);
    await client.query("COMMIT");
    console.log(`WhatsApp migration applied (${added} draft template(s) added, event rules seeded).`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("WhatsApp migration failed:", error.message);
  process.exitCode = 1;
});
