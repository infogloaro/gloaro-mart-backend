const pool = require("../config/db");
const { recordAudit } = require("../services/auditLog");

/**
 * Home sections: the app's home screen as an ordered list.
 *
 * The type decides what a section holds. Five types are picked by hand from
 * real records; "local_deals" fills itself with the products discounted most
 * right now. Hand-picked items are stored as ids and resolved on every read,
 * so a renamed product shows its new name and a deleted or hidden one simply
 * drops out — on the phone it never appears as a broken tile.
 */

const TYPES = ["featured_categories", "featured_vendors", "local_deals", "b2b_promotions", "product_carousel", "banner_strip"];
const AUDIENCES = ["all", "b2c", "b2b"];
const LAYOUTS = ["grid", "carousel", "list"];
const AUTOMATIC = { local_deals: "Products with the biggest discount right now" };
const MODULE = "marketing";

/** A product's image: its primary gallery image, else the single legacy one. */
const PRODUCT_IMAGE = `COALESCE(
  (SELECT m.url FROM product_media m WHERE m.product_id = p.id AND m.media_type = 'image'
   ORDER BY m.is_primary DESC, m.sort_order, m.id LIMIT 1),
  p.image_url)`;

/** Only what a shopper could open: active, approved, sold by an approved shop. */
const SELLABLE = `p.is_active AND p.moderation_status = 'approved' AND vp.status = 'approved'`;

const rupees = (cents) => `₹${(cents / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Per type: how to look its things up by id and by search. Every row comes back
 * as { refId, title, subtitle, imageUrl, data } — data is what the app needs
 * to draw and open the tile.
 */
const SOURCES = {
  featured_categories: {
    byIds: `SELECT c.id, c.name, c.icon_key, c.image_url FROM categories c WHERE c.id = ANY($1) AND c.is_active`,
    search: `SELECT c.id, c.name, c.icon_key, c.image_url FROM categories c WHERE c.is_active AND c.name ILIKE $1 ORDER BY c.sort_order, c.name LIMIT 20`,
    shape: (r) => ({ refId: r.id, title: r.name, subtitle: null, imageUrl: r.image_url, data: { kind: "category", id: r.id, name: r.name, iconKey: r.icon_key, imageUrl: r.image_url } }),
  },
  featured_vendors: {
    byIds: `SELECT v.id, v.business_name, v.city, v.logo_url, v.business_type FROM vendor_profiles v WHERE v.id = ANY($1) AND v.status = 'approved'`,
    search: `SELECT v.id, v.business_name, v.city, v.logo_url, v.business_type FROM vendor_profiles v
             WHERE v.status = 'approved' AND (v.business_name ILIKE $1 OR v.city ILIKE $1) ORDER BY v.business_name LIMIT 20`,
    shape: (r) => ({
      refId: r.id,
      title: r.business_name,
      subtitle: r.city,
      imageUrl: r.logo_url,
      data: { kind: "shop", id: r.id, name: r.business_name, city: r.city, logo: r.logo_url, businessType: r.business_type },
    }),
  },
  b2b_promotions: {
    byIds: `SELECT v.id, v.business_name, v.city, v.logo_url, v.business_type FROM vendor_profiles v
            WHERE v.id = ANY($1) AND v.status = 'approved' AND v.business_type IN ('b2b', 'both')`,
    search: `SELECT v.id, v.business_name, v.city, v.logo_url, v.business_type FROM vendor_profiles v
             WHERE v.status = 'approved' AND v.business_type IN ('b2b', 'both') AND (v.business_name ILIKE $1 OR v.city ILIKE $1)
             ORDER BY v.business_name LIMIT 20`,
    shape: (r) => ({
      refId: r.id,
      title: r.business_name,
      subtitle: [r.city, "Wholesale"].filter(Boolean).join(" · "),
      imageUrl: r.logo_url,
      data: { kind: "shop", id: r.id, name: r.business_name, city: r.city, logo: r.logo_url, businessType: r.business_type },
    }),
  },
  product_carousel: {
    byIds: `SELECT p.id, p.name, p.price_cents, p.mrp_cents, vp.business_name,
            COALESCE(NULLIF(btrim(vp.city), ''), vp.district) AS city, ${PRODUCT_IMAGE} AS image
            FROM products p JOIN vendor_profiles vp ON vp.id = p.vendor_id WHERE p.id = ANY($1) AND ${SELLABLE}`,
    search: `SELECT p.id, p.name, p.price_cents, p.mrp_cents, vp.business_name,
            COALESCE(NULLIF(btrim(vp.city), ''), vp.district) AS city, ${PRODUCT_IMAGE} AS image
             FROM products p JOIN vendor_profiles vp ON vp.id = p.vendor_id
             WHERE ${SELLABLE} AND (p.name ILIKE $1 OR vp.business_name ILIKE $1) ORDER BY p.name LIMIT 20`,
    shape: (r) => productShape(r),
  },
  banner_strip: {
    byIds: `SELECT b.id, b.title, b.subtitle, b.image_data, b.link_url, b.placement FROM banners b WHERE b.id = ANY($1) AND b.is_active`,
    search: `SELECT b.id, b.title, b.subtitle, b.image_data, b.link_url, b.placement FROM banners b
             WHERE b.is_active AND (COALESCE(b.title, '') ILIKE $1 OR b.placement ILIKE $1) ORDER BY b.sort_order, b.id LIMIT 20`,
    shape: (r) => ({
      refId: r.id,
      title: r.title || `Banner #${r.id}`,
      subtitle: r.subtitle ?? r.placement,
      imageUrl: r.image_data,
      data: { kind: "banner", id: r.id, title: r.title, subtitle: r.subtitle, image: r.image_data, linkUrl: r.link_url },
    }),
  },
};

