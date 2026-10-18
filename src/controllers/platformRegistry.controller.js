const pool = require("../config/db");
const { recordAudit } = require("../services/auditLog");
const { getConnector } = require("../connectors");
const { viewableCategorySlugs } = require("../middleware/platformAccess");
const { platformModuleKey } = require("../services/permissions");
const { holdForApproval } = require("../services/approvals");

/** For staff other than super admin: only the categories their role may view. */
function scopeFor(req) {
  return req.staff && !req.staff.isSuperAdmin ? viewableCategorySlugs(req.staff) : null;
}

/**
 * Super admin's Platform Registry: categories of e-commerce capability and
 * the platforms filed under them.
 *
 * Phase 1 keeps these as records only. A platform's status says whether the
 * business is using it, never whether anything is connected — connections,
 * credentials and connector tests arrive in later phases, and until a
 * connector_key is backed by real code the API reports connected: false.
 *
 * Mounted under /api/admin with no entry in ROUTE_MODULES, so requirePermission
 * refuses every role except super admin. Phase 3 opens it up per category.
 */

const SLUG = /^[a-z][a-z0-9_]{1,59}$/;
const METHODS = ["api", "webhook", "connector", "manual"];
const STATUSES = ["draft", "inactive", "active"];
// Audit logs group by area of the panel; the registry sits with feature flags.
const MODULE = "system";

const ENVIRONMENTS = ["test", "live"];

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "p_$1")
    .slice(0, 60);
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

const isSecretField = (f) => f.secret === true || f.type === "password";

/**
 * A platform as the panel sees it. connected needs both real connector code
 * and a passed test on the environment in use; setup_complete only says the
 * required settings are filled in.
 */
function toPlatformJson(row) {
  const { connection_status, connection_config, connection_secret_keys, ...platform } = row;
  const schema = platform.config_schema ?? [];
  const config = connection_config ?? {};
  const secretKeys = new Set(connection_secret_keys ?? []);
  const missing = schema.filter((f) => {
    if (!f.required || f.type === "boolean") return false;
    if (isSecretField(f)) return !secretKeys.has(f.key);
    return config[f.key] === undefined || config[f.key] === null || config[f.key] === "";
  });
  return {
    ...platform,
    connected: Boolean(getConnector(platform.connector_key)) && connection_status === "connected",
    connection_status: connection_status ?? "not_connected",
    setup_complete: missing.length === 0,
  };
}

function audit(req, action, entityType, entityId, previousValue, newValue) {
  return recordAudit({
    actorUserId: req.user.id,
    action,
    module: MODULE,
    entityType,
    entityId,
    previousValue,
    newValue,
  });
}

// ── Categories ──

async function listCategories(req, res) {
  const { rows } = await pool.query(
    `SELECT c.*,
            COUNT(p.id)::int AS platform_count,
            COUNT(p.id) FILTER (WHERE p.status = 'active')::int AS active_count
     FROM platform_categories c
     LEFT JOIN platforms p ON p.category_id = c.id
     GROUP BY c.id
     ORDER BY c.sort_order, c.name`,
  );
  const scope = scopeFor(req);
  res.json(scope ? rows.filter((c) => scope.has(c.slug)) : rows);
}

