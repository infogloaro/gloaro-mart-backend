const express = require('express');
const { requireAuth } = require('../middleware/auth');
const referralController = require('../controllers/referral.controller');

const router = express.Router();

router.post('/', requireAuth, referralController.createReferral);
router.get('/chapter/:chapterId', requireAuth, referralController.listByChapter);
router.get('/sent', requireAuth, referralController.listSentByMe);
router.get('/received', requireAuth, referralController.listReceivedByMe);
router.patch('/:id/status', requireAuth, referralController.updateStatus);

module.exports = router;
