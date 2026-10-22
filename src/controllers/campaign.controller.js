const pool = require("../config/db");
const { recordAudit } = require("../services/auditLog");
const { SPENT_SQL, STATUS_SQL } = require("../services/campaigns");

/**
 * Admin → Campaigns. A campaign is a discount across the marketplace, a set of
 * categories or a set of shops, for a while, funded by the platform, the shops
 * or both. Checkout applies it (services/campaigns.js); this is how it's set
 * up, started, watched and stopped.
 *
 * The discount, scope and funding are fixed once a campaign has started —
 * changing them mid-run would reprice orders already placed. Dates, budget,
 * name, description and banner can change until it ends.
 */

const SCOPES = ["platform", "category", "vendor"];
const TYPES = ["percentage", "flat", "free_delivery"];
const FUNDINGS = ["platform", "vendor", "shared"];
const STATUSES = ["draft", "scheduled", "running", "paused", "ended"];
const MODULE = "marketing";

const SELECT = `
  SELECT c.*, ${STATUS_SQL} AS status, ${SPENT_SQL} AS spent_cents,
         (SELECT COUNT(*)::int FROM campaign_participants p WHERE p.campaign_id = c.id) AS participant_count,
         (SELECT COUNT(*)::int FROM campaign_participants p WHERE p.campaign_id = c.id AND p.type = 'vendor' AND p.opted_in) AS opted_in_count,
         (SELECT COUNT(*)::int FROM order_campaigns oc JOIN orders o ON o.id = oc.order_id
          WHERE oc.campaign_id = c.id AND o.status <> 'cancelled') AS orders,
         (SELECT COALESCE(SUM(o.total_cents), 0)::int FROM order_campaigns oc JOIN orders o ON o.id = oc.order_id
          WHERE oc.campaign_id = c.id AND o.status <> 'cancelled') AS revenue_cents
  FROM campaigns c`;

function toJson(r) {
  return {
    id: r.id,
    name: r.name,
    scope: r.scope,
    status: r.status,
    discountType: r.discount_type,
    discountValue: r.discount_value,
    maxDiscountCents: r.max_discount_cents,
    minOrderCents: r.min_order_cents,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    fundedBy: r.funded_by,
    platformSharePercent: r.funded_by === "shared" ? r.platform_share_percent ?? 50 : r.funded_by === "platform" ? 100 : 0,
    budgetCents: r.budget_cents,
    spentCents: r.spent_cents,
    participantCount: r.participant_count,
    optedInCount: r.opted_in_count,
    orders: r.orders,
    revenueCents: r.revenue_cents,
    discountGivenCents: r.spent_cents,
    bannerUrl: r.banner_url,
    createdAt: r.created_at,
  };
}

async function loadCampaign(id) {
  const { rows } = await pool.query(`${SELECT} WHERE c.id = $1`, [Number(id)]);
  return rows[0] ?? null;
}

async function loadParticipants(campaignId) {
  const { rows } = await pool.query(
    `SELECT p.*, COALESCE(v.business_name, cat.name, '(removed)') AS name
     FROM campaign_participants p
     LEFT JOIN vendor_profiles v ON p.type = 'vendor' AND v.id = p.ref_id
     LEFT JOIN categories cat ON p.type = 'category' AND cat.id = p.ref_id
     WHERE p.campaign_id = $1 ORDER BY p.type DESC, name`,
    [campaignId],
  );
  return rows.map((p) => ({ id: p.id, type: p.type, refId: p.ref_id, name: p.name, optedIn: p.opted_in, joinedAt: p.joined_at }));
}

const audit = (req, action, entityId, previousValue, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: MODULE, entityType: "campaign", entityId, previousValue, newValue });

/** Why a campaign can't run as set up, or null when it can. */
function notReady(c, participants) {
  const vendors = participants.filter((p) => p.type === "vendor");
  if (c.scope === "category" && !participants.some((p) => p.type === "category")) return "Add at least one category first.";
  if (c.scope === "vendor" && vendors.length === 0) return "Add at least one shop first.";
  if (c.funded_by !== "platform" && !vendors.some((p) => p.optedIn)) {
    return "Shops pay for this campaign, and none has opted in yet.";
  }
  return null;
}

