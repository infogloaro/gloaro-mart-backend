const express = require('express');
const { requireAuth } = require('../middleware/auth');
const address = require('../controllers/address.controller');

const router = express.Router();

// Every route is scoped to the authenticated customer inside the controller —
// a customer must never be able to read or edit another customer's address.
router.get('/', requireAuth, address.listAddresses);
router.post('/', requireAuth, address.createAddress);
router.patch('/:id/default', requireAuth, address.setDefaultAddress);
router.patch('/:id', requireAuth, address.updateAddress);
router.delete('/:id', requireAuth, address.deleteAddress);

module.exports = router;
