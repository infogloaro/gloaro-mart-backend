const pool = require("../config/db");
const { recordAudit } = require("../services/auditLog");
const secretBox = require("../services/secretBox");
const { getConnector, listConnectors } = require("../connectors");
const { ProviderError } = require("../connectors/http");
const { recordSyncLog } = require("../services/platformSyncLog");
const { holdForApproval } = require("../services/approvals");

/**
 * Platform Registry, Phase 2: each platform's settings form and its saved
 * settings per environment (test, live).
 *
 * The form is data — platforms.config_schema — so a new provider needs no
 * frontend work. Fields marked secret are encrypted with secretBox and never
 * leave the server again; responses say only which ones are set.
 *
 * Saving settings never marks a platform connected. Only a registered
 * connector's test can (see src/connectors), and until one exists the test
 * endpoint says so plainly.
 */

const FIELD_KEY = /^[a-z][a-z0-9_]{0,59}$/;
const FIELD_TYPES = ["text", "textarea", "password", "url", "number", "select", "boolean"];
const ENVIRONMENTS = ["test", "live"];
const MAX_FIELDS = 40;
const MAX_VALUE = 4000;

function badRequest(res, message) {
  return res.status(400).json({ message });
}

async function loadPlatform(id) {
  const { rows } = await pool.query("SELECT * FROM platforms WHERE id = $1", [id]);
  return rows[0] ?? null;
}

/** A field is secret when it says so or is a password field. */
const isSecret = (field) => field.secret === true || field.type === "password";

// ── Settings form (schema) ──

function readSchema(input) {
  if (!Array.isArray(input)) return { error: "fields must be a list" };
  if (input.length > MAX_FIELDS) return { error: `A platform can have at most ${MAX_FIELDS} settings` };
  const seen = new Set();
  const fields = [];
  for (const [i, raw] of input.entries()) {
    const where = `Setting ${i + 1}`;
    if (!raw || typeof raw !== "object") return { error: `${where} is not valid` };
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!FIELD_KEY.test(key)) return { error: `${where}: key must start with a letter and use lowercase letters, numbers or underscores` };
    if (seen.has(key)) return { error: `${where}: the key "${key}" is used twice` };
    seen.add(key);
    const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 120) : "";
    if (!label) return { error: `${where}: label is required` };
    const type = raw.type ?? "text";
    if (!FIELD_TYPES.includes(type)) return { error: `${where}: type must be one of ${FIELD_TYPES.join(", ")}` };
    const field = { key, label, type, required: raw.required === true, secret: type === "password" || raw.secret === true };
    if (type === "select") {
      const options = Array.isArray(raw.options)
        ? [...new Set(raw.options.map((o) => String(o).trim()).filter(Boolean))].slice(0, 50)
        : [];
      if (options.length === 0) return { error: `${where}: a dropdown needs at least one option` };
      field.options = options;
    }
    if (field.secret && (type === "boolean" || type === "select")) {
      return { error: `${where}: only text-like settings can be secret` };
    }
    if (typeof raw.help === "string" && raw.help.trim()) field.help = raw.help.trim().slice(0, 200);
    fields.push(field);
  }
  return { fields };
}

async function updateSchema(req, res) {
  const platform = await loadPlatform(req.params.id);
  if (!platform) return res.status(404).json({ message: "Platform not found" });
  const { fields, error } = readSchema(req.body?.fields);
  if (error) return badRequest(res, error);
  const { rows } = await pool.query(
    `UPDATE platforms SET config_schema = $2::jsonb, updated_by_user_id = $3, updated_at = NOW()
     WHERE id = $1 RETURNING config_schema`,
    [platform.id, JSON.stringify(fields), req.user.id],
  );
  await recordAudit({
    actorUserId: req.user.id,
    action: "platform.settings_form_changed",
    module: "system",
    entityType: "platform",
    entityId: platform.id,
    previousValue: { fields: platform.config_schema.map((f) => f.key) },
    newValue: { fields: fields.map((f) => f.key) },
  });
  res.json(rows[0].config_schema);
}

// ── Saved settings per environment ──