// ── List, summary, detail ──

async function listCampaigns(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const params = [];
  const where = [];
  if (req.query.status && STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`x.status = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    where.push(`x.name ILIKE $${params.length}`);
  }
  const filtered = `SELECT * FROM (${SELECT}) x ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const { rows: count } = await pool.query(`SELECT COUNT(*)::int AS n FROM (${filtered}) y`, params);
  const { rows } = await pool.query(
    `${filtered} ORDER BY CASE x.status WHEN 'running' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'paused' THEN 2 WHEN 'draft' THEN 3 ELSE 4 END,
       x.starts_at DESC, x.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  res.json({ items: rows.map(toJson), total: count[0].n, page, pageSize });
}

async function campaignSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE x.status = 'running')::int AS running,
       COUNT(*) FILTER (WHERE x.status = 'scheduled')::int AS scheduled,
       COUNT(*) FILTER (WHERE x.budget_cents IS NOT NULL AND x.spent_cents >= x.budget_cents)::int AS budget_exhausted
     FROM (${SELECT}) x`,
  );
  const { rows: month } = await pool.query(
    `SELECT COALESCE(SUM(oc.discount_cents), 0)::int AS discount, COALESCE(SUM(o.total_cents), 0)::int AS revenue
     FROM order_campaigns oc JOIN orders o ON o.id = oc.order_id
     WHERE o.status <> 'cancelled' AND o.created_at >= date_trunc('month', NOW())`,
  );
  res.json({
    running: rows[0].running,
    scheduled: rows[0].scheduled,
    budgetExhausted: rows[0].budget_exhausted,
    discountThisMonthCents: month[0].discount,
    revenueThisMonthCents: month[0].revenue,
  });
}

async function getCampaign(req, res) {
  const c = await loadCampaign(req.params.id);
  if (!c) return res.status(404).json({ message: "Campaign not found" });
  res.json({ ...toJson(c), description: c.description, participants: await loadParticipants(c.id) });
}

// ── Create and change ──

function readMoney(value, label, errors) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!Number.isInteger(value) || value <= 0) errors.push(`${label} must be a positive amount`);
  return value;
}

function readDay(value, label, errors, endOfDay = false) {
  if (value === undefined) return undefined;
  const d = new Date(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? "23:59:59" : "00:00:00"}` : value);
  if (Number.isNaN(d.getTime())) errors.push(`${label} is not a date`);
  return d;
}

async function createCampaign(req, res) {
  const b = req.body || {};
  const errors = [];
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
  if (!name) errors.push("Give the campaign a name.");
  if (!SCOPES.includes(b.scope)) errors.push("scope must be platform, category or vendor");
  if (!TYPES.includes(b.discountType)) errors.push("discountType must be percentage, flat or free_delivery");
  if (!FUNDINGS.includes(b.fundedBy)) errors.push("fundedBy must be platform, vendor or shared");
  const value = b.discountType === "free_delivery" ? 0 : Number(b.discountValue);
  if (b.discountType === "percentage" && !(Number.isInteger(value) && value >= 1 && value <= 100)) errors.push("A percentage discount has to be between 1 and 100.");
  if (b.discountType === "flat" && !(Number.isInteger(value) && value > 0)) errors.push("A flat discount needs an amount.");
  const startsAt = readDay(b.startsAt, "startsAt", errors);
  const endsAt = readDay(b.endsAt, "endsAt", errors, true);
  if (!startsAt || !endsAt) errors.push("A campaign needs a start and an end.");
  else if (endsAt <= startsAt) errors.push("It ends before it starts.");
  const budget = readMoney(b.budgetCents, "Budget", errors);
  const maxDiscount = readMoney(b.maxDiscountCents, "Maximum discount", errors);
  const minOrder = b.minOrderCents === undefined || b.minOrderCents === null ? 0 : Number(b.minOrderCents);
  if (!Number.isInteger(minOrder) || minOrder < 0) errors.push("Minimum order must be zero or more");
  const share = b.fundedBy === "shared" ? (b.platformSharePercent ?? 50) : null;
  if (share !== null && !(Number.isInteger(share) && share >= 0 && share <= 100)) errors.push("Platform share must be 0 to 100");
  if (errors.length) return res.status(400).json({ message: errors.join(" ") });

  const { rows } = await pool.query(
    `INSERT INTO campaigns (name, description, scope, discount_type, discount_value, max_discount_cents, min_order_cents,
       starts_at, ends_at, funded_by, platform_share_percent, budget_cents, banner_url, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [name, typeof b.description === "string" ? b.description.trim() || null : null, b.scope, b.discountType, value,
      maxDiscount ?? null, minOrder, startsAt, endsAt, b.fundedBy, share, budget ?? null,
      typeof b.bannerUrl === "string" ? b.bannerUrl.trim() || null : null, req.user.id],
  );
  await audit(req, "campaign.created", rows[0].id, null, { name, scope: b.scope, discountType: b.discountType, discountValue: value, fundedBy: b.fundedBy });
  const c = await loadCampaign(rows[0].id);
  res.status(201).json({ ...toJson(c), description: c.description, participants: [] });
}

