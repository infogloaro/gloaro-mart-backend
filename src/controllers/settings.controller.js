const pool = require('../config/db');

// Body key -> column. Everything here is optional on a PUT; only the keys the
// admin actually sent are written, so two people editing different sections
// cannot blank each other's fields.
const COLUMNS = {
  platformName: 'platform_name',
  tagline: 'tagline',
  logoUrl: 'logo_url',
  faviconUrl: 'favicon_url',
  supportEmail: 'support_email',
  supportPhone: 'support_phone',
  whatsappNumber: 'whatsapp_number',
  addressLine: 'address_line',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  gstNumber: 'gst_number',
  currencyCode: 'currency_code',
  invoicePrefix: 'invoice_prefix',
  instagramUrl: 'instagram_url',
  facebookUrl: 'facebook_url',
  youtubeUrl: 'youtube_url',
  maintenanceMode: 'maintenance_mode',
  maintenanceMessage: 'maintenance_message',
};

// Columns that are NOT NULL in the table, so an explicit null has to be refused
// rather than passed through to the database as a constraint violation.
const REQUIRED = ['platformName', 'currencyCode', 'invoicePrefix', 'maintenanceMode'];

const URL_FIELDS = ['logoUrl', 'faviconUrl', 'instagramUrl', 'facebookUrl', 'youtubeUrl'];

function validate(body) {
  for (const key of REQUIRED) {
    if (key in body && body[key] == null) return `${key} cannot be empty`;
  }
  if ('platformName' in body && (typeof body.platformName !== 'string' || !body.platformName.trim())) {
    return 'platformName must be a non-empty string';
  }
  if ('supportEmail' in body && body.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.supportEmail)) {
    return 'Enter a valid support email';
  }
  for (const field of ['supportPhone', 'whatsappNumber']) {
    if (field in body && body[field] && !/^\d{10}$/.test(String(body[field]).replace(/\D/g, '').slice(-10))) {
      return `${field} must be a 10-digit mobile number`;
    }
  }
  if ('pincode' in body && body.pincode && !/^\d{6}$/.test(body.pincode)) {
    return 'Pincode must be 6 digits';
  }
  // 15 characters: 2 state code, 10 PAN, 1 entity, 1 'Z', 1 checksum.
  if ('gstNumber' in body && body.gstNumber && !/^[0-9A-Z]{15}$/.test(String(body.gstNumber).toUpperCase())) {
    return 'GST number must be 15 characters';
  }
  if ('currencyCode' in body && body.currencyCode && !/^[A-Za-z]{3}$/.test(body.currencyCode)) {
    return 'Currency must be a 3-letter code, e.g. INR';
  }
  for (const field of URL_FIELDS) {
    if (field in body && body[field] && !/^https?:\/\/\S+$/i.test(body[field])) {
      return `${field} must start with http:// or https://`;
    }
  }
  if ('maintenanceMode' in body && typeof body.maintenanceMode !== 'boolean') {
    return 'maintenanceMode must be a boolean';
  }
  return null;
}

async function readSettings() {
  const { rows } = await pool.query('SELECT * FROM platform_settings WHERE id = 1');
  return rows[0] || null;
}

// ── Public: what the app and storefront are allowed to see ──

async function getPublicSettings(req, res) {
  const settings = await readSettings();
  if (!settings) return res.status(404).json({ message: 'Settings have not been initialised' });
  res.json({
    platform_name: settings.platform_name,
    tagline: settings.tagline,
    logo_url: settings.logo_url,
    support_email: settings.support_email,
    support_phone: settings.support_phone,
    whatsapp_number: settings.whatsapp_number,
    currency_code: settings.currency_code,
    instagram_url: settings.instagram_url,
    facebook_url: settings.facebook_url,
    youtube_url: settings.youtube_url,
    maintenance_mode: settings.maintenance_mode,
    maintenance_message: settings.maintenance_mode ? settings.maintenance_message : null,
  });
}

// ── Admin ──

async function getSettings(req, res) {
  const settings = await readSettings();
  if (!settings) return res.status(404).json({ message: 'Settings have not been initialised' });
  res.json(settings);
}

async function updateSettings(req, res) {
  const body = req.body || {};
  const invalid = validate(body);
  if (invalid) return res.status(400).json({ message: invalid });

  const assignments = [];
  const params = [];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (!(key in body)) continue;
    let value = body[key];
    if (typeof value === 'string') value = value.trim() || null;
    if (key === 'gstNumber' && value) value = String(value).toUpperCase();
    if (key === 'currencyCode' && value) value = String(value).toUpperCase();
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  }
  if (assignments.length === 0) {
    return res.status(400).json({ message: 'No updatable fields supplied' });
  }

  const { rows } = await pool.query(
    `UPDATE platform_settings SET ${assignments.join(', ')}, updated_at = now() WHERE id = 1 RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Settings have not been initialised' });
  res.json(rows[0]);
}

module.exports = { getPublicSettings, getSettings, updateSettings };
