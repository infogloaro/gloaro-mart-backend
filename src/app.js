const express = require("express");
const cors = require("cors");
const errorHandler = require("./middleware/errorHandler");

const app = express();
app.use(cors());
app.use(
  express.json({
    limit: "8mb",
    // Payment webhooks are signed over the exact bytes sent. Re-serialising the
    // parsed object would reorder keys and change spacing, so the signature
    // would never match — the raw buffer is kept for those handlers.
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Uploaded images: stored in the database (media_files); files saved to disk
// before that are still served from there. Names are generated server-side,
// so a name never changes content and can be cached hard.
app.use("/uploads", require("./controllers/upload.controller").serveUpload);
app.use(
  "/uploads",
  express.static(require("./controllers/upload.controller").UPLOAD_ROOT, {
    maxAge: "30d",
    immutable: true,
    index: false,
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
  }),
);

app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/vendors", require("./routes/vendor.routes"));
app.use("/api/products", require("./routes/product.routes"));
app.use("/api/nearby", require("./routes/nearby.routes"));
app.use("/api/cart", require("./routes/cart.routes"));
app.use("/api/wishlist", require("./routes/wishlist.routes"));
app.use("/api/orders", require("./routes/order.routes"));
app.use("/api/reviews", require("./routes/review.routes"));
app.use("/api/support", require("./routes/support.routes"));
app.use("/api/business", require("./routes/business.routes"));
app.use("/api/wallet", require("./routes/wallet.routes"));
app.use("/api/rewards", require("./routes/rewards.routes"));
app.use("/api/coupons", require("./routes/coupon.routes"));
app.use("/api/org", require("./routes/org.routes"));
app.use("/api/referrals", require("./routes/referral.routes"));
app.use("/api/analytics", require("./routes/analytics.routes"));
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/banners", require("./routes/banner.routes"));
app.use("/api/categories", require("./routes/category.routes"));
app.use("/api/brands", require("./routes/brand.routes"));
app.use("/api/settings", require("./routes/settings.routes"));
app.use("/api/feature-flags", require("./routes/featureFlag.routes"));
app.use("/api/menu", require("./routes/menu.routes"));
app.use("/api/addresses", require("./routes/address.routes"));
app.use("/api/serviceability", require("./routes/serviceability.routes"));
app.use("/api/payments", require("./routes/payment.routes"));
app.use("/api/matching", require("./routes/matching.routes"));
app.use("/api/notifications", require("./routes/notification.routes"));
app.use("/api/webhooks/platforms", require("./routes/platformWebhook.routes"));
app.use("/api/bot", require("./routes/bot.routes"));
app.use("/api/ads", require("./routes/ads.routes"));
app.use("/api/enquiries", require("./routes/enquiry.routes"));
// Public: running discount campaigns, for the shopper app to show.
app.get("/api/campaigns/active", require("./controllers/campaign.controller").publicCampaigns);
// Public: the app's home screen sections, live ones only, in order.
app.get("/api/home/sections", require("./controllers/homeSection.controller").publicSections);
// Public: the enabled channels and campaigns the shopper apps read on start-up.
app.get("/api/platform/public", require("./controllers/platformPublic.controller").publicPlatforms);
// Mounted above /api/vendors so the vendor's own portal is a distinct namespace
// from the public vendor profiles under /api/vendors/:id.
app.use("/api/vendor", require("./routes/vendorPortal.routes"));

// The admin console, served from here so it needs no host of its own:
// https://<backend>/admin. admin_console/ is the gloaro_mart_admin repo built
// with ADMIN_BASE=/admin/ and VITE_API_URL=<this backend> (see its README).
// File names under assets/ change with every build, so they cache for long;
// index.html never does, so a new build shows up on the next visit.
const ADMIN_DIR = require("path").join(__dirname, "..", "admin_console");
app.use("/admin/assets", express.static(require("path").join(ADMIN_DIR, "assets"), { maxAge: "30d", immutable: true }));
app.use("/admin", express.static(ADMIN_DIR, { index: false, maxAge: "1h" }));
app.get(/^\/admin(\/.*)?$/, (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(require("path").join(ADMIN_DIR, "index.html"));
});

app.use(errorHandler);

module.exports = app;
