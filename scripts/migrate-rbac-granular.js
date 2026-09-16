/**
 * Moves existing roles onto the per-menu permission keys.
 *
 *   node scripts/migrate-rbac-granular.js
 *
 * The old catalogue had one key per broad module ('catalogue.view',
 * 'orders.manage', …). The new one has three per sidebar menu
 * ('products.view', 'products.edit', 'products.delete', …). A role holding an
 * old key is given every new key that key used to cover, so nobody's access
 * narrows on the way through — a '.manage' key becomes edit *and* delete on
 * each menu it covered, because that is what it allowed before.
 *
 * Idempotent: keys already in the new vocabulary are left alone, and re-running
 * changes nothing. Super admin is untouched — it holds everything by virtue of
 * its slug and has never had rows in this table.
 */
require('dotenv').config({ quiet: true });
const pool = require('../src/config/db');
const { PERMISSION_KEYS } = require('../src/services/permissions');

/** Which menus each old module key covered. */
const OLD_MODULE_MENUS = {
  catalogue: ['products', 'categories', 'brands', 'attributes', 'catalogue_import', 'inventory', 'reviews'],
  orders: [
    'orders',
    'control_tower',
    'vendor_routing',
    'shipments',
    'delivery_partners',
    'returns',
    'replacements',
    'cancellations',
    'rfq',
    'quotations',
    'purchase_orders',
  ],
  vendors: ['vendors'],
  finance: ['wallets', 'payments', 'refunds', 'invoices', 'settlements', 'credit_notes', 'commission_plans'],
  customers: ['users', 'organisation', 'business_accounts', 'support'],
  marketing: ['offers', 'banners', 'app_menu', 'home_sections', 'campaigns', 'referrals', 'notifications'],
  reports: ['dashboard', 'analytics'],
  settings: ['settings', 'feature_flags'],
  staff: ['staff'],
  audit: ['audit_logs'],
};

/** 'catalogue.view' → every new key it used to imply. */
function translate(oldKey) {
  const [module, action] = oldKey.split('.');
  const menus = OLD_MODULE_MENUS[module];
  if (!menus) return [];

  // 'manage' was create, change and remove in one, so it becomes all three.
  const actions = action === 'view' ? ['view'] : ['view', 'edit', 'delete'];
  return menus.flatMap((menu) => actions.map((a) => `${menu}.${a}`)).filter((k) => PERMISSION_KEYS.has(k));
}

async function main() {
  const { rows: roles } = await pool.query(
    `SELECT r.id, r.name, r.is_system,
            COALESCE(ARRAY_AGG(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
     FROM staff_roles r
     LEFT JOIN staff_role_permissions p ON p.role_id = r.id
     GROUP BY r.id ORDER BY r.id`
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const role of roles) {
      const legacy = role.permissions.filter((k) => !PERMISSION_KEYS.has(k));
      if (legacy.length === 0) {
        console.log(`  ${role.name}: already on the new keys (${role.permissions.length} held)`);
        continue;
      }

      const kept = role.permissions.filter((k) => PERMISSION_KEYS.has(k));
      const translated = legacy.flatMap(translate);
      const next = [...new Set([...kept, ...translated])];

      await client.query('DELETE FROM staff_role_permissions WHERE role_id = $1', [role.id]);
      for (const permission of next) {
        await client.query(
          'INSERT INTO staff_role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [role.id, permission]
        );
      }

      console.log(`  ${role.name}: ${legacy.join(', ')}`);
      console.log(`    → ${next.length} keys across ${new Set(next.map((k) => k.split('.')[0])).size} menus`);
    }

    await client.query('COMMIT');
    console.log('\nMigration applied.\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nMigration FAILED, nothing was changed:\n  ', err.message);
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();
  await pool.end();
}

main();
