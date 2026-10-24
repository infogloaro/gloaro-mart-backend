/**
 * Copies the app's built-in strings (assets/i18n/<lang>.json in the Flutter
 * repo) into app_strings (LG1), so the admin can see and edit every one.
 * Only adds what is missing: wording an admin already changed is kept.
 *
 *   node scripts/seed-app-strings.js D:\G_mart\gloaro_mart\assets\i18n
 */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/db");

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("Pass the app's assets/i18n folder");
  const { rows: languages } = await pool.query("SELECT code FROM app_languages");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { code } of languages) {
      const file = path.join(dir, `${code}.json`);
      if (!fs.existsSync(file)) continue;
      const strings = JSON.parse(fs.readFileSync(file, "utf8"));
      let added = 0;
      for (const [key, text] of Object.entries(strings)) {
        if (typeof text !== "string" || !text.trim()) continue;
        const r = await client.query(
          "INSERT INTO app_strings (key, lang, text) VALUES ($1, $2, $3) ON CONFLICT (key, lang) DO NOTHING",
          [key, code, text]
        );
        added += r.rowCount;
      }
      console.log(`${code}: ${added} added of ${Object.keys(strings).length}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Seeding app strings failed:", error.message);
  process.exitCode = 1;
});
