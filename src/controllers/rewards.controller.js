const pool = require('../config/db');
const rewards = require('../services/rewards');
const { recordAudit } = require('../services/auditLog');

/** Reward points (SB11): the customer's balance and history, and the admin's rules. */

async function getMine(req, res) {
  res.json(await rewards.summary(req.user.id));
}

async function getMyTransactions(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({ transactions: await rewards.history(req.user.id, { limit, offset }) });
}

async function getSettings(req, res) {
  res.json(rewards.settingsJson(await rewards.getSettings()));
}

const FIELDS = {
  earnPoints: ['earn_points', 'Points earned', 0, 1000],
  earnPerRupees: ['earn_per_rupees', 'Rupees per earn', 1, 100000],
  pointsPerRupee: ['points_per_rupee', 'Points per ₹1', 1, 1000],
  maxRedeemPercent: ['max_redeem_percent', 'Most of an order paid with points (%)', 0, 100],
  minRedeemPoints: ['min_redeem_points', 'Fewest points used at once', 0, 1000000],
};

async function updateSettings(req, res) {
  const b = req.body ?? {};
  const set = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return res.status(400).json({ message: 'enabled is on or off.' });
    set.enabled = b.enabled;
  }
  for (const [key, [column, label, min, max]] of Object.entries(FIELDS)) {
    if (b[key] === undefined) continue;
    const n = Number(b[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      return res.status(400).json({ message: `${label} must be a whole number from ${min} to ${max}.` });
    }
    set[column] = n;
  }
  const keys = Object.keys(set);
  if (!keys.length) return res.status(400).json({ message: 'Nothing to change.' });

  const before = await rewards.getSettings();
  await pool.query('INSERT INTO reward_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  const { rows } = await pool.query(
    `UPDATE reward_settings SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')},
       updated_by = $${keys.length + 1}, updated_at = now()
     WHERE id = 1 RETURNING *`,
    [...keys.map((k) => set[k]), req.user.id]
  );
  await recordAudit({
    actorUserId: req.user.id,
    action: 'rewards.settings_updated',
    module: 'rewards',
    entityType: 'reward_settings',
    entityId: 1,
    newValue: set,
    previousValue: Object.fromEntries(keys.map((k) => [k, before[k]])),
  }).catch(() => {});
  res.json(rewards.settingsJson(rows[0]));
}

module.exports = { getMine, getMyTransactions, getSettings, updateSettings };
