const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');

/**
 * App languages (LG1): which languages the customer app offers and the
 * admin's wording for its screens. The app ships its own strings and lays
 * these over them, so a missing row only means "use the built-in text".
 */

const MAX_TEXT = 2000;

// "{name}" style slots the app fills in; a translation must keep the same ones.
const slots = (text) => [...new Set((text.match(/\{\w+\}/g) || []).sort())].join(',');

async function readLanguages(onlyEnabled) {
  const { rows } = await pool.query(
    `SELECT code, name, native_name, enabled, is_default, updated_at FROM app_languages
     ${onlyEnabled ? 'WHERE enabled' : ''} ORDER BY sort_order, code`
  );
  return rows.map((l) => ({
    code: l.code,
    name: l.name,
    nativeName: l.native_name,
    enabled: l.enabled,
    isDefault: l.is_default,
    updatedAt: l.updated_at,
  }));
}

// ── Public ──

/** GET /api/i18n: the enabled languages, the default and their strings. */
async function getPublic(req, res) {
  const languages = await readLanguages(true);
  const codes = languages.map((l) => l.code);
  const { rows } = await pool.query('SELECT key, lang, text FROM app_strings WHERE lang = ANY($1)', [codes]);
  const strings = Object.fromEntries(codes.map((c) => [c, {}]));
  for (const r of rows) strings[r.lang][r.key] = r.text;
  const { rows: v } = await pool.query(
    `SELECT GREATEST((SELECT MAX(updated_at) FROM app_strings), (SELECT MAX(updated_at) FROM app_languages)) AS version`
  );
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    languages: languages.map(({ code, name, nativeName, isDefault }) => ({ code, name, nativeName, isDefault })),
    defaultLanguage: languages.find((l) => l.isDefault)?.code ?? 'en',
    version: v[0].version,
    strings,
  });
}

/** PUT /api/i18n/me { language }: the signed-in user's pick, or null to clear it. */
async function setMine(req, res) {
  const language = req.body?.language ?? null;
  if (language !== null) {
    const { rows } = await pool.query('SELECT 1 FROM app_languages WHERE code = $1 AND enabled', [language]);
    if (!rows[0]) return res.status(400).json({ message: 'That language is not offered.' });
  }
  await pool.query('UPDATE users SET preferred_language = $2 WHERE id = $1', [req.user.id, language]);
  res.json({ language });
}

// ── Admin (General Settings permission) ──

/** GET /api/admin/languages: every language, and every key with its text per language. */
async function adminList(req, res) {
  const languages = await readLanguages(false);
  const { rows } = await pool.query('SELECT key, lang, text, updated_at FROM app_strings ORDER BY key');
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, { key: r.key, texts: {}, updatedAt: r.updated_at });
    const entry = byKey.get(r.key);
    entry.texts[r.lang] = r.text;
    if (r.updated_at > entry.updatedAt) entry.updatedAt = r.updated_at;
  }
  // Only keys the app knows, i.e. with English text.
  res.json({ languages, strings: [...byKey.values()].filter((s) => s.texts.en !== undefined) });
}

/** PATCH /api/admin/languages/:code { enabled?, isDefault? } */
async function adminUpdateLanguage(req, res) {
  const { enabled, isDefault } = req.body || {};
  if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be true or false' });
  if (isDefault !== undefined && isDefault !== true) return res.status(400).json({ message: 'Make another language the default instead.' });
  const { rows: before } = await pool.query('SELECT * FROM app_languages WHERE code = $1', [req.params.code]);
  const lang = before[0];
  if (!lang) return res.status(404).json({ message: 'Language not found' });
  if (enabled === false && lang.code === 'en') return res.status(400).json({ message: 'English is always on.' });
  if (enabled === false && lang.is_default) return res.status(400).json({ message: 'Make another language the default before turning this one off.' });
  if (isDefault && enabled === false) return res.status(400).json({ message: 'The default language must be on.' });
  if (isDefault && !lang.enabled && enabled !== true) return res.status(400).json({ message: 'Turn the language on first.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (isDefault) await client.query('UPDATE app_languages SET is_default = false, updated_at = now() WHERE is_default AND code <> $1', [lang.code]);
    const { rows } = await client.query(
      `UPDATE app_languages SET enabled = COALESCE($2, enabled), is_default = COALESCE($3, is_default), updated_at = now()
       WHERE code = $1 RETURNING *`,
      [lang.code, enabled ?? null, isDefault ?? null]
    );
    await client.query('COMMIT');
    await recordAudit({
      actorUserId: req.user.id,
      action: 'language.updated',
      module: 'settings',
      entityType: 'app_language',
      entityId: lang.code,
      previousValue: { enabled: lang.enabled, isDefault: lang.is_default },
      newValue: { enabled: rows[0].enabled, isDefault: rows[0].is_default },
    });
    res.json({ code: rows[0].code, enabled: rows[0].enabled, isDefault: rows[0].is_default });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * PUT /api/admin/languages/strings/:key { lang, text }: the wording of one
 * string in one language. Blank text removes a Tamil or Hindi row, so the app
 * falls back to its built-in text; English can't be blank.
 */
async function adminSetString(req, res) {
  const { key } = req.params;
  const { lang } = req.body || {};
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : null;
  if (text === null) return res.status(400).json({ message: 'text must be text' });
  if (text.length > MAX_TEXT) return res.status(400).json({ message: `At most ${MAX_TEXT} characters.` });
  const { rows: language } = await pool.query('SELECT code FROM app_languages WHERE code = $1', [lang]);
  if (!language[0]) return res.status(400).json({ message: 'Unknown language' });
  const { rows: current } = await pool.query('SELECT lang, text FROM app_strings WHERE key = $1', [key]);
  const english = current.find((r) => r.lang === 'en');
  if (!english) return res.status(404).json({ message: 'The app has no string with that key.' });
  const before = current.find((r) => r.lang === lang)?.text ?? null;

  if (!text) {
    if (lang === 'en') return res.status(400).json({ message: 'English text cannot be empty.' });
    await pool.query('DELETE FROM app_strings WHERE key = $1 AND lang = $2', [key, lang]);
  } else {
    if (slots(text) !== slots(english.text)) {
      return res.status(400).json({
        message: `Keep the same blanks as the English text: ${slots(english.text) || 'none'}.`,
      });
    }
    await pool.query(
      `INSERT INTO app_strings (key, lang, text, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key, lang) DO UPDATE SET text = EXCLUDED.text, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, lang, text, req.user.id]
    );
  }
  await recordAudit({
    actorUserId: req.user.id,
    action: 'language.string_changed',
    module: 'settings',
    entityType: 'app_string',
    entityId: `${lang}:${key}`,
    previousValue: { text: before },
    newValue: { text: text || null },
  });
  res.json({ key, lang, text: text || null });
}

module.exports = { getPublic, setMine, adminList, adminUpdateLanguage, adminSetString };
