const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const multer = require('multer');

/**
 * Admin image uploads, saved as files under <backend>/uploads/<folder>/.
 *
 * The database keeps only the relative path (/uploads/products/abc.webp), and
 * the admin panel and the app each prefix their API base URL to show it, so
 * moving the server never means rewriting rows.
 *
 * Needs a server with a writable, persistent disk (local, Render, a VPS). A
 * serverless host such as Vercel discards anything written here.
 */
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads');

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

// Kept in memory so the bytes can be checked before anything touches the disk.
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
      const dir = path.join(UPLOAD_ROOT, folder);
      await fs.mkdir(dir, { recursive: true });
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
      await fs.writeFile(path.join(dir, name), req.file.buffer);
      res.status(201).json({ path: `/uploads/${folder}/${name}`, size: req.file.size });
    } catch (e) {
      next(e);
    }
  });
}

module.exports = { UPLOAD_ROOT, uploadImage, uploadTo };
