const pool = require('../config/db');

const SCOPES = ['global', 'category', 'vendor'];

/**
 * Most specific scope wins. Kept as an ordering rather than an if/else chain so
 * the same precedence drives both the resolve endpoint and the list ordering —
 * two places deciding "which rule wins" independently is how they drift apart.
 */
const SCOPE_RANK = `CASE p.scope WHEN 'vendor' THEN 0 WHEN 'category' THEN 1 ELSE 2 END`;

// Columns are listed rather than using p.* for one reason: commission_percent
// is NUMERIC, and pg returns NUMERIC as a string ("5.00"), so a client doing
// arithmetic on it silently gets string concatenation. The ::float cast makes
// the API hand back a number, which is what every caller assumes it already is.
const SELECT_PLAN = `
  SELECT p.id, p.scope, p.category_id, p.vendor_id,
         p.commission_percent::float AS commission_percent,
         p.flat_fee_cents, p.is_active, p.notes, p.created_at, p.updated_at,
         c.name AS category_name, vp.business_name AS vendor_name
  FROM commission_plans p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN vendor_profiles vp ON vp.id = p.vendor_id`;

/**
 * Returns an error string, or null when the body is usable.
 *
 * `partial` is set for PATCH, where an absent key means "leave it alone" rather
 * than "clear it" — a required-field check on PATCH would reject every edit
 * that touches only one column.
 */
function validate(body, { partial = false } = {}) {
  const { scope, categoryId, vendorId, commissionPercent, flatFeeCents } = body;

  if (!partial || scope !== undefined) {
    if (!SCOPES.includes(scope)) return `scope must be one of ${SCOPES.join(', ')}`;
    if (scope === 'category' && !Number.isInteger(Number(categoryId))) {
      return 'categoryId is required for a category plan';
    }
    if (scope === 'vendor' && !Number.isInteger(Number(vendorId))) {
      return 'vendorId is required for a vendor plan';
    }
  }

  if (!partial || commissionPercent !== undefined) {
    const pct = Number(commissionPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return 'commissionPercent must be between 0 and 100';
    }
  }

  if (flatFeeCents !== undefined && flatFeeCents !== null) {
    const fee = Number(flatFeeCents);
    if (!Number.isInteger(fee) || fee < 0) return 'flatFeeCents must be a whole number of cents, 0 or more';
  }

  return null;
}

async function listPlans(req, res) {
  const { scope } = req.query;
  const params = [];
  let where = '';
  if (scope) {
    if (!SCOPES.includes(scope)) return res.status(400).json({ message: `scope must be one of ${SCOPES.join(', ')}` });
    params.push(scope);
    where = 'WHERE p.scope = $1';
  }

  const { rows } = await pool.query(
    `${SELECT_PLAN} ${where} ORDER BY ${SCOPE_RANK}, COALESCE(c.name, vp.business_name, '')`,
    params
  );
  res.json(rows);
}

async function createPlan(req, res) {
  const error = validate(req.body || {});
  if (error) return res.status(400).json({ message: error });

  const { scope, categoryId, vendorId, commissionPercent, flatFeeCents, notes } = req.body;

  try {
    const { rows } = await pool.query(
      `INSERT INTO commission_plans (scope, category_id, vendor_id, commission_percent, flat_fee_cents, notes)
       VALUES ($1, $2, $3, $4, COALESCE($5, 0), $6)
       RETURNING id`,
      [
        scope,
        scope === 'category' ? Number(categoryId) : null,
        scope === 'vendor' ? Number(vendorId) : null,
        Number(commissionPercent),
        flatFeeCents == null ? null : Number(flatFeeCents),
        notes ?? null,
      ]
    );
    const { rows: created } = await pool.query(`${SELECT_PLAN} WHERE p.id = $1`, [rows[0].id]);
    res.status(201).json(created[0]);
  } catch (err) {
    // The partial unique indexes are the only guard against two rules for the
    // same target; a check-then-insert would still race two concurrent admins.
    if (err.code === '23505') {
      return res.status(409).json({ message: 'A commission plan already exists for that target.' });
    }
    if (err.code === '23503') {
      return res.status(400).json({ message: 'That category or vendor does not exist.' });
    }
    throw err;
  }
}

async function updatePlan(req, res) {
  const error = validate(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ message: error });

  const { commissionPercent, flatFeeCents, isActive, notes } = req.body || {};

  // Scope and target are deliberately not editable: changing them turns a rule
  // into a different rule, and the audit trail reads better as delete + create.
  const { rows } = await pool.query(
    `UPDATE commission_plans SET
       commission_percent = COALESCE($2, commission_percent),
       flat_fee_cents     = COALESCE($3, flat_fee_cents),
       is_active          = COALESCE($4, is_active),
       notes              = COALESCE($5, notes),
       updated_at         = now()
     WHERE id = $1
     RETURNING id`,
    [
      req.params.id,
      commissionPercent == null ? null : Number(commissionPercent),
      flatFeeCents == null ? null : Number(flatFeeCents),
      typeof isActive === 'boolean' ? isActive : null,
      notes ?? null,
    ]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Commission plan not found' });

  const { rows: updated } = await pool.query(`${SELECT_PLAN} WHERE p.id = $1`, [req.params.id]);
  res.json(updated[0]);
}

async function deletePlan(req, res) {
  const { rows } = await pool.query('SELECT scope FROM commission_plans WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ message: 'Commission plan not found' });

  // Resolution has to terminate somewhere. Without the global rule a vendor
  // with no override has no commission at all, which is worse than a wrong one.
  if (rows[0].scope === 'global') {
    return res.status(400).json({
      message: 'The global plan is the platform fallback and cannot be deleted. Edit its rate instead.',
    });
  }

  await pool.query('DELETE FROM commission_plans WHERE id = $1', [req.params.id]);
  res.status(204).end();
}

/**
 * The rate that actually applies to a given vendor and category.
 *
 * Inactive rules are skipped rather than treated as 0% — deactivating a vendor
 * override means "fall back to the category or global rate", not "this vendor
 * pays nothing".
 */
async function resolvePlan(req, res) {
  const { vendorId, categoryId } = req.query;

  const { rows } = await pool.query(
    `${SELECT_PLAN}
     WHERE p.is_active
       AND (p.scope = 'global'
         OR (p.scope = 'vendor'   AND p.vendor_id = $1)
         OR (p.scope = 'category' AND p.category_id = $2))
     ORDER BY ${SCOPE_RANK}
     LIMIT 1`,
    [vendorId ? Number(vendorId) : null, categoryId ? Number(categoryId) : null]
  );

  if (!rows[0]) {
    return res.status(404).json({ message: 'No active commission plan applies — the global plan may be inactive.' });
  }
  res.json(rows[0]);
}

module.exports = { listPlans, createPlan, updatePlan, deletePlan, resolvePlan };
