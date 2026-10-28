const bookings = require('../services/serviceBookings');

/**
 * Service bookings (NS10). Public: GET /api/services/:id/slots?date=,
 * GET /api/services/:id/availability?days=. Customers: /api/bookings. The
 * shop: /api/vendor/bookings and /api/vendor/booking-blocks.
 */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof bookings.BookingError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

module.exports = {
  slots: handle(async (req, res) => res.json(await bookings.slots(req.params.id, req.query.date))),
  availability: handle(async (req, res) => res.json(await bookings.availability(req.params.id, req.query.days))),

  customerCreate: handle(async (req, res) => res.status(201).json(await bookings.create(req.user.id, req.body || {}))),
  customerList: handle(async (req, res) => res.json(await bookings.list('customer', req.user.id, req.query))),
  customerGet: handle(async (req, res) => res.json(await bookings.get(req.params.id, 'customer', req.user.id))),
  customerCancel: handle(async (req, res) =>
    res.json(await bookings.move(req.params.id, 'customer', req.user.id, req.user.id, 'cancel', req.body?.reason))
  ),

  vendorList: handle(async (req, res) => res.json(await bookings.list('vendor', req.vendorId, req.query))),
  vendorGet: handle(async (req, res) => res.json(await bookings.get(req.params.id, 'vendor', req.vendorId))),
  vendorMove: handle(async (req, res) =>
    res.json(await bookings.move(req.params.id, 'vendor', req.vendorId, req.user.id, req.params.action, req.body?.reason))
  ),
  vendorBlocks: handle(async (req, res) => res.json(await bookings.listBlocks(req.vendorId))),
  vendorAddBlock: handle(async (req, res) => res.status(201).json(await bookings.addBlock(req.vendorId, req.body || {}))),
  vendorRemoveBlock: handle(async (req, res) => {
    await bookings.removeBlock(req.vendorId, req.params.id);
    res.status(204).send();
  }),
};
