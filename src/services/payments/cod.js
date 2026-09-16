/**
 * Cash on delivery.
 *
 * There is no gateway: the customer owes nothing until a courier hands over the
 * goods, and capture is driven by the order reaching 'delivered' rather than by
 * anything arriving over the wire. Every webhook is therefore rejected — a COD
 * payment that could be captured by an HTTP call would be free money.
 */
module.exports = {
  name: 'cod',

  createAttempt() {
    // Nothing to redirect to and nothing to reserve; the attempt exists only so
    // the ledger shows the customer chose COD.
    return { providerOrderId: null, redirect: null };
  },

  verifyWebhook() {
    return false;
  },

  parseWebhook() {
    const err = new Error('COD payments are not captured by webhook.');
    err.status = 400;
    throw err;
  },

  createRefund({ refund }) {
    // Cash back at the door, or a transfer ops make by hand. Either way the
    // money moves outside this system, so the row is raised and left for a
    // human to complete rather than reported as done.
    return { providerRefundId: null, status: 'pending', note: `Refund ${refund.id} to be settled manually` };
  },
};
