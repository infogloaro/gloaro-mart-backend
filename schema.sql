CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  full_name TEXT,
  email TEXT NOT NULL UNIQUE,
  phone_number TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===== PHASE 1 ADDITIONS (GLOARO MART) =====

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'customer'
  CHECK (role IN ('customer', 'vendor', 'admin'));

CREATE TABLE vendor_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  business_type TEXT NOT NULL CHECK (business_type IN ('b2b', 'b2c', 'both')),
  gst_number TEXT,
  address_line TEXT,
  city TEXT,
  state TEXT,
  pincode TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_vendor_profiles_user_id ON vendor_profiles(user_id);

-- If CREATE EXTENSION fails (managed Postgres without superuser), fall back to a
-- haversine formula written directly in SQL in nearby.controller.js's query.
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
CREATE INDEX idx_vendor_profiles_geo ON vendor_profiles USING gist (ll_to_earth(latitude, longitude));

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_products_vendor_id ON products(vendor_id);
CREATE INDEX idx_products_category ON products(category);

CREATE TABLE carts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_carts_active_per_user ON carts(user_id) WHERE status = 'active';

CREATE TABLE cart_items (
  id SERIAL PRIMARY KEY,
  cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (cart_id, product_id)
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled')),
  payment_method TEXT NOT NULL DEFAULT 'cod' CHECK (payment_method IN ('cod')),
  total_cents INTEGER NOT NULL,
  delivery_address TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_vendor_id ON orders(vendor_id);

CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name_snapshot TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

-- ===== PHASE 2 ADDITIONS (GLOARO MART) =====

-- --- GST ---
ALTER TABLE products ADD COLUMN gst_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0
  CHECK (gst_rate_percent >= 0 AND gst_rate_percent <= 100);

ALTER TABLE orders ADD COLUMN subtotal_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN gst_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
-- total_cents stays as the grand total (subtotal - discount + gst) so existing
-- mobile code reading order.total keeps working unchanged.

ALTER TABLE order_items ADD COLUMN gst_rate_percent_snapshot NUMERIC(5,2) NOT NULL DEFAULT 0;

-- --- B2B bulk pricing + MOQ ---
ALTER TABLE products ADD COLUMN moq INTEGER NOT NULL DEFAULT 1 CHECK (moq >= 1);

CREATE TABLE product_price_tiers (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_quantity INTEGER NOT NULL CHECK (min_quantity >= 1),
  max_quantity INTEGER, -- NULL = open-ended top tier ("50+")
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  created_at TIMESTAMPTZ DEFAULT now(),
  CHECK (max_quantity IS NULL OR max_quantity >= min_quantity)
);
CREATE INDEX idx_price_tiers_product_id ON product_price_tiers(product_id);

-- --- Wallet ---
CREATE TABLE vendor_wallets (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL UNIQUE REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE wallet_transactions (
  id SERIAL PRIMARY KEY,
  vendor_wallet_id INTEGER NOT NULL REFERENCES vendor_wallets(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('credit')), -- only 'credit' in Phase 2; no payouts yet
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_after_cents INTEGER NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_wallet_txns_wallet_id ON wallet_transactions(vendor_wallet_id);
-- Guard against double-crediting if updateStatus is retried/called twice on an
-- already-delivered order.
CREATE UNIQUE INDEX idx_wallet_txns_one_credit_per_order ON wallet_transactions(order_id)
  WHERE type = 'credit';

-- --- Offers / coupons ---
CREATE TABLE coupons (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('flat', 'percentage')),
  discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
  min_order_value_cents INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (vendor_id, code)
);
CREATE INDEX idx_coupons_vendor_id ON coupons(vendor_id);

ALTER TABLE orders ADD COLUMN coupon_id INTEGER REFERENCES coupons(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN coupon_code_snapshot TEXT;

-- ===== PHASE 3 ADDITIONS (GLOARO MART) =====
-- Business 360: State -> District -> Chapter -> Members -> Businesses -> Referral Network

CREATE TABLE states (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_states_name_ci ON states (LOWER(name));

CREATE TABLE districts (
  id SERIAL PRIMARY KEY,
  state_id INTEGER NOT NULL REFERENCES states(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_districts_state_id ON districts(state_id);
CREATE UNIQUE INDEX idx_districts_name_ci_per_state ON districts (state_id, LOWER(name));

CREATE TABLE chapters (
  id SERIAL PRIMARY KEY,
  district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_chapters_district_id ON chapters(district_id);
CREATE UNIQUE INDEX idx_chapters_name_ci_per_district ON chapters (district_id, LOWER(name));

-- 1:1 membership, mirrors vendor_profiles.user_id UNIQUE. Switching chapters
-- upserts chapter_id + resets joined_at rather than delete+recreate.
CREATE TABLE chapter_memberships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE RESTRICT,
  joined_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_chapter_memberships_chapter_id ON chapter_memberships(chapter_id);

CREATE TABLE referrals (
  id SERIAL PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  referring_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiving_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  estimated_value_cents INTEGER NOT NULL DEFAULT 0 CHECK (estimated_value_cents >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converted', 'declined')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CHECK (referring_user_id <> receiving_user_id)
);
CREATE INDEX idx_referrals_chapter_id ON referrals(chapter_id);
CREATE INDEX idx_referrals_referring_user_id ON referrals(referring_user_id);
CREATE INDEX idx_referrals_receiving_user_id ON referrals(receiving_user_id);

-- ===== PHASE 4 ADDITIONS (GLOARO MART) =====
-- Delivery Tracking: set once per order, so plain columns rather than a log table.
ALTER TABLE orders ADD COLUMN delivery_partner_name TEXT;
ALTER TABLE orders ADD COLUMN delivery_partner_phone TEXT;
ALTER TABLE orders ADD COLUMN estimated_delivery_at TIMESTAMPTZ;

-- ===== ADMIN MODULE ADDITIONS =====

-- Vendor approval gate: new vendors default to pending. Does NOT retroactively
-- change existing rows -- only affects future INSERTs.
ALTER TABLE vendor_profiles ALTER COLUMN status SET DEFAULT 'pending';

-- Platform-wide coupons: vendor_id nullable, NULL = platform-wide.
ALTER TABLE coupons ALTER COLUMN vendor_id DROP NOT NULL;
CREATE UNIQUE INDEX idx_coupons_platform_code ON coupons(code) WHERE vendor_id IS NULL;

-- ===== BANNERS MODULE ADDITIONS =====
-- Home screen promo banners, managed from the admin web dashboard.
-- image_data stores a base64 data URI (no external object storage configured).
CREATE TABLE IF NOT EXISTS banners (
  id SERIAL PRIMARY KEY,
  title TEXT,
  subtitle TEXT,
  image_data TEXT NOT NULL,
  link_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- Where the image is rendered: the home carousel, or the background of one
  -- of the three section cards above it.
  placement TEXT NOT NULL DEFAULT 'home'
    CHECK (placement IN ('home', 'card_shop', 'card_b2b', 'card_nearme')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_banners_active_sort ON banners(is_active, sort_order);
CREATE INDEX idx_banners_placement_active_sort ON banners(placement, is_active, sort_order);

-- ===== ADMIN MODULES: CATEGORIES, VENDOR SUSPEND =====

-- Product categories, previously hardcoded in the mobile app.
-- ===== PHASE 5 ADDITIONS (GLOARO MART) =====

-- App drawer / header menu, managed from the admin panel so the navigation can
-- change without shipping a new build.
CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  icon_key TEXT,
  -- Where tapping it goes. 'section' = a built-in app screen (shop, b2b,
  -- near_me, orders, wallet…), 'category' = the catalogue filtered by
  -- link_value, 'url' = an external link.
  link_type TEXT NOT NULL DEFAULT 'section'
    CHECK (link_type IN ('section', 'category', 'vendor', 'url')),
  link_value TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_menu_items_active ON menu_items(is_active, sort_order);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon_key TEXT NOT NULL DEFAULT 'other',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_categories_active_sort ON categories(is_active, sort_order);
-- Optional picture for the app's category tiles (scripts/migrate-category-images.js).
ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_url TEXT;

INSERT INTO categories (name, icon_key, sort_order) VALUES
  ('Gadgets', 'devices', 0),
  ('Fashion', 'fashion', 1),
  ('Grocery', 'grocery', 2),
  ('Home', 'home', 3),
  ('Beauty', 'beauty', 4)
ON CONFLICT (name) DO NOTHING;

-- Allow admin to suspend an already-approved vendor.
ALTER TABLE vendor_profiles DROP CONSTRAINT IF EXISTS vendor_profiles_status_check;
ALTER TABLE vendor_profiles ADD CONSTRAINT vendor_profiles_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'suspended'));

-- ===== SPRINT 1: ADDRESS BOOK & SERVICEABILITY (PHASE 1) =====
-- Contracts: documents/SPRINT_1_ADDRESS_SERVICEABILITY_SPEC.md

CREATE TABLE IF NOT EXISTS addresses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_name TEXT NOT NULL,
  mobile_number TEXT NOT NULL,
  house_building TEXT NOT NULL,
  street TEXT,
  area TEXT,
  landmark TEXT,
  city TEXT NOT NULL,
  district TEXT,
  state TEXT NOT NULL,
  pincode TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  address_type TEXT NOT NULL DEFAULT 'home'
    CHECK (address_type IN ('home', 'work', 'other')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  -- Orders reference these rows, so deleting is a soft delete. A hard DELETE
  -- would break the address shown on a past order.
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id) WHERE is_active;
-- One default per customer, enforced here rather than in application code that
-- can race with itself on two simultaneous "set default" taps.
CREATE UNIQUE INDEX IF NOT EXISTS idx_addresses_one_default_per_user
  ON addresses(user_id) WHERE is_default AND is_active;
CREATE INDEX IF NOT EXISTS idx_addresses_geo
  ON addresses USING gist (ll_to_earth(latitude, longitude));

-- Where a vendor can deliver: a radius around the shop, or an allowed pincode.
CREATE TABLE IF NOT EXISTS vendor_service_areas (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  area_type TEXT NOT NULL DEFAULT 'radius'
    CHECK (area_type IN ('radius', 'pincode')),
  radius_km NUMERIC(6,2),
  pincode TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  CHECK (
    (area_type = 'radius'  AND radius_km IS NOT NULL) OR
    (area_type = 'pincode' AND pincode   IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_vendor_service_areas_vendor ON vendor_service_areas(vendor_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_vendor_service_areas_pincode ON vendor_service_areas(pincode) WHERE is_active;

-- One row per vendor: charges, thresholds and store hours.
CREATE TABLE IF NOT EXISTS vendor_delivery_rules (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL UNIQUE REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  delivery_charge_cents INTEGER NOT NULL DEFAULT 0 CHECK (delivery_charge_cents >= 0),
  free_delivery_above_cents INTEGER CHECK (free_delivery_above_cents >= 0),
  min_order_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
  preparation_minutes INTEGER NOT NULL DEFAULT 30 CHECK (preparation_minutes >= 0),
  supports_delivery BOOLEAN NOT NULL DEFAULT true,
  supports_pickup BOOLEAN NOT NULL DEFAULT false,
  opens_at TIME,
  closes_at TIME,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Orders: structured address alongside the legacy free-text column.
-- delivery_address stays nullable and in place until every client sends
-- address_id; it is dropped in a later release, not this one.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_id INTEGER REFERENCES addresses(id) ON DELETE RESTRICT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address_snapshot JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_charge_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'delivery';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_method_check
  CHECK (delivery_method IN ('delivery', 'pickup'));
ALTER TABLE orders ALTER COLUMN delivery_address DROP NOT NULL;

-- ===== PHASE 2: BRANDS (CATALOGUE FOUNDATION) =====
-- Admin-managed brand master. Products point at a brand; the column is nullable
-- because the catalogue predates brands and unbranded local goods are normal.

CREATE TABLE IF NOT EXISTS brands (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  -- Stable key for app-side filtering and deep links, so a display-name change
  -- does not break a saved filter.
  slug TEXT NOT NULL UNIQUE,
  logo_url TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brands_active_sort ON brands(is_active, sort_order);

-- ON DELETE SET NULL is the safety net only: brand.controller refuses to delete a
-- brand that still has products, so this never fires in normal operation.
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);

-- ===== PLATFORM SETTINGS (GENERAL SETTINGS) =====
-- One row, id pinned to 1. Branding and business details the admin edits and
-- the app reads, so the logo or a support number can change without a release.

CREATE TABLE IF NOT EXISTS platform_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  platform_name TEXT NOT NULL DEFAULT 'Gloaro Mart',
  tagline TEXT,
  logo_url TEXT,
  favicon_url TEXT,
  support_email TEXT,
  support_phone TEXT,
  whatsapp_number TEXT,
  address_line TEXT,
  city TEXT,
  state TEXT,
  pincode TEXT,
  gst_number TEXT,
  currency_code TEXT NOT NULL DEFAULT 'INR',
  invoice_prefix TEXT NOT NULL DEFAULT 'GLM',
  instagram_url TEXT,
  facebook_url TEXT,
  youtube_url TEXT,
  -- When on, the app shows a maintenance notice instead of the catalogue.
  maintenance_mode BOOLEAN NOT NULL DEFAULT false,
  maintenance_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (id, platform_name, tagline)
VALUES (1, 'Gloaro Mart', 'One Ecosystem. Multiple Business Solutions.')
ON CONFLICT (id) DO NOTHING;

-- ===== SPRINT 2: CHECKOUT GROUPS & ORDER STATUS HISTORY (PHASE 5) =====
-- Contracts per documents/SPRINT_2_CHECKOUT_GROUPS_SPEC.md
--
-- Checkout already splits a cart into one order per vendor. This adds the
-- missing parent so three shops bought in one tap read as one purchase, and a
-- log so a status change records who moved it and when.
--
-- The rule this block preserves: each vendor order keeps its own independent
-- lifecycle. The group is a header, never a state machine — which is why there
-- is no status column on checkout_groups. Group status is derived on read.
--
-- Everything here is idempotent, so scripts/migrate-sprint2.js can be re-run.

-- Human-facing reference: GLM-2026-00001. A sequence, not COUNT(*) + 1 — two
-- simultaneous checkouts would compute the same number and one would fail the
-- unique index.
CREATE SEQUENCE IF NOT EXISTS checkout_group_ref_seq;

CREATE TABLE IF NOT EXISTS checkout_groups (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  address_id INTEGER REFERENCES addresses(id) ON DELETE RESTRICT,
  delivery_address_snapshot JSONB,
  delivery_method TEXT NOT NULL DEFAULT 'delivery'
    CHECK (delivery_method IN ('delivery', 'pickup')),

  -- Rolled up from the vendor orders at checkout, so the customer sees one
  -- total without the app having to add up N orders itself.
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  gst_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  delivery_charge_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,

  payment_method TEXT NOT NULL DEFAULT 'cod' CHECK (payment_method IN ('cod')),
  -- Widened in Phase 6 when the gateway lands.
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkout_groups_user_id ON checkout_groups(user_id, created_at DESC);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_group_id INTEGER REFERENCES checkout_groups(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_orders_checkout_group_id ON orders(checkout_group_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,               -- NULL for the row written at creation
  to_status TEXT NOT NULL,
  changed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_role IN ('customer', 'vendor', 'admin', 'system')),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id, created_at);

-- --- Backfill: existing data must not look broken ---

-- One group per pre-Sprint-2 order, so old orders still open in the new UI.
-- LEGACY references are deliberately outside the GLM-YYYY-NNNNN series.
INSERT INTO checkout_groups (reference, user_id, address_id, delivery_address_snapshot, delivery_method,
                             subtotal_cents, gst_cents, discount_cents, delivery_charge_cents, total_cents,
                             payment_method, created_at)
SELECT 'GLM-LEGACY-' || lpad(o.id::text, 6, '0'), o.user_id, o.address_id, o.delivery_address_snapshot,
       COALESCE(o.delivery_method, 'delivery'), o.subtotal_cents, o.gst_cents, o.discount_cents,
       COALESCE(o.delivery_charge_cents, 0), o.total_cents, o.payment_method, o.created_at
FROM orders o
WHERE o.checkout_group_id IS NULL
ON CONFLICT (reference) DO NOTHING;

UPDATE orders o
SET checkout_group_id = cg.id
FROM checkout_groups cg
WHERE o.checkout_group_id IS NULL
  AND cg.reference = 'GLM-LEGACY-' || lpad(o.id::text, 6, '0');

-- Seed a history row so no timeline renders empty.
INSERT INTO order_status_history (order_id, from_status, to_status, actor_role, created_at, note)
SELECT o.id, NULL, o.status, 'system', o.created_at, 'Backfilled from order record'
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id);

-- Every row is linked now, so the column can carry the invariant itself.
ALTER TABLE orders ALTER COLUMN checkout_group_id SET NOT NULL;

-- ===== SPRINT 3: PAYMENTS & REFUNDS (PHASE 6) =====
-- Contracts per documents/SPRINT_3_PAYMENTS_SPEC.md
--
-- One payment per checkout group: the customer pays once for the purchase,
-- exactly as Sprint 2 set it up. Refunds hang off the payment and may name a
-- single vendor order, because one shop can refund without the others.
--
-- Payment status is STORED, unlike a group's derived status. The truth for a
-- group lives in its own orders, so a copy would drift; the truth for a payment
-- lives at a gateway and arrives as unordered webhooks, so there is nothing
-- local to derive. Every event that set it is kept in payment_transactions.
--
-- Everything here is idempotent, so scripts/migrate-sprint3.js can be re-run.

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  checkout_group_id INTEGER NOT NULL UNIQUE REFERENCES checkout_groups(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  method TEXT NOT NULL CHECK (method IN ('cod', 'upi', 'card', 'netbanking', 'wallet')),
  -- 'cod' until a gateway lands; each adapter sets its own name after that.
  provider TEXT NOT NULL DEFAULT 'cod',
  provider_payment_id TEXT,

  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'processing', 'successful', 'failed',
                      'cancelled', 'refunded', 'partially_refunded')),

  amount_cents INTEGER NOT NULL,
  amount_captured_cents INTEGER NOT NULL DEFAULT 0,
  amount_refunded_cents INTEGER NOT NULL DEFAULT 0,

  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- One row per try. A customer whose UPI fails and who then pays by card has two
-- attempts and one payment; without this the failed try either vanishes or
-- corrupts the payment row.
CREATE TABLE IF NOT EXISTS payment_attempts (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'processing', 'successful', 'failed', 'cancelled')),
  provider_order_id TEXT,
  provider_reference TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_payment ON payment_attempts(payment_id, created_at);

-- Append-only. Rows are inserted, never updated or deleted: this is the record
-- the stored payment status can always be re-checked against.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  attempt_id INTEGER REFERENCES payment_attempts(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  -- The gateway's own event id. This UNIQUE is what makes a replayed webhook a
  -- no-op instead of a double capture.
  provider_event_id TEXT UNIQUE,
  actor_role TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_role IN ('customer', 'vendor', 'admin', 'system', 'gateway')),
  changed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_payment ON payment_transactions(payment_id, created_at);

CREATE TABLE IF NOT EXISTS refunds (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  -- Set when the refund is for one shop's order rather than the whole purchase.
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  provider_refund_id TEXT,
  requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);

CREATE TABLE IF NOT EXISTS refund_transactions (
  id SERIAL PRIMARY KEY,
  refund_id INTEGER NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  provider_event_id TEXT UNIQUE,
  actor_role TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_role IN ('customer', 'vendor', 'admin', 'system', 'gateway')),
  changed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refund_transactions_refund ON refund_transactions(refund_id, created_at);

-- --- Backfill: every purchase gets the COD payment it always implicitly had ---
--
-- Status is read from the orders as they stand: all delivered means the cash
-- was collected, all cancelled means it never will be, anything else is still
-- owed. Cancelled orders are excluded from the captured amount.
INSERT INTO payments (checkout_group_id, user_id, method, provider, status,
                      amount_cents, amount_captured_cents, created_at)
SELECT cg.id,
       cg.user_id,
       'cod',
       'cod',
       CASE
         WHEN COUNT(*) FILTER (WHERE o.status <> 'cancelled') = 0 THEN 'cancelled'
         WHEN COUNT(*) FILTER (WHERE o.status <> 'cancelled' AND o.status <> 'delivered') = 0 THEN 'successful'
         ELSE 'pending'
       END,
       cg.total_cents,
       CASE
         WHEN COUNT(*) FILTER (WHERE o.status <> 'cancelled' AND o.status <> 'delivered') = 0
           THEN COALESCE(SUM(o.total_cents) FILTER (WHERE o.status = 'delivered'), 0)
         ELSE 0
       END,
       cg.created_at
FROM checkout_groups cg
JOIN orders o ON o.checkout_group_id = cg.id
WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.checkout_group_id = cg.id)
GROUP BY cg.id, cg.user_id, cg.total_cents, cg.created_at;

-- One ledger row per backfilled payment, so no history renders empty.
INSERT INTO payment_transactions (payment_id, event, amount_cents, actor_role, note, created_at)
SELECT p.id, 'backfilled', p.amount_captured_cents, 'system',
       'Created from the existing order records', p.created_at
FROM payments p
WHERE NOT EXISTS (SELECT 1 FROM payment_transactions t WHERE t.payment_id = p.id);

-- ===== SPRINT 4: CATALOGUE FOUNDATION & INVENTORY (PHASE 2) =====
-- Contracts per documents/SPRINT_4_CATALOGUE_INVENTORY_SPEC.md
--
-- Part A gives a product variants, media and attributes. Part B gives every
-- sellable thing a stock row with a movement log. They land together because a
-- reservation cannot be written against a variant that does not exist yet.
--
-- The rule this block preserves: a product with no variants behaves exactly as
-- it does today. Everything here is additive and nullable, so an app build
-- already in the field keeps reading price_cents, stock_quantity and image_url
-- and keeps getting the truth.
--
-- Those three columns become server-maintained mirrors once variants or media
-- exist: lowest active variant price, summed inventory, primary image. They are
-- never written by hand again -- refreshProductMirrors in
-- src/controllers/catalogue.controller.js is the only writer.
--
-- Everything here is idempotent, so scripts/migrate-sprint4.js can be re-run.

-- --- Part A: catalogue ---

ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_code TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS mrp_cents INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS specifications JSONB;

-- The vendor's own code, so two shops may both stock the same SKU string.
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_vendor_sku
  ON products(vendor_id, sku) WHERE sku IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT,
  price_cents INTEGER NOT NULL,
  mrp_cents INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variants_sku
  ON product_variants(product_id, sku) WHERE sku IS NOT NULL;

-- Category-scoped, so Fashion offers Size and Colour while Electronics offers
-- Storage and RAM. category_id NULL means every category.
CREATE TABLE IF NOT EXISTS product_attributes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  input_type TEXT NOT NULL DEFAULT 'select'
    CHECK (input_type IN ('select', 'text', 'number')),
  -- Separates the attributes that make a different sellable thing (size) from
  -- those that merely describe one (material).
  is_variant_defining BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_product_attributes_category ON product_attributes(category_id);

CREATE TABLE IF NOT EXISTS attribute_values (
  id SERIAL PRIMARY KEY,
  attribute_id INTEGER NOT NULL REFERENCES product_attributes(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (attribute_id, value)
);

-- RESTRICT, not CASCADE: deleting the value 'Large' while variants are sold as
-- Large would erase what those variants are. The delete is refused instead.
CREATE TABLE IF NOT EXISTS variant_attribute_values (
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  attribute_value_id INTEGER NOT NULL REFERENCES attribute_values(id) ON DELETE RESTRICT,
  PRIMARY KEY (variant_id, attribute_value_id)
);

CREATE TABLE IF NOT EXISTS product_media (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL DEFAULT 'image'
    CHECK (media_type IN ('image', 'video')),
  url TEXT NOT NULL,
  alt_text TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_media_product ON product_media(product_id, sort_order);

-- Exactly one primary per product, enforced here rather than by trusting the
-- caller. Promoting a second image has to demote the first in the same
-- transaction, which is what makes the swap atomic.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_media_primary
  ON product_media(product_id) WHERE is_primary;

-- --- Part B: inventory ---

-- One row per sellable thing: a variant, or a product with no variants.
CREATE TABLE IF NOT EXISTS inventory (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  available_qty INTEGER NOT NULL DEFAULT 0 CHECK (available_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  sold_qty INTEGER NOT NULL DEFAULT 0 CHECK (sold_qty >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Two indexes rather than one UNIQUE (product_id, variant_id): in Postgres a
-- NULL is never equal to another NULL, so the plain constraint would let a
-- product collect any number of simple stock rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_variant
  ON inventory(variant_id) WHERE variant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_simple
  ON inventory(product_id) WHERE variant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_vendor ON inventory(vendor_id);

-- Append-only. The three counters above can always be re-derived from this.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id SERIAL PRIMARY KEY,
  inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  delta_available INTEGER NOT NULL DEFAULT 0,
  delta_reserved INTEGER NOT NULL DEFAULT 0,
  delta_sold INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL
    CHECK (reason IN ('reserved', 'released', 'sold', 'restocked', 'adjusted')),
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_role IN ('customer', 'vendor', 'admin', 'system', 'gateway')),
  changed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_inventory
  ON inventory_movements(inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_order ON inventory_movements(order_id);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id SERIAL PRIMARY KEY,
  inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  checkout_group_id INTEGER REFERENCES checkout_groups(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'held'
    CHECK (status IN ('held', 'confirmed', 'released', 'expired')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_order ON inventory_reservations(order_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_open
  ON inventory_reservations(expires_at) WHERE status = 'held';

-- --- Cart and order lines carry a variant ---

ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS variant_id INTEGER
  REFERENCES product_variants(id) ON DELETE CASCADE;

-- The old UNIQUE (cart_id, product_id) would collapse a Small and a Large into
-- one line. Replaced by the same NULL-safe pair used on inventory.
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_cart_id_product_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_items_simple
  ON cart_items(cart_id, product_id) WHERE variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_items_variant
  ON cart_items(cart_id, product_id, variant_id) WHERE variant_id IS NOT NULL;

-- SET NULL, not CASCADE: deleting a variant must never delete the record of
-- what was sold. The label is snapshotted for exactly the same reason.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id INTEGER
  REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_label_snapshot TEXT;

-- --- Backfill: existing data must not look broken ---
--
-- No product gets variants. A flat catalogue is a catalogue of simple products,
-- and inventing variants would be inventing data.

-- Every product gets the stock row it always implicitly had.
INSERT INTO inventory (product_id, variant_id, vendor_id, available_qty)
SELECT p.id, NULL, p.vendor_id, GREATEST(p.stock_quantity, 0)
FROM products p
WHERE NOT EXISTS (
  SELECT 1 FROM inventory i WHERE i.product_id = p.id AND i.variant_id IS NULL
);

-- One movement per backfilled row, so no stock number exists without a reason.
INSERT INTO inventory_movements (inventory_id, delta_available, reason, actor_role, note, created_at)
SELECT i.id, i.available_qty, 'restocked', 'system',
       'Backfilled from products.stock_quantity', now()
FROM inventory i
WHERE NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.inventory_id = i.id);

-- Every product with an image gets that image as its primary media row.
INSERT INTO product_media (product_id, media_type, url, is_primary, sort_order)
SELECT p.id, 'image', p.image_url, true, 0
FROM products p
WHERE p.image_url IS NOT NULL
  AND btrim(p.image_url) <> ''
  AND NOT EXISTS (SELECT 1 FROM product_media m WHERE m.product_id = p.id AND m.is_primary);

-- ===== SPRINT 5: LOCATION-BASED VENDOR MATCHING ENGINE (PHASE 3) =====
-- Contracts per documents/SPRINT_5_VENDOR_MATCHING_SPEC.md
--
-- Two shops selling the same thing were, until now, two unrelated rows. This
-- block gives them a shared key, gives every vendor a score to be ranked by,
-- and gives a rejected order somewhere else to go.
--
-- The rule this block preserves: a customer who chose a shop still gets that
-- shop. Nothing here re-picks a vendor during checkout — matching runs before
-- the customer commits, and after a vendor rejects.
--
-- Everything here is idempotent, so scripts/migrate-sprint5.js can be re-run.

-- --- What makes two products the same thing ---

-- Generated, not maintained. An application-side key drifts the first time a
-- product is renamed by a path that forgot to update it; a generated column
-- cannot disagree with the row it lives on. Unbranded goods fall back to the
-- name alone, which is looser — acceptable, because a candidate is only ever
-- offered, never auto-assigned without the price check in the re-routing.
ALTER TABLE products ADD COLUMN IF NOT EXISTS match_key TEXT
  GENERATED ALWAYS AS (COALESCE(brand_id::text, '-') || '|' || lower(btrim(name))) STORED;

CREATE INDEX IF NOT EXISTS idx_products_match_key ON products(match_key);

-- --- The weights the score is built from ---

-- One row, id pinned to 1 — the same shape as platform_settings. Admin edits
-- them; nothing else writes them.
CREATE TABLE IF NOT EXISTS vendor_matching_weights (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  stock_weight NUMERIC(6,2) NOT NULL DEFAULT 20 CHECK (stock_weight >= 0),
  distance_weight NUMERIC(6,2) NOT NULL DEFAULT 25 CHECK (distance_weight >= 0),
  delivery_weight NUMERIC(6,2) NOT NULL DEFAULT 15 CHECK (delivery_weight >= 0),
  price_weight NUMERIC(6,2) NOT NULL DEFAULT 20 CHECK (price_weight >= 0),
  rating_weight NUMERIC(6,2) NOT NULL DEFAULT 10 CHECK (rating_weight >= 0),
  performance_weight NUMERIC(6,2) NOT NULL DEFAULT 10 CHECK (performance_weight >= 0),
  -- An alternative costing up to this much more is assigned outright; anything
  -- dearer waits for the customer, because silently charging more is not a
  -- reassignment the platform gets to make alone.
  reassign_price_tolerance_percent NUMERIC(6,2) NOT NULL DEFAULT 10
    CHECK (reassign_price_tolerance_percent >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO vendor_matching_weights (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- --- What a vendor's record says about it ---

-- Counters only. Rates are derived on read — two columns that must agree is one
-- column too many. Maintained as orders move rather than aggregated at match
-- time, which would put a full scan of orders on the critical path of every
-- product view.
CREATE TABLE IF NOT EXISTS vendor_performance_metrics (
  vendor_id INTEGER PRIMARY KEY REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  orders_total INTEGER NOT NULL DEFAULT 0,
  orders_accepted INTEGER NOT NULL DEFAULT 0,
  orders_rejected INTEGER NOT NULL DEFAULT 0,
  orders_cancelled INTEGER NOT NULL DEFAULT 0,
  orders_delivered INTEGER NOT NULL DEFAULT 0,
  -- Live count of orders not yet in a terminal state: the vendor's workload.
  open_orders INTEGER NOT NULL DEFAULT 0 CHECK (open_orders >= 0),
  fulfilment_minutes_total BIGINT NOT NULL DEFAULT 0,
  -- Reviews arrive in Phase 13. Until then rating_count stays 0 and the rating
  -- axis scores neutral, so a vendor with no reviews is not ranked last forever.
  rating_sum NUMERIC(12,2) NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Why a vendor won ---

-- The candidates and their sub-scores as they were at the time. A score
-- recomputed later would use today's stock and today's weights, and could never
-- explain a decision made last week.
CREATE TABLE IF NOT EXISTS vendor_matching_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
  context TEXT NOT NULL DEFAULT 'browse'
    CHECK (context IN ('browse', 'checkout', 'reroute')),
  strategy TEXT NOT NULL DEFAULT 'recommended'
    CHECK (strategy IN ('recommended', 'fastest', 'cheapest', 'nearest', 'best_rated', 'pickup')),
  match_key TEXT,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  quantity INTEGER,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  selected_vendor_id INTEGER REFERENCES vendor_profiles(id) ON DELETE SET NULL,
  weights JSONB,
  candidates JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_matching_logs_created ON vendor_matching_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_matching_logs_user ON vendor_matching_logs(user_id, created_at DESC);

-- --- Where a rejected order went ---

-- A rejection does not move an order to another vendor: the original is
-- cancelled and a replacement is created, so each vendor keeps its own order
-- and its own history. This table is the link between the two.
CREATE TABLE IF NOT EXISTS order_assignment_history (
  id SERIAL PRIMARY KEY,
  checkout_group_id INTEGER NOT NULL REFERENCES checkout_groups(id) ON DELETE CASCADE,
  from_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  to_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  from_vendor_id INTEGER REFERENCES vendor_profiles(id) ON DELETE SET NULL,
  to_vendor_id INTEGER REFERENCES vendor_profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned', 'pending_customer', 'accepted', 'declined', 'no_alternative')),
  reason TEXT,
  original_total_cents INTEGER,
  proposed_total_cents INTEGER,
  actor_role TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_role IN ('customer', 'vendor', 'admin', 'system')),
  changed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_assignment_group ON order_assignment_history(checkout_group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_assignment_pending
  ON order_assignment_history(checkout_group_id) WHERE status = 'pending_customer';

-- --- Backfill: a vendor's record starts from the orders it already has ---
--
-- Rejections are not among them: nothing could reject before this sprint, so
-- orders_rejected starts at 0 for everyone rather than guessing which past
-- cancellation was really a refusal.
INSERT INTO vendor_performance_metrics
  (vendor_id, orders_total, orders_accepted, orders_cancelled, orders_delivered, open_orders,
   fulfilment_minutes_total)
SELECT vp.id,
       COUNT(o.id)::int,
       COUNT(o.id) FILTER (WHERE o.status <> 'pending' AND o.status <> 'cancelled')::int,
       COUNT(o.id) FILTER (WHERE o.status = 'cancelled')::int,
       COUNT(o.id) FILTER (WHERE o.status = 'delivered')::int,
       COUNT(o.id) FILTER (WHERE o.status NOT IN ('delivered', 'cancelled'))::int,
       COALESCE(SUM(EXTRACT(EPOCH FROM (o.updated_at - o.created_at)) / 60)
                FILTER (WHERE o.status = 'delivered'), 0)::bigint
FROM vendor_profiles vp
LEFT JOIN orders o ON o.vendor_id = vp.id
WHERE NOT EXISTS (SELECT 1 FROM vendor_performance_metrics m WHERE m.vendor_id = vp.id)
GROUP BY vp.id;

-- ===== SPRINT 7: ONLINE PAYMENTS, END TO END (PHASE 6) =====
-- Contracts per documents/SPRINT_7_ONLINE_PAYMENTS_SPEC.md
--
-- Sprint 3 built the whole payment machine and wired one method to it. This is
-- the widening its own comment promised:
--
--   payment_method ... CHECK (payment_method IN ('cod'))
--   -- Widened in Phase 6 when the gateway lands.
--
-- The rule this block exists to allow: COD commits the sale at checkout,
-- because the cash arrives with the courier. An online order has a gateway
-- between the tap and the money, so its stock is held and confirmed only when
-- the capture webhook lands. Confirming it at checkout would sell stock for
-- money that never arrives.
--
-- Everything here is idempotent, so scripts/migrate-sprint7.js can be re-run.

-- --- The six methods payments already understood ---
--
-- payments.method has allowed all six since Sprint 3. These two tables were the
-- only things standing between the customer and the machine.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method IN ('cod', 'upi', 'card', 'netbanking', 'wallet'));

ALTER TABLE checkout_groups DROP CONSTRAINT IF EXISTS checkout_groups_payment_method_check;
ALTER TABLE checkout_groups ADD CONSTRAINT checkout_groups_payment_method_check
  CHECK (payment_method IN ('cod', 'upi', 'card', 'netbanking', 'wallet'));

-- --- Finding holds that have died of old age ---
--
-- Sprint 4 gave reservations an expires_at and nothing has ever read it, which
-- was harmless while every order was COD and confirmed instantly. An online
-- order that is never paid holds its stock forever, so the column starts
-- mattering now.
--
-- Partial, so the index covers only the rows the sweep looks at rather than
-- every reservation ever written.
CREATE INDEX IF NOT EXISTS idx_inventory_reservations_expiring
  ON inventory_reservations(expires_at)
  WHERE status = 'held' AND expires_at IS NOT NULL;

-- ===== VENDOR COMMISSION PLANS (PHASE 9) =====
--
-- What the platform keeps from a vendor's sale. Three scopes, most specific
-- wins: a vendor rule beats a category rule, which beats the global rule.
--
-- Rules are stored, never resolved into the vendor row. Copying the effective
-- rate onto vendors would mean re-writing every vendor the moment the global
-- rate changes, and any vendor missed by that sweep would silently bill at a
-- stale rate. Resolution happens on read, where it cannot go stale.
--
-- Idempotent throughout, so scripts/migrate-commission-plans.js can be re-run.

CREATE TABLE IF NOT EXISTS commission_plans (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'category', 'vendor')),
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  vendor_id INTEGER REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  commission_percent NUMERIC(6,2) NOT NULL
    CHECK (commission_percent >= 0 AND commission_percent <= 100),
  -- Charged on top of the percentage, e.g. a fixed handling fee per order.
  flat_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (flat_fee_cents >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The scope decides which target column is allowed to be set. Without this a
  -- row could claim scope 'vendor' while pointing at a category, and resolution
  -- would quietly apply it to the wrong thing.
  CONSTRAINT commission_plans_scope_target CHECK (
    (scope = 'global'   AND category_id IS NULL     AND vendor_id IS NULL) OR
    (scope = 'category' AND category_id IS NOT NULL AND vendor_id IS NULL) OR
    (scope = 'vendor'   AND category_id IS NULL     AND vendor_id IS NOT NULL)
  )
);

-- One rule per target. Two active rules at the same scope have no defined
-- winner, so the database refuses them rather than letting resolution pick
-- arbitrarily by insertion order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_plans_global
  ON commission_plans ((scope)) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_plans_category
  ON commission_plans (category_id) WHERE scope = 'category';
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_plans_vendor
  ON commission_plans (vendor_id) WHERE scope = 'vendor';

-- The platform is never without a fallback rate: resolution must always find
-- something, and a missing global rule would make commission undefined.
INSERT INTO commission_plans (scope, commission_percent, notes)
SELECT 'global', 10.00, 'Default platform commission'
WHERE NOT EXISTS (SELECT 1 FROM commission_plans WHERE scope = 'global');


-- ===== VENDOR KYC & DOCUMENTS (PHASE 16) =====
--
-- The verification trail behind a vendor. Each submission is its own row and is
-- kept after review, so a rejection and the corrected resubmission both survive
-- — an audit that overwrites the thing being audited is not an audit.
--
-- Idempotent throughout, so scripts/migrate-vendor-kyc.js can be re-run.

CREATE TABLE IF NOT EXISTS vendor_documents (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('gstin', 'pan', 'bank', 'fssai', 'other')),
  -- The identifier printed on the document: GSTIN, PAN, or account number.
  doc_number TEXT,
  -- A link, not a blob. There is no upload pipeline yet, and storing files in
  -- the row would have to be undone the moment one arrives.
  file_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A rejection the vendor cannot act on is a dead end, so the reason is part
  -- of what makes the row valid rather than a field the UI hopes was filled.
  CONSTRAINT vendor_documents_rejection_reason
    CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

-- The review queue reads pending-first, oldest-first: the default listing.
CREATE INDEX IF NOT EXISTS idx_vendor_documents_status
  ON vendor_documents (status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_vendor_documents_vendor
  ON vendor_documents (vendor_id);

-- ===== PRODUCT MODERATION (PHASE 17) =====
--
-- A review queue between a vendor listing a product and customers seeing it.
--
-- This is deliberately NOT is_active. A vendor may set is_active themselves —
-- it is their own "in stock / taking it down" switch — so hanging moderation
-- off it would let a rejected product be re-published by its own seller. The
-- moderation columns are admin-owned; nothing on the vendor routes writes them.
--
-- Effective customer visibility is: is_active AND moderation_status='approved'.
--
-- Idempotent, so scripts/migrate-product-moderation.js can be re-run.

-- The default is 'approved' for exactly one statement, so that every product
-- that already existed is grandfathered in rather than vanishing from the shop
-- the moment this runs. The default then flips to 'pending' for everything
-- created afterwards. Splitting it this way keeps the migration re-runnable:
-- ADD COLUMN IF NOT EXISTS is a no-op on a second run, so a genuinely pending
-- product is never silently approved by running the script again.
ALTER TABLE products ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE products ALTER COLUMN moderation_status SET DEFAULT 'pending';

ALTER TABLE products ADD COLUMN IF NOT EXISTS moderation_reason TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS moderated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_moderation_status_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_moderation_status_check
      CHECK (moderation_status IN ('pending', 'approved', 'rejected'));
  END IF;

  -- A rejection the vendor cannot act on is a dead end, so the reason is part
  -- of what makes the row valid rather than a field the UI hopes was filled.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_moderation_reason_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_moderation_reason_check
      CHECK (moderation_status <> 'rejected' OR moderation_reason IS NOT NULL);
  END IF;
END $$;

-- The queue reads pending-first, oldest-first: the longest wait is the most urgent.
CREATE INDEX IF NOT EXISTS idx_products_moderation
  ON products (moderation_status, submitted_at);

-- ===== ADMIN STAFF & RBAC (PHASE 15) =====
--
-- Until now 'admin' was one undivided role: anyone who could see the panel could
-- do everything in it. This splits that into named roles holding permissions.
--
-- users.role still decides who may reach the admin panel at all. staff_role_id
-- decides what they may do once inside. Keeping them separate means the existing
-- auth middleware is unchanged and still correct — RBAC is a second gate behind
-- it, not a replacement for it.
--
-- Idempotent, so scripts/migrate-rbac.js can be re-run.

CREATE TABLE IF NOT EXISTS staff_roles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  -- A system role is the platform's own, not the operator's: it cannot be
  -- deleted, because deleting the super-admin role would leave nobody able to
  -- restore it.
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per granted permission. Stored as keys rather than a bitmask or a
-- column per module so adding a permission is a data change, not a migration.
CREATE TABLE IF NOT EXISTS staff_role_permissions (
  role_id INTEGER NOT NULL REFERENCES staff_roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- ON DELETE SET NULL, not CASCADE: deleting a role must never delete the people
-- who held it. They fall back to having no permissions, which is safe.
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_role_id INTEGER
  REFERENCES staff_roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_staff_role ON users (staff_role_id)
  WHERE staff_role_id IS NOT NULL;

-- The one role that must exist. Its permissions are not listed here: the
-- middleware treats super-admin as holding everything, so this table never has
-- to be topped up when a new permission key is added in code.
INSERT INTO staff_roles (name, slug, description, is_system)
SELECT 'Super Admin', 'super_admin', 'Full access to every module. Cannot be restricted.', TRUE
WHERE NOT EXISTS (SELECT 1 FROM staff_roles WHERE slug = 'super_admin');

-- Every existing admin becomes a super admin. Without this the migration would
-- lock the only administrator out of the panel it just secured.
UPDATE users
SET staff_role_id = (SELECT id FROM staff_roles WHERE slug = 'super_admin')
WHERE role = 'admin' AND staff_role_id IS NULL;

-- ===== RETURNS & SHOP REVIEWS (PHASE 13) =====
--
-- Two features that both hang off a delivered order, and both write into
-- machinery that already exists: a return ends in a `refunds` row, and a
-- review moves the rating_sum/rating_count that search and the matching
-- engine have been reading (and scoring neutral) since Sprint 6.

-- A customer asking for money back on something already delivered.
--
-- Separate from `refunds` rather than a reason code on it: a return is a
-- request that can be refused, while a refund is money moving. Only an
-- approved return produces a refund, and the two have different lifecycles.
CREATE TABLE IF NOT EXISTS order_returns (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('damaged', 'wrong_item', 'not_as_described', 'missing_items', 'other')),
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  -- Set when approving raises the refund, so the two stay linked.
  refund_id INTEGER REFERENCES refunds(id) ON DELETE SET NULL,
  resolution_note TEXT,
  reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- One open request per order. A rejected or cancelled one must not block the
-- customer from asking again, so the constraint covers only the live states.
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_returns_one_open
  ON order_returns (order_id) WHERE status IN ('requested', 'approved');

CREATE INDEX IF NOT EXISTS idx_order_returns_status ON order_returns (status, created_at);
CREATE INDEX IF NOT EXISTS idx_order_returns_user ON order_returns (user_id, created_at DESC);
-- Photos the customer attached when asking (paths under /uploads/returns/),
-- required since 2026-10-18 (scripts/migrate-return-photos.js).
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]'::jsonb;

-- A customer's rating of a shop, earned by a delivered order.
--
-- Keyed on the order, not on (user, vendor): buying from the same shop three
-- times earns three ratings, and tying each to its order is what makes the
-- review verifiable and lets the aggregate be rebuilt from scratch.
CREATE TABLE IF NOT EXISTS vendor_reviews (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_reviews_vendor ON vendor_reviews (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_user ON vendor_reviews (user_id, created_at DESC);

-- Rebuild the aggregate from the reviews themselves rather than trusting the
-- running totals. Cheap here, and it makes the columns reproducible: if the
-- two ever disagree, the reviews are the truth.
UPDATE vendor_performance_metrics m
SET rating_sum = COALESCE(r.total, 0),
    rating_count = COALESCE(r.count, 0),
    updated_at = now()
FROM (
  SELECT vendor_id, SUM(rating)::numeric AS total, COUNT(*) AS count
  FROM vendor_reviews GROUP BY vendor_id
) r
WHERE m.vendor_id = r.vendor_id;

-- ===== WISHLIST (PHASE 13) =====
--
-- Products a customer saved for later. Deliberately not a second cart: no
-- quantity, no price snapshot, no serviceability. It is a bookmark, and the
-- price and stock shown are always whatever the product says today.
CREATE TABLE IF NOT EXISTS wishlist_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  -- Saving the same product twice is the same save, not a second one.
  UNIQUE (user_id, product_id)
);

-- ===== NOTIFICATIONS =====
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(160) NOT NULL,
  body TEXT NOT NULL,
  deep_link VARCHAR(255),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);

-- ===== AUDIT LOGS (PHASE 24) =====
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  module VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80),
  entity_id VARCHAR(80),
  previous_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_module ON audit_logs(module, created_at DESC);

-- ===== FEATURE FLAGS (PHASE 24) =====
CREATE TABLE IF NOT EXISTS feature_flags (
  id SERIAL PRIMARY KEY,
  flag_key VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(255),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_enabled ON feature_flags(enabled, flag_key);

CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist_items (user_id, created_at DESC);

-- ===== SPRINT 8: MART TAB — SHOP DISCOVERY (PHASE 14) =====
-- Contracts: documents/SPRINT_8_MART_TAB_SPEC.md (this plan).
--
-- Storefront marketing fields the shop-discovery grid and shop details page
-- need that nowhere else in the schema provides. Visibility itself is still
-- governed entirely by vendor_profiles.status = 'approved' — these columns
-- only decorate an already-visible shop.
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

-- ===== SESSION REVOCATION (PHASE 25) =====
--
-- A JWT is stateless by design — the server never tracked who was logged in,
-- so changing a password or revoking admin access only affected the *next*
-- login. The old token kept working until it expired (up to 7 days).
--
-- token_version is embedded in every token issued at login and rechecked on
-- every authenticated request. Bumping it — on a password change or a staff
-- revocation — makes every token issued before that moment fail its very
-- next request, everywhere, without needing a session store.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- ===== ADMIN PASSWORD CHANGE OTP (PHASE 26) =====
--
-- A super admin changing their own password is one of the highest-blast-radius
-- actions in the panel, so it is gated by an OTP mailed to the company inbox
-- rather than trusted on the current password alone. The new password is
-- hashed and staged here the moment it is requested, and only ever written to
-- users.password_hash once the matching OTP comes back — nothing sensitive is
-- kept around waiting on a second form submission from the browser.
CREATE TABLE IF NOT EXISTS admin_password_otps (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  new_password_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_password_otps_user ON admin_password_otps(user_id, created_at DESC);

-- ===== PLATFORM REGISTRY (PHASE 27) =====
--
-- Super admin's catalogue of e-commerce capabilities: integrations, sales
-- channels, campaigns and so on. Categories and entries are data, so adding
-- "Marketing Platforms → Google Ads" needs no code change.
--
-- An entry here is a record, not a connection. integration_method says how it
-- is meant to work; connector_key names the server code that actually talks
-- to the provider, and stays NULL until such a connector exists. Nothing may
-- be shown as "connected" on the strength of a row in this table alone.
CREATE TABLE IF NOT EXISTS platform_categories (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  icon_key VARCHAR(40) NOT NULL DEFAULT 'puzzle',
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Seeded categories can be renamed or hidden but not deleted: later phases
  -- hang permissions and management screens off their slugs.
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platforms (
  id SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES platform_categories(id) ON DELETE RESTRICT,
  slug VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  logo_url TEXT,
  integration_method VARCHAR(20) NOT NULL DEFAULT 'manual'
    CHECK (integration_method IN ('api', 'webhook', 'connector', 'manual')),
  connector_key VARCHAR(60),
  status VARCHAR(20) NOT NULL DEFAULT 'inactive'
    CHECK (status IN ('draft', 'inactive', 'active')),
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platforms_category ON platforms(category_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_platforms_status ON platforms(status);

INSERT INTO platform_categories (slug, name, description, icon_key, sort_order, is_system) VALUES
  ('integrations', 'Integrations', 'Payment gateways, shipping APIs, ERP, CRM, WhatsApp, email and analytics.', 'puzzle', 10, TRUE),
  ('sales_channels', 'Sales Channels', 'Website, mobile app, marketplaces, social commerce and POS.', 'store', 20, TRUE),
  ('campaigns', 'Campaigns & Promotions', 'Discount campaigns, coupons, flash sales, loyalty and referral programs.', 'megaphone', 30, TRUE),
  ('marketplaces', 'Marketplace Platforms', 'Multi-vendor marketplace connections, external storefronts and product synchronization.', 'globe', 40, TRUE),
  ('fulfilment', 'Delivery & Fulfillment', 'Delivery partners, shipping providers, warehouse systems and tracking services.', 'truck', 50, TRUE),
  ('finance', 'Payments & Finance', 'Payment providers, settlement systems, commissions, billing and reconciliation.', 'wallet', 60, TRUE),
  ('engagement', 'Customer Engagement', 'WhatsApp, SMS, email, push notifications, loyalty and customer engagement tools.', 'bell', 70, TRUE),
  ('catalog_services', 'Product & Catalog Services', 'Product feeds, catalog synchronization, inventory connections and pricing services.', 'box', 80, TRUE),
  ('analytics', 'Analytics & Tracking', 'Analytics providers, conversion tracking, attribution and reporting.', 'chart', 90, TRUE),
  ('custom', 'Custom Platforms', 'New platform categories and custom capabilities as business needs change.', 'sparkles', 100, TRUE)
ON CONFLICT (slug) DO NOTHING;

-- ===== PLATFORM CONNECTIONS (PHASE 28) =====
--
-- config_schema lists the settings a platform needs (key, label, type,
-- required, secret), so its settings form is generated rather than built per
-- provider. Each platform keeps one connection per environment; the one named
-- by platforms.environment is the one in use.
--
-- Secret values live only in secrets_encrypted: AES-256-GCM, keyed by
-- PLATFORM_SECRETS_KEY from the server environment. The API never sends them
-- back, only which keys are set. status stays 'not_connected' until a real
-- connector has tested the credentials (Phase 4); saving them changes nothing.
ALTER TABLE platforms ADD COLUMN IF NOT EXISTS config_schema JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE platforms ADD COLUMN IF NOT EXISTS environment VARCHAR(10) NOT NULL DEFAULT 'test';
DO $$ BEGIN
  ALTER TABLE platforms ADD CONSTRAINT platforms_environment_check CHECK (environment IN ('test', 'live'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS platform_connections (
  id SERIAL PRIMARY KEY,
  platform_id INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  environment VARCHAR(10) NOT NULL CHECK (environment IN ('test', 'live')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets_encrypted TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'not_connected'
    CHECK (status IN ('not_connected', 'connected', 'error')),
  last_tested_at TIMESTAMPTZ,
  last_error TEXT,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform_id, environment)
);
-- Names of the secrets that are set (never their values), so the panel can show
-- "API key: set" without decrypting anything just to render a page.
ALTER TABLE platform_connections ADD COLUMN IF NOT EXISTS secret_keys JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ===== PLATFORM CONNECTORS (PHASE 29) =====
--
-- Every exchange a connector has with its provider — a connection test, an
-- incoming webhook, a sync run — leaves a row here, so the panel can show what
-- happened without anyone reading server logs. Rows never hold credentials;
-- detail is a short, already-redacted summary.
CREATE TABLE IF NOT EXISTS platform_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  platform_id INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  environment VARCHAR(10) NOT NULL CHECK (environment IN ('test', 'live')),
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('test', 'webhook', 'sync')),
  status VARCHAR(10) NOT NULL CHECK (status IN ('ok', 'error', 'rejected')),
  event VARCHAR(120),
  message TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_sync_logs_platform ON platform_sync_logs(platform_id, created_at DESC);

-- ===== APPROVAL WORKFLOWS (PHASE 30) =====
--
-- Sensitive admin actions can be set to wait for a super admin's sign-off.
-- A rule switches that on per action. While on, the same request from staff
-- who are not super admin is stored as a pending approval instead of applied;
-- approving replays it through the normal code path, so it is validated again
-- against the state at that moment. Super admins act directly: they are the
-- approvers, and requiring a second one could lock out a solo super admin.
--
-- payload holds the request minus anything secret; payload_encrypted holds the
-- full request (secretBox) when it carries credentials, such as Live settings.
CREATE TABLE IF NOT EXISTS approval_rules (
  action VARCHAR(60) PRIMARY KEY,
  label VARCHAR(160) NOT NULL,
  description TEXT,
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO approval_rules (action, label, description, requires_approval) VALUES
  ('platform.go_live', 'Turn on a platform with Live settings',
   'Enabling a platform that uses its Live settings, or switching an enabled platform to Live.', TRUE),
  ('platform.live_settings', 'Save Live settings',
   'Saving or changing the Live credentials of a platform.', TRUE),
  ('role.permissions', 'Change a role''s permissions',
   'Creating a role with permissions, or changing what an existing role may do.', FALSE)
ON CONFLICT (action) DO NOTHING;

CREATE TABLE IF NOT EXISTS approval_requests (
  id SERIAL PRIMARY KEY,
  action VARCHAR(60) NOT NULL REFERENCES approval_rules(action),
  entity_type VARCHAR(40) NOT NULL,
  entity_id VARCHAR(40),
  summary TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_encrypted TEXT,
  status VARCHAR(12) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'failed')),
  requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT,
  result_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status, created_at DESC);
-- One open request per action and thing, so the queue can't fill with duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_one_pending
  ON approval_requests(action, entity_type, COALESCE(entity_id, '')) WHERE status = 'pending';

-- ===== PLATFORM MONITORING & CHANNELS (PHASE 31) =====
--
-- Which sales channel an order came through: a Platform Registry entry with
-- the "orders" capability (website, mobile app, a marketplace...). Set at
-- checkout from the X-Sales-Channel header; NULL for orders placed before
-- channels existed or from a client that doesn't say. A channel deleted from
-- the registry leaves its orders unattributed rather than blocking the delete.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_channel_id INTEGER REFERENCES platforms(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_sales_channel ON orders(sales_channel_id, created_at DESC);

-- ===== HOME SECTIONS (PHASE 32) =====
--
-- The app's home screen as an ordered list of sections. Each section has a
-- type that fixes what it holds; hand-picked sections keep their items in
-- home_section_items (ref_id points at a category, shop, product or banner
-- depending on the type), "local_deals" fills itself from live discounts.
-- A section is on screen only when switched on, inside its optional window
-- and not empty.
CREATE TABLE IF NOT EXISTS home_sections (
  id SERIAL PRIMARY KEY,
  type VARCHAR(30) NOT NULL CHECK (type IN
    ('featured_categories', 'featured_vendors', 'local_deals', 'b2b_promotions', 'product_carousel', 'banner_strip')),
  title VARCHAR(120) NOT NULL,
  subtitle VARCHAR(200),
  audience VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'b2c', 'b2b')),
  layout VARCHAR(10) NOT NULL DEFAULT 'carousel' CHECK (layout IN ('grid', 'carousel', 'list')),
  max_items INTEGER NOT NULL DEFAULT 10 CHECK (max_items BETWEEN 1 AND 50),
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS home_section_items (
  id SERIAL PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES home_sections(id) ON DELETE CASCADE,
  ref_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (section_id, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_home_sections_order ON home_sections(sort_order, id);

-- ===== CAMPAIGNS (PHASE 33) =====
--
-- Marketplace discount campaigns. state is what an admin set (draft, active,
-- paused, ended); the status shown — scheduled / running / ended — is worked
-- out from state, the dates and the budget. Spend is never stored: it is the
-- sum of campaign discounts on orders that weren't cancelled, so a cancelled
-- order hands its discount back to the budget by itself.
--
-- Who pays decides who takes part: a platform-funded campaign runs for every
-- matching order; vendor- or shared-funded ones run only for shops that opted
-- in (campaign_participants.opted_in).
CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  scope VARCHAR(10) NOT NULL CHECK (scope IN ('platform', 'category', 'vendor')),
  discount_type VARCHAR(15) NOT NULL CHECK (discount_type IN ('percentage', 'flat', 'free_delivery')),
  -- Percent for 'percentage', cents for 'flat', unused for 'free_delivery'.
  discount_value INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  max_discount_cents INTEGER CHECK (max_discount_cents IS NULL OR max_discount_cents > 0),
  min_order_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  funded_by VARCHAR(10) NOT NULL CHECK (funded_by IN ('platform', 'vendor', 'shared')),
  platform_share_percent INTEGER CHECK (platform_share_percent IS NULL OR platform_share_percent BETWEEN 0 AND 100),
  budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents > 0),
  banner_url TEXT,
  state VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'paused', 'ended')),
  ended_at TIMESTAMPTZ,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS campaign_participants (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL CHECK (type IN ('vendor', 'category')),
  ref_id INTEGER NOT NULL,
  opted_in BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, type, ref_id)
);

-- One campaign per order at most; the discount and who funds it, frozen at checkout.
CREATE TABLE IF NOT EXISTS order_campaigns (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  discount_cents INTEGER NOT NULL CHECK (discount_cents > 0),
  platform_cents INTEGER NOT NULL,
  vendor_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_campaigns_campaign ON order_campaigns(campaign_id);

-- orders.discount_cents stays the total discount (coupon + campaign), so totals,
-- groups and payments need no change; this column is the campaign's part of it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS campaign_discount_cents INTEGER NOT NULL DEFAULT 0;

-- ===== REVIEWS & RATINGS (PHASE 34) =====
--
-- Phase 13's shop ratings grow into product reviews with moderation. The table
-- keeps its Phase 13 name so that block can still be re-run; `target` says
-- whether a row is about the shop or about one product.
--
-- Verified = tied to a delivered order. Shop reviews always are. A product
-- review is verified when the author has a delivered order containing it, and
-- goes live at once; an unverified one waits in the admin queue (pending).
-- 'flagged' is not stored: it is a published review with open reports.
-- Only published reviews count towards the shop and product averages.
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS target VARCHAR(10) NOT NULL DEFAULT 'vendor';
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS title VARCHAR(120);
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]';
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS status VARCHAR(10) NOT NULL DEFAULT 'published';
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS moderated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS vendor_reply TEXT;
ALTER TABLE vendor_reviews ADD COLUMN IF NOT EXISTS vendor_replied_at TIMESTAMPTZ;

-- An unverified product review has no order behind it.
ALTER TABLE vendor_reviews ALTER COLUMN order_id DROP NOT NULL;
-- One shop review per order still holds, but only for shop reviews: an order
-- of three products can earn three product reviews as well.
ALTER TABLE vendor_reviews DROP CONSTRAINT IF EXISTS vendor_reviews_order_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_reviews_shop_order
  ON vendor_reviews (order_id) WHERE target = 'vendor';
-- One review per customer per product; buying it again updates that review.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_reviews_product_author
  ON vendor_reviews (product_id, user_id) WHERE target = 'product';
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_status ON vendor_reviews (status, created_at);
CREATE INDEX IF NOT EXISTS idx_vendor_reviews_product
  ON vendor_reviews (product_id, created_at DESC) WHERE target = 'product';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_reviews_target_check') THEN
    ALTER TABLE vendor_reviews ADD CONSTRAINT vendor_reviews_target_check CHECK (
      (target = 'vendor' AND product_id IS NULL AND order_id IS NOT NULL)
      OR (target = 'product' AND product_id IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_reviews_status_check') THEN
    ALTER TABLE vendor_reviews ADD CONSTRAINT vendor_reviews_status_check
      CHECK (status IN ('pending', 'published', 'rejected'));
  END IF;
END $$;

-- A customer telling the admins a published review breaks the rules. Open
-- until an admin either takes the review down (upheld) or clears it (dismissed).
CREATE TABLE IF NOT EXISTS review_reports (
  id SERIAL PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES vendor_reviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(500) NOT NULL,
  resolution VARCHAR(10) CHECK (resolution IN ('dismissed', 'upheld')),
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (review_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_review_reports_open ON review_reports (review_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS review_helpful (
  review_id INTEGER NOT NULL REFERENCES vendor_reviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (review_id, user_id)
);

-- The product's published rating, kept on the row so listings show stars
-- without a join. Rebuilt from the reviews whenever one changes.
ALTER TABLE products ADD COLUMN IF NOT EXISTS rating_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS rating_average NUMERIC(3,2);

-- Sub-category within the category (Fashion → Men / Women, Gadgets → Mobiles …);
-- search filters by it and returns facets.subcategories (scripts/migrate-subcategories.js).
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory TEXT;
CREATE INDEX IF NOT EXISTS idx_products_category_subcategory ON products(category, lower(subcategory));

-- Both aggregates rebuilt from published reviews only.
UPDATE vendor_performance_metrics m
SET rating_sum = COALESCE(r.total, 0), rating_count = COALESCE(r.count, 0), updated_at = now()
FROM vendor_performance_metrics m2
LEFT JOIN (
  SELECT vendor_id, SUM(rating)::numeric AS total, COUNT(*)::int AS count
  FROM vendor_reviews WHERE target = 'vendor' AND status = 'published' GROUP BY vendor_id
) r ON r.vendor_id = m2.vendor_id
WHERE m.vendor_id = m2.vendor_id;

UPDATE products p
SET rating_count = COALESCE(r.count, 0), rating_average = r.average
FROM products p2
LEFT JOIN (
  SELECT product_id, COUNT(*)::int AS count, ROUND(AVG(rating), 2) AS average
  FROM vendor_reviews WHERE target = 'product' AND status = 'published' GROUP BY product_id
) r ON r.product_id = p2.id
WHERE p.id = p2.id;

-- ===== CANCELLATIONS (PHASE 35) =====
--
-- What can still be called off depends on how far the order has travelled:
-- one rule per stage (delivered is a return, not a cancellation). A customer
-- or vendor allowed at that stage cancels straight away when auto_approve is
-- on (a vendor allowed always does — holding a shop's "I can't fill this" in a
-- queue doesn't get the order delivered); otherwise the request waits for an
-- admin. Asking where the rules say no is still recorded, as ineligible, so an
-- admin can override.
--
-- The fee is the customer's: charged only on cancellations they asked for,
-- only out of money actually paid, and an admin can waive it. Every cancelled
-- order gets a row here, whoever cancelled it, so this is the full record.
CREATE TABLE IF NOT EXISTS cancellation_rules (
  order_status VARCHAR(20) PRIMARY KEY
    CHECK (order_status IN ('pending', 'confirmed', 'packed', 'out_for_delivery')),
  customer_allowed BOOLEAN NOT NULL,
  vendor_allowed BOOLEAN NOT NULL,
  auto_approve BOOLEAN NOT NULL,
  fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (fee_percent BETWEEN 0 AND 100),
  restock BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ
);

-- Defaults keep today's behaviour where it existed (customer cancels a
-- pending order at once; a shop can cancel before it ships) and send the rest
-- to the queue.
INSERT INTO cancellation_rules (order_status, customer_allowed, vendor_allowed, auto_approve, fee_percent, restock) VALUES
  ('pending',          TRUE,  TRUE,  TRUE,  0, TRUE),
  ('confirmed',        TRUE,  TRUE,  FALSE, 0, TRUE),
  ('packed',           TRUE,  TRUE,  FALSE, 5, TRUE),
  ('out_for_delivery', FALSE, FALSE, FALSE, 10, FALSE)
ON CONFLICT (order_status) DO NOTHING;

-- CXL-2026-00001, from a sequence for the same reason checkout groups use one.
CREATE SEQUENCE IF NOT EXISTS order_cancellation_ref_seq;

CREATE TABLE IF NOT EXISTS order_cancellations (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  requested_by VARCHAR(10) NOT NULL CHECK (requested_by IN ('customer', 'vendor', 'admin', 'system')),
  requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_status_at_request VARCHAR(20) NOT NULL,
  reason_code VARCHAR(30) NOT NULL,
  reason_note TEXT,
  status VARCHAR(15) NOT NULL
    CHECK (status IN ('requested', 'approved', 'auto_approved', 'rejected', 'withdrawn')),
  -- Whether the rules allowed it when asked; approving an ineligible one is an override.
  eligible BOOLEAN NOT NULL,
  -- The terms it was raised under; later rule changes don't touch them.
  fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  restock BOOLEAN NOT NULL DEFAULT TRUE,
  -- Settled when the order is actually cancelled.
  fee_cents INTEGER NOT NULL DEFAULT 0,
  refund_cents INTEGER NOT NULL DEFAULT 0,
  refund_id INTEGER REFERENCES refunds(id) ON DELETE SET NULL,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_cancellations_one_open
  ON order_cancellations (order_id) WHERE status = 'requested';
CREATE INDEX IF NOT EXISTS idx_order_cancellations_status ON order_cancellations (status, created_at);

-- ===== SUPPORT TICKETS (PHASE 36) =====
--
-- A conversation with a clock on it. Customers and vendors open tickets from
-- the app; staff answer them in the admin panel. The first reply and the
-- resolution each have a deadline set from the priority (services/support.js);
-- changing the priority moves both, counted from when the ticket was opened.
--
-- Internal messages are staff notes: never sent to or listed for the requester.
-- 'pending_customer' / 'pending_vendor' mean we are waiting on someone else; a
-- reply from the requester puts the ticket back to 'open'. 'closed' is final.
CREATE SEQUENCE IF NOT EXISTS support_ticket_ref_seq;

CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  requester_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_type VARCHAR(10) NOT NULL CHECK (requester_type IN ('customer', 'vendor')),
  -- The shop involved: the requester's own for a vendor, the order's for a customer.
  vendor_id INTEGER REFERENCES vendor_profiles(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  subject VARCHAR(160) NOT NULL,
  category VARCHAR(10) NOT NULL
    CHECK (category IN ('order', 'payment', 'delivery', 'vendor', 'product', 'account', 'other')),
  priority VARCHAR(10) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending_customer', 'pending_vendor', 'resolved', 'closed')),
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_response_due_at TIMESTAMPTZ,
  first_responded_at TIMESTAMPTZ,
  resolution_due_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_from VARCHAR(10) NOT NULL DEFAULT 'customer'
    CHECK (last_message_from IN ('customer', 'vendor', 'admin', 'system')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_requester ON support_tickets (requester_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assignee ON support_tickets (assignee_id) WHERE status NOT IN ('resolved', 'closed');

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_role VARCHAR(10) NOT NULL CHECK (author_role IN ('customer', 'vendor', 'admin', 'system')),
  body TEXT NOT NULL,
  internal BOOLEAN NOT NULL DEFAULT FALSE,
  attachments JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NOT internal OR author_role IN ('admin', 'system'))
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket ON support_ticket_messages (ticket_id, created_at);

-- ===== SHIPMENTS (PHASE 37) =====
--
-- The physical movement of one shop order's goods, tracked apart from the
-- order. A shipment is opened when the order is packed and follows the order
-- from then on (services/shipments.js); scans recorded by staff move the order
-- forward in turn (out for delivery, delivered).
--
-- A failed delivery closes its shipment and opens the next attempt for the
-- same order (attempt_count + 1, previous_shipment_id), so every attempt keeps
-- its own trail. A parcel returned to the shop cancels the order and restocks.
-- Events are append-only: a wrong scan is corrected by adding the right one.
CREATE SEQUENCE IF NOT EXISTS shipment_tracking_seq;

CREATE TABLE IF NOT EXISTS shipments (
  id SERIAL PRIMARY KEY,
  tracking_number TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled')),
  -- Who carries it. Free text until delivery partners have their own records.
  partner_name TEXT,
  partner_phone TEXT,
  external_tracking_id TEXT,
  tracking_url TEXT,
  package_count INTEGER NOT NULL DEFAULT 1 CHECK (package_count >= 1),
  weight_grams INTEGER CHECK (weight_grams IS NULL OR weight_grams > 0),
  -- Cash the rider collects; NULL when paid online.
  cod_amount_cents INTEGER,
  dispatched_at TIMESTAMPTZ,
  estimated_delivery_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  previous_shipment_id INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- At most one shipment on the road per order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_one_open ON shipments (order_id)
  WHERE status IN ('created', 'picked_up', 'in_transit', 'out_for_delivery');
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments (status, created_at DESC);

CREATE TABLE IF NOT EXISTS shipment_events (
  id SERIAL PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,
  description TEXT,
  location TEXT,
  actor_role VARCHAR(10) CHECK (actor_role IN ('customer', 'vendor', 'partner', 'admin', 'system')),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment ON shipment_events (shipment_id, occurred_at DESC);

-- Backfill: orders already packed, on the road or delivered get the shipment
-- they would have had, with one event per step the order history records.
INSERT INTO shipments (tracking_number, order_id, vendor_id, status, partner_name, partner_phone,
                       cod_amount_cents, dispatched_at, estimated_delivery_at, delivered_at, created_at)
SELECT 'GMS-' || to_char(o.created_at, 'YYYY') || '-' || lpad(nextval('shipment_tracking_seq')::text, 6, '0'),
       -- 'packed' is the order's word for a shipment that was just created.
       o.id, o.vendor_id, CASE o.status WHEN 'packed' THEN 'created' ELSE o.status END,
       o.delivery_partner_name, o.delivery_partner_phone,
       CASE WHEN COALESCE(p.method, 'cod') = 'cod' THEN o.total_cents END,
       (SELECT MIN(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'out_for_delivery'),
       o.estimated_delivery_at,
       CASE WHEN o.status = 'delivered' THEN COALESCE(
         (SELECT MAX(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'delivered'), o.updated_at) END,
       COALESCE((SELECT MIN(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'packed'), o.updated_at)
FROM orders o
LEFT JOIN payments p ON p.checkout_group_id = o.checkout_group_id
WHERE o.status IN ('packed', 'out_for_delivery', 'delivered')
  AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id);

INSERT INTO shipment_events (shipment_id, status, description, actor_role, occurred_at)
SELECT s.id, CASE h.to_status WHEN 'packed' THEN 'created' ELSE h.to_status END,
       'From the order history', 'system', h.created_at
FROM shipments s
JOIN order_status_history h ON h.order_id = s.order_id AND h.to_status IN ('packed', 'out_for_delivery', 'delivered')
WHERE NOT EXISTS (SELECT 1 FROM shipment_events e WHERE e.shipment_id = s.id);

-- ===== DELIVERY PARTNERS (PHASE 38) =====
--
-- Riders and courier agencies, added and onboarded by staff (there is no rider
-- app yet, so "online" is set by staff too). Two things gate giving one work:
-- paperwork on file and in date (licence and ID proof), and capacity left
-- today. A shipment is assigned to a partner; its delivered COD shipments are
-- cash the partner holds until a handover is recorded.
CREATE TABLE IF NOT EXISTS delivery_partners (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  type VARCHAR(10) NOT NULL DEFAULT 'rider' CHECK (type IN ('rider', 'agency')),
  phone VARCHAR(20) NOT NULL UNIQUE,
  email VARCHAR(160),
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  status_reason TEXT,
  vehicle_type VARCHAR(30),
  vehicle_number VARCHAR(20),
  service_areas TEXT[] NOT NULL DEFAULT '{}',
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  daily_capacity INTEGER NOT NULL DEFAULT 20 CHECK (daily_capacity >= 0),
  onboarded_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_partners_status ON delivery_partners (status, created_at);

CREATE TABLE IF NOT EXISTS delivery_partner_documents (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES delivery_partners(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL CHECK (type IN ('licence', 'rc', 'insurance', 'id_proof', 'other')),
  file_url TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  expires_at DATE,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delivery_partner_documents_partner ON delivery_partner_documents (partner_id, uploaded_at DESC);

-- Cash a partner handed over. What they still hold = COD on their delivered
-- shipments minus these.
CREATE TABLE IF NOT EXISTS delivery_partner_cod_handovers (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES delivery_partners(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note TEXT,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS partner_id INTEGER REFERENCES delivery_partners(id) ON DELETE SET NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_shipments_partner ON shipments (partner_id, status);

-- ===== VENDOR MATCHING RULES (PHASE 39) =====
--
-- The admin page's matching rules, enforced: a factor can be switched off
-- without losing its weight, a vendor beyond the radius is never a candidate,
-- a shop that hasn't accepted within the window is re-routed (services/
-- reroute.js, swept every minute by server.js), re-routes can wait for an
-- admin instead of happening on their own, and an order stops being re-routed
-- after a set number of attempts.
--
-- The accept window only applies to orders placed after it was introduced
-- (accept_window_since), so switching it on never re-routes old orders.
ALTER TABLE vendor_matching_weights ADD COLUMN IF NOT EXISTS disabled_factors TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE vendor_matching_weights ADD COLUMN IF NOT EXISTS max_radius_km NUMERIC(6,1) NOT NULL DEFAULT 15 CHECK (max_radius_km > 0);
ALTER TABLE vendor_matching_weights ADD COLUMN IF NOT EXISTS accept_window_minutes INTEGER NOT NULL DEFAULT 15 CHECK (accept_window_minutes > 0);
ALTER TABLE vendor_matching_weights ADD COLUMN IF NOT EXISTS auto_reassign BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE vendor_matching_weights ADD COLUMN IF NOT EXISTS max_reassign_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_reassign_attempts >= 0);
ALTER TABLE vendor_matching_weights ADD COLUMN IF NOT EXISTS accept_window_since TIMESTAMPTZ NOT NULL DEFAULT now();

-- A run made for an order (re-routing) says which order, which try, and how it ended.
ALTER TABLE vendor_matching_logs ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE vendor_matching_logs ADD COLUMN IF NOT EXISTS attempt INTEGER;
ALTER TABLE vendor_matching_logs ADD COLUMN IF NOT EXISTS outcome VARCHAR(12)
  CHECK (outcome IS NULL OR outcome IN ('matched', 'no_vendor', 'reassigned', 'expired'));
ALTER TABLE vendor_matching_logs ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE vendor_matching_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_vendor_matching_logs_order ON vendor_matching_logs (order_id) WHERE order_id IS NOT NULL;

-- Re-routes waiting for an admin, and the ones an admin turned down.
ALTER TABLE order_assignment_history DROP CONSTRAINT IF EXISTS order_assignment_history_status_check;
ALTER TABLE order_assignment_history ADD CONSTRAINT order_assignment_history_status_check
  CHECK (status IN ('assigned', 'pending_customer', 'pending_admin', 'accepted', 'declined', 'admin_rejected', 'no_alternative'));
-- Why it started: the shop said no, or let the accept window run out.
ALTER TABLE order_assignment_history ADD COLUMN IF NOT EXISTS trigger VARCHAR(10) NOT NULL DEFAULT 'rejected'
  CHECK (trigger IN ('rejected', 'expired'));
ALTER TABLE order_assignment_history ADD COLUMN IF NOT EXISTS resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE order_assignment_history ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_order_assignment_from_order ON order_assignment_history (from_order_id);

-- ===== INVOICES & GST (PHASE 40) =====
--
-- A tax invoice per delivered shop order, issued when the order is delivered
-- (services/invoices.js) and never edited afterwards: every amount is copied
-- in at issue. A mistake is cancelled (with a reason) or credit-noted.
--
-- Numbering is gapless per Indian financial year (April–March) and never
-- reused: <invoice_prefix>/<FY>/<n>, e.g. GLM/2026-27/000001, from a counter
-- row taken under lock — a sequence can skip numbers on rollback.
--
-- Place of supply is the delivery state; same state as the shop = CGST + SGST
-- split in half, different state = IGST. The amounts are what checkout charged:
-- GST on each line's value, discount taken off after tax, delivery as a 0% line.
CREATE TABLE IF NOT EXISTS invoice_series (
  financial_year VARCHAR(7) PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  invoice_date TIMESTAMPTZ NOT NULL,
  financial_year VARCHAR(7) NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  vendor_name TEXT NOT NULL,
  vendor_gstin TEXT,
  vendor_state TEXT,
  vendor_address TEXT,
  buyer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  buyer_name TEXT NOT NULL,
  -- Set for a registered business buyer (B2B); NULL is a B2C sale.
  buyer_gstin TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  place_of_supply TEXT NOT NULL,
  supply_type VARCHAR(12) NOT NULL CHECK (supply_type IN ('intra_state', 'inter_state')),
  taxable_cents INTEGER NOT NULL,
  cgst_cents INTEGER NOT NULL DEFAULT 0,
  sgst_cents INTEGER NOT NULL DEFAULT 0,
  igst_cents INTEGER NOT NULL DEFAULT 0,
  cess_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  round_off_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'cancelled')),
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Filled by the credit-notes step when one is raised against this invoice.
  credit_note_number TEXT,
  pdf_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One live invoice per order; a cancelled one doesn't block re-issuing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_one_per_order ON invoices (order_id) WHERE status = 'issued';
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices (invoice_date DESC);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  hsn_code TEXT,
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  taxable_cents INTEGER NOT NULL,
  gst_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  cgst_cents INTEGER NOT NULL DEFAULT 0,
  sgst_cents INTEGER NOT NULL DEFAULT 0,
  igst_cents INTEGER NOT NULL DEFAULT 0,
  cess_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (invoice_id);

-- ===== CREDIT NOTES (PHASE 41) =====
--
-- The only way to reverse an issued invoice: its own gapless number series per
-- financial year (<prefix>-CN/<FY>/<n>, the counter row keyed 'CN:<FY>' in
-- invoice_series), lines that point at the invoice lines they reverse, and no
-- edits once raised — a wrong one is cancelled, which puts the invoice back in full.
--
-- Amounts are pro rata on the invoice line (taxable, each tax, the discount), and
-- crediting the last of a line takes exactly what is left, so a line can never be
-- credited for more than it was invoiced. The money side: an online payment gets
-- a refund (an existing unlinked refund on the order is reused — an approved
-- return's, for instance); COD is settled off-platform, as returns already are.
-- The counter key now carries a series name ('CN:2026-27'), not just a year.
ALTER TABLE invoice_series ALTER COLUMN financial_year TYPE VARCHAR(20);

CREATE TABLE IF NOT EXISTS credit_notes (
  id SERIAL PRIMARY KEY,
  credit_note_number TEXT NOT NULL UNIQUE,
  credit_note_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  financial_year VARCHAR(7) NOT NULL,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  reason VARCHAR(20) NOT NULL CHECK (reason IN ('return', 'cancellation', 'price_adjustment', 'deficiency', 'other')),
  reason_note TEXT,
  taxable_cents INTEGER NOT NULL,
  cgst_cents INTEGER NOT NULL DEFAULT 0,
  sgst_cents INTEGER NOT NULL DEFAULT 0,
  igst_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'cancelled')),
  refund_id INTEGER REFERENCES refunds(id) ON DELETE SET NULL,
  return_id INTEGER REFERENCES order_returns(id) ON DELETE SET NULL,
  pdf_url TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes (invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_date ON credit_notes (credit_note_date DESC);

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id SERIAL PRIMARY KEY,
  credit_note_id INTEGER NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  invoice_line_id INTEGER NOT NULL REFERENCES invoice_lines(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  hsn_code TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  taxable_cents INTEGER NOT NULL,
  gst_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  cgst_cents INTEGER NOT NULL DEFAULT 0,
  sgst_cents INTEGER NOT NULL DEFAULT 0,
  igst_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_note_lines_invoice_line ON credit_note_lines (invoice_line_id);

-- ===== SETTLEMENTS (PHASE 42) =====
--
-- What the platform owes each vendor for one weekly cycle (Monday–Sunday, India
-- time), generated automatically once the week is over (services/settlements.js,
-- run hourly by server.js and on demand). One settlement per vendor per cycle.
--
-- Per order: gross = what the customer paid + the platform-funded share of any
-- campaign discount (the platform owes the shop that part); commission = the
-- commission plan's percentage of the goods value (subtotal) + its flat fee.
-- Deductions: refunds completed in the cycle on the vendor's orders, TDS
-- (income tax, on gross) and TCS (GST, on the taxable value) at the rates in
-- settlement_config, and anything a negative cycle carried forward.
--
-- pending_approval → approved → paid (UTR, one-way). Hold and fail are side
-- states. A wrong payout is corrected by an adjustment on a later cycle.
CREATE TABLE IF NOT EXISTS settlement_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tds_percent NUMERIC(5,3) NOT NULL DEFAULT 0.1 CHECK (tds_percent BETWEEN 0 AND 10),
  tcs_percent NUMERIC(5,3) NOT NULL DEFAULT 0.5 CHECK (tcs_percent BETWEEN 0 AND 10),
  -- Cycles that ended before this are never generated, so switching settlements
  -- on doesn't create payouts for years of history.
  generate_from DATE NOT NULL DEFAULT (now() - interval '90 days')::date,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settlement_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS vendor_bank_accounts (
  vendor_id INTEGER PRIMARY KEY REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  account_holder VARCHAR(120) NOT NULL,
  account_number VARCHAR(20) NOT NULL,
  ifsc VARCHAR(11) NOT NULL,
  bank_name VARCHAR(120),
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS settlement_ref_seq;

CREATE TABLE IF NOT EXISTS settlements (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  order_count INTEGER NOT NULL DEFAULT 0,
  gross_cents INTEGER NOT NULL DEFAULT 0,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  deduction_cents INTEGER NOT NULL DEFAULT 0,
  adjustment_cents INTEGER NOT NULL DEFAULT 0,
  net_payable_cents INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'paid', 'on_hold', 'failed')),
  hold_reason TEXT,
  failure_reason TEXT,
  -- Copied at approval, so a later bank change can't redirect an approved payout.
  bank_account_masked TEXT,
  bank_account_number TEXT,
  bank_ifsc TEXT,
  payout_utr TEXT UNIQUE,
  paid_at TIMESTAMPTZ,
  -- A draft whose negative balance was taken into a later settlement.
  carried_into INTEGER REFERENCES settlements(id) ON DELETE SET NULL,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vendor_id, period_start)
);
CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements (status, period_start DESC);

-- An order is settled once, ever.
CREATE TABLE IF NOT EXISTS settlement_orders (
  settlement_id INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  delivered_at TIMESTAMPTZ,
  gross_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  PRIMARY KEY (settlement_id, order_id)
);

CREATE TABLE IF NOT EXISTS settlement_deductions (
  id SERIAL PRIMARY KEY,
  settlement_id INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('commission', 'refund', 'tds', 'tcs', 'penalty', 'adjustment', 'other')),
  label TEXT NOT NULL,
  -- Positive = taken off the payout; an adjustment can be negative (paid to the vendor).
  amount_cents INTEGER NOT NULL,
  note TEXT,
  -- A completed refund is deducted once, ever.
  refund_id INTEGER UNIQUE REFERENCES refunds(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settlement_deductions_settlement ON settlement_deductions (settlement_id);

-- ===== RETURNS LIFECYCLE & REPLACEMENTS (PHASE 43) =====
--
-- Returns grow the steps the admin page works through: approve (with the refund
-- to authorise; pickup is scheduled) → goods received and inspected → refund
-- released. The customer picks a refund or a replacement when asking. A
-- rejected return can be disputed by the customer and decided again.
--
-- A replacement is raised when a replacement-return is approved. Nothing ships
-- until every line is in stock at the shop set to fulfil it (the original, or
-- another shop selling the same item); approving creates a ₹0 order for the
-- customer, in the same checkout group, with the stock held. From then on its
-- status follows that order. The platform absorbs any price difference, and
-- the replacement order carries no tax invoice (it is not a new sale).
ALTER TABLE order_returns DROP CONSTRAINT IF EXISTS order_returns_status_check;
ALTER TABLE order_returns ADD CONSTRAINT order_returns_status_check CHECK (status IN (
  'requested', 'approved', 'rejected', 'pickup_scheduled', 'picked_up', 'received', 'refunded', 'disputed', 'cancelled'));
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS resolution VARCHAR(12) NOT NULL DEFAULT 'refund'
  CHECK (resolution IN ('refund', 'replacement'));
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS approved_refund_cents INTEGER CHECK (approved_refund_cents IS NULL OR approved_refund_cents >= 0);
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS pickup_scheduled_at TIMESTAMPTZ;
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS condition VARCHAR(10)
  CHECK (condition IS NULL OR condition IN ('unopened', 'opened', 'used', 'damaged', 'missing'));
ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS dispute_reason TEXT;

-- The open-request index also covers the new in-progress states.
DROP INDEX IF EXISTS idx_order_returns_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_returns_one_open
  ON order_returns (order_id) WHERE status IN ('requested', 'approved', 'pickup_scheduled', 'picked_up', 'received', 'disputed');

CREATE TABLE IF NOT EXISTS order_return_events (
  id SERIAL PRIMARY KEY,
  return_id INTEGER NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,
  note TEXT,
  actor_role VARCHAR(10) NOT NULL DEFAULT 'system' CHECK (actor_role IN ('customer', 'vendor', 'admin', 'system')),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_return_events_return ON order_return_events (return_id, created_at);

-- Existing returns get the history they have, so the page's timeline isn't empty.
INSERT INTO order_return_events (return_id, status, note, actor_role, actor_user_id, created_at)
SELECT r.id, 'requested', r.comment, 'customer', r.user_id, r.created_at FROM order_returns r
WHERE NOT EXISTS (SELECT 1 FROM order_return_events e WHERE e.return_id = r.id);
INSERT INTO order_return_events (return_id, status, note, actor_role, actor_user_id, created_at)
SELECT r.id, r.status, r.resolution_note, 'admin', r.reviewed_by_user_id, r.reviewed_at FROM order_returns r
WHERE r.reviewed_at IS NOT NULL AND r.status IN ('approved', 'rejected')
  AND NOT EXISTS (SELECT 1 FROM order_return_events e WHERE e.return_id = r.id AND e.status = r.status);

-- A replacement order is ₹0 to the customer; this is what the platform owes the
-- shop that fulfils it (picked up by settlements as part of the gross).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacement_of_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform_paid_cents INTEGER NOT NULL DEFAULT 0;

CREATE SEQUENCE IF NOT EXISTS replacement_ref_seq;

CREATE TABLE IF NOT EXISTS replacements (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  return_id INTEGER NOT NULL UNIQUE REFERENCES order_returns(id) ON DELETE CASCADE,
  original_order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  -- Set when another shop fulfils instead of the original.
  fulfil_vendor_id INTEGER REFERENCES vendor_profiles(id) ON DELETE SET NULL,
  replacement_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  -- requested / awaiting_stock / cancelled are stored; once the order exists the
  -- status shown follows it (order_created, shipped, delivered, failed).
  status VARCHAR(16) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'awaiting_stock', 'approved', 'cancelled')),
  value_cents INTEGER NOT NULL,
  price_difference_cents INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  cancel_reason TEXT,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which product each original line is replaced with (the same one, or the
-- equivalent at the shop fulfilling instead).
CREATE TABLE IF NOT EXISTS replacement_items (
  id SERIAL PRIMARY KEY,
  replacement_id INTEGER NOT NULL REFERENCES replacements(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS replacement_events (
  id SERIAL PRIMARY KEY,
  replacement_id INTEGER NOT NULL REFERENCES replacements(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL,
  note TEXT,
  actor_role VARCHAR(10) NOT NULL DEFAULT 'system' CHECK (actor_role IN ('customer', 'vendor', 'admin', 'system')),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_replacement_events ON replacement_events (replacement_id, created_at);

-- ===== BUSINESS ACCOUNTS (PHASE 44) =====
--
-- A buying organisation, not a person: people order under one GSTIN, against
-- one credit limit. Registered from the app (status pending), verified by an
-- admin. Only a verified account can order as a business.
--
-- Credit: an order placed for the business can be paid 'credit' when the
-- account has a limit, the order fits what's left, it's within the member's
-- per-order limit, and nothing is overdue. Credit drawn = the business's credit
-- orders that weren't cancelled − payments recorded against the account.
-- Overdue = credit orders older than the payment terms not yet covered by
-- payments (oldest first). Invoices of business orders carry the GSTIN (B2B).
CREATE TABLE IF NOT EXISTS business_accounts (
  id SERIAL PRIMARY KEY,
  legal_name VARCHAR(200) NOT NULL,
  trade_name VARCHAR(200),
  gstin VARCHAR(15) NOT NULL UNIQUE,
  pan VARCHAR(10),
  state TEXT,
  city TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'suspended')),
  status_reason TEXT,
  primary_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  contact_name VARCHAR(120),
  contact_phone VARCHAR(20),
  credit_limit_cents BIGINT NOT NULL DEFAULT 0 CHECK (credit_limit_cents >= 0),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 180),
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_business_accounts_status ON business_accounts (status, created_at);

-- A person belongs to at most one business.
CREATE TABLE IF NOT EXISTS business_members (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('owner', 'approver', 'buyer')),
  order_limit_cents BIGINT CHECK (order_limit_cents IS NULL OR order_limit_cents > 0),
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_addresses (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  label VARCHAR(80) NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  pincode VARCHAR(6) NOT NULL,
  -- A branch registered in another state files under its own GSTIN.
  gstin VARCHAR(15),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  contact_name VARCHAR(120),
  contact_phone VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_addresses_default ON business_addresses (account_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS business_documents (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL CHECK (type IN ('gstin', 'pan', 'bank', 'fssai', 'other')),
  file_url TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Money the business paid against its credit.
CREATE TABLE IF NOT EXISTS business_credit_payments (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  reference VARCHAR(60) NOT NULL,
  note TEXT,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, reference)
);

ALTER TABLE checkout_groups ADD COLUMN IF NOT EXISTS business_account_id INTEGER REFERENCES business_accounts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS business_account_id INTEGER REFERENCES business_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_business ON orders (business_account_id) WHERE business_account_id IS NOT NULL;

-- 'credit' joins the payment methods.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method IN ('cod', 'upi', 'card', 'netbanking', 'wallet', 'credit'));
ALTER TABLE checkout_groups DROP CONSTRAINT IF EXISTS checkout_groups_payment_method_check;
ALTER TABLE checkout_groups ADD CONSTRAINT checkout_groups_payment_method_check
  CHECK (payment_method IN ('cod', 'upi', 'card', 'netbanking', 'wallet', 'credit'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('cod', 'upi', 'card', 'netbanking', 'wallet', 'credit'));

-- ===== RFQS & QUOTATIONS (PHASE 45) =====
--
-- A verified business asks for prices on a basket (catalogue items or described
-- ones); shops are invited, not matched, and answer with quotations. A
-- quotation is versioned, never edited: a new price is a new revision and the
-- old one is marked 'revised', so the negotiation stays readable afterwards.
-- An RFQ takes quotes until its closing time (then closed, or expired if nobody
-- quoted), or until an admin closes it to compare.
CREATE SEQUENCE IF NOT EXISTS rfq_ref_seq;
CREATE SEQUENCE IF NOT EXISTS quotation_ref_seq;

CREATE TABLE IF NOT EXISTS rfqs (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  business_account_id INTEGER NOT NULL REFERENCES business_accounts(id) ON DELETE RESTRICT,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title VARCHAR(160) NOT NULL,
  notes TEXT,
  delivery_address TEXT,
  delivery_city TEXT,
  delivery_by DATE,
  closes_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'closed', 'awarded', 'cancelled', 'expired')),
  cancel_reason TEXT,
  awarded_quotation_id INTEGER,
  awarded_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON rfqs (status, closes_at);
CREATE INDEX IF NOT EXISTS idx_rfqs_business ON rfqs (business_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rfq_items (
  id SERIAL PRIMARY KEY,
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  specification TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit VARCHAR(20) NOT NULL DEFAULT 'pcs',
  target_price_cents INTEGER CHECK (target_price_cents IS NULL OR target_price_cents > 0)
);
CREATE INDEX IF NOT EXISTS idx_rfq_items_rfq ON rfq_items (rfq_id);

CREATE TABLE IF NOT EXISTS rfq_vendors (
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'viewed', 'quoted', 'declined')),
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  viewed_at TIMESTAMPTZ,
  decline_reason TEXT,
  PRIMARY KEY (rfq_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_rfq_vendors_vendor ON rfq_vendors (vendor_id, invited_at DESC);

CREATE TABLE IF NOT EXISTS quotations (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL,
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'revision_requested', 'revised', 'accepted', 'rejected', 'withdrawn', 'expired')),
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  delivery_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  valid_until DATE,
  delivery_days INTEGER CHECK (delivery_days IS NULL OR delivery_days BETWEEN 0 AND 365),
  payment_terms_days INTEGER CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 180),
  notes TEXT,
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  UNIQUE (rfq_id, vendor_id, revision)
);
-- One live quotation per shop per RFQ; older revisions are 'revised'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotations_one_live ON quotations (rfq_id, vendor_id)
  WHERE status IN ('submitted', 'revision_requested', 'accepted');
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations (status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS quotation_lines (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  rfq_item_id INTEGER NOT NULL REFERENCES rfq_items(id) ON DELETE CASCADE,
  unit_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent BETWEEN 0 AND 28),
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  unavailable BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_quotation_lines_quotation ON quotation_lines (quotation_id);

-- The back-and-forth on a quotation (admin, vendor or buyer).
CREATE TABLE IF NOT EXISTS quotation_messages (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  author_role VARCHAR(10) NOT NULL CHECK (author_role IN ('admin', 'vendor', 'buyer')),
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quotation_messages_quotation ON quotation_messages (quotation_id, created_at);

-- ===== PURCHASE ORDERS (PHASE 46) =====
--
-- What an awarded quotation becomes: a commitment to buy at the agreed prices.
-- Raised when a quotation is awarded (services/quotations.js), one per
-- quotation, with a line per priced quotation line. Deliveries against it are
-- recorded over time (purchase_order_deliveries), so a PO is finished only when
-- everything has arrived and been paid.
CREATE SEQUENCE IF NOT EXISTS purchase_order_seq;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  po_number TEXT NOT NULL UNIQUE,
  quotation_id INTEGER NOT NULL UNIQUE REFERENCES quotations(id) ON DELETE RESTRICT,
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE RESTRICT,
  business_account_id INTEGER NOT NULL REFERENCES business_accounts(id) ON DELETE RESTRICT,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  buyer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'acknowledged', 'in_progress', 'partially_delivered', 'delivered', 'closed', 'cancelled')),
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  delivery_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  expected_delivery_at TIMESTAMPTZ,
  delivery_address TEXT,
  notes TEXT,
  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  cancel_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders (status, issued_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  quotation_line_id INTEGER REFERENCES quotation_lines(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  hsn_code TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit VARCHAR(20) NOT NULL,
  delivered_quantity INTEGER NOT NULL DEFAULT 0 CHECK (delivered_quantity >= 0),
  unit_price_cents INTEGER NOT NULL,
  tax_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  line_total_cents INTEGER NOT NULL,
  CHECK (delivered_quantity <= quantity)
);
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po ON purchase_order_lines (purchase_order_id);

ALTER TABLE rfqs DROP CONSTRAINT IF EXISTS rfqs_awarded_quotation_fk;
ALTER TABLE rfqs ADD CONSTRAINT rfqs_awarded_quotation_fk FOREIGN KEY (awarded_quotation_id) REFERENCES quotations(id) ON DELETE SET NULL;

-- ===== PURCHASE ORDER FULFILMENT (PHASE 47) =====
--
-- Deliveries against a PO and the payments for them. Each delivery is
-- invoiced at its value (the delivered lines at the PO prices, with tax; the
-- delivery that completes the PO carries the remainder, delivery charge
-- included), so invoiced = sum of deliveries. Payments are confirmed by the
-- vendor (the payee). Rules in services/purchaseOrders.js.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS resend_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor ON purchase_orders (vendor_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_business ON purchase_orders (business_account_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_deliveries (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
  tracking_number TEXT,
  shipment_id INTEGER,
  note TEXT,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_po_deliveries_po ON purchase_order_deliveries (purchase_order_id, delivered_at);

CREATE TABLE IF NOT EXISTS purchase_order_delivery_lines (
  delivery_id INTEGER NOT NULL REFERENCES purchase_order_deliveries(id) ON DELETE CASCADE,
  purchase_order_line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (delivery_id, purchase_order_line_id)
);

CREATE TABLE IF NOT EXISTS purchase_order_payments (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method VARCHAR(20) NOT NULL DEFAULT 'bank_transfer' CHECK (method IN ('bank_transfer', 'upi', 'cheque', 'cash', 'other')),
  reference TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_po_payments_po ON purchase_order_payments (purchase_order_id);

-- ===== ANALYTICS (PHASE 48) =====
--
-- What Admin → Analytics reads beyond orders: which app surface an order was
-- placed from (Near Me vs the main shop; B2B is an order for a business
-- account), and app sessions for conversion and the funnel. The app reports
-- events in batches (POST /api/analytics/events); checkout itself records
-- 'order_placed' for the session in the X-Session-Id header. Rules in
-- controllers/analytics.controller.js.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS origin VARCHAR(10);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_origin_check;
ALTER TABLE orders ADD CONSTRAINT orders_origin_check CHECK (origin IS NULL OR origin IN ('shop', 'near_me'));
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);

CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(64) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event VARCHAR(20) NOT NULL CHECK (event IN ('session_start', 'product_view', 'add_to_cart', 'checkout_start', 'order_placed')),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  platform VARCHAR(20),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_time ON analytics_events (occurred_at, event);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events (session_id);

-- ===== WHATSAPP (PHASE 49) =====
--
-- WhatsApp through Meta's Cloud API, configured as the 'whatsapp_cloud'
-- platform in the Platform Registry (credentials stay there, encrypted).
-- Templates are drafted here and submitted to Meta for approval; every
-- message, out and in, is logged with Meta's id and delivery status. Sending
-- goes through a queue (services/whatsapp.js) so Meta being slow or down never
-- holds up an order. Plan: docs/whatsapp-plan.md.
CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(512) NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  category VARCHAR(20) NOT NULL DEFAULT 'UTILITY' CHECK (category IN ('UTILITY', 'AUTHENTICATION', 'MARKETING')),
  header_text VARCHAR(60),
  body_text TEXT NOT NULL,
  footer_text VARCHAR(60),
  -- [{ type: 'URL'|'QUICK_REPLY'|'PHONE_NUMBER', text, url?, phone?, example? }]
  buttons JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Sample values for {{1}}, {{2}}… — Meta reviews the template with them.
  body_examples JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled')),
  meta_template_id TEXT,
  rejected_reason TEXT,
  -- What the template is for (order_placed, vendor_new_order…), for the event rules later.
  purpose VARCHAR(40),
  submitted_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, language)
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id BIGSERIAL PRIMARY KEY,
  direction VARCHAR(3) NOT NULL CHECK (direction IN ('out', 'in')),
  -- The other party's number, digits only with country code (919876543210).
  phone VARCHAR(20) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('template', 'text')),
  template_id INTEGER REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  template_name VARCHAR(512),
  language VARCHAR(10),
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  button_param TEXT,
  -- The text as the recipient sees it (template filled in), for the log.
  body TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'received')),
  meta_message_id TEXT UNIQUE,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Why it was sent: 'test', or the event (order_placed…).
  event VARCHAR(40),
  environment VARCHAR(10),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_queue ON whatsapp_messages (next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_created ON whatsapp_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone ON whatsapp_messages (phone, created_at DESC);

-- Consent: Meta requires it, and nothing automatic is sent without it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_opt_out_at TIMESTAMPTZ;

-- ===== WHATSAPP BOT ACCESS (PHASE 50) =====
--
-- The Gloaro bot owns the WhatsApp conversation; Gloaro Mart owns orders. The
-- bot calls POST /api/bot/session with a service key and the customer's
-- WhatsApp number (which Meta signs, so it can be trusted) and gets a short
-- customer login, then uses the same cart, address, checkout and order APIs as
-- the app. Keys are shown once and stored only as a SHA-256 hash.
CREATE TABLE IF NOT EXISTS bot_api_keys (
  id SERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  key_prefix VARCHAR(16) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Which customer account a WhatsApp number is, once decided — a stored phone
-- can be typed many ways, and two accounts can share one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_whatsapp_phone ON users (whatsapp_phone) WHERE whatsapp_phone IS NOT NULL;

-- ===== WHATSAPP ORDER UPDATES (PHASE 51) =====
--
-- Automatic WhatsApp messages on order events (services/whatsappEvents.js).
-- The sender sweeps recent events — status history, refunds, returns,
-- invoices, new purchases — so every way an order moves is covered without
-- touching the code that moves it, and only committed changes are seen.
-- An event counts only if it happened after its rule was switched on, and is
-- sent at most once (dedupe_key), so switching a rule on never floods old
-- orders and a retry never sends twice.
CREATE TABLE IF NOT EXISTS whatsapp_event_rules (
  event VARCHAR(40) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  template_name VARCHAR(512) NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  enabled_at TIMESTAMPTZ,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS checkout_group_id INTEGER REFERENCES checkout_groups(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS skip_reason TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_dedupe ON whatsapp_messages (dedupe_key) WHERE dedupe_key IS NOT NULL;
-- 'skipped': the event happened but nothing was sent (opted out, no number,
-- template not approved…), kept so the log says why.
ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_status_check;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'received', 'skipped'));
ALTER TABLE whatsapp_messages ALTER COLUMN kind DROP NOT NULL;
ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_kind_check;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_kind_check CHECK (kind IS NULL OR kind IN ('template', 'text'));
ALTER TABLE whatsapp_messages ALTER COLUMN phone DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_status_history_created ON order_status_history (created_at);
CREATE INDEX IF NOT EXISTS idx_refunds_updated ON refunds (updated_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_order_return_events_created ON order_return_events (created_at);
CREATE INDEX IF NOT EXISTS idx_checkout_groups_created ON checkout_groups (created_at);

-- ===== WHATSAPP PROVIDER (PHASE WP1) =====
--
-- Two ways to send WhatsApp, one in use at a time, picked in Admin → Channels:
-- Meta's Cloud API ('whatsapp_cloud', approved templates only) and UltraMsg
-- ('ultramsg', a QR-linked number sending the templates' text as plain
-- messages) — a stand-in until Meta is approved. Each is its own platform row
-- with its own encrypted settings; the queue, templates, order-update rules
-- and log are shared. Also adds the shop's new-order alert (shop_new_order).
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS whatsapp_provider VARCHAR(20) NOT NULL DEFAULT 'whatsapp_cloud';
ALTER TABLE platform_settings DROP CONSTRAINT IF EXISTS platform_settings_whatsapp_provider_check;
ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_whatsapp_provider_check
  CHECK (whatsapp_provider IN ('whatsapp_cloud', 'ultramsg'));
-- Which provider sent (or received) a message.
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS provider VARCHAR(20);

-- ===== WHATSAPP BILLS & INVOICES (PHASE WP2) =====
--
-- On a plain-text provider (UltraMsg) "Order placed" carries the itemised
-- bill and "Invoice ready" the invoice as a PDF, made when the message is sent
-- (services/invoicePdf.js) — never stored. Customer updates also go to the
-- delivery address's mobile number unless it wrote STOP.
-- { type: 'invoice', id } — the file sent with the message.
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS attachment JSONB;

-- ===== AD PROMOTIONS — PRICING (PHASE 52) =====
--
-- Shops pay GLOARO to promote their shop, products and offers. This phase is
-- the price list and the engine that reads it (services/adPricing.js); the
-- campaigns, payments and serving come next. Every number here is set by the
-- super admin — the seeds are the brief's sample values, to be changed.
-- Plan: docs/ad-promotions-plan.md.

-- One row: which pricing models are on, tax, limits, policies.
CREATE TABLE IF NOT EXISTS ad_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  model_fixed BOOLEAN NOT NULL DEFAULT TRUE,          -- A: rate card price
  model_commission BOOLEAN NOT NULL DEFAULT FALSE,    -- B: % of orders the ad brings in, nothing upfront
  model_fixed_commission BOOLEAN NOT NULL DEFAULT FALSE, -- C: rate card price + % of orders
  model_package BOOLEAN NOT NULL DEFAULT TRUE,        -- D: Basic / Growth / Premium / Enterprise
  commission_percent NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (commission_percent BETWEEN 0 AND 100),
  fixed_commission_percent NUMERIC(5,2) NOT NULL DEFAULT 5 CHECK (fixed_commission_percent BETWEEN 0 AND 100),
  attribution_days INTEGER NOT NULL DEFAULT 7 CHECK (attribution_days BETWEEN 1 AND 90),
  tax_percent NUMERIC(5,2) NOT NULL DEFAULT 18 CHECK (tax_percent BETWEEN 0 AND 50),
  tax_label VARCHAR(20) NOT NULL DEFAULT 'GST',
  sac_code VARCHAR(10) NOT NULL DEFAULT '998365',
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  home_country CHAR(2) NOT NULL DEFAULT 'IN',
  min_charge_cents INTEGER NOT NULL DEFAULT 10000 CHECK (min_charge_cents >= 0),
  min_budget_cents INTEGER NOT NULL DEFAULT 10000 CHECK (min_budget_cents >= 0),
  max_budget_cents INTEGER NOT NULL DEFAULT 100000000 CHECK (max_budget_cents > 0),
  max_hours INTEGER NOT NULL DEFAULT 8760 CHECK (max_hours BETWEEN 1 AND 87600),
  cancellation_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (cancellation_fee_percent BETWEEN 0 AND 100),
  prorata_refund BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (min_budget_cents <= max_budget_cents)
);

-- How far an ad reaches. Each level has its own duration prices.
CREATE TABLE IF NOT EXISTS ad_levels (
  key VARCHAR(15) PRIMARY KEY CHECK (key IN ('local', 'city', 'district', 'state', 'country', 'international')),
  label VARCHAR(40) NOT NULL,
  description TEXT,
  min_hours INTEGER NOT NULL DEFAULT 1 CHECK (min_hours >= 1),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Duration packs per level: "24 hours of city reach costs ₹1,000". A booking
-- is priced at the cheapest mix of packs that covers its hours.
CREATE TABLE IF NOT EXISTS ad_rate_packs (
  id SERIAL PRIMARY KEY,
  level VARCHAR(15) NOT NULL REFERENCES ad_levels(key) ON DELETE CASCADE,
  hours INTEGER NOT NULL CHECK (hours BETWEEN 1 AND 8760),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (level, hours)
);

-- Where an ad can be aimed: country → state → district → city → locality.
-- A region's multiplier scales its price (a metro costs more); the audience
-- estimate is entered by the admin and shown as an estimate, never invented.
CREATE TABLE IF NOT EXISTS ad_regions (
  id SERIAL PRIMARY KEY,
  level VARCHAR(10) NOT NULL CHECK (level IN ('country', 'state', 'district', 'city', 'locality')),
  name VARCHAR(120) NOT NULL,
  parent_id INTEGER REFERENCES ad_regions(id) ON DELETE RESTRICT,
  country_code CHAR(2) NOT NULL DEFAULT 'IN',
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_km NUMERIC(6,2) CHECK (radius_km IS NULL OR radius_km > 0),
  audience_estimate INTEGER CHECK (audience_estimate IS NULL OR audience_estimate >= 0),
  price_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1 CHECK (price_multiplier > 0 AND price_multiplier <= 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A locality is a point and a radius.
  CHECK (level <> 'locality' OR (latitude IS NOT NULL AND longitude IS NOT NULL AND radius_km IS NOT NULL)),
  CHECK (level = 'country' OR parent_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_regions_name ON ad_regions (COALESCE(parent_id, 0), level, lower(name));
CREATE INDEX IF NOT EXISTS idx_ad_regions_parent ON ad_regions (parent_id);

-- The slots in the app an ad can take.
CREATE TABLE IF NOT EXISTS ad_placements (
  key VARCHAR(30) PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,29}$'),
  name VARCHAR(80) NOT NULL,
  description TEXT,
  -- Image sizes it takes, e.g. ["1200x400"].
  formats JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_levels JSONB NOT NULL DEFAULT '["local","city","district","state","country","international"]'::jsonb,
  max_live_per_region INTEGER NOT NULL DEFAULT 5 CHECK (max_live_per_region BETWEEN 1 AND 100),
  premium_percent NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (premium_percent BETWEEN -90 AND 1000),
  premium_cents INTEGER NOT NULL DEFAULT 0 CHECK (premium_cents >= 0),
  sponsored_label BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Adjustments on top of the rate card, in priority order.
CREATE TABLE IF NOT EXISTS ad_pricing_rules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  kind VARCHAR(15) NOT NULL CHECK (kind IN ('seasonal', 'peak', 'volume', 'category', 'enterprise', 'multi_region')),
  -- seasonal: uses starts_at/ends_at · peak: {fromHour, toHour} (IST) · volume: {minHours}
  -- category: {categoryIds} · enterprise: {vendorIds} · multi_region: {minRegions}
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  adjust_percent NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (adjust_percent BETWEEN -90 AND 500),
  priority INTEGER NOT NULL DEFAULT 100,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

-- Fixed-price bundles.
CREATE TABLE IF NOT EXISTS ad_packages (
  id SERIAL PRIMARY KEY,
  name VARCHAR(60) NOT NULL UNIQUE,
  tier VARCHAR(12) NOT NULL CHECK (tier IN ('basic', 'growth', 'premium', 'enterprise', 'custom')),
  description TEXT,
  level VARCHAR(15) NOT NULL REFERENCES ad_levels(key),
  hours INTEGER NOT NULL CHECK (hours BETWEEN 1 AND 8760),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  placements JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_regions INTEGER NOT NULL DEFAULT 1 CHECK (max_regions BETWEEN 1 AND 100),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Discount codes for ad bookings — separate from shopping coupons.
CREATE TABLE IF NOT EXISTS ad_coupons (
  id SERIAL PRIMARY KEY,
  code VARCHAR(30) NOT NULL,
  kind VARCHAR(8) NOT NULL CHECK (kind IN ('percent', 'flat')),
  value INTEGER NOT NULL CHECK (value > 0),
  max_discount_cents INTEGER CHECK (max_discount_cents IS NULL OR max_discount_cents > 0),
  min_spend_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_spend_cents >= 0),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind <> 'percent' OR value <= 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_coupons_code ON ad_coupons (upper(code));

-- ===== AD PROMOTIONS — CAMPAIGNS (PHASE 53) =====
--
-- A shop's booking: what it shows, where, when, and the price it was sold at
-- (price_snapshot, from services/adPricing.js at payment — never recomputed).
-- Lifecycle and money in services/adCampaigns.js.
--
-- draft → pending_payment (offline, waiting for the money) → pending_approval
--   → scheduled → live → completed; paused from live; rejected / cancelled
--   with a refund per the policy.
CREATE SEQUENCE IF NOT EXISTS ad_campaign_ref_seq;

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_role VARCHAR(10) NOT NULL DEFAULT 'admin' CHECK (created_by_role IN ('admin', 'vendor')),
  title VARCHAR(120) NOT NULL,
  description TEXT,
  offer_text VARCHAR(160),
  cta_label VARCHAR(30),
  cta_kind VARCHAR(10) NOT NULL DEFAULT 'shop' CHECK (cta_kind IN ('shop', 'product', 'url', 'call', 'whatsapp')),
  cta_target TEXT,
  -- The checkout discount campaign the ad advertises, for offer redemptions.
  discount_campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  model VARCHAR(20) NOT NULL CHECK (model IN ('fixed', 'commission', 'fixed_commission', 'package')),
  package_id INTEGER REFERENCES ad_packages(id) ON DELETE SET NULL,
  level VARCHAR(15) NOT NULL REFERENCES ad_levels(key),
  placements JSONB NOT NULL DEFAULT '[]'::jsonb,
  coupon_code VARCHAR(30),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  hours INTEGER NOT NULL CHECK (hours > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft', 'pending_payment', 'pending_approval', 'scheduled', 'live', 'paused', 'completed', 'rejected', 'cancelled')),
  payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN
    ('unpaid', 'pending', 'paid', 'not_required', 'refunded', 'partially_refunded')),
  -- The quote at payment (or, for a draft, the latest estimate).
  price_snapshot JSONB,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  taxable_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  cancel_reason TEXT,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  went_live_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_status ON ad_campaigns (status, starts_at);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_vendor ON ad_campaigns (vendor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ad_campaign_regions (
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  region_id INTEGER NOT NULL REFERENCES ad_regions(id) ON DELETE RESTRICT,
  PRIMARY KEY (campaign_id, region_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_campaign_regions_region ON ad_campaign_regions (region_id);

CREATE TABLE IF NOT EXISTS ad_assets (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind VARCHAR(10) NOT NULL DEFAULT 'banner' CHECK (kind IN ('banner', 'card', 'square')),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  bytes INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_assets_campaign ON ad_assets (campaign_id, sort_order);

-- What each campaign was charged and how. 'booking' is the original
-- purchase; 'extension' buys more hours. Settlement payments are paid at once
-- (the amount is taken from the shop's next payout); offline ones wait for the
-- admin to confirm the money arrived. The idempotency key stops a double
-- click or a repeated request from charging twice.
CREATE TABLE IF NOT EXISTS ad_payments (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE RESTRICT,
  purpose VARCHAR(10) NOT NULL DEFAULT 'booking' CHECK (purpose IN ('booking', 'extension')),
  method VARCHAR(12) NOT NULL CHECK (method IN ('settlement', 'offline', 'online')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  taxable_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'failed')),
  reference TEXT,
  extension_hours INTEGER CHECK (extension_hours IS NULL OR extension_hours > 0),
  extension_snapshot JSONB,
  idempotency_key VARCHAR(80) UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_payments_campaign ON ad_payments (campaign_id);
CREATE INDEX IF NOT EXISTS idx_ad_payments_status ON ad_payments (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ad_refunds (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE RESTRICT,
  payment_id INTEGER REFERENCES ad_payments(id) ON DELETE SET NULL,
  method VARCHAR(12) NOT NULL CHECK (method IN ('settlement', 'offline', 'online')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  taxable_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  -- Settlement refunds are credited at once; offline ones until the admin has paid them back.
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  reference TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_refunds_campaign ON ad_refunds (campaign_id);

-- Money a shop owes GLOARO (positive) or is owed back (negative) outside its
-- orders, taken into its next weekly settlement as one deduction or credit.
CREATE TABLE IF NOT EXISTS vendor_charges (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  kind VARCHAR(15) NOT NULL CHECK (kind IN ('advertising', 'ad_refund', 'ad_commission')),
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  ad_payment_id INTEGER REFERENCES ad_payments(id) ON DELETE SET NULL,
  ad_refund_id INTEGER REFERENCES ad_refunds(id) ON DELETE SET NULL,
  -- Set once it has gone into a settlement.
  settlement_id INTEGER REFERENCES settlements(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vendor_charges_open ON vendor_charges (vendor_id) WHERE settlement_id IS NULL;
ALTER TABLE settlement_deductions ADD COLUMN IF NOT EXISTS vendor_charge_id INTEGER UNIQUE REFERENCES vendor_charges(id) ON DELETE SET NULL;
ALTER TABLE settlement_deductions DROP CONSTRAINT IF EXISTS settlement_deductions_kind_check;
ALTER TABLE settlement_deductions ADD CONSTRAINT settlement_deductions_kind_check
  CHECK (kind IN ('commission', 'refund', 'tds', 'tcs', 'penalty', 'adjustment', 'other', 'advertising'));

-- GST tax invoices for ad fees: GLOARO sells, the shop buys. Their own series.
CREATE TABLE IF NOT EXISTS ad_invoice_series (
  financial_year VARCHAR(20) PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ad_invoices (
  id SERIAL PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  invoice_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  financial_year VARCHAR(20) NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE RESTRICT,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES ad_payments(id) ON DELETE RESTRICT,
  seller_name TEXT NOT NULL,
  seller_gstin TEXT,
  seller_state TEXT,
  buyer_vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  buyer_name TEXT NOT NULL,
  buyer_gstin TEXT,
  buyer_state TEXT,
  buyer_address TEXT,
  sac_code VARCHAR(10) NOT NULL,
  description TEXT NOT NULL,
  supply_type VARCHAR(12) NOT NULL CHECK (supply_type IN ('intra_state', 'inter_state')),
  taxable_cents INTEGER NOT NULL,
  cgst_cents INTEGER NOT NULL DEFAULT 0,
  sgst_cents INTEGER NOT NULL DEFAULT 0,
  igst_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every rupee of ad money, by kind, so revenue, tax, discounts and refunds are
-- never mixed. Revenue reports read this.
CREATE TABLE IF NOT EXISTS ad_ledger (
  id BIGSERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE RESTRICT,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE RESTRICT,
  entry VARCHAR(15) NOT NULL CHECK (entry IN ('ad_revenue', 'ad_tax', 'ad_discount', 'ad_refund', 'ad_tax_refund', 'ad_commission')),
  amount_cents INTEGER NOT NULL,
  payment_id INTEGER REFERENCES ad_payments(id) ON DELETE SET NULL,
  refund_id INTEGER REFERENCES ad_refunds(id) ON DELETE SET NULL,
  note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_ledger_time ON ad_ledger (occurred_at);
CREATE INDEX IF NOT EXISTS idx_ad_ledger_campaign ON ad_ledger (campaign_id);

CREATE TABLE IF NOT EXISTS ad_campaign_history (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role VARCHAR(10) NOT NULL DEFAULT 'system' CHECK (actor_role IN ('admin', 'vendor', 'system')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_campaign_history_campaign ON ad_campaign_history (campaign_id, created_at);

-- ===== AD PROMOTIONS — SERVING & RESULTS (PHASE 54) =====
--
-- The app asks GET /api/ads for a slot and reports what it showed and what was
-- tapped (POST /api/ads/events). An impression counts once per session, per
-- campaign and slot, per hour; a click or enquiry once per minute — so a
-- refreshing screen or a double tap doesn't inflate the numbers. Daily totals
-- are kept as events arrive, so the dashboard never scans raw events.
--
-- An order is attributed to an ad when the same signed-in customer tapped one
-- of that shop's ads within the attribution window before ordering. Delivered
-- orders only; each order once. On the commission models (B, C) that order
-- carries GLOARO's ad commission, taken from the shop's next payout.
CREATE TABLE IF NOT EXISTS ad_events (
  id BIGSERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  event VARCHAR(10) NOT NULL CHECK (event IN ('impression', 'click', 'enquiry')),
  placement VARCHAR(30) NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  bucket TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_events_dedupe ON ad_events (campaign_id, placement, session_id, event, bucket);
CREATE INDEX IF NOT EXISTS idx_ad_events_clicks ON ad_events (user_id, occurred_at DESC) WHERE event = 'click' AND user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ad_stats_daily (
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  placement VARCHAR(30) NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  enquiries INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  order_value_cents BIGINT NOT NULL DEFAULT 0,
  commission_cents BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day, placement)
);
CREATE INDEX IF NOT EXISTS idx_ad_stats_daily_day ON ad_stats_daily (day);

CREATE TABLE IF NOT EXISTS ad_attributions (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  click_event_id BIGINT REFERENCES ad_events(id) ON DELETE SET NULL,
  placement VARCHAR(30) NOT NULL,
  order_value_cents INTEGER NOT NULL,
  commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  vendor_charge_id INTEGER REFERENCES vendor_charges(id) ON DELETE SET NULL,
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ad_attributions_campaign ON ad_attributions (campaign_id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ad_campaign_id INTEGER REFERENCES ad_campaigns(id) ON DELETE SET NULL;
-- ===== CUSTOMER LOGIN OTP =====

CREATE TABLE IF NOT EXISTS login_otps (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_otps_user_idx ON login_otps (user_id, created_at DESC);

-- ===== PUSH DEVICE TOKENS =====

CREATE TABLE IF NOT EXISTS device_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens (user_id);

-- ===== PRODUCT REVIEWS =====
--
-- A customer's rating of one product, earned by a delivered order that
-- contained it. One per (user, product): re-buying and re-rating edits the
-- same row rather than stacking ratings. The summary is computed on read, so
-- there is no running total to drift out of step with these rows.
CREATE TABLE IF NOT EXISTS product_reviews (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_product_reviews_product ON product_reviews (product_id, created_at DESC);

-- ===== CUSTOMER WALLET & TOP-UPS =====
--
-- Separate from vendor_wallets (a vendor's earnings, credit-only). A customer
-- wallet holds money the customer loaded. Money enters only through a top-up
-- that a verified gateway webhook confirms; the ledger is append-only and the
-- balance can never go negative.
CREATE TABLE IF NOT EXISTS customer_wallets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_topups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'successful', 'failed', 'cancelled')),
  provider TEXT NOT NULL,
  provider_order_id TEXT UNIQUE,
  provider_payment_id TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_topups_user ON wallet_topups (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_wallet_transactions (
  id SERIAL PRIMARY KEY,
  wallet_id INTEGER NOT NULL REFERENCES customer_wallets(id) ON DELETE RESTRICT,
  topup_id INTEGER REFERENCES wallet_topups(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_after_cents INTEGER NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_wallet_txns_wallet ON customer_wallet_transactions (wallet_id, created_at DESC);
-- A top-up can credit at most once, whatever the gateway replays.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_wallet_txns_one_credit_per_topup
  ON customer_wallet_transactions (topup_id) WHERE type = 'credit';

-- ===== MEDIA FILES (UPLOADS STORED IN THE DATABASE) =====
-- Every uploaded image (products, banners, brands, categories, shop logos, ads,
-- reviews, support, business documents) lives here, keyed by the same
-- /uploads/<folder>/<name> path the rest of the schema stores. Hosts with a
-- throwaway disk keep every image across redeploys.
CREATE TABLE IF NOT EXISTS media_files (
  path TEXT PRIMARY KEY CHECK (path ~ '^/uploads/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$'),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes BYTEA NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== USERNAMES =====
-- Sign-in is by username (or a phone OTP) instead of email. Unique ignoring
-- case; accounts made before this keep signing in with their email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username)) WHERE username IS NOT NULL;

-- ===== SHOP BRANDING & GALLERY (SB1) =====
-- Shops set their own description, logo and cover (vendor_profiles already
-- has the columns; nothing wrote them before) and keep a small photo gallery
-- that customers see on the shop page. Photos show at once; an admin can hide
-- one with a reason. Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB1).
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

CREATE TABLE IF NOT EXISTS vendor_gallery (
  id SERIAL PRIMARY KEY,
  vendor_id INT NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  caption VARCHAR(140),
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  hidden_reason VARCHAR(300),
  hidden_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendor_gallery_vendor ON vendor_gallery (vendor_id, sort_order, id);

-- ===== SHOP TRUST & PLACE (SB2) =====
-- What a customer can trust about a shop and where it is. "Verified" isn't
-- stored: it is worked out when read (approved shop + every required KYC
-- document approved), so it can't drift from the documents; an admin can hold
-- the badge back with a reason. approved_at is the first approval (backfilled
-- from the audit log where one was recorded, else left empty). district is
-- the shop's district, which ad targeting already matches on.
-- Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB2).
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS district TEXT;
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS verification_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS verification_hold_reason VARCHAR(300);

UPDATE vendor_profiles vp SET approved_at = a.at
FROM (
  SELECT entity_id, MIN(created_at) AS at FROM audit_logs
  WHERE action = 'vendor.status_changed' AND new_value->>'status' = 'approved'
  GROUP BY entity_id
) a
WHERE vp.id::text = a.entity_id AND vp.approved_at IS NULL AND vp.status = 'approved';

CREATE INDEX IF NOT EXISTS idx_vendor_documents_approved ON vendor_documents (vendor_id, doc_type) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_vendor_profiles_approved_at ON vendor_profiles (approved_at DESC);

-- ===== SHOP HOURS (SB3) =====
-- When a shop is open. A shop can keep its one daily window (opens_at /
-- closes_at on vendor_delivery_rules, unchanged) or set a weekly timetable:
-- one row per day of the week (0 = Sunday), either closed or open from
-- opens_at to closes_at (a window past midnight runs into the next day;
-- opens_at = closes_at means open 24 hours). Holidays close the shop for a
-- whole date. Times are the shop's own clock (timezone, India by default),
-- never the server's. shop_open_at() is the one rule used by the shop list,
-- the shop page and checkout: weekly hours win, then the daily window; NULL
-- when the shop never said (checkout keeps treating that as open).
-- Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB3).
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata';

CREATE TABLE IF NOT EXISTS vendor_hours (
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_closed BOOLEAN NOT NULL DEFAULT false,
  opens_at TIME,
  closes_at TIME,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, day_of_week),
  CHECK (is_closed OR (opens_at IS NOT NULL AND closes_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS vendor_holidays (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  note VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, holiday_date)
);

CREATE OR REPLACE FUNCTION shop_open_at(p_vendor INTEGER, p_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $fn$
  WITH t AS (
    SELECT l.ts::date AS d, l.ts::time AS tm, EXTRACT(DOW FROM l.ts)::int AS dow
    FROM (SELECT p_at AT TIME ZONE vp.timezone AS ts FROM vendor_profiles vp WHERE vp.id = p_vendor) l
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM vendor_hours h WHERE h.vendor_id = p_vendor) THEN (
      -- Today's window, unless today is a holiday.
      EXISTS (
        SELECT 1 FROM vendor_hours h, t
        WHERE h.vendor_id = p_vendor AND h.day_of_week = t.dow AND NOT h.is_closed
          AND NOT EXISTS (SELECT 1 FROM vendor_holidays x WHERE x.vendor_id = p_vendor AND x.holiday_date = t.d)
          AND (h.opens_at = h.closes_at
               OR (h.opens_at < h.closes_at AND t.tm >= h.opens_at AND t.tm < h.closes_at)
               OR (h.opens_at > h.closes_at AND t.tm >= h.opens_at)))
      -- Or yesterday's window running past midnight.
      OR EXISTS (
        SELECT 1 FROM vendor_hours h, t
        WHERE h.vendor_id = p_vendor AND h.day_of_week = (t.dow + 6) % 7 AND NOT h.is_closed
          AND NOT EXISTS (SELECT 1 FROM vendor_holidays x WHERE x.vendor_id = p_vendor AND x.holiday_date = t.d - 1)
          AND h.opens_at > h.closes_at AND t.tm < h.closes_at))
    WHEN EXISTS (SELECT 1 FROM vendor_holidays x, t WHERE x.vendor_id = p_vendor AND x.holiday_date = t.d) THEN false
    ELSE (
      SELECT CASE
        WHEN dr.opens_at IS NULL OR dr.closes_at IS NULL THEN NULL
        WHEN dr.opens_at = dr.closes_at THEN true
        WHEN dr.opens_at < dr.closes_at THEN t.tm >= dr.opens_at AND t.tm < dr.closes_at
        ELSE t.tm >= dr.opens_at OR t.tm < dr.closes_at
      END
      FROM t LEFT JOIN vendor_delivery_rules dr ON dr.vendor_id = p_vendor)
  END
$fn$;

CREATE INDEX IF NOT EXISTS idx_vendor_holidays_vendor_date ON vendor_holidays (vendor_id, holiday_date);

-- ===== SHOP FOLLOWS (SB4) =====
-- Customers follow (favourite) shops. notify_offers is the customer's opt-in
-- to hear about a followed shop's new offers (sent from SB8); it is off unless
-- they switch it on, and notify_offers_at records when they did. A follow of a
-- shop that is later suspended stays, but only approved shops are listed.
-- Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB4).
CREATE TABLE IF NOT EXISTS shop_follows (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  notify_offers BOOLEAN NOT NULL DEFAULT false,
  notify_offers_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_follows_vendor ON shop_follows (vendor_id, created_at DESC);

-- ===== SHOP VISITS (SB5) =====
-- Shop-page visits for "Most visited", "Trending" and the shop's own count.
-- One row per visitor per shop per India day: 'u:<user id>' when signed in,
-- else 's:<app session id>' (a guest who signs in the same day isn't counted
-- twice). Each new row adds 1 to shop_visit_daily, the roll-up that sorts read.
-- Not counted: the shop's own owner, admins, bots, views that came from an ad
-- tap (paid placement never moves these lists), more than 60 shops per
-- visitor per day, and views of shops that aren't approved. Visitor rows are
-- only needed for de-duplication, so they are pruned after 35 days; the
-- daily totals stay. Rules in services/shopVisits.js.
-- Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB5).
CREATE TABLE IF NOT EXISTS shop_views (
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  visitor VARCHAR(70) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, day, visitor)
);
CREATE INDEX IF NOT EXISTS idx_shop_views_visitor_day ON shop_views (visitor, day);
CREATE INDEX IF NOT EXISTS idx_shop_views_day ON shop_views (day);

CREATE TABLE IF NOT EXISTS shop_visit_daily (
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  visitors INTEGER NOT NULL DEFAULT 0 CHECK (visitors >= 0),
  PRIMARY KEY (vendor_id, day)
);
CREATE INDEX IF NOT EXISTS idx_shop_visit_daily_day ON shop_visit_daily (day);
-- ===== SHOP REPORTS (SB7) =====
-- Customers report wrong shop details (closed for good, wrong hours, address,
-- phone, map pin, category, not a real shop, other). Admins work the queue
-- under Vendors: resolved (the details were fixed) or dismissed (they were
-- right). The reporter is told either way; the admin's note stays internal.
-- One open report per customer per shop; at most 10 new reports a day per
-- customer. Rules in services/shopReports.js.
-- Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB7).
CREATE TABLE IF NOT EXISTS shop_reports (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason VARCHAR(20) NOT NULL CHECK (reason IN (
    'closed_permanently', 'wrong_hours', 'wrong_address', 'wrong_phone', 'wrong_location',
    'wrong_category', 'not_real', 'other')),
  note VARCHAR(500),
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution_note VARCHAR(500),
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_reports_one_open ON shop_reports (vendor_id, user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_shop_reports_queue ON shop_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_reports_user ON shop_reports (user_id, created_at DESC);
-- ===== NOTIFICATION PREFERENCES (SB8) =====
-- What each customer wants to hear about (topic) and where (channel). No row
-- means the topic's default (services/notificationPrefs.js). Switching a
-- channel on records consent_at; off keeps the row with enabled = false.
-- Order updates in the app can't be switched off (they are the order itself).
-- WhatsApp consent stays on users.whatsapp_opt_in (the bot's START / STOP).
-- shop_offer_alerts remembers which offers were already announced, so a shop
-- pausing and resuming a coupon doesn't alert its followers twice.
-- Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB8).
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic VARCHAR(20) NOT NULL CHECK (topic IN ('order_updates', 'shop_offers', 'price_drops')),
  channel VARCHAR(10) NOT NULL CHECK (channel IN ('in_app', 'push')),
  enabled BOOLEAN NOT NULL,
  consent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic, channel)
);

CREATE TABLE IF NOT EXISTS shop_offer_alerts (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  offer_key VARCHAR(60) NOT NULL,
  title VARCHAR(160) NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, offer_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_type_time ON notifications (user_id, type, created_at DESC);

-- ===== PUBLIC OFFERS (SB6) =====
-- Shop coupons a customer can find (the offers hub) and the rules they keep.
-- is_public: the shop lists the coupon in the hub (off by default, so every
-- existing coupon stays as private as it was). starts_at / max_uses /
-- per_user_limit / new_customers_only are checked at validation and checkout.
-- A 'free_delivery' coupon takes off exactly the shop's delivery charge.
-- Uses are counted from orders (coupon_id, not cancelled), never stored.
-- Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB6).
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS title VARCHAR(80);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS max_uses INTEGER;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS per_user_limit INTEGER;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS new_customers_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_discount_type_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_discount_type_check CHECK (discount_type IN ('flat', 'percentage', 'free_delivery'));
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_max_uses_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_max_uses_check CHECK (max_uses IS NULL OR max_uses > 0);
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_per_user_limit_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_per_user_limit_check CHECK (per_user_limit IS NULL OR per_user_limit > 0);
CREATE INDEX IF NOT EXISTS idx_coupons_public ON coupons (expires_at) WHERE is_public AND is_active;
CREATE INDEX IF NOT EXISTS idx_orders_coupon ON orders (coupon_id) WHERE coupon_id IS NOT NULL;
-- A free-delivery coupon has no amount of its own (it is the delivery charge).
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_discount_value_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_discount_value_check CHECK (discount_value > 0 OR discount_type = 'free_delivery');

-- ===== SHOP ENQUIRIES (SB9) =====
-- "Ask the shop": a customer asks a shop about stock, a variant, a wholesale
-- quantity, delivery or anything else, optionally about one product, and the
-- shop answers in a thread. Status: open (waiting for the shop), answered
-- (the shop replied last), closed (either side closed it; a new question is a
-- new enquiry). Each side's last read time drives its unread count. An
-- enquiry started from a shop's ad keeps the campaign and counts as that ad's
-- 'enquiry'. Rules in services/shopEnquiries.js.
-- Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB9).
CREATE SEQUENCE IF NOT EXISTS shop_enquiry_ref_seq;

CREATE TABLE IF NOT EXISTS shop_enquiries (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic VARCHAR(10) NOT NULL CHECK (topic IN ('stock', 'variant', 'wholesale', 'delivery', 'other')),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT,
  quantity INTEGER CHECK (quantity IS NULL OR quantity > 0),
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  ad_campaign_id INTEGER REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_from VARCHAR(10) NOT NULL DEFAULT 'customer' CHECK (last_message_from IN ('customer', 'vendor')),
  customer_read_at TIMESTAMPTZ,
  vendor_read_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  closed_by VARCHAR(10) CHECK (closed_by IS NULL OR closed_by IN ('customer', 'vendor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_enquiries_vendor ON shop_enquiries (vendor_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_enquiries_user ON shop_enquiries (user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS shop_enquiry_messages (
  id SERIAL PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES shop_enquiries(id) ON DELETE CASCADE,
  author_role VARCHAR(10) NOT NULL CHECK (author_role IN ('customer', 'vendor')),
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body VARCHAR(2000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_enquiry_messages_enquiry ON shop_enquiry_messages (enquiry_id, created_at);

-- ===== AD FIXES (SB10) =====
-- Two fixes to the ad results (Phase 54):
-- 1. An order credited to an ad and then refunded on a return no longer counts:
--    the ad commission the shop paid on it is credited back (a negative
--    vendor_charges row, paid in its next settlement) and the campaign's daily
--    results drop the order. A partial refund gives back that share. Reversals
--    also happen when the tap that brought the order is marked invalid (below).
-- 2. Repeated taps on one ad from one session or one network address in a day
--    are listed for the admin, who can mark them invalid ("don't bill"): they
--    leave the shop's click count and can't credit an order to the ad.
-- The address is kept only as a salted hash (ip_hash). Rules in
-- services/adFixes.js. Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB10).
ALTER TABLE ad_events ADD COLUMN IF NOT EXISTS ip_hash VARCHAR(16);
ALTER TABLE ad_events ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMPTZ;
ALTER TABLE ad_events ADD COLUMN IF NOT EXISTS invalid_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ad_events ADD COLUMN IF NOT EXISTS invalid_note TEXT;
CREATE INDEX IF NOT EXISTS idx_ad_events_click_day ON ad_events (campaign_id, occurred_at) WHERE event = 'click';

ALTER TABLE ad_attributions ADD COLUMN IF NOT EXISTS reversed_value_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ad_attributions ADD COLUMN IF NOT EXISTS reversed_commission_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ad_attribution_reversals (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES ad_attributions(order_id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  reason VARCHAR(15) NOT NULL CHECK (reason IN ('returned', 'invalid_click')),
  return_id INTEGER REFERENCES order_returns(id) ON DELETE SET NULL,
  value_cents INTEGER NOT NULL CHECK (value_cents >= 0),
  commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
  vendor_charge_id INTEGER REFERENCES vendor_charges(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_attribution_reversals_order ON ad_attribution_reversals (order_id);

-- The credit back to the shop, and its line in the ad money ledger.
ALTER TABLE vendor_charges DROP CONSTRAINT IF EXISTS vendor_charges_kind_check;
ALTER TABLE vendor_charges ADD CONSTRAINT vendor_charges_kind_check
  CHECK (kind IN ('advertising', 'ad_refund', 'ad_commission', 'ad_reversal'));
ALTER TABLE ad_ledger DROP CONSTRAINT IF EXISTS ad_ledger_entry_check;
ALTER TABLE ad_ledger ADD CONSTRAINT ad_ledger_entry_check
  CHECK (entry IN ('ad_revenue', 'ad_tax', 'ad_discount', 'ad_refund', 'ad_tax_refund', 'ad_commission', 'ad_reversal'));
-- ===== PUBLIC OFFER MODERATION (SB6b) =====
-- Admin → Offers & Coupons → Shop offers: an admin can take a shop's public
-- coupon out of the Gloaro Mart offers list (misleading, wrong, abusive) with a
-- reason the shop sees. A hidden coupon is not listed, not announced to
-- followers, and the shop can't list it again until the admin shows it; its
-- code still works for anyone who has it, like a private coupon. Rules in
-- services/offerModeration.js. Plan: G_mart docs/SHOPS_PROMOTIONS_PLAN.md (SB6).
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS hidden_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_coupons_public_shop ON coupons (created_at DESC) WHERE vendor_id IS NOT NULL AND (is_public OR hidden_at IS NOT NULL);
-- ===== REWARD POINTS (SB11) =====
-- Customers earn points on what they pay for items and spend them as a
-- discount at checkout. Gloaro Mart funds the discount: the shop is paid as if
-- the customer had paid it (settlements.grossFor, creditWalletForOrder).
-- Earned points are 'pending' until the order is delivered, then 'credited';
-- a cancelled order voids them. Rules in services/rewards.js. Plan: G_mart
-- docs/WORK_PLAN.md (RW).
CREATE TABLE IF NOT EXISTS reward_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- Earn [earn_points] for every [earn_per_rupees] paid for items.
  earn_points INTEGER NOT NULL DEFAULT 1 CHECK (earn_points BETWEEN 0 AND 1000),
  earn_per_rupees INTEGER NOT NULL DEFAULT 10 CHECK (earn_per_rupees BETWEEN 1 AND 100000),
  -- [points_per_rupee] points take ₹1 off.
  points_per_rupee INTEGER NOT NULL DEFAULT 10 CHECK (points_per_rupee BETWEEN 1 AND 1000),
  -- Points pay at most this share of the items (after coupons and campaigns).
  max_redeem_percent INTEGER NOT NULL DEFAULT 20 CHECK (max_redeem_percent BETWEEN 0 AND 100),
  min_redeem_points INTEGER NOT NULL DEFAULT 10 CHECK (min_redeem_points >= 0),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO reward_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS reward_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_points INTEGER NOT NULL DEFAULT 0 CHECK (balance_points >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only, except an 'earn' row's status (pending → credited | void).
--   earn          +points on an order (items: the per-product split)
--   redeem        -points spent on an order at checkout
--   redeem_refund +points spent on an order that was cancelled or refunded
--   earn_reversal -points taken back when a delivered order is refunded on a return
--   adjustment    ±points by an admin
CREATE TABLE IF NOT EXISTS reward_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  return_id INTEGER REFERENCES order_returns(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('earn', 'redeem', 'redeem_refund', 'earn_reversal', 'adjustment')),
  status TEXT NOT NULL DEFAULT 'credited' CHECK (status IN ('pending', 'credited', 'void')),
  -- Signed: what the row does to the balance once credited.
  points INTEGER NOT NULL CHECK (points <> 0),
  balance_after INTEGER,
  value_cents INTEGER NOT NULL DEFAULT 0,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reward_txns_user ON reward_transactions (user_id, created_at DESC, id DESC);
-- An order earns and spends once; a cancellation (return_id NULL) or a return gives back once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_txns_one_earn ON reward_transactions (order_id) WHERE type = 'earn';
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_txns_one_redeem ON reward_transactions (order_id) WHERE type = 'redeem';
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_txns_one_refund
  ON reward_transactions (order_id, type, COALESCE(return_id, 0)) WHERE type IN ('redeem_refund', 'earn_reversal') AND order_id IS NOT NULL;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_redeemed INTEGER NOT NULL DEFAULT 0;
-- Part of discount_cents (so totals add up as before), funded by Gloaro Mart.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_discount_cents INTEGER NOT NULL DEFAULT 0;

-- ===== PHONE SIGN-UP =====
-- Sign-up is by mobile number: the number is checked with an OTP before the
-- account exists, then a password is set. No username; email is optional
-- (an account without one gets a placeholder like the WhatsApp bot's).
CREATE TABLE IF NOT EXISTS signup_otps (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL CHECK (phone ~ '^[0-9]{10}$'),
  role TEXT NOT NULL CHECK (role IN ('customer', 'vendor')),
  otp_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_otps_phone_idx ON signup_otps (phone, role, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gender_check;
ALTER TABLE users ADD CONSTRAINT users_gender_check CHECK (gender IN ('male', 'female', 'other'));
-- The code typed at sign-up, kept as typed; no reward is tied to it yet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code_used TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- ===== VENDOR REGISTRATION & KYC (VK1) =====
-- Vendor sign-up asks for the business (legal form, what it sells, where it
-- is) and then the documents: a government ID, a photo of the shop and the
-- owner's signature, confirmed with an OTP to the registered mobile. Only
-- the last four characters of an ID number are stored; the reviewer reads
-- the full number off the uploaded photo.
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE vendor_profiles DROP CONSTRAINT IF EXISTS vendor_profiles_entity_type_check;
ALTER TABLE vendor_profiles ADD CONSTRAINT vendor_profiles_entity_type_check
  CHECK (entity_type IN ('proprietorship', 'partnership', 'llp', 'private_limited', 'other'));
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS shop_category TEXT;
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS landmark TEXT;
-- When the vendor last sent the documents from the app; null until then.
ALTER TABLE vendor_profiles ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ;

ALTER TABLE vendor_documents DROP CONSTRAINT IF EXISTS vendor_documents_doc_type_check;
ALTER TABLE vendor_documents ADD CONSTRAINT vendor_documents_doc_type_check
  CHECK (doc_type IN ('gstin', 'pan', 'bank', 'fssai', 'other',
                      'aadhaar', 'voter_id', 'driving_licence', 'shop_photo', 'signature'));

-- The code that confirms a KYC submission, sent to the vendor's own number.
CREATE TABLE IF NOT EXISTS kyc_otps (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kyc_otps_user_idx ON kyc_otps (user_id, created_at DESC);

-- ===== SHIPPING OUTSIDE THE SERVICE AREA (SH1) =====
-- A customer may order from a shop in another district or state. Inside the
-- shop's service area the order is a local delivery as before; outside it the
-- shop ships by courier, at its own outstation charge and an ETA in days,
-- unless it has turned shipping off (fresh food, say). On by default, so a
-- Madurai customer can buy from a Coimbatore shop without the shop doing
-- anything.
ALTER TABLE vendor_delivery_rules ADD COLUMN IF NOT EXISTS ships_outside_area BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE vendor_delivery_rules ADD COLUMN IF NOT EXISTS outstation_charge_cents INTEGER NOT NULL DEFAULT 6000;
ALTER TABLE vendor_delivery_rules ADD COLUMN IF NOT EXISTS outstation_eta_days INTEGER NOT NULL DEFAULT 4;
ALTER TABLE vendor_delivery_rules DROP CONSTRAINT IF EXISTS vendor_delivery_rules_outstation_check;
ALTER TABLE vendor_delivery_rules ADD CONSTRAINT vendor_delivery_rules_outstation_check
  CHECK (outstation_charge_cents >= 0 AND outstation_eta_days BETWEEN 1 AND 30);

-- ===== HOME CHIP PICTURES (HC1) =====
-- The picture on each quick chip under the app's home search bar (Deals, B2B,
-- Near Me, Mart, Categories), set from General Settings. Keys are the chip
-- names, values are /uploads/settings/... paths. A chip with no entry shows
-- the picture built into the app.
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS home_chip_images JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ===== APP LANGUAGES (LG1) =====
-- The languages the customer app offers (English, Tamil, Hindi) and the words
-- on its screens. The app ships its own copy of every string; rows here are
-- the admin's wording, which the app downloads and prefers, so a translation
-- is fixed without a new release. English can't be switched off. One language
-- is the default for someone who has never picked one.
CREATE TABLE IF NOT EXISTS app_languages (
  code VARCHAR(5) PRIMARY KEY,
  name TEXT NOT NULL,
  native_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  is_default BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (code <> 'en' OR enabled),
  CHECK (NOT is_default OR enabled)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_languages_one_default ON app_languages (is_default) WHERE is_default;
INSERT INTO app_languages (code, name, native_name, enabled, is_default, sort_order) VALUES
  ('en', 'English', 'English', true, true, 0),
  ('ta', 'Tamil', 'தமிழ்', true, false, 1),
  ('hi', 'Hindi', 'हिन्दी', true, false, 2)
ON CONFLICT (code) DO NOTHING;

-- Keyed like the app's assets/i18n/<lang>.json ("home.search_hint"). A key
-- with no English row is unknown to the app and refused by the admin API;
-- scripts/seed-app-strings.js adds the app's keys without touching edits.
CREATE TABLE IF NOT EXISTS app_strings (
  key VARCHAR(120) NOT NULL,
  lang VARCHAR(5) NOT NULL REFERENCES app_languages(code) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, lang)
);

-- The language a signed-in customer picked (NULL: never picked; the app then
-- uses the default). Also meant for choosing WhatsApp template languages.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(5) REFERENCES app_languages(code) ON DELETE SET NULL;
