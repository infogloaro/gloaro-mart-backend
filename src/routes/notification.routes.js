const express = require("express");
const { requireAuth } = require("../middleware/auth");
const notifications = require("../controllers/notification.controller");

const router = express.Router();
router.use(requireAuth);

router.get("/", notifications.listMine);
router.post("/read-all", notifications.markAllRead);
router.patch("/:id/read", notifications.markRead);

module.exports = router;
