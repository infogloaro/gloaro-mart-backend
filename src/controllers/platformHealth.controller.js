const pool = require("../config/db");
const { getConnector } = require("../connectors");
const { viewableCategorySlugs } = require("../middleware/platformAccess");

/**
 * One health line per platform, from what the server has actually seen: the
 * last connection test of the environment in use, webhooks in the last 24
 * hours, and orders through it. The verdict is worked out here so every screen
 * reads the same thing:
 *
 *   off       disabled in the registry
 *   manual    no connector — tracked only, nothing to monitor
 *   unknown   has a connector but has never passed or failed a test
 *   down      the last test failed
 *   degraded  connected, but errors or rejected webhooks in the last 24 hours
 *   healthy   connected, nothing wrong in the last 24 hours
 */

function verdict(row) {
  if (row.status !== "active") return "off";
  if (!getConnector(row.connector_key)) return "manual";
  if (row.connection_status === "error") return "down";
  if (row.connection_status !== "connected") return "unknown";
  if (row.errors_24h > 0 || row.rejected_24h > 0) return "degraded";
  return "healthy";
}

async function platformHealth(req, res) {
  const params = [];
  let scope = "";
  if (req.staff && !req.staff.isSuperAdmin) {
    params.push([...viewableCategorySlugs(req.staff)]);
    scope = `WHERE c.slug = ANY($1)`;
  }
  const { rows } = await pool.query(
    `SELECT p.id, p.slug, p.name, p.status, p.environment, p.connector_key, p.capabilities, p.logo_url,
            c.slug AS category_slug, c.name AS category_name,
            pc.status AS connection_status, pc.last_tested_at, pc.last_error,
            COALESCE(l.ok_24h, 0) AS ok_24h, COALESCE(l.errors_24h, 0) AS errors_24h,
            COALESCE(l.rejected_24h, 0) AS rejected_24h, COALESCE(l.webhooks_24h, 0) AS webhooks_24h,
            l.last_event_at,
            CASE WHEN p.capabilities ? 'orders'
                 THEN (SELECT COUNT(*)::int FROM orders o
                       WHERE o.sales_channel_id = p.id AND o.created_at > NOW() - INTERVAL '7 days')
            END AS orders_7d
     FROM platforms p
     JOIN platform_categories c ON c.id = p.category_id
     LEFT JOIN platform_connections pc ON pc.platform_id = p.id AND pc.environment = p.environment
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE s.status = 'ok')::int AS ok_24h,
              COUNT(*) FILTER (WHERE s.status = 'error')::int AS errors_24h,
              COUNT(*) FILTER (WHERE s.status = 'rejected')::int AS rejected_24h,
              COUNT(*) FILTER (WHERE s.kind = 'webhook')::int AS webhooks_24h,
              MAX(s.created_at) AS last_event_at
       FROM platform_sync_logs s
       WHERE s.platform_id = p.id AND s.environment = p.environment AND s.created_at > NOW() - INTERVAL '24 hours'
     ) l ON TRUE
     ${scope}
     ORDER BY c.sort_order, p.sort_order, p.name`,
    params,
  );

  // The latest few problems per platform, for the "what went wrong" line.
  const ids = rows.map((r) => r.id);
  const { rows: problems } = ids.length
    ? await pool.query(
        `SELECT * FROM (
           SELECT s.platform_id, s.kind, s.status, s.event, s.message, s.created_at,
                  ROW_NUMBER() OVER (PARTITION BY s.platform_id ORDER BY s.created_at DESC) AS n
           FROM platform_sync_logs s
           JOIN platforms p ON p.id = s.platform_id AND s.environment = p.environment
           WHERE s.platform_id = ANY($1) AND s.status <> 'ok'
         ) x WHERE n <= 3`,
        [ids],
      )
    : { rows: [] };

  const platforms = rows.map((r) => ({
    ...r,
    health: verdict(r),
    recent_problems: problems
      .filter((p) => p.platform_id === r.id)
      .map(({ kind, status, event, message, created_at }) => ({ kind, status, event, message, created_at })),
  }));
  const summary = {};
  for (const p of platforms) summary[p.health] = (summary[p.health] ?? 0) + 1;
  res.json({ summary, platforms });
}

module.exports = { platformHealth };
