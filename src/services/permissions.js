/**
 * The permission catalogue, and the map from request path to required permission.
 *
 * Defined in code rather than a table because these keys are only meaningful to
 * the code that checks them: a permission row in the database naming a module
 * that no longer exists is worse than no row at all. The database stores which
 * role holds which key; this file is the authority on what the keys are.
 *
 * One module per menu in the admin sidebar, and three actions on each of them:
 *
 *   <module>.view     open the module and read what is in it
 *   <module>.edit     create and change things in it
 *   <module>.delete   remove things from it
 *
 * Edit and delete each imply view, because neither is usable without it — a
 * role that may delete an order but not see the order list is a role that can
 * do nothing.
 *
 * `routes` is what makes a key real. It lists the admin API path segments the
 * module owns, and enforcement is driven entirely by that list: a permission
 * with no routes yet hides the menu but guards nothing, because there is not
 * yet an API behind it to guard. Where several menus read and write the same
 * resource they share one module — splitting them in this list would promise
 * an isolation the server cannot deliver, since it sees only the path.
 */

const SUPER_ADMIN = "super_admin";

const ACTIONS = [
  { action: "view", verb: "View" },
  { action: "edit", verb: "Create and edit" },
  { action: "delete", verb: "Delete from" },
];

const MODULES = [
  // ----- Overview -----
  { key: "dashboard", label: "Dashboard", group: "Overview", routes: ["reports"] },
  { key: "analytics", label: "Analytics", group: "Overview", routes: ["analytics"] },

  // ----- Catalogue -----
  {
    key: "products",
    label: "Products, Variants & Moderation",
    group: "Catalogue",
    routes: ["products", "media"],
    covers: ["Products", "Product Variants", "Product Moderation"],
  },
  { key: "categories", label: "Categories", group: "Catalogue", routes: ["categories"] },
  { key: "brands", label: "Brands", group: "Catalogue", routes: ["brands"] },
  { key: "attributes", label: "Attributes", group: "Catalogue", routes: ["attributes"] },
  { key: "catalogue_import", label: "Bulk Import / Export", group: "Catalogue", routes: ["catalogue"] },
  { key: "inventory", label: "Inventory", group: "Catalogue", routes: ["inventory"] },

  // ----- Vendors -----
  {
    key: "vendors",
    label: "Vendors, KYC, Service Areas & Performance",
    group: "Vendors",
    routes: ["vendors", "vendor-documents"],
    covers: ["Vendors", "KYC & Documents", "Service Areas", "Vendor Performance", "Delivery Zones & Rules"],
  },
  { key: "commission_plans", label: "Commission Plans", group: "Vendors", routes: ["commission-plans"] },

  // ----- Orders & Fulfilment -----
  { key: "orders", label: "Orders", group: "Orders & Fulfilment", routes: ["orders"] },
  { key: "control_tower", label: "Order Control Tower", group: "Orders & Fulfilment", routes: ["control-tower"] },
  { key: "vendor_routing", label: "Vendor Matching & Re-routing", group: "Orders & Fulfilment", routes: ["matching"] },
  { key: "shipments", label: "Shipments", group: "Orders & Fulfilment", routes: ["shipments"] },
  { key: "delivery_partners", label: "Delivery Partners", group: "Orders & Fulfilment", routes: ["delivery-partners"] },

  // ----- Payments & Finance -----
  { key: "wallets", label: "Wallets", group: "Payments & Finance", routes: ["wallets"] },
  { key: "payments", label: "Payments", group: "Payments & Finance", routes: ["payments"] },
  { key: "refunds", label: "Refunds", group: "Payments & Finance", routes: ["refunds"] },
  { key: "invoices", label: "Invoices & GST", group: "Payments & Finance", routes: ["invoices"] },
  { key: "settlements", label: "Settlements", group: "Payments & Finance", routes: ["settlements"] },
  { key: "credit_notes", label: "Credit Notes", group: "Payments & Finance", routes: ["credit-notes"] },

  // ----- Post-Purchase -----
  { key: "returns", label: "Returns", group: "Post-Purchase", routes: ["returns"] },
  { key: "replacements", label: "Replacements", group: "Post-Purchase", routes: ["replacements"] },
  { key: "cancellations", label: "Cancellations", group: "Post-Purchase", routes: ["cancellations"] },
  { key: "support", label: "Support Tickets", group: "Post-Purchase", routes: ["support"] },
  { key: "reviews", label: "Reviews & Ratings", group: "Post-Purchase", routes: ["reviews"] },

  // ----- B2B Marketplace -----
  { key: "business_accounts", label: "Business Accounts", group: "B2B Marketplace", routes: ["business-accounts"] },
  { key: "rfq", label: "RFQ Management", group: "B2B Marketplace", routes: ["rfqs"] },
  { key: "quotations", label: "Quotations", group: "B2B Marketplace", routes: ["quotations"] },
  { key: "purchase_orders", label: "Purchase Orders", group: "B2B Marketplace", routes: ["purchase-orders"] },

  // ----- Marketing & CMS -----
  { key: "offers", label: "Offers & Coupons", group: "Marketing & CMS", routes: ["coupons"] },
  { key: "banners", label: "Banners", group: "Marketing & CMS", routes: ["banners"] },
  // Served by its own router at /api/menu/admin rather than a segment under
  // /api/admin, so it is guarded by requirePermissionFor('app_menu') there —
  // enforced, just not through the path-prefix map.
  { key: "app_menu", label: "App Menu", group: "Marketing & CMS", routes: [], guardedElsewhere: true },
  { key: "home_sections", label: "Home Sections", group: "Marketing & CMS", routes: ["home-sections"] },
  { key: "campaigns", label: "Campaigns", group: "Marketing & CMS", routes: ["campaigns"] },

  // ----- Customers & Network -----
  { key: "users", label: "Users", group: "Customers & Network", routes: ["users"] },
  { key: "organisation", label: "Organisation", group: "Customers & Network", routes: ["org"] },
  { key: "referrals", label: "Referrals", group: "Customers & Network", routes: ["referrals"] },

  // ----- System & Administration -----
  {
    key: "staff",
    label: "Admin Staff & RBAC",
    group: "System & Administration",
    routes: ["staff", "roles"],
    covers: ["Admin Staff & RBAC"],
  },
  { key: "audit_logs", label: "Admin Logs", group: "System & Administration", routes: ["audit-logs"] },
  { key: "feature_flags", label: "Feature Flags", group: "System & Administration", routes: ["feature-flags"] },
  { key: "settings", label: "General Settings", group: "System & Administration", routes: ["settings"] },
];

