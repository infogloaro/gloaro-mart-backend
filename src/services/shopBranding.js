const pool = require('../config/db');

/**
 * Shop branding & gallery (SB1, schema "SHOP BRANDING & GALLERY"): the words
 * and pictures customers see on a shop page. Shops write their own; admins can
 * correct the words and hide a photo. Pictures must be ones uploaded through
 * the vendors upload area, so a profile can't point at someone else's site.
 */

const IMAGE_PATH = /^\/uploads\/vendors\/[\w.-]+\.(jpg|png|webp)$/;
const MAX_DESCRIPTION = 1000;
const MAX_CAPTION = 140;
const MAX_PHOTOS = 12;

class BrandingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The branding fields present in a request body, checked. A field left out
 * stays as it is; '' or null clears it. Returns { description?, logo_url?,
 * cover_image_url?, contact? } with only the fields to change.
 */
function readBranding(body = {}) {
  const out = {};
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') throw new BrandingError(400, 'description must be text.');
    const d = (body.description ?? '').trim();
    if (d.length > MAX_DESCRIPTION) throw new BrandingError(400, `The description is at most ${MAX_DESCRIPTION} characters.`);
    out.description = d || null;
  }
  for (const [key, col, label] of [['logoUrl', 'logo_url', 'logo'], ['coverImageUrl', 'cover_image_url', 'cover photo']]) {
    if (body[key] === undefined) continue;
    const v = typeof body[key] === 'string' ? body[key].trim() : body[key];
    if (v === null || v === '') {
      out[col] = null;
    } else if (typeof v !== 'string' || !IMAGE_PATH.test(v)) {
      throw new BrandingError(400, `Upload the ${label} first (it is saved under /uploads/vendors).`);
    } else {
      out[col] = v;
    }
  }
  if (body.contact !== undefined) out.contact = readContact(body.contact);
  return out;
}

/**
 * AB2: what the shop chooses to publish for customers — never its login
 * phone or email, only what it types here (the landmark is the existing
 * vendor_profiles.landmark). `contact` replaces the whole
 * set ({} clears it); every key is optional. Returns the cleaned object.
 */
const CONTACT_KEYS = ['phone', 'altPhone', 'whatsapp', 'email', 'website', 'establishedYear', 'instagram', 'facebook'];

function readContact(c) {
  if (c === null) return {};
  if (typeof c !== 'object' || Array.isArray(c)) throw new BrandingError(400, 'contact must be an object.');
  const unknown = Object.keys(c).filter((k) => !CONTACT_KEYS.includes(k));
  if (unknown.length) throw new BrandingError(400, `Unknown contact field: ${unknown.join(', ')}.`);
  const text = (k) => (typeof c[k] === 'string' ? c[k].trim() : c[k] == null ? '' : String(c[k]).trim());
  const out = {};
  // Indian numbers: a mobile (+91 optional) or, for the second line, a landline with its STD code.
  const phone = (k, label, landline) => {
    const v = text(k).replace(/[\s()-]/g, '');
    if (!v) return;
    const mobile = v.match(/^(?:\+?91|0)?([6-9]\d{9})$/);
    if (mobile) out[k] = `+91${mobile[1]}`;
    else if (landline && /^0\d{9,10}$/.test(v)) out[k] = v;
    else throw new BrandingError(400, `${label} must be a 10-digit Indian ${landline ? 'mobile or a landline with its STD code' : 'mobile number'}.`);
  };
  phone('phone', 'The phone number', false);
  phone('altPhone', 'The other phone number', true);
  phone('whatsapp', 'The WhatsApp number', false);
  const email = text('email');
  if (email) {
    if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new BrandingError(400, 'The email address does not look right.');
    out.email = email.toLowerCase();
  }
  let site = text('website');
  if (site) {
    if (!/^https?:\/\//i.test(site)) site = `https://${site}`;
    let u;
    try { u = new URL(site); } catch { u = null; }
    if (!u || !/\.[a-z]{2,}$/i.test(u.hostname) || site.length > 200) throw new BrandingError(400, 'The website must be a web address, like www.myshop.in.');
    out.website = u.toString();
  }
  const year = text('establishedYear');
  if (year) {
    const y = Number(year);
    if (!Number.isInteger(y) || y < 1800 || y > new Date().getFullYear()) throw new BrandingError(400, 'The year the shop started must be between 1800 and this year.');
    out.establishedYear = y;
  }
  // Social: a handle (@name) or the profile link; stored as the link.
  const social = (k, host, handle, label) => {
    const v = text(k);
    if (!v) return;
    const m = v.match(new RegExp(`^(?:https?://)?(?:www\\.|m\\.)?${host.replace('.', '\\.')}/([^/?#\\s]+)/?(?:[?#].*)?$`, 'i'));
    const name = m ? m[1] : v.replace(/^@/, '');
    if (!handle.test(name)) throw new BrandingError(400, `The ${label} must be your page name or its link.`);
    out[k] = `https://www.${host}/${name}`;
  };
  social('instagram', 'instagram.com', /^[A-Za-z0-9._]{1,30}$/, 'Instagram account');
  social('facebook', 'facebook.com', /^[A-Za-z0-9.-]{1,80}$/, 'Facebook page');
  return out;
}

/** SQL pieces that set [fields] on vendor_profiles, numbered from [from]. */
function brandingSet(fields, from) {
  const cols = Object.keys(fields);
  return { sql: cols.map((c, i) => `${c} = $${from + i}`), values: cols.map((c) => fields[c]) };
}

/** Visible photos for customers, in the shop's order. */
async function publicGallery(vendorId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, url, caption FROM vendor_gallery WHERE vendor_id = $1 AND status = 'visible' ORDER BY sort_order, id`,
    [vendorId]
  );
  return rows;
}

/** Every photo with its status, for the shop itself or an admin. */
async function fullGallery(vendorId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, url, caption, sort_order, status, hidden_reason, created_at FROM vendor_gallery
     WHERE vendor_id = $1 ORDER BY sort_order, id`,
    [vendorId]
  );
  return rows.map(toJson);
}