async function updateCampaign(req, res) {
  const c = await loadCampaign(req.params.id);
  if (!c) return res.status(404).json({ message: "Campaign not found" });
  if (c.status === "ended") return res.status(409).json({ message: "This campaign has ended; start a new one instead." });
  const b = req.body || {};
  const errors = [];
  const locked = ["scope", "discountType", "discountValue", "fundedBy", "platformSharePercent", "maxDiscountCents", "minOrderCents"].filter((k) => k in b);
  if (locked.length && c.state !== "draft") errors.push("The discount, scope and funding are fixed once a campaign has started.");
  if (locked.length && c.state === "draft") errors.push("Change the discount by creating the campaign again; only dates, budget, name and banner can be edited here.");
  const endsAt = b.endsAt === null || b.endsAt === "" ? undefined : readDay(b.endsAt, "endsAt", errors, true);
  const startsAt = b.startsAt === undefined ? undefined : readDay(b.startsAt, "startsAt", errors);
  if (startsAt && c.status !== "draft" && c.status !== "scheduled") errors.push("A campaign that has started keeps its start date.");
  const start = startsAt ?? c.starts_at;
  const end = endsAt ?? c.ends_at;
  if (end <= start) errors.push("It ends before it starts.");
  const budget = readMoney(b.budgetCents, "Budget", errors);
  if (budget != null && budget < c.spent_cents) errors.push(`It has already given ${(c.spent_cents / 100).toFixed(2)} in discounts; the budget can't be lower.`);
  if (errors.length) return res.status(400).json({ message: errors.join(" ") });

  await pool.query(
    `UPDATE campaigns SET
       name = COALESCE($2, name),
       description = CASE WHEN $3::boolean THEN $4 ELSE description END,
       starts_at = COALESCE($5, starts_at),
       ends_at = COALESCE($6, ends_at),
       budget_cents = CASE WHEN $7::boolean THEN $8 ELSE budget_cents END,
       banner_url = CASE WHEN $9::boolean THEN $10 ELSE banner_url END,
       updated_at = NOW()
     WHERE id = $1`,
    [c.id, typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 120) : null,
      "description" in b, typeof b.description === "string" ? b.description.trim() || null : null,
      startsAt ?? null, endsAt ?? null, "budgetCents" in b, budget ?? null,
      "bannerUrl" in b, typeof b.bannerUrl === "string" ? b.bannerUrl.trim() || null : null],
  );
  await audit(req, "campaign.updated", c.id, { ends_at: c.ends_at, budget_cents: c.budget_cents }, { changed: Object.keys(b) });
  return getCampaign(req, res);
}

async function setState(req, res, next, fromStates, to, action) {
  const c = await loadCampaign(req.params.id);
  if (!c) return res.status(404).json({ message: "Campaign not found" });
  if (!fromStates.includes(c.status)) return res.status(409).json({ message: `A ${c.status} campaign can't be ${action}.` });
  if (to === "active") {
    const problem = notReady(c, await loadParticipants(c.id));
    if (problem) return res.status(409).json({ message: problem });
  }
  await pool.query(
    `UPDATE campaigns SET state = $2::varchar, ended_at = CASE WHEN $2::varchar = 'ended' THEN NOW() ELSE ended_at END, updated_at = NOW() WHERE id = $1`,
    [c.id, to],
  );
  await audit(req, `campaign.${action}`, c.id, { status: c.status }, { state: to });
  return getCampaign(req, res);
}

