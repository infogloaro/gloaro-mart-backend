const express = require("express");
const { optionalAuth } = require("../middleware/auth");
const featureFlags = require("../controllers/featureFlag.controller");

const router = express.Router();
router.get("/enabled", optionalAuth, featureFlags.listEnabledFlags);

module.exports = router;
