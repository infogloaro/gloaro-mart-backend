/**
 * Campaign rules shared by the admin, checkout and the shopper apps.
 *
 * Status is worked out, not stored: draft and paused are what an admin set;
 * otherwise a campaign is scheduled before its start, ended after its end or
 * once its spend reaches the budget, and running in between. Spend is the sum
 * of its discounts on orders that weren't cancelled.
 */

const SPENT_SQL = `(SELECT COALESCE(SUM(oc.discount_cents), 0)::int
   FROM order_campaigns oc JOIN orders o ON o.id = oc.order_id
   WHERE oc.campaign_id = c.id AND o.status <> 'cancelled')`;

const STATUS_SQL = `CASE
   WHEN c.state = 'draft' THEN 'draft'
   WHEN c.state = 'paused' THEN 'paused'
   WHEN c.state = 'ended' OR c.ends_at <= NOW()
        OR (c.budget_cents IS NOT NULL AND ${SPENT_SQL} >= c.budget_cents) THEN 'ended'
   WHEN c.starts_at > NOW() THEN 'scheduled'
   ELSE 'running' END`;

/** Platform's and vendor's share of a discount. */
function split(campaign, discountCents) {
  const platformPercent =
    campaign.funded_by === "platform" ? 100 : campaign.funded_by === "vendor" ? 0 : campaign.platform_share_percent ?? 50;
  const platformCents = Math.round((discountCents * platformPercent) / 100);
  return { platformCents, vendorCents: discountCents - platformCents };
}

/**
 * The discount one campaign gives one shop's order, or 0 when it doesn't apply.
 * items: [{ unitPriceCents, quantity, category }]; categoryNames: the campaign's
 * categories (for scope 'category'); remainingBudget: null when uncapped.
 */
function discountFor(campaign, { items, deliveryChargeCents, roomCents, categoryNames, remainingBudget }) {
  const eligible = campaign.scope === "category" ? items.filter((i) => categoryNames.has(String(i.category ?? "").toLowerCase())) : items;
  const base = eligible.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
  if (base === 0 || base < campaign.min_order_cents) return 0;
  let cents;
  if (campaign.discount_type === "percentage") cents = Math.floor((base * campaign.discount_value) / 100);
  else if (campaign.discount_type === "flat") cents = Math.min(campaign.discount_value, base);
  else cents = deliveryChargeCents; // free delivery
  if (campaign.max_discount_cents) cents = Math.min(cents, campaign.max_discount_cents);
  // Never more than is left of the goods after the coupon (free delivery only
  // ever removes the delivery charge, which the total always includes), nor
  // past the budget.
  if (campaign.discount_type !== "free_delivery") cents = Math.min(cents, roomCents);
  if (remainingBudget != null) cents = Math.min(cents, remainingBudget);
  return Math.max(0, cents);
}

/**
 * Inside the checkout transaction: the best running campaign for one shop's
 * order, or null. Candidate campaigns are locked FOR UPDATE, so two checkouts
 * can't both spend the last of a budget.
 */
async function bestCampaignForOrder(client, { vendorId, items, subtotalCents, couponDiscountCents, deliveryChargeCents }) {
  const { rows: campaigns } = await client.query(
    `SELECT c.* FROM campaigns c
     WHERE c.state = 'active' AND c.starts_at <= NOW() AND c.ends_at > NOW()
       AND (c.funded_by = 'platform'
            OR EXISTS (SELECT 1 FROM campaign_participants p
                       WHERE p.campaign_id = c.id AND p.type = 'vendor' AND p.ref_id = $1 AND p.opted_in))
       AND (c.scope <> 'vendor'
            OR EXISTS (SELECT 1 FROM campaign_participants p
                       WHERE p.campaign_id = c.id AND p.type = 'vendor' AND p.ref_id = $1))
     ORDER BY c.id
     FOR UPDATE OF c`,
    [vendorId],
  );
  if (campaigns.length === 0) return null;

  const ids = campaigns.map((c) => c.id);
  const { rows: spentRows } = await client.query(
    `SELECT oc.campaign_id, COALESCE(SUM(oc.discount_cents), 0)::int AS spent
     FROM order_campaigns oc JOIN orders o ON o.id = oc.order_id
     WHERE oc.campaign_id = ANY($1) AND o.status <> 'cancelled' GROUP BY oc.campaign_id`,
    [ids],
  );
  const spent = new Map(spentRows.map((r) => [r.campaign_id, r.spent]));
  const { rows: catRows } = await client.query(
    `SELECT p.campaign_id, LOWER(c.name) AS name FROM campaign_participants p
     JOIN categories c ON c.id = p.ref_id WHERE p.campaign_id = ANY($1) AND p.type = 'category'`,
    [ids],
  );

  let best = null;
  for (const campaign of campaigns) {
    const remainingBudget = campaign.budget_cents == null ? null : campaign.budget_cents - (spent.get(campaign.id) ?? 0);
    if (remainingBudget != null && remainingBudget <= 0) continue;
    const cents = discountFor(campaign, {
      items,
      deliveryChargeCents,
      roomCents: Math.max(0, subtotalCents - couponDiscountCents),
      categoryNames: new Set(catRows.filter((r) => r.campaign_id === campaign.id).map((r) => r.name)),
      remainingBudget,
    });
    if (cents > 0 && (!best || cents > best.discountCents)) best = { campaign, discountCents: cents, ...split(campaign, cents) };
  }
  return best;
}

module.exports = { SPENT_SQL, STATUS_SQL, bestCampaignForOrder, discountFor, split };