/** What the panel may see of one environment's saved settings. */
function describeConnection(schema, environment, row) {
  const config = row?.config ?? {};
  const secretKeys = new Set(row?.secret_keys ?? []);
  const values = {};
  const secretsSet = {};
  const missingRequired = [];
  for (const field of schema) {
    if (isSecret(field)) {
      secretsSet[field.key] = secretKeys.has(field.key);
      if (field.required && !secretKeys.has(field.key)) missingRequired.push(field.key);
    } else {
      const value = config[field.key];
      if (value !== undefined) values[field.key] = value;
      const empty = value === undefined || value === null || value === "";
      if (field.required && empty && field.type !== "boolean") missingRequired.push(field.key);
    }
  }
  return {
    environment,
    values,
    secretsSet,
    missingRequired,
    complete: missingRequired.length === 0,
    status: row?.status ?? "not_connected",
    lastTestedAt: row?.last_tested_at ?? null,
    lastError: row?.last_error ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

async function listConnections(req, res) {
  const platform = await loadPlatform(req.params.id);
  if (!platform) return res.status(404).json({ message: "Platform not found" });
  const { rows } = await pool.query("SELECT * FROM platform_connections WHERE platform_id = $1", [platform.id]);
  const byEnv = Object.fromEntries(rows.map((r) => [r.environment, r]));
  res.json({
    schema: platform.config_schema,
    environment: platform.environment,
    canStoreSecrets: secretBox.isConfigured(),
    canTest: Boolean(getConnector(platform.connector_key)),
    connector: getConnector(platform.connector_key)
      ? { key: platform.connector_key, name: getConnector(platform.connector_key).name }
      : null,
    // Where the provider should send events; the panel prefixes the API host.
    webhookPath: getConnector(platform.connector_key) ? `/api/webhooks/platforms/${platform.slug}` : null,
    connections: ENVIRONMENTS.map((env) => describeConnection(platform.config_schema, env, byEnv[env])),
  });
}

/** Checks one submitted value against its field; returns [value, error]. */
function coerce(field, value) {
  if (value === null || value === "") return [null, null];
  switch (field.type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? [n, null] : [null, `${field.label} must be a number`];
    }
    case "boolean":
      return typeof value === "boolean" ? [value, null] : [null, `${field.label} must be on or off`];
    case "select":
      return field.options.includes(String(value)) ? [String(value), null] : [null, `${field.label} must be one of the listed options`];
    case "url": {
      const s = String(value).trim();
      return /^https?:\/\/[^\s]+$/i.test(s) ? [s, null] : [null, `${field.label} must be a link starting with http:// or https://`];
    }
    default: {
      const s = String(value).trim();
      return s.length > MAX_VALUE ? [null, `${field.label} is too long`] : [s || null, null];
    }
  }
}

async function saveConnection(req, res) {
  const { environment } = req.params;
  if (!ENVIRONMENTS.includes(environment)) return badRequest(res, "environment must be test or live");
  const platform = await loadPlatform(req.params.id);
  if (!platform) return res.status(404).json({ message: "Platform not found" });

  const schema = platform.config_schema;
  const fieldsByKey = new Map(schema.map((f) => [f.key, f]));
  const valuesIn = req.body?.values ?? {};
  const secretsIn = req.body?.secrets ?? {};
  if (typeof valuesIn !== "object" || typeof secretsIn !== "object") return badRequest(res, "values and secrets must be objects");

  const { rows: existingRows } = await pool.query(
    "SELECT * FROM platform_connections WHERE platform_id = $1 AND environment = $2",
    [platform.id, environment],
  );
  const existing = existingRows[0];

  // Plain settings: start from what is saved, keep only fields still on the form.
  const config = {};
  for (const [k, v] of Object.entries(existing?.config ?? {})) {
    if (fieldsByKey.has(k) && !isSecret(fieldsByKey.get(k))) config[k] = v;
  }
  const changedValues = {};
  for (const [k, raw] of Object.entries(valuesIn)) {
    const field = fieldsByKey.get(k);
    if (!field) return badRequest(res, `"${k}" is not a setting of this platform`);
    if (isSecret(field)) return badRequest(res, `${field.label} is secret; send it under secrets`);
    const [value, error] = coerce(field, raw);
    if (error) return badRequest(res, error);
    if (value === null) delete config[k];
    else config[k] = value;
    if (JSON.stringify(existing?.config?.[k] ?? null) !== JSON.stringify(value)) changedValues[k] = value;
  }

  // Secrets: a value replaces, null or "" clears, an absent key is left alone.
  const secretEntries = Object.entries(secretsIn);
  let sealed = existing?.secrets_encrypted ?? null;
  let secretKeys = (existing?.secret_keys ?? []).filter((k) => fieldsByKey.has(k) && isSecret(fieldsByKey.get(k)));
  const changedSecrets = [];
  if (secretEntries.length > 0) {
    let secrets;
    try {
      secrets = secretBox.open(sealed);
    } catch (e) {
      if (e instanceof secretBox.SecretKeyMissingError) return res.status(503).json({ message: e.message });
      // The key changed since these were saved: they are unreadable, so start
      // again from the ones being entered now.
      secrets = {};
      secretKeys = [];
    }
    for (const k of Object.keys(secrets)) if (!secretKeys.includes(k)) delete secrets[k];
    for (const [k, raw] of secretEntries) {
      const field = fieldsByKey.get(k);
      if (!field) return badRequest(res, `"${k}" is not a setting of this platform`);
      if (!isSecret(field)) return badRequest(res, `${field.label} is not secret; send it under values`);
      const [value, error] = coerce(field, raw);
      if (error) return badRequest(res, error);
      if (value === null) delete secrets[k];
      else secrets[k] = value;
      changedSecrets.push(k);
    }
    secretKeys = Object.keys(secrets);
    try {
      sealed = secretKeys.length ? secretBox.seal(secrets) : null;
    } catch (e) {
      if (e instanceof secretBox.SecretKeyMissingError) return res.status(503).json({ message: e.message });
      throw e;
    }
  }

  const changed = Object.keys(changedValues).length > 0 || changedSecrets.length > 0;

  // Live credentials wait for sign-off when the rule is on. The full request
  // (with secret values) is stored encrypted; the visible copy names only
  // which settings change.
  if (environment === "live" && changed) {
    const held = await holdForApproval(req, res, {
      action: "platform.live_settings",
      entityType: "platform",
      entityId: platform.id,
      summary: `Change ${platform.name}'s Live settings (${[...Object.keys(changedValues), ...changedSecrets].join(", ")})`,
      handler: "platform.save_connection",
      secretBody: true,
      safeBody: { values: changedValues, secretsChanged: changedSecrets },
    });
    if (held) return;
  }
  // New credentials void any earlier test result.
  const { rows } = await pool.query(
    `INSERT INTO platform_connections
       (platform_id, environment, config, secrets_encrypted, secret_keys, updated_by_user_id)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6)
     ON CONFLICT (platform_id, environment) DO UPDATE SET
       config = EXCLUDED.config,
       secrets_encrypted = EXCLUDED.secrets_encrypted,
       secret_keys = EXCLUDED.secret_keys,
       status = CASE WHEN $7::boolean THEN 'not_connected' ELSE platform_connections.status END,
       last_error = CASE WHEN $7::boolean THEN NULL ELSE platform_connections.last_error END,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = NOW()
     RETURNING *`,
    [platform.id, environment, JSON.stringify(config), sealed, JSON.stringify(secretKeys), req.user.id, changed],
  );

  if (changed) {
    await recordAudit({
      actorUserId: req.user.id,
      action: "platform.settings_saved",
      module: "system",
      entityType: "platform",
      entityId: platform.id,
      // Secret values are never logged — only that they changed.
      newValue: { environment, values: changedValues, secretsChanged: changedSecrets },
    });
  }
  res.json(describeConnection(schema, environment, rows[0]));
}

async function testConnection(req, res) {
  const { environment } = req.params;
  if (!ENVIRONMENTS.includes(environment)) return badRequest(res, "environment must be test or live");
  const platform = await loadPlatform(req.params.id);
  if (!platform) return res.status(404).json({ message: "Platform not found" });

  const connector = getConnector(platform.connector_key);
  if (!connector) {
    return res.status(409).json({
      message: `No connector is built for ${platform.name} yet, so these settings can't be tested. They are saved, and the platform stays Not connected.`,
    });
  }

  const { rows } = await pool.query(
    "SELECT * FROM platform_connections WHERE platform_id = $1 AND environment = $2",
    [platform.id, environment],
  );
  const row = rows[0];
  let result;
  try {
    result = await connector.testConnection({
      config: row?.config ?? {},
      secrets: secretBox.open(row?.secrets_encrypted),
      environment,
    });
  } catch (e) {
    // Only messages written for people go back; anything else could quote a value.
    const known = e instanceof ProviderError || e instanceof secretBox.SecretKeyMissingError;
    if (!known) console.error(`Connector ${connector.key} test failed:`, e);
    result = { ok: false, message: known ? e.message : "The connector failed unexpectedly. Check the server log." };
  }
  await recordSyncLog({
    platformId: platform.id,
    environment,
    kind: "test",
    status: result.ok ? "ok" : "error",
    event: "connection.test",
    message: result.message,
  });
  await pool.query(
    `INSERT INTO platform_connections (platform_id, environment, status, last_tested_at, last_error)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (platform_id, environment) DO UPDATE SET
       status = EXCLUDED.status, last_tested_at = NOW(), last_error = EXCLUDED.last_error`,
    [platform.id, environment, result.ok ? "connected" : "error", result.ok ? null : String(result.message).slice(0, 500)],
  );
  await recordAudit({
    actorUserId: req.user.id,
    action: result.ok ? "platform.connection_test_passed" : "platform.connection_test_failed",
    module: "system",
    entityType: "platform",
    entityId: platform.id,
    newValue: { environment, message: result.message ?? null },
  });
  res.status(result.ok ? 200 : 502).json({ ok: result.ok, message: result.message ?? null });
}

/** The connectors built into this server, with the settings each needs. */
function connectors(req, res) {
  res.json(listConnectors());
}

/** Recent tests, webhooks and syncs for one platform, newest first. */
async function listLogs(req, res) {
  const platform = await loadPlatform(req.params.id);
  if (!platform) return res.status(404).json({ message: "Platform not found" });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await pool.query(
    `SELECT id, environment, kind, status, event, message, detail, created_at
     FROM platform_sync_logs WHERE platform_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [platform.id, limit],
  );
  res.json(rows);
}

module.exports = { updateSchema, listConnections, saveConnection, testConnection, connectors, listLogs };
