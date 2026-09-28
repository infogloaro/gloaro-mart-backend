const pool = require('../config/db');
const { providerForMethod } = require('../services/payments');

/**
 * The customer wallet: balance, history and top-ups.
 *
 * Money only ever enters through applyTopupEvent, which runs from the verified
 * payment webhook. Nothing a client sends can credit the wallet — the top-up
 * endpoint only opens a pending request.
 */

const MIN_TOPUP_CENTS = 1000; // ₹10
const MAX_TOPUP_CENTS = 5000000; // ₹50,000

async function getBalance(req, res) {
  const { rows } = await pool.query('SELECT balance_cents FROM customer_wallets WHERE user_id = $1', [req.user.id]);
  // No row simply means nothing has been loaded yet.
  res.json({ balanceCents: rows[0]?.balance_cents ?? 0 });
}

async function getTransactions(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.amount_cents, t.balance_after_cents, t.description, t.created_at
       FROM customer_wallet_transactions t
       JOIN customer_wallets w ON w.id = t.wallet_id
      WHERE w.user_id = $1
      ORDER BY t.created_at DESC, t.id DESC LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  res.json(rows);
}

/**
 * Opens a top-up. Nothing is credited here: the response says where to pay,
 * and the balance moves only when the provider's webhook confirms it.
 */
async function createTopup(req, res) {
  const { amountCents } = req.body || {};
  if (!Number.isInteger(amountCents) || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) {
    return res.status(400).json({
      message: `amountCents must be a whole number between ${MIN_TOPUP_CENTS} and ${MAX_TOPUP_CENTS}`,
    });
  }

  const provider = providerForMethod('upi');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO wallet_topups (user_id, amount_cents, provider) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, amountCents, provider.name]
    );
    const topup = rows[0];
    // The provider takes an attempt-shaped object; the top-up id plays that role.
    const { providerOrderId, redirect } = provider.createAttempt({
      payment: null,
      attempt: { id: `topup_${topup.id}` },
      amountCents,
    });
    await client.query('UPDATE wallet_topups SET provider_order_id = $2 WHERE id = $1', [topup.id, providerOrderId]);
    await client.query('COMMIT');
    res.status(201).json({
      topupId: topup.id,
      status: 'pending',
      amountCents,
      provider: provider.name,
      providerOrderId,
      redirect: redirect ?? null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getTopup(req, res) {
  const { rows } = await pool.query(
    `SELECT id, amount_cents, status, provider, failure_reason, created_at, updated_at
       FROM wallet_topups WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Top-up not found' });
  res.json(rows[0]);
}

/**
 * Applies a verified gateway event to a top-up, inside the webhook's
 * transaction. Returns null when the event is not about a top-up, so the
 * caller can carry on with its own lookup.
 *
 * The top-up row is locked and only a pending one moves, so a replayed or
 * out-of-order event cannot credit twice or undo a settled top-up.
 */
async function applyTopupEvent(client, parsed) {
  if (!parsed.providerPaymentId) return null;
  const { rows } = await client.query(
    `SELECT * FROM wallet_topups
      WHERE provider_order_id = $1 OR provider_payment_id = $1
      FOR UPDATE`,
    [parsed.providerPaymentId]
  );
  const topup = rows[0];
  if (!topup) return null;
  if (topup.status !== 'pending') return { status: 'ignored' };

  if (parsed.event === 'failed' || parsed.event === 'cancelled') {
    const status = parsed.event === 'failed' ? 'failed' : 'cancelled';
    await client.query(
      'UPDATE wallet_topups SET status = $2, failure_reason = $3, updated_at = now() WHERE id = $1',
      [topup.id, status, parsed.failureReason]
    );
    return { status };
  }
  if (parsed.event !== 'captured') return { status: 'ignored' };

  // The gateway must have collected exactly what was asked for. A mismatch is
  // left pending for a human rather than crediting an amount nobody agreed.
  if (parsed.amountCents && parsed.amountCents !== topup.amount_cents) {
    console.error(`[wallet] top-up ${topup.id} amount mismatch: asked ${topup.amount_cents}, got ${parsed.amountCents}`);
    return { status: 'ignored' };
  }

  const { rows: walletRows } = await client.query(
    `INSERT INTO customer_wallets (user_id, balance_cents) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       balance_cents = customer_wallets.balance_cents + EXCLUDED.balance_cents, updated_at = now()
     RETURNING id, balance_cents`,
    [topup.user_id, topup.amount_cents]
  );
  const wallet = walletRows[0];
  await client.query(
    `INSERT INTO customer_wallet_transactions (wallet_id, topup_id, type, amount_cents, balance_after_cents, description)
     VALUES ($1, $2, 'credit', $3, $4, $5)`,
    [wallet.id, topup.id, topup.amount_cents, wallet.balance_cents, 'Wallet top-up']
  );
  await client.query(
    `UPDATE wallet_topups SET status = 'successful', provider_payment_id = $2, updated_at = now() WHERE id = $1`,
    [topup.id, parsed.providerPaymentId]
  );
  return { status: 'successful' };
}

module.exports = { getBalance, getTransactions, createTopup, getTopup, applyTopupEvent };