async function createCategory(req, res) {
  const { name, description, iconKey, sortOrder } = req.body || {};
  const cleanName = cleanText(name, 120);
  if (!cleanName) return res.status(400).json({ message: "name is required" });
  const slug = req.body?.slug ? String(req.body.slug) : slugify(cleanName);
  if (!SLUG.test(slug)) {
    return res.status(400).json({ message: "slug must start with a letter and use lowercase letters, numbers or underscores" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO platform_categories (slug, name, description, icon_key, sort_order)
       VALUES ($1, $2, $3, COALESCE($4, 'puzzle'), COALESCE($5, 1000))
       RETURNING *`,
      [slug, cleanName, cleanText(description, 500), cleanText(iconKey, 40), Number.isInteger(sortOrder) ? sortOrder : null],
    );
    await audit(req, "platform_category.created", "platform_category", rows[0].id, null, {
      slug: rows[0].slug,
      name: rows[0].name,
    });
    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ message: "A category with this slug already exists" });
    throw error;
  }
}

async function updateCategory(req, res) {
  const { rows: before } = await pool.query("SELECT * FROM platform_categories WHERE id = $1", [req.params.id]);
  if (!before[0]) return res.status(404).json({ message: "Category not found" });
  const { name, description, iconKey, sortOrder, isActive } = req.body || {};
  if (name !== undefined && !cleanText(name, 120)) return res.status(400).json({ message: "name cannot be empty" });
  if (isActive !== undefined && typeof isActive !== "boolean") {
    return res.status(400).json({ message: "isActive must be a boolean" });
  }
  const { rows } = await pool.query(
    `UPDATE platform_categories SET
       name = COALESCE($2, name),
       description = CASE WHEN $3::boolean THEN $4 ELSE description END,
       icon_key = COALESCE($5, icon_key),
       sort_order = COALESCE($6, sort_order),
       is_active = COALESCE($7, is_active),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      cleanText(name, 120),
      description !== undefined,
      cleanText(description, 500),
      cleanText(iconKey, 40),
      Number.isInteger(sortOrder) ? sortOrder : null,
      typeof isActive === "boolean" ? isActive : null,
    ],
  );
  const pick = (r) => ({ name: r.name, description: r.description, is_active: r.is_active, sort_order: r.sort_order });
  await audit(req, "platform_category.updated", "platform_category", rows[0].id, pick(before[0]), pick(rows[0]));
  res.json(rows[0]);
}

async function deleteCategory(req, res) {
  const { rows } = await pool.query("SELECT * FROM platform_categories WHERE id = $1", [req.params.id]);
  const category = rows[0];
  if (!category) return res.status(404).json({ message: "Category not found" });
  if (category.is_system) {
    return res.status(409).json({ message: "Built-in categories can be renamed or hidden, not deleted" });
  }
  const { rows: used } = await pool.query("SELECT COUNT(*)::int AS n FROM platforms WHERE category_id = $1", [category.id]);
  if (used[0].n > 0) {
    return res.status(409).json({ message: `Move or delete its ${used[0].n} platform(s) first` });
  }
  await pool.query("DELETE FROM platform_categories WHERE id = $1", [category.id]);
  // Its permission module is gone too. Without this, a later category given the
  // same slug would silently inherit every grant made for this one.
  await pool.query("DELETE FROM staff_role_permissions WHERE left(permission, length($1)) = $1", [
    `${platformModuleKey(category.slug)}.`,
  ]);
  await audit(req, "platform_category.deleted", "platform_category", category.id, { slug: category.slug, name: category.name }, null);
  res.status(204).end();
}

// ── Platforms ──

async function listPlatforms(req, res) {
  const params = [];
  const where = [];
  if (req.query.category) {
    params.push(String(req.query.category));
    where.push(`c.slug = $${params.length}`);
  }
  if (req.query.status && STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`p.status = $${params.length}`);
  }
  const scope = scopeFor(req);
  if (scope) {
    params.push([...scope]);
    where.push(`c.slug = ANY($${params.length})`);
  }
  const { rows } = await pool.query(
    `${PLATFORM_SELECT}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY c.sort_order, p.sort_order, p.name`,
    params,
  );
  res.json(rows.map(toPlatformJson));
}

// Each platform with its category and the saved settings of the environment it uses.
const PLATFORM_SELECT = `
  SELECT p.*, c.slug AS category_slug, c.name AS category_name,
         pc.status AS connection_status, pc.config AS connection_config, pc.secret_keys AS connection_secret_keys
  FROM platforms p
  JOIN platform_categories c ON c.id = p.category_id
  LEFT JOIN platform_connections pc ON pc.platform_id = p.id AND pc.environment = p.environment`;

async function fetchPlatformJson(id) {
  const { rows } = await pool.query(`${PLATFORM_SELECT} WHERE p.id = $1`, [id]);
  return toPlatformJson(rows[0]);
}

