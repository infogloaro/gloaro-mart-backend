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

const invoices = require('../services/serviceInvoices');
/** SV9: the invoice of a completed booking — JSON, or the PDF with ?format=pdf / .pdf. */
const invoice = (side, owner) => handle(async (req, res) => {
  const inv = await invoices.load(req.params.id, side, owner(req));
  if (req.query.format !== 'pdf' && !req.path.endsWith('.pdf')) return res.json(inv);
  const { buffer, filename } = invoices.pdf(inv);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.send(buffer);
});

module.exports = {
  customerInvoice: invoice('customer', (req) => req.user.id),
  vendorInvoice: invoice('vendor', (req) => req.vendorId),
  slots: handle(async (req, res) => res.json(await bookings.slots(req.params.id, req.query.date))),
  availability: handle(async (req, res) => res.json(await bookings.availability(req.params.id, req.query.days))),
  nextSlots: handle(async (req, res) => res.json(await bookings.nextSlots(req.query.ids))),

  customerCreate: handle(async (req, res) => res.status(201).json(await bookings.create(req.user.id, req.body || {}))),
  customerList: handle(async (req, res) => res.json(await bookings.list('customer', req.user.id, req.query))),
  customerGet: handle(async (req, res) => res.json(await bookings.get(req.params.id, 'customer', req.user.id))),
  customerPay: handle(async (req, res) => res.json(await bookings.pay(req.params.id, req.user.id))),
  customerReschedule: handle(async (req, res) => res.json(await bookings.reschedule(req.params.id, req.user.id, req.body || {}))),
  customerCancel: handle(async (req, res) =>
    res.json(await bookings.move(req.params.id, 'customer', req.user.id, req.user.id, 'cancel', req.body?.reason))
  ),

  vendorList: handle(async (req, res) => res.json(await bookings.list('vendor', req.vendorId, req.query))),
  vendorGet: handle(async (req, res) => res.json(await bookings.get(req.params.id, 'vendor', req.vendorId))),
  vendorMove: handle(async (req, res) =>
    res.json(await bookings.move(req.params.id, 'vendor', req.vendorId, req.user.id, req.params.action, req.body?.reason))
  ),
  // SV8: the shop's completed bookings of a month, commission and share.
  vendorEarnings: handle(async (req, res) => res.json(await require('../services/serviceCommissions').vendorEarnings(req.vendorId, req.query))),
  vendorBlocks: handle(async (req, res) => res.json(await bookings.listBlocks(req.vendorId))),
  vendorAddBlock: handle(async (req, res) => res.status(201).json(await bookings.addBlock(req.vendorId, req.body || {}))),
  vendorRemoveBlock: handle(async (req, res) => {
    await bookings.removeBlock(req.vendorId, req.params.id);
    res.status(204).send();
  }),
};
