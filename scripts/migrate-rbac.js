/**
 * Applies the admin staff & RBAC section of schema.sql.
 *
 *   node scripts/migrate-rbac.js
 *
 * Every existing admin is made a super admin, so nobody loses access to the
 * panel this secures. Re-running is safe.
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/config/db');

const MARKER = '-- ===== ADMIN STAFF & RBAC (PHASE 15) =====';

async function report(label) {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('staff_roles', 'staff_role_permissions')`
  );
  const present = new Set(tables.map((t) => t.table_name));

  let admins = [];
  if (present.has('staff_roles')) {
    const { rows } = await pool.query(
      `SELECT u.email, r.slug FROM users u
       LEFT JOIN staff_roles r ON r.id = u.staff_role_id
       WHERE u.role = 'admin' ORDER BY u.id`
    );
    admins = rows;
  }

  console.log(`\n${label}`);
  console.log(`  ${present.has('staff_roles') ? '[x]' : '[ ]'} table  staff_roles`);
  console.log(`  ${present.has('staff_role_permissions') ? '[x]' : '[ ]'} table  staff_role_permissions`);
  for (const a of admins) {
    console.log(`      ${a.slug === 'super_admin' ? '[x]' : '[ ]'} ${a.email} → ${a.slug ?? 'no role'}`);
  }

  // The migration is only a success if every admin came out with a role — an
  // admin left with none can reach the panel and do nothing in it.
  return present.size === 2 && admins.length > 0 && admins.every((a) => a.slug);
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const start = schema.indexOf(MARKER);
  if (start === -1) {
    console.error('Could not find the RBAC marker in schema.sql — nothing to run.');
    process.exit(1);
  }
  const sql = schema.slice(start);

  await report('Before:');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('\nMigration applied.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nMigration FAILED, nothing was changed:');
    console.error('  ', err.message);
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  const ok = await report('After:');
  await pool.end();
  console.log(ok ? '\nRBAC ready — every admin is a super admin.\n' : '\nSomething is wrong — check above.\n');
  process.exit(ok ? 0 : 1);
}

main();
