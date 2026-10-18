const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const support = require('../controllers/support.controller');
const { uploadTo } = require('../controllers/upload.controller');

/** Help & Support for customers and vendors: their own tickets only. */
const router = express.Router();
router.use(requireAuth, requireRole('customer', 'vendor'));

router.param('id', (req, res, next, value) => (/^\d+$/.test(value) ? next() : res.status(404).json({ message: 'Not found' })));

// Returns { path } to send in a message's attachments array.
router.post('/attachments', uploadTo('support'));
router.get('/tickets', support.listMyTickets);
router.post('/tickets', support.createTicket);
router.get('/tickets/:id', support.getMyTicket);
router.post('/tickets/:id/messages', support.replyToMyTicket);
router.post('/tickets/:id/resolve', support.resolveMyTicket);

module.exports = router;