const resumeCampaign = (req, res) => setState(req, res, null, ["draft", "paused", "scheduled"], "active", "started");
const pauseCampaign = (req, res) => setState(req, res, null, ["running", "scheduled"], "paused", "paused");
const endCampaign = (req, res) => setState(req, res, null, ["draft", "scheduled", "running", "paused"], "ended", "ended");

// ── Participants ──

async function candidates(req, res) {
  const c = await loadCampaign(req.params.id);
  if (!c) return res.status(404).json({ message: "Campaign not found" });
  const q = `%${String(req.query.q ?? "").trim()}%`;
  const type = req.query.type === "category" ? "category" : "vendor";
  const { rows } =
    type === "category"
      ? await pool.query(`SELECT id, name, NULL AS city FROM categories WHERE is_active AND name ILIKE $1 ORDER BY sort_order, name LIMIT 20`, [q])
      : await pool.query(`SELECT id, business_name AS name, city FROM vendor_profiles WHERE status = 'approved' AND (business_name ILIKE $1 OR city ILIKE $1) ORDER BY business_name LIMIT 20`, [q]);
  res.json(rows.map((r) => ({ type, refId: r.id, name: r.name, subtitle: r.city })));
}

async function addParticipant(req, res) {
  const c = await loadCampaign(req.params.id);
  if (!c) return res.status(404).json({ message: "Campaign not found" });
  if (c.status === "ended") return res.status(409).json({ message: "This campaign has ended." });
  const { type, refId } = req.body || {};
  if (!["vendor", "category"].includes(type) || !Number.isInteger(refId)) return res.status(400).json({ message: "type (vendor or category) and refId are required" });
  if (type === "category" && c.scope !== "category") return res.status(400).json({ message: "Only a category campaign takes categories." });
  const exists = type === "vendor"
    ? await pool.query("SELECT 1 FROM vendor_profiles WHERE id = $1 AND status = 'approved'", [refId])
    : await pool.query("SELECT 1 FROM categories WHERE id = $1 AND is_active", [refId]);
  if (!exists.rows[0]) return res.status(400).json({ message: `That ${type === "vendor" ? "shop" : "category"} can't take part.` });
  // A platform-funded campaign costs the shop nothing, so it is in at once;
  // otherwise the shop has to agree (vendor portal, or recorded here).
  const optedIn = type === "vendor" && c.funded_by === "platform";
  try {
    await pool.query(
      `INSERT INTO campaign_participants (campaign_id, type, ref_id, opted_in, joined_at) VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NOW() END)`,
      [c.id, type, refId, optedIn],
    );
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ message: "Already taking part." });
    throw e;
  }
  await audit(req, "campaign.participant_added", c.id, null, { type, refId });
  return getCampaign(req, res);
}

async function updateParticipant(req, res) {
  if (typeof req.body?.optedIn !== "boolean") return res.status(400).json({ message: "optedIn must be true or false" });
  const { rows } = await pool.query(
    `UPDATE campaign_participants SET opted_in = $3, joined_at = CASE WHEN $3 THEN COALESCE(joined_at, NOW()) ELSE NULL END
     WHERE id = $2 AND campaign_id = $1 AND type = 'vendor' RETURNING *`,
    [Number(req.params.id), Number(req.params.participantId), req.body.optedIn],
  );
  if (!rows[0]) return res.status(404).json({ message: "Shop not found in this campaign" });
  // Recorded by an admin on the shop's behalf — say so in the log.
  await audit(req, req.body.optedIn ? "campaign.vendor_opted_in_by_admin" : "campaign.vendor_opted_out_by_admin", rows[0].campaign_id, null, { vendorId: rows[0].ref_id });
  return getCampaign(req, res);
}

