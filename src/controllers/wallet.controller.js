const pool = require('../config/db');

async function getOrCreateWallet(vendorId) {
  const { rows } = await pool.query(
    `INSERT INTO vendor_wallets (vendor_id) VALUES ($1)
     ON CONFLICT (vendor_id) DO UPDATE SET vendor_id = EXCLUDED.vendor_id
     RETURNING *`,
    [vendorId]
  );
  return rows[0];
}

// Credits a vendor's wallet when one of their orders is delivered. Safe to call
// more than once for the same order: idx_wallet_txns_one_credit_per_order
// prevents a duplicate 'credit' row, so the balance only ever moves once.
async function creditWalletForOrder(order) {
  const wallet = await getOrCreateWallet(order.vendor_id);
  const newBalance = wallet.balance_cents + order.total_cents;
  const { rows: txnRows } = await pool.query(
    `INSERT INTO wallet_transactions (vendor_wallet_id, order_id, type, amount_cents, balance_after_cents, description)
     VALUES ($1, $2, 'credit', $3, $4, $5)
     ON CONFLICT (order_id) WHERE type = 'credit' DO NOTHING
     RETURNING *`,
    [wallet.id, order.id, order.total_cents, newBalance, `Order #${order.id} delivered`]
  );
  if (txnRows[0]) {
    await pool.query('UPDATE vendor_wallets SET balance_cents = $2, updated_at = now() WHERE id = $1', [
      wallet.id,
      newBalance,
    ]);
  }
}

async function getWallet(req, res) {
  const { rows: vendorRows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [req.user.id]);
  const vendorId = vendorRows[0]?.id;
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  const wallet = await getOrCreateWallet(vendorId);
  res.json(wallet);
}

async function getTransactions(req, res) {
  const { rows: vendorRows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [req.user.id]);
  const vendorId = vendorRows[0]?.id;
  if (!vendorId) return res.status(404).json({ message: 'Vendor profile not found' });
  const wallet = await getOrCreateWallet(vendorId);
  const { rows } = await pool.query(
    'SELECT * FROM wallet_transactions WHERE vendor_wallet_id = $1 ORDER BY created_at DESC LIMIT 100',
    [wallet.id]
  );
  res.json(rows);
}

module.exports = { getWallet, getTransactions, creditWalletForOrder };
