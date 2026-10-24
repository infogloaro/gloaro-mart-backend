/**
 * Applies WHATSAPP BILLS & INVOICES (PHASE WP2) only, and switches on the
 * order-update rules still off (invoice, return pickup, shop alert) — from
 * now, so nothing old is sent. Safe to run more than once.
 */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");

const MARKER = "-- ===== WHATSAPP BILLS & INVOICES (PHASE WP2) =====";
const NEXT = "\n-- ===== ";
const SWITCH_ON = ["invoice_ready", "return_pickup", "shop_new_order"];

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("WP2 schema marker not found");
  const end = schema.indexOf(NEXT, start + MARKER.length);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schema.slice(start, end === -1 ? undefined : end));
    const { rows } = await client.query(
      `UPDATE whatsapp_event_rules SET enabled = TRUE, enabled_at = now(), updated_at = now()
       WHERE event = ANY($1) AND NOT enabled RETURNING event`,
      [SWITCH_ON]
    );
    await client.query("COMMIT");
    console.log(`WhatsApp bills migration applied; switched on: ${rows.map((r) => r.event).join(", ") || "none (already on)"}.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("WhatsApp bills migration failed:", error.message);
  process.exitCode = 1;
});