function productShape(r) {
  const off = r.mrp_cents && r.mrp_cents > r.price_cents ? Math.round((1 - r.price_cents / r.mrp_cents) * 100) : null;
  return {
    refId: r.id,
    title: r.name,
    subtitle: [rupees(r.price_cents), off ? `${off}% off` : null, r.business_name, r.city].filter(Boolean).join(" · "),
    imageUrl: r.image,
    data: { kind: "product", id: r.id, name: r.name, priceCents: r.price_cents, mrpCents: r.mrp_cents, discountPercent: off, image: r.image, shop: r.business_name, city: r.city },
  };
}

/** The automatic sections' contents, worked out now. */
async function automaticItems(section) {
  if (section.type !== "local_deals") return [];
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.price_cents, p.mrp_cents, vp.business_name,
            COALESCE(NULLIF(btrim(vp.city), ''), vp.district) AS city, ${PRODUCT_IMAGE} AS image
     FROM products p JOIN vendor_profiles vp ON vp.id = p.vendor_id
     WHERE ${SELLABLE} AND p.mrp_cents > p.price_cents
     ORDER BY (p.mrp_cents - p.price_cents)::float / p.mrp_cents DESC, p.id
     LIMIT $1`,
    [section.max_items],
  );
  return rows.map(productShape);
}

/** Hand-picked items in their saved order; anything no longer showable drops out. */
async function pickedItems(section, links) {
  if (links.length === 0) return [];
  const source = SOURCES[section.type];
  const { rows } = await pool.query(source.byIds, [links.map((l) => l.ref_id)]);
  const byId = new Map(rows.map((r) => [r.id, source.shape(r)]));
  return links
    .filter((l) => byId.has(l.ref_id))
    .slice(0, section.max_items)
    .map((l, i) => ({ id: l.id, ...byId.get(l.ref_id), sortOrder: i }));
}

async function loadSections({ onlyLive = false, audience = null } = {}) {
  const params = [];
  const where = [];
  if (onlyLive) {
    where.push("s.is_active", "(s.starts_at IS NULL OR s.starts_at <= NOW())", "(s.ends_at IS NULL OR s.ends_at > NOW())");
  }
  if (audience) {
    params.push(audience);
    where.push(`s.audience IN ('all', $${params.length})`);
  }
  const { rows: sections } = await pool.query(
    `SELECT s.* FROM home_sections s ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.sort_order, s.id`,
    params,
  );
  const { rows: links } = sections.length
    ? await pool.query("SELECT * FROM home_section_items WHERE section_id = ANY($1) ORDER BY sort_order, id", [sections.map((s) => s.id)])
    : { rows: [] };

  const out = [];
  for (const s of sections) {
    const items = AUTOMATIC[s.type] ? await automaticItems(s) : await pickedItems(s, links.filter((l) => l.section_id === s.id));
    out.push({ section: s, items });
  }
  return out;
}

function toAdminJson({ section: s, items }) {
  return {
    id: s.id,
    type: s.type,
    title: s.title,
    subtitle: s.subtitle,
    audience: s.audience,
    source: AUTOMATIC[s.type] ? "automatic" : "manual",
    rule: AUTOMATIC[s.type] ?? null,
    layout: s.layout,
    maxItems: s.max_items,
    isActive: s.is_active,
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    sortOrder: s.sort_order,
    itemCount: items.length,
    items: items.map(({ data, ...item }, i) => ({ id: item.id ?? -item.refId, ...item, sortOrder: i })),
  };
}

// ── Admin ──

async function listSections(req, res) {
  const all = await loadSections();
  const { rows } = await pool.query("SELECT MAX(updated_at) AS at FROM home_sections");
  res.json({ sections: all.map(toAdminJson), updatedAt: rows[0].at });
}

async function sectionJson(id) {
  const all = await loadSections();
  const found = all.find((x) => x.section.id === Number(id));
  return found ? toAdminJson(found) : null;
}

function readDate(value, label, errors) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) errors.push(`${label} is not a date`);
  return d;
}

async function createSection(req, res) {
  const { type, title, subtitle, audience = "all", layout } = req.body || {};
  if (!TYPES.includes(type)) return res.status(400).json({ message: `type must be one of: ${TYPES.join(", ")}` });
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ message: "A section needs a heading." });
  if (!AUDIENCES.includes(audience)) return res.status(400).json({ message: "audience must be all, b2c or b2b" });
  if (layout !== undefined && !LAYOUTS.includes(layout)) return res.status(400).json({ message: "layout must be grid, carousel or list" });
  // New sections go to the bottom, switched off: filled first, then shown.
  const { rows } = await pool.query(
    `INSERT INTO home_sections (type, title, subtitle, audience, layout, sort_order, updated_by_user_id)
     VALUES ($1, $2, $3, $4, COALESCE($5, $6), (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM home_sections), $7)
     RETURNING id`,
    [type, title.trim().slice(0, 120), subtitle?.trim?.().slice(0, 200) || null, audience, layout ?? null,
      type === "featured_categories" ? "grid" : "carousel", req.user.id],
  );
  await recordAudit({ actorUserId: req.user.id, action: "home_section.created", module: MODULE, entityType: "home_section", entityId: rows[0].id, newValue: { type, title: title.trim(), audience } });
  res.status(201).json(await sectionJson(rows[0].id));
}

async function updateSection(req, res) {
  const { rows: found } = await pool.query("SELECT * FROM home_sections WHERE id = $1", [req.params.id]);
  const section = found[0];
  if (!section) return res.status(404).json({ message: "Section not found" });
  const b = req.body || {};
  const errors = [];
  if (b.title !== undefined && (typeof b.title !== "string" || !b.title.trim())) errors.push("The heading can't be empty.");
  if (b.audience !== undefined && !AUDIENCES.includes(b.audience)) errors.push("audience must be all, b2c or b2b");
  if (b.layout !== undefined && !LAYOUTS.includes(b.layout)) errors.push("layout must be grid, carousel or list");
  if (b.isActive !== undefined && typeof b.isActive !== "boolean") errors.push("isActive must be true or false");
  if (b.maxItems !== undefined && !(Number.isInteger(b.maxItems) && b.maxItems >= 1 && b.maxItems <= 50)) errors.push("maxItems must be 1 to 50");
  const startsAt = readDate(b.startsAt, "startsAt", errors);
  const endsAt = readDate(b.endsAt, "endsAt", errors);
  const start = startsAt === undefined ? section.starts_at : startsAt;
  const end = endsAt === undefined ? section.ends_at : endsAt;
  if (start && end && start > end) errors.push("The window ends before it starts.");
  if (b.itemRefIds !== undefined) {
    if (AUTOMATIC[section.type]) errors.push("This section fills itself; its items can't be picked.");
    else if (!Array.isArray(b.itemRefIds) || !b.itemRefIds.every(Number.isInteger)) errors.push("itemRefIds must be a list of ids");
  }
  if (errors.length) return res.status(400).json({ message: errors.join(" ") });

  const max = b.maxItems ?? section.max_items;
  let refIds = null;
  if (Array.isArray(b.itemRefIds)) {
    refIds = [...new Set(b.itemRefIds)];
    if (refIds.length > max) return res.status(400).json({ message: `At most ${max} item${max === 1 ? "" : "s"} fit in this section.` });
    // Only real, showable things can be picked.
    const { rows } = refIds.length ? await pool.query(SOURCES[section.type].byIds, [refIds]) : { rows: [] };
    const valid = new Set(rows.map((r) => r.id));
    const unknown = refIds.filter((id) => !valid.has(id));
    if (unknown.length) return res.status(400).json({ message: `These can't be shown in this section: ${unknown.join(", ")}` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE home_sections SET
         title = COALESCE($2, title),
         subtitle = CASE WHEN $3::boolean THEN $4 ELSE subtitle END,
         audience = COALESCE($5, audience),
         layout = COALESCE($6, layout),
         max_items = COALESCE($7, max_items),
         is_active = COALESCE($8, is_active),
         starts_at = CASE WHEN $9::boolean THEN $10::timestamptz ELSE starts_at END,
         ends_at = CASE WHEN $11::boolean THEN $12::timestamptz ELSE ends_at END,
         updated_by_user_id = $13, updated_at = NOW()
       WHERE id = $1`,
      [
        section.id,
        b.title?.trim().slice(0, 120) ?? null,
        b.subtitle !== undefined,
        typeof b.subtitle === "string" ? b.subtitle.trim().slice(0, 200) || null : null,
        b.audience ?? null,
        b.layout ?? null,
        b.maxItems ?? null,
        typeof b.isActive === "boolean" ? b.isActive : null,
        startsAt !== undefined,
        startsAt ?? null,
        endsAt !== undefined,
        endsAt ?? null,
        req.user.id,
      ],
    );
    if (refIds) {
      await client.query("DELETE FROM home_section_items WHERE section_id = $1", [section.id]);
      for (const [i, refId] of refIds.entries()) {
        await client.query("INSERT INTO home_section_items (section_id, ref_id, sort_order) VALUES ($1, $2, $3)", [section.id, refId, i]);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const changed = Object.keys(b).filter((k) => k !== "itemRefIds");
  await recordAudit({
    actorUserId: req.user.id,
    action: typeof b.isActive === "boolean" && b.isActive !== section.is_active ? (b.isActive ? "home_section.shown" : "home_section.hidden") : "home_section.updated",
    module: MODULE,
    entityType: "home_section",
    entityId: section.id,
    previousValue: { title: section.title, is_active: section.is_active },
    newValue: { changed, ...(refIds ? { items: refIds.length } : {}) },
  });
  res.json(await sectionJson(section.id));
}

async function deleteSection(req, res) {
  const { rows } = await pool.query("DELETE FROM home_sections WHERE id = $1 RETURNING id, title, type", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: "Section not found" });
  await recordAudit({ actorUserId: req.user.id, action: "home_section.deleted", module: MODULE, entityType: "home_section", entityId: rows[0].id, previousValue: { title: rows[0].title, type: rows[0].type } });
  res.status(204).end();
}

async function reorderSections(req, res) {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.every(Number.isInteger)) return res.status(400).json({ message: "ids must be a list of section ids" });
  const { rows } = await pool.query("SELECT id FROM home_sections");
  const all = new Set(rows.map((r) => r.id));
  // The whole order every time, so two admins reordering can't leave gaps or duplicates.
  if (ids.length !== all.size || !ids.every((id) => all.has(id)) || new Set(ids).size !== ids.length) {
    return res.status(409).json({ message: "The list changed since you loaded it. Reload and try again." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [i, id] of ids.entries()) {
      await client.query("UPDATE home_sections SET sort_order = $2, updated_at = NOW(), updated_by_user_id = $3 WHERE id = $1", [id, i, req.user.id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await recordAudit({ actorUserId: req.user.id, action: "home_section.reordered", module: MODULE, entityType: "home_section", entityId: null, newValue: { ids } });
  res.json({ ok: true });
}

async function candidates(req, res) {
  const { rows } = await pool.query("SELECT * FROM home_sections WHERE id = $1", [req.params.id]);
  const section = rows[0];
  if (!section) return res.status(404).json({ message: "Section not found" });
  if (AUTOMATIC[section.type]) return res.json([]);
  const q = String(req.query.q ?? "").trim();
  const source = SOURCES[section.type];
  const { rows: found } = await pool.query(source.search, [`%${q}%`]);
  res.json(found.map(source.shape).map(({ data, ...c }) => c));
}

// ── Public ──

/**
 * GET /api/home/sections?audience=b2c|b2b — what the app's home screen shows,
 * in order: only sections that are switched on, inside their window and not
 * empty, each with the data needed to draw and open its tiles.
 */
async function publicSections(req, res) {
  const audience = AUDIENCES.includes(req.query.audience) && req.query.audience !== "all" ? req.query.audience : null;
  const live = await loadSections({ onlyLive: true, audience });
  res.set("Cache-Control", "public, max-age=60");
  res.json(
    live
      .filter(({ items }) => items.length > 0)
      .map(({ section: s, items }) => ({
        id: s.id,
        type: s.type,
        title: s.title,
        subtitle: s.subtitle,
        layout: s.layout,
        items: items.map((i) => i.data),
      })),
  );
}

module.exports = { listSections, createSection, updateSection, deleteSection, reorderSections, candidates, publicSections };
