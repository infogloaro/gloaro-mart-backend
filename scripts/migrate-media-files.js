/**
 * Creates media_files and copies every image saved under <backend>/uploads/
 * into it, so uploads survive on hosts with a throwaway disk. Safe to run
 * more than once: existing paths are left as they are.
 */
require("dotenv").config();
const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../src/config/db");
const { UPLOAD_ROOT } = require("../src/controllers/upload.controller");

const MARKER = "-- ===== MEDIA FILES (UPLOADS STORED IN THE DATABASE) =====";
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

async function main() {
  const schema = await fs.readFile(path.join(__dirname, "..", "schema.sql"), "utf8");
  const start = schema.indexOf(MARKER);
  if (start === -1) throw new Error("Media files schema marker not found");
  const end = schema.indexOf("-- =====", start + MARKER.length);
  await pool.query(schema.slice(start, end === -1 ? undefined : end));

  let copied = 0;
  let skipped = 0;
  const folders = await fs.readdir(UPLOAD_ROOT, { withFileTypes: true }).catch(() => []);
  for (const folder of folders.filter((d) => d.isDirectory())) {
    for (const file of await fs.readdir(path.join(UPLOAD_ROOT, folder.name))) {
      const mime = MIME[path.extname(file).toLowerCase()];
      if (!mime) { skipped++; continue; }
      const bytes = await fs.readFile(path.join(UPLOAD_ROOT, folder.name, file));
      const { rowCount } = await pool.query(
        "INSERT INTO media_files (path, mime, bytes, size) VALUES ($1, $2, $3, $4) ON CONFLICT (path) DO NOTHING",
        [`/uploads/${folder.name}/${file}`, mime, bytes, bytes.length],
      );
      copied += rowCount;
    }
  }
  console.log(`Media files ready: ${copied} file(s) copied in, ${skipped} non-image file(s) skipped.`);
  await pool.end();
}

main().catch(async (error) => {
  console.error("Media files migration failed:", error.message);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
