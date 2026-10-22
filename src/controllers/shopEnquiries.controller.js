const shopEnquiries = require('../services/shopEnquiries');

/**
 * "Ask the shop" (SB9). Customers: /api/enquiries. The shop:
 * /api/vendor/enquiries (req.vendorId from the vendor portal's attachVendor).
 */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof shopEnquiries.EnquiryError) return res.status(err.status).json({ message: err.message });
    throw err;
  }
};

const topics = handle(async (req, res) => res.json({ items: shopEnquiries.TOPICS }));

const customerCreate = handle(async (req, res) => {
  res.status(201).json(await shopEnquiries.create(req.user.id, req.body || {}));
});
const customerList = handle(async (req, res) => res.json(await shopEnquiries.list('customer', req.user.id, req.query)));
const customerGet = handle(async (req, res) => res.json(await shopEnquiries.open(req.params.id, 'customer', req.user.id)));
const customerReply = handle(async (req, res) => {
  res.status(201).json(await shopEnquiries.reply(req.params.id, 'customer', req.user.id, req.user.id, req.body?.message));
});
const customerClose = handle(async (req, res) => res.json(await shopEnquiries.close(req.params.id, 'customer', req.user.id)));

const vendorList = handle(async (req, res) => res.json(await shopEnquiries.list('vendor', req.vendorId, req.query)));
const vendorGet = handle(async (req, res) => res.json(await shopEnquiries.open(req.params.id, 'vendor', req.vendorId)));
const vendorReply = handle(async (req, res) => {
  res.status(201).json(await shopEnquiries.reply(req.params.id, 'vendor', req.vendorId, req.user.id, req.body?.message));
});
const vendorClose = handle(async (req, res) => res.json(await shopEnquiries.close(req.params.id, 'vendor', req.vendorId)));

module.exports = {
  topics,
  customerCreate,
  customerList,
  customerGet,
  customerReply,
  customerClose,
  vendorList,
  vendorGet,
  vendorReply,
  vendorClose,
};
