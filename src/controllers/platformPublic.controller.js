const pool = require("../config/db");

/**
 * GET /api/platform/public — what the shopper apps may know about the Platform
 * Registry, so a change in Settings reaches them on their next load:
 *
 *   channels       enabled sales channels (send one back as X-Sales-Channel)
 *   campaigns      enabled entries in Campaigns & Promotions
 *   capabilities   every capability some enabled platform provides
 *
 * Only enabled platforms, and only their name, slug, description and logo:
 * never settings, credentials, connector details or anything disabled.
 */
async function publicPlatforms(req, res) {
  const { rows } = await pool.query(
    `SELECT p.slug, p.name, p.description, p.logo_url, p.capabilities, c.slug AS category
     FROM platforms p
     JOIN platform_categories c ON c.id = p.category_id
     WHERE p.status = 'active' AND c.is_active = true
     ORDER BY c.sort_order, p.sort_order, p.name`,
  );
  const pick = ({ slug, name, description, logo_url }) => ({ slug, name, description, logo: logo_url });
  // A minute of caching keeps app start-ups cheap without hiding a change for long.
  res.set("Cache-Control", "public, max-age=60");
  res.json({
    channels: rows.filter((r) => r.capabilities.includes("orders")).map(pick),
    campaigns: rows.filter((r) => r.category === "campaigns").map(pick),
    capabilities: [...new Set(rows.flatMap((r) => r.capabilities))].sort(),
  });
}

module.exports = { publicPlatforms };
