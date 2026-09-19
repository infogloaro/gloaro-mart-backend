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
