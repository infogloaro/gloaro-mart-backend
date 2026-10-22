const express = require("express");
const { requireAuth } = require("../middleware/auth");
const notifications = require("../controllers/notification.controller");

const router = express.Router();
router.use(requireAuth);

router.get("/", notifications.listMine);
router.post("/device-token", notifications.registerDeviceToken);
router.delete("/device-token", notifications.removeDeviceToken);
router.post("/read-all", notifications.markAllRead);
// SB8: what the customer wants to hear about, and where.
router.get("/preferences", notifications.getPreferences);
router.put("/preferences", notifications.updatePreferences);
router.patch("/:id/read", notifications.markRead);

module.exports = router;
