/**
 * Seeds the data the Sprint 1 Postman collection expects.
 *
 *   node scripts/seed-sprint1.js
 *
 * Idempotent — safe to re-run. Every insert either upserts on a natural key or
 * clears its own previous rows first, so repeated runs do not pile up
 * duplicate service areas or products.
 *
 * Creates three accounts, all with password `password123`:
 *   customer@gloaromart.com   — has no addresses; the collection creates them
 *   vendor@gloaromart.com     — approved, pinned in Madurai, 5 km radius
 *   admin@gloaromart.com      — for the admin override folder
 *
 * Geography is arranged so the reason codes are all reachable:
 *   Sri Balaji Stores   pin 9.9252, 78.1198   radius 5 km    open 24h
 *   Anna Nagar Electric pin 10.2, 78.9        radius 3 km    far away  -> OUT_OF_SERVICE_AREA
 *   Night Owl Mart      pin 9.9260, 78.1200   radius 5 km    02:00-02:01 -> STORE_CLOSED
 *   Pincode Only Store  no pin                pincode 625020 only
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/config/db');

const PASSWORD = 'password123';

async function upsertUser(client, { name, email, phone, role }, passwordHash) {
  const { rows } = await client.query(
    `INSERT INTO users (full_name, email, phone_number, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET
       full_name = EXCLUDED.full_name,
       role = EXCLUDED.role,
       -- Reset the password too. Some of these accounts may already exist from
       -- earlier testing with a different password, and this script advertises
       -- a known one — without this the printed credentials would be a lie.
       password_hash = EXCLUDED.password_hash
     RETURNING id, email, role`,
    [name, email, phone, passwordHash, role]
  );
  return rows[0];
}

async function upsertVendor(client, userId, vendor) {
  // vendor_profiles.user_id is UNIQUE, so this is a true upsert.
  const { rows } = await client.query(
    `INSERT INTO vendor_profiles
       (user_id, business_name, business_type, gst_number, address_line, city, state, pincode,
        latitude, longitude, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved')
     ON CONFLICT (user_id) DO UPDATE SET
       business_name = EXCLUDED.business_name,
       city          = EXCLUDED.city,
       state         = EXCLUDED.state,
       pincode       = EXCLUDED.pincode,
       latitude      = EXCLUDED.latitude,
       longitude     = EXCLUDED.longitude,
       status        = 'approved'
     RETURNING id, business_name`,
    [
      userId,
      vendor.businessName,
      vendor.businessType || 'both',
      vendor.gstNumber || null,
      vendor.addressLine || null,
      vendor.city,
      vendor.state,
      vendor.pincode,
      vendor.latitude,
      vendor.longitude,
    ]
  );
  return rows[0];
}

async function setServiceAreas(client, vendorId, areas) {
  // Replace rather than append, so re-running does not stack duplicate rules.
  await client.query('DELETE FROM vendor_service_areas WHERE vendor_id = $1', [vendorId]);
  for (const area of areas) {
    await client.query(
      `INSERT INTO vendor_service_areas (vendor_id, area_type, radius_km, pincode)
       VALUES ($1, $2, $3, $4)`,
      [vendorId, area.type, area.type === 'radius' ? area.radiusKm : null, area.type === 'pincode' ? area.pincode : null]
    );
  }
}

async function setDeliveryRules(client, vendorId, rules) {
  await client.query(
    `INSERT INTO vendor_delivery_rules
       (vendor_id, delivery_charge_cents, free_delivery_above_cents, min_order_cents,
        preparation_minutes, supports_delivery, supports_pickup, opens_at, closes_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (vendor_id) DO UPDATE SET
       delivery_charge_cents     = EXCLUDED.delivery_charge_cents,
       free_delivery_above_cents = EXCLUDED.free_delivery_above_cents,
       min_order_cents           = EXCLUDED.min_order_cents,
       preparation_minutes       = EXCLUDED.preparation_minutes,
       supports_delivery         = EXCLUDED.supports_delivery,
       supports_pickup           = EXCLUDED.supports_pickup,
       opens_at                  = EXCLUDED.opens_at,
       closes_at                 = EXCLUDED.closes_at,
       updated_at                = now()`,
    [
      vendorId,
      rules.deliveryChargeCents ?? 0,
      rules.freeDeliveryAboveCents ?? null,
      rules.minOrderCents ?? 0,
      rules.preparationMinutes ?? 30,
      rules.supportsDelivery !== false,
      rules.supportsPickup === true,
      rules.opensAt || null,
      rules.closesAt || null,
    ]
  );
}

async function upsertProduct(client, vendorId, product) {
  const { rows: existing } = await client.query(
    'SELECT id FROM products WHERE vendor_id = $1 AND name = $2',
    [vendorId, product.name]
  );
  if (existing[0]) {
    const { rows } = await client.query(
      `UPDATE products SET price_cents = $2, stock_quantity = $3, gst_rate_percent = $4,
                           moq = $5, category = $6, is_active = true
       WHERE id = $1 RETURNING id, name`,
      [existing[0].id, product.priceCents, product.stock, product.gst ?? 0, product.moq ?? 1, product.category]
    );
    return rows[0];
  }
  const { rows } = await client.query(
    `INSERT INTO products (vendor_id, name, description, price_cents, stock_quantity,
                           category, gst_rate_percent, moq, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
     RETURNING id, name`,
    [
      vendorId,
      product.name,
      product.description || null,
      product.priceCents,
      product.stock,
      product.category,
      product.gst ?? 0,
      product.moq ?? 1,
    ]
  );
  return rows[0];
}

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const client = await pool.connect();
  const summary = { vendors: [], products: [] };

  try {
    await client.query('BEGIN');

    const customer = await upsertUser(
      client,
      { name: 'Test Customer', email: 'customer@gloaromart.com', phone: '9876543210', role: 'customer' },
      passwordHash
    );
    const admin = await upsertUser(
      client,
      { name: 'Platform Admin', email: 'admin@gloaromart.com', phone: '9000000000', role: 'admin' },
      passwordHash
    );

    const vendorSpecs = [
      {
        login: { name: 'Balaji Owner', email: 'vendor@gloaromart.com', phone: '9111111111' },
        profile: {
          businessName: 'Sri Balaji Stores',
          city: 'Madurai',
          state: 'Tamil Nadu',
          pincode: '625020',
          latitude: 9.9252,
          longitude: 78.1198,
        },
        areas: [{ type: 'radius', radiusKm: 5 }],
        rules: {
          deliveryChargeCents: 3000,
          freeDeliveryAboveCents: 50000,
          minOrderCents: 10000,
          preparationMinutes: 30,
          supportsDelivery: true,
          supportsPickup: true,
        },
        products: [
          // Rs.50 — the only item cheap enough to fall under the Rs.100 minimum,
          // so BELOW_MIN_ORDER is reachable with a single unit.
          { name: 'Salt 1kg', priceCents: 5000, stock: 200, category: 'Grocery', gst: 5 },
          // Rs.120 — over the minimum, under the Rs.500 free-delivery threshold.
          { name: 'Aachi Sambar Masala 500g', priceCents: 12000, stock: 100, category: 'Grocery', gst: 5 },
          // Rs.680 — over the threshold, so delivery comes out free.
          { name: 'Idli Rice 10kg', priceCents: 68000, stock: 40, category: 'Grocery', gst: 5 },
          { name: 'Out Of Stock Item', priceCents: 9900, stock: 0, category: 'Grocery', gst: 5 },
        ],
      },
      {
        login: { name: 'Electronics Owner', email: 'vendor2@gloaromart.com', phone: '9222222222' },
        profile: {
          businessName: 'Anna Nagar Electronics',
          city: 'Dindigul',
          state: 'Tamil Nadu',
          pincode: '624001',
          latitude: 10.2,
          longitude: 78.9,
        },
        // Far from the seeded customer address — exercises OUT_OF_SERVICE_AREA.
        areas: [{ type: 'radius', radiusKm: 3 }],
        rules: { deliveryChargeCents: 5000, minOrderCents: 0, preparationMinutes: 45 },
        products: [{ name: 'Bluetooth Speaker', priceCents: 149900, stock: 25, category: 'Gadgets', gst: 18 }],
      },
      {
        login: { name: 'Night Owl Owner', email: 'vendor3@gloaromart.com', phone: '9333333333' },
        profile: {
          businessName: 'Night Owl Mart',
          city: 'Madurai',
          state: 'Tamil Nadu',
          pincode: '625020',
          latitude: 9.926,
          longitude: 78.12,
        },
        areas: [{ type: 'radius', radiusKm: 5 }],
        // A one-minute window at 2am — reliably closed, exercises STORE_CLOSED.
        rules: { deliveryChargeCents: 2000, opensAt: '02:00', closesAt: '02:01' },
        products: [{ name: 'Midnight Snack Pack', priceCents: 25000, stock: 60, category: 'Grocery', gst: 12 }],
      },
      {
        login: { name: 'Pincode Owner', email: 'vendor4@gloaromart.com', phone: '9444444444' },
        profile: {
          businessName: 'Pincode Only Store',
          city: 'Madurai',
          state: 'Tamil Nadu',
          pincode: '625020',
          // No map pin on purpose — only its pincode rule can ever match.
          latitude: null,
          longitude: null,
        },
        areas: [{ type: 'pincode', pincode: '625020' }],
        rules: { deliveryChargeCents: 1500, minOrderCents: 0 },
        products: [{ name: 'Local Filter Coffee 250g', priceCents: 32000, stock: 80, category: 'Grocery', gst: 5 }],
      },
    ];

    for (const spec of vendorSpecs) {
      const user = await upsertUser(client, { ...spec.login, role: 'vendor' }, passwordHash);
      const vendor = await upsertVendor(client, user.id, spec.profile);
      await setServiceAreas(client, vendor.id, spec.areas);
      await setDeliveryRules(client, vendor.id, spec.rules);

      const products = [];
      for (const p of spec.products) {
        products.push(await upsertProduct(client, vendor.id, p));
      }
      summary.vendors.push({ id: vendor.id, name: vendor.business_name, login: spec.login.email });
      summary.products.push(...products.map((p) => ({ ...p, vendor: vendor.business_name })));
    }

    await client.query('COMMIT');

    console.log('\nSeed complete.\n');
    console.log('Accounts (password: %s)', PASSWORD);
    console.log('  customer  %s  (id %d)', customer.email, customer.id);
    console.log('  admin     %s  (id %d)', admin.email, admin.id);
    for (const v of summary.vendors) {
      console.log('  vendor    %s  -> %s (vendorId %d)', v.login, v.name, v.id);
    }

    // Node's console.log has no printf padding (%-4d), so pad the strings first.
    console.log('\nProducts');
    for (const p of summary.products) {
      console.log(`  productId ${String(p.id).padEnd(4)} ${p.name.padEnd(28)} ${p.vendor}`);
    }

    console.log('\nPostman variables to set');
    console.log('  vendorId  = %d   (Sri Balaji Stores)', summary.vendors[0].id);
    console.log('  productId = %d   (Aachi Sambar Masala)', summary.products[0].id);

    console.log('\nReason codes you can reproduce');
    console.log('  BELOW_MIN_ORDER      order under Rs.100 from Sri Balaji Stores');
    console.log('  OUT_OF_SERVICE_AREA  add Bluetooth Speaker (Anna Nagar Electronics is ~90 km away)');
    console.log('  STORE_CLOSED         add Midnight Snack Pack (Night Owl Mart opens 02:00-02:01)');
    console.log('  OUT_OF_STOCK         add Out Of Stock Item');
    console.log('  PINCODE_NOT_SERVED   add Local Filter Coffee, then use an address outside 625020');
    console.log('\nFree delivery kicks in above Rs.500 at Sri Balaji Stores (Rs.30 otherwise).\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nSeed failed, nothing was written:\n', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