/**
 * The flat catalogue the panel renders as a grid: one row per module, one
 * checkbox per action.
 */
const PERMISSIONS = MODULES.flatMap((module) =>
  ACTIONS.map(({ action, verb }) => ({
    key: `${module.key}.${action}`,
    module: module.key,
    moduleLabel: module.label,
    group: module.group,
    action,
    label: `${verb} ${module.label}`,
    // Both stronger actions are useless without the read they act on, so each
    // carries it rather than making the operator remember to tick all three.
    implies: action === "view" ? undefined : [`${module.key}.view`],
    // True when no API answers to this module yet: the key gates the menu, but
    // there is nothing behind it for the server to refuse.
    pending: module.routes.length === 0 && !module.guardedElsewhere,
    covers: module.covers,
  }))
);

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

/**
 * Path prefix → the module that owns it.
 *
 * Matched on the first path segment, so every route under a prefix is covered
 * by one entry and a route added later inherits the rule rather than being born
 * unguarded. Anything not listed is refused for everyone except a super admin —
 * failing closed, because an unmapped admin route is a mistake, not a
 * free-for-all.
 */
const ROUTE_MODULES = Object.fromEntries(
  MODULES.flatMap((module) => module.routes.map((route) => [route, module.key]))
);

/** GET reads, DELETE deletes, everything else writes. */
function actionFor(method) {
  if (method === "GET" || method === "HEAD") return "view";
  if (method === "DELETE") return "delete";
  return "edit";
}

/** Expands granted keys with everything they imply, so a check is a plain lookup. */
function expand(granted) {
  const held = new Set(granted);
  for (const permission of PERMISSIONS) {
    if (held.has(permission.key) && permission.implies) {
      for (const implied of permission.implies) held.add(implied);
    }
  }
  return held;
}

/** The permission a request needs, or null when the path is unmapped. */
function requiredFor(method, path) {
  const segment = path.split("/").filter(Boolean)[0];
  const module = ROUTE_MODULES[segment];
  if (!module) return null;
  return `${module}.${actionFor(method)}`;
}

module.exports = {
  SUPER_ADMIN,
  ACTIONS,
  MODULES,
  PERMISSIONS,
  PERMISSION_KEYS,
  ROUTE_MODULES,
  actionFor,
  expand,
  requiredFor,
};
