const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const pool = require('../config/db');

/**
 * Image uploads, stored in the database (table media_files) under a path such
 * as /uploads/products/abc.webp. Rows keep only that path, and the admin panel
 * and the app prefix their API base URL to show it, so moving the server never
 * means rewriting rows — and hosts with a throwaway disk (Render's free plan,
 * serverless) keep every image across redeploys.
 *
 * Files saved to <backend>/uploads/ before this change are still served from
 * disk (see serveUpload) until scripts/migrate-media-files.js copies them in.
 */
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads');

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// The admin path segment the upload is posted under → the folder it lands in.
// Posting under the module's own segment means the RBAC gate already asks for
// that module's edit permission; no separate rule is needed.
const FOLDERS = {
  products: 'products',
  media: 'products',
  banners: 'banners',
  brands: 'brands',
  categories: 'categories',
  vendors: 'vendors',
  settings: 'settings',
  platforms: 'platforms',
  'delivery-partners': 'partners',
  // Shop ad banners (Ad Promotions); guarded by the ad_promotions module.
  ads: 'ads',
};

const MAX_BYTES = 5 * 1024 * 1024;

// Vendor KYC pictures (VK1): uploaded only by the vendor's own route.
const PRIVATE_FOLDER = 'kyc';

// Kept in memory so the bytes can be checked before anything is stored.
const receive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
}).single('file');

/**
 * The image type from the file's first bytes. The browser's declared type and
 * the file name are both the uploader's word for it, so neither is trusted.
 */
function detectImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function uploadImage(req, res, next) {
  const folder = FOLDERS[req.params.area];
  if (!folder) return res.status(404).json({ message: 'Uploads are not supported here' });
  saveImage(folder, req, res, next);
}

/** The same upload for a route outside the admin panel, into a fixed folder. */
function uploadTo(folder) {
  return (req, res, next) => saveImage(folder, req, res, next);
}

function saveImage(folder, req, res, next) {
  receive(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ message: tooBig ? 'Image must be 5 MB or smaller' : err.message });
    }
    if (!req.file) return res.status(400).json({ message: "Send the image as multipart field 'file'" });

    const ext = detectImage(req.file.buffer);
    if (!ext) return res.status(400).json({ message: 'Only JPG, PNG or WebP images are accepted' });

    try {
      // ID documents are served only to someone holding the link, so their
      // names are long enough that the link can't be guessed.
      const name = `${Date.now()}-${crypto.randomBytes(folder === PRIVATE_FOLDER ? 24 : 6).toString('hex')}.${ext}`;
      const filePath = `/uploads/${folder}/${name}`;
      await pool.query('INSERT INTO media_files (path, mime, bytes, size) VALUES ($1, $2, $3, $4)', [
        filePath,
        MIME[ext],
        req.file.buffer,
        req.file.size,
      ]);
      res.status(201).json({ path: filePath, size: req.file.size });
    } catch (e) {
      next(e);
    }
  });
}

/**
 * GET /uploads/<folder>/<name> from media_files. Anything not there falls
 * through to the old on-disk files. Names are generated server-side and never
 * reused, so a path never changes content and can be cached hard.
 */
async function serveUpload(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!/^\/[\w-]+\/[\w.-]+$/.test(req.path)) return next();
  try {
    const { rows } = await pool.query('SELECT mime, bytes FROM media_files WHERE path = $1', [`/uploads${req.path}`]);
    if (!rows[0]) return next();
    res.set({
      'Content-Type': rows[0].mime,
      // Vendor ID documents stay out of shared caches.
      'Cache-Control': req.path.startsWith(`/${PRIVATE_FOLDER}/`) ? 'private, no-store' : 'public, max-age=2592000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(rows[0].bytes);
  } catch (e) {
    next(e);
  }
}

module.exports = { UPLOAD_ROOT, uploadImage, uploadTo, serveUpload };