async function readPlatformInput(body, { partial }) {
  const errors = [];
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = cleanText(body.name, 120);
    if (!out.name) errors.push("name is required");
  }
  if (!partial || body.categoryId !== undefined) {
    // Checked as an integer first: a missing or non-numeric id would reach
    // Postgres as NaN and fail the query instead of the validation.
    const categoryId = Number(body.categoryId);
    const { rows } = Number.isInteger(categoryId)
      ? await pool.query("SELECT id FROM platform_categories WHERE id = $1", [categoryId])
      : { rows: [] };
    if (!rows[0]) errors.push("categoryId must be an existing category");
    else out.categoryId = rows[0].id;
  }
  if (body.integrationMethod !== undefined) {
    if (!METHODS.includes(body.integrationMethod)) errors.push(`integrationMethod must be one of: ${METHODS.join(", ")}`);
    else out.integrationMethod = body.integrationMethod;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) errors.push(`status must be one of: ${STATUSES.join(", ")}`);
    else out.status = body.status;
  }
  if (body.capabilities !== undefined) {
    const ok = Array.isArray(body.capabilities) && body.capabilities.every((c) => typeof c === "string" && SLUG.test(c));
    if (!ok) errors.push("capabilities must be a list of lowercase keys, e.g. orders, products");
    else out.capabilities = [...new Set(body.capabilities)];
  }
  if (body.environment !== undefined) {
    if (!ENVIRONMENTS.includes(body.environment)) errors.push("environment must be test or live");
    else out.environment = body.environment;
  }
  if (body.description !== undefined) out.description = cleanText(body.description, 1000);
  if (body.logoUrl !== undefined) out.logoUrl = cleanText(body.logoUrl, 2000);
  if (body.connectorKey !== undefined) {
    if (body.connectorKey === null || body.connectorKey === "") out.connectorKey = null;
    else if (!getConnector(body.connectorKey)) errors.push("connectorKey is not a connector built into this server");
    else out.connectorKey = body.connectorKey;
  }
  if (body.sortOrder !== undefined && Number.isInteger(body.sortOrder)) out.sortOrder = body.sortOrder;
  return { errors, out };
}

const AUDITED = (r) => ({
  name: r.name,
  category_id: r.category_id,
  status: r.status,
  integration_method: r.integration_method,
  environment: r.environment,
  capabilities: r.capabilities,
});

async function createPlatform(req, res) {
  const { errors, out } = await readPlatformInput(req.body || {}, { partial: false });
  if (errors.length) return res.status(400).json({ message: errors.join("; ") });
  const slug = req.body.slug ? String(req.body.slug) : slugify(out.name);
  if (!SLUG.test(slug)) {
    return res.status(400).json({ message: "slug must start with a letter and use lowercase letters, numbers or underscores" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO platforms
         (category_id, slug, name, description, logo_url, integration_method, status, capabilities, sort_order,
          created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'manual'), COALESCE($7, 'inactive'), COALESCE($8::jsonb, '[]'::jsonb),
               COALESCE($9, 0), $10, $10)
       RETURNING *`,
      [
        out.categoryId,
        slug,
        out.name,
        out.description ?? null,
        out.logoUrl ?? null,
        out.integrationMethod ?? null,
        out.status ?? null,
        out.capabilities ? JSON.stringify(out.capabilities) : null,
        out.sortOrder ?? null,
        req.user.id,
      ],
    );
    if (out.connectorKey) await applyConnector(client, rows[0].id, out.connectorKey, { replaceSettings: true });
    await client.query("COMMIT");
    await audit(req, "platform.created", "platform", rows[0].id, null, { ...AUDITED(rows[0]), connector_key: out.connectorKey ?? null });
    res.status(201).json(await fetchPlatformJson(rows[0].id));
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return res.status(409).json({ message: "A platform with this slug already exists" });
    throw error;
  } finally {
    client.release();
  }
}

async function updatePlatform(req, res) {
  const { rows: before } = await pool.query("SELECT * FROM platforms WHERE id = $1", [req.params.id]);
  if (!before[0]) return res.status(404).json({ message: "Platform not found" });
  const { errors, out } = await readPlatformInput(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ message: errors.join("; ") });

  // Turning on real money / real customers: enabled and on Live afterwards, not before.
  const liveAfter = (out.status ?? before[0].status) === "active" && (out.environment ?? before[0].environment) === "live";
  const liveBefore = before[0].status === "active" && before[0].environment === "live";
  if (liveAfter && !liveBefore) {
    const held = await holdForApproval(req, res, {
      action: "platform.go_live",
      entityType: "platform",
      entityId: before[0].id,
      summary: `Turn on ${before[0].name} with its Live settings`,
      handler: "platform.update",
    });
    if (held) return;
  }

  const { rows } = await pool.query(
    `UPDATE platforms SET
       category_id = COALESCE($2, category_id),
       name = COALESCE($3, name),
       description = CASE WHEN $4::boolean THEN $5 ELSE description END,
       logo_url = CASE WHEN $6::boolean THEN $7 ELSE logo_url END,
       integration_method = COALESCE($8, integration_method),
       status = COALESCE($9, status),
       capabilities = COALESCE($10::jsonb, capabilities),
       sort_order = COALESCE($11, sort_order),
       environment = COALESCE($13, environment),
       updated_by_user_id = $12,
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      req.params.id,
      out.categoryId ?? null,
      out.name ?? null,
      "description" in out,
      out.description ?? null,
      "logoUrl" in out,
      out.logoUrl ?? null,
      out.integrationMethod ?? null,
      out.status ?? null,
      out.capabilities ? JSON.stringify(out.capabilities) : null,
      out.sortOrder ?? null,
      req.user.id,
      out.environment ?? null,
    ],
  );
  // A status change is the action people search the log for, so it gets its own name.
  const action =
    out.status && out.status !== before[0].status
      ? out.status === "active"
        ? "platform.activated"
        : "platform.deactivated"
      : out.environment && out.environment !== before[0].environment
        ? "platform.environment_changed"
        : "platform.updated";
  const connectorChanged = "connectorKey" in out && out.connectorKey !== before[0].connector_key;
  if (connectorChanged) {
    // A different connector needs its own settings; an empty form is filled in either way.
    await applyConnector(pool, rows[0].id, out.connectorKey, {
      replaceSettings: Boolean(out.connectorKey) && (req.body.applyConnectorSettings === true || rows[0].config_schema.length === 0),
    });
  }
  await audit(
    req,
    connectorChanged ? "platform.connector_changed" : action,
    "platform",
    rows[0].id,
    { ...AUDITED(before[0]), connector_key: before[0].connector_key },
    { ...AUDITED(rows[0]), connector_key: connectorChanged ? out.connectorKey : before[0].connector_key },
  );
  res.json(await fetchPlatformJson(rows[0].id));
}

