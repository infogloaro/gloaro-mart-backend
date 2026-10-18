/**
 * Applies the invoices schema, then issues an invoice for every delivered
 * order that has none — dated when it was delivered, numbered in delivery
 * order. Safe to run more than once: it is also how a missed invoice is fixed.
 */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");
const { issueForOrder } = require("../src/services/invoices");

const MARKER = "-- ===== INVOICES & GST (PHASE 40) =====";

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("Invoices schema marker not found");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schema.slice(start));
    await client.query("COMMIT");
    console.log("Invoices migration applied.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    `SELECT o.id, COALESCE(
       (SELECT MAX(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'delivered'),
       o.updated_at) AS delivered_at
     FROM orders o
     WHERE o.status = 'delivered' AND o.replacement_of_order_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id AND i.status = 'issued')
     ORDER BY delivered_at, o.id`
  );
  let issued = 0;
  for (const r of rows) {
    try {
      await issueForOrder(r.id, { at: r.delivered_at });
      issued += 1;
    } catch (err) {
      console.error(`Order ${r.id}: ${err.message}`);
    }
  }
  console.log(`Invoices issued for ${issued} delivered order(s).`);
  await pool.end();
}

main().catch((error) => {
  console.error("Invoices migration failed:", error.message);
  process.exitCode = 1;
});