async function removeParticipant(req, res) {
  const { rows } = await pool.query("DELETE FROM campaign_participants WHERE id = $2 AND campaign_id = $1 RETURNING *", [Number(req.params.id), Number(req.params.participantId)]);
  if (!rows[0]) return res.status(404).json({ message: "Not taking part" });
  await audit(req, "campaign.participant_removed", rows[0].campaign_id, { type: rows[0].type, refId: rows[0].ref_id }, null);
  return getCampaign(req, res);
}

// ── Vendor portal: shops see and join campaigns they would pay for ──

async function vendorCampaigns(req, res) {
  const vendorId = req.vendorId;
  const { rows } = await pool.query(
    `SELECT x.*, p.opted_in FROM (${SELECT}) x
     LEFT JOIN campaign_participants p ON p.campaign_id = x.id AND p.type = 'vendor' AND p.ref_id = $1
     WHERE x.status IN ('scheduled', 'running', 'draft') AND x.funded_by <> 'platform'
       AND (x.scope <> 'vendor' OR p.id IS NOT NULL)
     ORDER BY x.starts_at`,
    [vendorId],
  );
  res.json(rows.map((r) => ({ ...toJson(r), description: r.description, optedIn: r.opted_in === true, invited: r.opted_in !== null })));
}

async function vendorOptIn(req, res) {
  const vendorId = req.vendorId;
  const join = req.path.endsWith("/opt-in");
  const c = await loadCampaign(req.params.id);
  if (!c || c.funded_by === "platform" || c.status === "ended") return res.status(404).json({ message: "Campaign not found" });
  const { rows: existing } = await pool.query("SELECT * FROM campaign_participants WHERE campaign_id = $1 AND type = 'vendor' AND ref_id = $2", [c.id, vendorId]);
  if (c.scope === "vendor" && !existing[0]) return res.status(403).json({ message: "This campaign is only for invited shops." });
  if (existing[0]) {
    await pool.query("UPDATE campaign_participants SET opted_in = $2, joined_at = CASE WHEN $2 THEN COALESCE(joined_at, NOW()) ELSE NULL END WHERE id = $1", [existing[0].id, join]);
  } else if (join) {
    await pool.query("INSERT INTO campaign_participants (campaign_id, type, ref_id, opted_in, joined_at) VALUES ($1, 'vendor', $2, TRUE, NOW())", [c.id, vendorId]);
  }
  await recordAudit({ actorUserId: req.user.id, action: join ? "campaign.vendor_opted_in" : "campaign.vendor_opted_out", module: MODULE, entityType: "campaign", entityId: c.id, newValue: { vendorId } });
  res.json({ optedIn: join });
}

// ── Public: what the shopper app may show ──

async function publicCampaigns(req, res) {
  res.set("Cache-Control", "public, max-age=60");
  res.json(await runningCampaigns());
}

/** Running campaigns as the shopper app sees them (also the offers hub, SB6). */
async function runningCampaigns() {
  const { rows } = await pool.query(`SELECT * FROM (${SELECT}) x WHERE x.status = 'running' ORDER BY x.ends_at`);
  const out = [];
  for (const r of rows) {
    const parts = await loadParticipants(r.id);
    out.push({
      id: r.id,
      name: r.name,
      description: r.description,
      bannerUrl: r.banner_url,
      discountType: r.discount_type,
      discountValue: r.discount_value,
      maxDiscountCents: r.max_discount_cents,
      minOrderCents: r.min_order_cents,
      endsAt: r.ends_at,
      scope: r.scope,
      // Where it applies, so the app can label shops and categories.
      categoryIds: parts.filter((p) => p.type === "category").map((p) => p.refId),
      vendorIds: r.funded_by === "platform" && r.scope !== "vendor" ? [] : parts.filter((p) => p.type === "vendor" && (p.optedIn || r.funded_by === "platform")).map((p) => p.refId),
    });
  }
  return out;
}

module.exports = {
  listCampaigns, campaignSummary, getCampaign, createCampaign, updateCampaign,
  resumeCampaign, pauseCampaign, endCampaign,
  candidates, addParticipant, updateParticipant, removeParticipant,
  vendorCampaigns, vendorOptIn, publicCampaigns, runningCampaigns,
};
