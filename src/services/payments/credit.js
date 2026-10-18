/**
 * Business credit (Admin → Business Accounts).
 *
 * Like COD there is no gateway: the business is invoiced and pays later, within
 * its terms, and that money is recorded against the account rather than this
 * payment. Every webhook is rejected — credit settled by an HTTP call would be
 * free goods.
 */
module.exports = {
  name: 'credit',

  createAttempt() {
    return { providerOrderId: null, redirect: null };
  },

  verifyWebhook() {
    return false;
  },

  parseWebhook() {
    const err = new Error('Credit payments are not captured by webhook.');
    err.status = 400;
    throw err;
  },

  createRefund({ refund }) {
    // Nothing was collected per order, so a "refund" on credit is a reduction
    // of what the business owes, settled by hand.
    return { providerRefundId: null, status: 'pending', note: `Refund ${refund.id} to be settled against the credit account` };
  },
};