function toJson(r) {
  return {
    id: r.id,
    url: r.url,
    caption: r.caption,
    sortOrder: r.sort_order,
    status: r.status,
    hiddenReason: r.hidden_reason,
    createdAt: r.created_at,
  };
}

function readCaption(v) {
  if (v === undefined) return undefined;
  if (v !== null && typeof v !== 'string') throw new BrandingError(400, 'caption must be text.');
  const c = (v ?? '').trim();
  if (c.length > MAX_CAPTION) throw new BrandingError(400, `A caption is at most ${MAX_CAPTION} characters.`);
  return c || null;
}

async function addPhoto(vendorId, body = {}) {
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!IMAGE_PATH.test(url)) throw new BrandingError(400, 'Upload the photo first (it is saved under /uploads/vendors).');
  const caption = readCaption(body.caption) ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One shop at a time, so two quick adds can't pass the limit together.
    await client.query('SELECT id FROM vendor_profiles WHERE id = $1 FOR UPDATE', [vendorId]);
    const { rows: n } = await client.query('SELECT COUNT(*)::int AS n, COALESCE(MAX(sort_order), -1) AS last FROM vendor_gallery WHERE vendor_id = $1', [vendorId]);
    if (n[0].n >= MAX_PHOTOS) throw new BrandingError(409, `A shop shows up to ${MAX_PHOTOS} photos. Remove one first.`);
    const { rows } = await client.query(
      'INSERT INTO vendor_gallery (vendor_id, url, caption, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [vendorId, url, caption, n[0].last + 1]
    );
    await client.query('COMMIT');
    return toJson(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Caption and/or position of one of the shop's own photos. */
async function updatePhoto(vendorId, photoId, body = {}) {
  const caption = readCaption(body.caption);
  let sort;
  if (body.sortOrder !== undefined) {
    sort = Number(body.sortOrder);
    if (!Number.isInteger(sort) || sort < 0) throw new BrandingError(400, 'sortOrder is a whole number from 0.');
  }
  const { rows } = await pool.query(
    `UPDATE vendor_gallery SET
       caption = CASE WHEN $3 THEN $4 ELSE caption END,
       sort_order = COALESCE($5, sort_order),
       updated_at = now()
     WHERE id = $1 AND vendor_id = $2 RETURNING *`,
    [Number(photoId), vendorId, caption !== undefined, caption ?? null, sort ?? null]
  );
  if (!rows[0]) throw new BrandingError(404, 'Photo not found');
  return toJson(rows[0]);
}

async function removePhoto(vendorId, photoId) {
  const { rowCount } = await pool.query('DELETE FROM vendor_gallery WHERE id = $1 AND vendor_id = $2', [Number(photoId), vendorId]);
  if (!rowCount) throw new BrandingError(404, 'Photo not found');
}

/** Admin: hide a photo (with the reason the shop sees) or show it again. */
async function setPhotoStatus(vendorId, photoId, { status, reason } = {}, userId) {
  if (!['visible', 'hidden'].includes(status)) throw new BrandingError(400, "status is 'visible' or 'hidden'.");
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (status === 'hidden' && !why) throw new BrandingError(400, 'Say why the photo is hidden; the shop sees it.');
  if (why.length > 300) throw new BrandingError(400, 'The reason is at most 300 characters.');
  const { rows: before } = await pool.query('SELECT * FROM vendor_gallery WHERE id = $1 AND vendor_id = $2', [Number(photoId), vendorId]);
  if (!before[0]) throw new BrandingError(404, 'Photo not found');
  const { rows } = await pool.query(
    `UPDATE vendor_gallery SET status = $2, hidden_reason = $3, hidden_by = $4, updated_at = now() WHERE id = $1 RETURNING *`,
    [before[0].id, status, status === 'hidden' ? why : null, status === 'hidden' ? userId : null]
  );
  return { before: toJson(before[0]), after: toJson(rows[0]) };
}

module.exports = {
  BrandingError,
  MAX_PHOTOS,
  readBranding,
  readContact,
  brandingSet,
  publicGallery,
  fullGallery,
  addPhoto,
  updatePhoto,
  removePhoto,
  setPhotoStatus,
};
