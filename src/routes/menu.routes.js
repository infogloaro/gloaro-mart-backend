const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requirePermissionFor } = require('../middleware/rbac');
const menu = require('../controllers/menu.controller');

const router = express.Router();

// Public — the app reads this on launch, before login.
router.get('/', menu.listActiveMenu);

// Admin. These sit on their own router rather than under /api/admin, so they
// were reachable by any admin whatever their role until this guard was added —
// the one module in the panel RBAC did not cover.
const canManageMenu = [requireAuth, requireRole('admin'), requirePermissionFor('app_menu')];

router.get('/admin', canManageMenu, menu.listAllMenu);
router.post('/admin', canManageMenu, menu.createMenuItem);
router.put('/admin/reorder', canManageMenu, menu.reorderMenu);
router.patch('/admin/:id', canManageMenu, menu.updateMenuItem);
router.delete('/admin/:id', canManageMenu, menu.deleteMenuItem);

module.exports = router;
