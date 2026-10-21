const pool = require('../../config/db');

/**
 * The customer's Gloaro wallet (customer_wallets), paid at checkout.
 *
 * Like COD there is no gateway: the money is already on the platform, so the
 * checkout debits the balance inside its own transaction and the payment is
 * captured at once. Refunds go straight back to the same wallet — settleRefund
 * runs inside the refund's transaction so the credit and the refund row can't
 * disagree. Webhooks are rejected: nothing outside this server moves a wallet.
 */
module.exports = {
  name: 'wallet',

  createAttempt() {
    return { providerOrderId: null, redirect: null };
  },

  verifyWebhook() {
    return false;
  },

  parseWebhook() {
    const err = new Error('Wallet payments are not captured by webhook.');
    err.status = 400;
    throw err;
  },

  createRefund() {
    // settleRefund does the actual credit; the refund is settled the moment
    // it is approved, since the money never left the platform.
    return { providerRefundId: null, status: 'successful' };
  },

  /**
   * Puts a refund back on the customer's wallet, in the caller's transaction.
   * The wallet row is created if the customer has none (a wallet payment
   * implies one, but a row deleted by hand must not lose the refund).
   */
  async settleRefund(client, { payment, refund }) {
    const db = client || pool;
    const { rows } = await db.query(
      `INSERT INTO customer_wallets (user_id, balance_cents) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         balance_cents = customer_wallets.balance_cents + EXCLUDED.balance_cents, updated_at = now()
       RETURNING id, balance_cents`,
      [payment.user_id, refund.amount_cents]
    );
    const wallet = rows[0];
    const what = refund.order_id ? `Refund for order #${refund.order_id}` : 'Refund';
    await db.query(
      `INSERT INTO customer_wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, description)
       VALUES ($1, 'credit', $2, $3, $4)`,
      [wallet.id, refund.amount_cents, wallet.balance_cents, refund.reason ? `${what} — ${refund.reason}` : what]
    );
    return wallet;
  },

  /**
   * Takes the order total off the wallet, in the checkout's transaction.
   * Throws 402 when the balance is short; the row is locked by the UPDATE so
   * two checkouts at once can't both spend the same money.
   */
  async debit(client, { userId, amountCents, groupReference }) {
    const { rows } = await client.query(
      `UPDATE customer_wallets SET balance_cents = balance_cents - $2, updated_at = now()
       WHERE user_id = $1 AND balance_cents >= $2
       RETURNING id, balance_cents`,
      [userId, amountCents]
    );
    const wallet = rows[0];
    if (!wallet) {
      const { rows: have } = await client.query('SELECT balance_cents FROM customer_wallets WHERE user_id = $1', [userId]);
      const balance = have[0]?.balance_cents ?? 0;
      const err = new Error(
        `Not enough money in your wallet: it has ₹${(balance / 100).toFixed(2)} and this order is ₹${(amountCents / 100).toFixed(2)}. Add money or choose another way to pay.`
      );
      err.status = 402;
      throw err;
    }
    await client.query(
      `INSERT INTO customer_wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, description)
       VALUES ($1, 'debit', $2, $3, $4)`,
      [wallet.id, amountCents, wallet.balance_cents, `Paid for order ${groupReference}`]
    );
    return wallet;
  },
};
