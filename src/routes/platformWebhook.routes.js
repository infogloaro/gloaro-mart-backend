const express = require("express");
const webhook = require("../controllers/platformWebhook.controller");

// Public by design: providers call these. Each request is verified by the
// platform's connector before anything is recorded as received.
const router = express.Router();

router.get("/:slug", webhook.handshake);
router.post("/:slug", webhook.receive);

module.exports = router;
