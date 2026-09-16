const express = require('express');
const { requireAuth } = require('../middleware/auth');
const orgController = require('../controllers/org.controller');

const router = express.Router();

router.get('/states', orgController.listStates);
router.post('/states', requireAuth, orgController.createState);
router.get('/states/:stateId/districts', orgController.listDistricts);
router.post('/districts', requireAuth, orgController.createDistrict);
router.get('/districts/:districtId/chapters', orgController.listChapters);
router.post('/chapters', requireAuth, orgController.createChapter);
router.get('/chapters/:chapterId/members', orgController.listChapterMembers);
router.get('/chapters/:chapterId', orgController.getChapter);

router.get('/membership/me', requireAuth, orgController.getMyMembership);
router.post('/membership', requireAuth, orgController.joinChapter);
router.delete('/membership', requireAuth, orgController.leaveChapter);

module.exports = router;
