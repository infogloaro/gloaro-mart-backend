const crypto = require("crypto");

/**
 * Encrypts platform credentials at rest with AES-256-GCM.
 *
 * The key is PLATFORM_SECRETS_KEY: 32 random bytes, base64 encoded, kept in
 * the server environment and never in the database, so a copy of the database
 * alone does not reveal any credentials. Generate one with
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Losing or changing the key makes every stored secret unreadable; they then
 * have to be entered again. Stored format: v1:<iv>:<tag>:<ciphertext>, base64.
 */

class SecretKeyMissingError extends Error {}

function key() {
  const raw = process.env.PLATFORM_SECRETS_KEY;
  const buf = raw ? Buffer.from(raw, "base64") : null;
  if (!buf || buf.length !== 32) {
    throw new SecretKeyMissingError(
      "PLATFORM_SECRETS_KEY is not set to 32 base64-encoded bytes, so credentials cannot be stored.",
    );
  }
  return buf;
}

function isConfigured() {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/** Encrypts a plain object of secret values. */
function seal(values) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

/** Decrypts what seal() produced. Throws if the key is wrong or the data was altered. */
function open(sealed) {
  if (!sealed) return {};
  const [version, iv, tag, body] = sealed.split(":");
  if (version !== "v1") throw new Error("Unknown secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const text = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(text);
}

module.exports = { seal, open, isConfigured, SecretKeyMissingError };
