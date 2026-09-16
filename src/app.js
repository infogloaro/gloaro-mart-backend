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

app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/vendors", require("./routes/vendor.routes"));
app.use("/api/products", require("./routes/product.routes"));
app.use("/api/nearby", require("./routes/nearby.routes"));
app.use("/api/cart", require("./routes/cart.routes"));
app.use("/api/wishlist", require("./routes/wishlist.routes"));
app.use("/api/orders", require("./routes/order.routes"));
app.use("/api/wallet", require("./routes/wallet.routes"));
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
// Mounted above /api/vendors so the vendor's own portal is a distinct namespace
// from the public vendor profiles under /api/vendors/:id.
app.use("/api/vendor", require("./routes/vendorPortal.routes"));

app.use(errorHandler);

module.exports = app;