/**
 * Points a platform at built-in connector code (or at none). Switching resets
 * both environments to not_connected: a test passed by one connector says
 * nothing about another.
 */
async function applyConnector(db, platformId, connectorKey, { replaceSettings }) {
  const connector = getConnector(connectorKey);
  await db.query(
    `UPDATE platforms SET
       connector_key = $2::varchar,
       integration_method = CASE WHEN $2::varchar IS NULL THEN integration_method ELSE 'connector' END,
       config_schema = CASE WHEN $3::boolean THEN $4::jsonb ELSE config_schema END,
       capabilities = CASE WHEN $3::boolean AND capabilities = '[]'::jsonb THEN $5::jsonb ELSE capabilities END,
       updated_at = NOW()
     WHERE id = $1`,
    [
      platformId,
      connectorKey,
      replaceSettings && Boolean(connector),
      JSON.stringify(connector?.settings ?? []),
      JSON.stringify(connector?.capabilities ?? []),
    ],
  );
  await db.query(
    "UPDATE platform_connections SET status = 'not_connected', last_error = NULL, updated_at = NOW() WHERE platform_id = $1",
    [platformId],
  );
}

async function deletePlatform(req, res) {
  const { rows } = await pool.query("SELECT * FROM platforms WHERE id = $1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: "Platform not found" });
  await pool.query("DELETE FROM platforms WHERE id = $1", [req.params.id]);
  await audit(req, "platform.deleted", "platform", rows[0].id, AUDITED(rows[0]), null);
  res.status(204).end();
}

/**
 * Every registry entry with the "orders" capability — the sales channels — with
 * its order count. Disabled ones are included: their past orders still need a
 * filter. A channel added in the registry appears here with no code change.
 */
async function listOrderChannels(req, res) {
  const { rows } = await pool.query(
    `SELECT p.id, p.slug, p.name, p.status, p.logo_url,
            (SELECT COUNT(*)::int FROM orders o WHERE o.sales_channel_id = p.id) AS order_count
     FROM platforms p
     WHERE p.capabilities ? 'orders'
     ORDER BY (p.status = 'active') DESC, p.sort_order, p.name`,
  );
  const { rows: none } = await pool.query("SELECT COUNT(*)::int AS n FROM orders WHERE sales_channel_id IS NULL");
  res.json({ channels: rows, unattributedCount: none[0].n });
}

module.exports = {
  listOrderChannels,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listPlatforms,
  createPlatform,
  updatePlatform,
  deletePlatform,
  // For Channels, which shows the WhatsApp platform in the same shape.
  PLATFORM_SELECT,
  toPlatformJson,
};
