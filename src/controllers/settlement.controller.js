const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const settlements = require('../services/settlements');

/** Admin → Settlements, plus the vendor's own view and bank account. Rules in services/settlements.js. */

const MODULE = 'payments';
const PAGE_SIZE = 25;
const STATUSES = ['draft', 'pending_approval', 'approved', 'paid', 'on_hold', 'failed'];
const UTR = /^[A-Za-z0-9]{6,22}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const SELECT = `
  SELECT s.*, vp.business_name AS vendor_name, vp.gst_number AS vendor_gstin, au.full_name AS approved_by_name,
         b.account_number AS current_account, b.ifsc AS current_ifsc
  FROM settlements s
  JOIN vendor_profiles vp ON vp.id = s.vendor_id
  LEFT JOIN users au ON au.id = s.approved_by
  LEFT JOIN vendor_bank_accounts b ON b.vendor_id = s.vendor_id`;

function toJson(s) {
  // Approved ones show the account they were approved to; open ones show what's on file now.
  const account = s.bank_account_number ?? s.current_account;
  return {
    id: s.id,
    reference: s.reference,
    vendorId: s.vendor_id,
    vendorName: s.vendor_name,
    vendorGstin: s.vendor_gstin,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    orderCount: s.order_count,
    grossCents: s.gross_cents,
    commissionCents: s.commission_cents,
    deductionCents: s.deduction_cents,
    adjustmentCents: s.adjustment_cents,
    netPayableCents: s.net_payable_cents,
    status: s.status,
    holdReason: s.hold_reason ?? s.failure_reason,
    bankAccountMasked: account ? settlements.mask(account) : null,
    bankIfsc: s.bank_ifsc ?? s.current_ifsc ?? null,
    payoutUtr: s.payout_utr,
    paidAt: s.paid_at,
    approvedByName: s.approved_by_name,
    approvedAt: s.approved_at,
    createdAt: s.created_at,
  };
}

async function loadDetail(id, vendorId = null) {
  const params = [Number(id)];
  let where = 's.id = $1';
  if (vendorId) {
    params.push(vendorId);
    where += ' AND s.vendor_id = $2';
  }
  const { rows } = await pool.query(`${SELECT} WHERE ${where}`, params);
  if (!rows[0]) return null;
  const [{ rows: deductions }, { rows: orders }] = await Promise.all([
    pool.query('SELECT * FROM settlement_deductions WHERE settlement_id = $1 ORDER BY id', [rows[0].id]),
    pool.query(
      `SELECT so.*, COALESCE(cg.reference, '#' || so.order_id) AS group_reference
       FROM settlement_orders so JOIN orders o ON o.id = so.order_id LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
       WHERE so.settlement_id = $1 ORDER BY so.delivered_at`,
      [rows[0].id]
    ),
  ]);
  return {
    ...toJson(rows[0]),
    deductions: deductions.map((d) => ({ id: d.id, kind: d.kind, label: d.label, amountCents: d.amount_cents, note: d.note })),
    orders: orders.map((o) => ({
      orderId: o.order_id,
      orderReference: `${o.group_reference} · #${o.order_id}`,
      deliveredAt: o.delivered_at,
      grossCents: o.gross_cents,
      commissionCents: o.commission_cents,
      netCents: o.net_cents,
    })),
  };
}

async function listSettlements(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const conditions = [];
  if (req.query.status) {
    if (!STATUSES.includes(req.query.status)) return res.status(400).json({ message: 'Unknown status' });
    params.push(req.query.status);
    conditions.push(`s.status = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    conditions.push(`(vp.business_name ILIKE $${params.length} OR s.reference ILIKE $${params.length} OR s.payout_utr ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY s.period_start DESC, vp.business_name, s.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(`SELECT COUNT(*)::int AS total FROM settlements s JOIN vendor_profiles vp ON vp.id = s.vendor_id ${where}`, params),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

/** Also closes any finished week first, so the page never waits on the hourly run. */
async function settlementSummary(req, res) {
  await settlements.generateDueSettlements();
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending_approval')::int AS pending,
            COALESCE(SUM(net_payable_cents) FILTER (WHERE status = 'pending_approval'), 0)::bigint AS pending_cents,
            COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
            COALESCE(SUM(net_payable_cents) FILTER (WHERE status = 'approved'), 0)::bigint AS approved_cents,
            COALESCE(SUM(net_payable_cents) FILTER (WHERE status = 'paid'
              AND to_char(paid_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')), 0)::bigint AS paid_month,
            COUNT(*) FILTER (WHERE status = 'on_hold')::int AS on_hold,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM settlements`
  );
  const s = rows[0];
  res.json({
    pendingCount: s.pending,
    pendingCents: Number(s.pending_cents),
    approvedCount: s.approved,
    approvedCents: Number(s.approved_cents),
    paidThisMonthCents: Number(s.paid_month),
    onHoldCount: s.on_hold,
    failedCount: s.failed,
  });
}

async function getSettlement(req, res) {
  const detail = await loadDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'Settlement not found' });
  res.json(detail);
}

const fail = (res, err) => {
  if (err instanceof settlements.SettlementError) return res.status(err.status).json({ message: err.message });
  throw err;
};
const audit = (req, action, entityId, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: MODULE, entityType: 'settlement', entityId, newValue });

/** Body { ids } from the page's batch bar, or a single one via /:id/approve. */
async function approveSettlements(req, res) {
  const ids = req.params.id ? [Number(req.params.id)] : req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(Number.isInteger)) {
    return res.status(400).json({ message: 'Send the settlement ids to approve.' });
  }
  try {
    const approved = await settlements.approve({ ids: [...new Set(ids)], userId: req.user.id });
    for (const s of approved) await audit(req, 'settlement.approved', s.id, { netPayableCents: s.net_payable_cents });
    if (req.params.id) return res.json(await loadDetail(req.params.id));
    res.json({ approved: approved.length });
  } catch (err) {
    fail(res, err);
  }
}

function readReason(req, res) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) {
    res.status(400).json({ message: 'Give a reason (up to 500 characters).' });
    return null;
  }
  return reason;
}

async function holdSettlement(req, res) {
  const reason = readReason(req, res);
  if (!reason) return;
  try {
    await settlements.hold({ id: Number(req.params.id), reason });
    await audit(req, 'settlement.held', req.params.id, { reason });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

async function paySettlement(req, res) {
  const utr = typeof req.body?.utr === 'string' ? req.body.utr.trim().toUpperCase() : '';
  if (!UTR.test(utr)) return res.status(400).json({ message: 'The UTR is 6 to 22 letters and digits, as on the bank statement.' });
  try {
    await settlements.pay({ id: Number(req.params.id), utr });
    await audit(req, 'settlement.paid', req.params.id, { utr });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

/** The bank sent an approved transfer back. */
async function failSettlement(req, res) {
  const reason = readReason(req, res);
  if (!reason) return;
  try {
    await settlements.fail({ id: Number(req.params.id), reason });
    await audit(req, 'settlement.failed', req.params.id, { reason });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

async function addAdjustment(req, res) {
  const amountCents = req.body?.amountCents;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (!Number.isInteger(amountCents) || amountCents === 0) {
    return res.status(400).json({ message: 'amountCents must be a whole number, positive to credit the vendor, negative to take off.' });
  }
  if (!note || note.length > 300) return res.status(400).json({ message: 'Say what the adjustment is for (up to 300 characters).' });
  try {
    await settlements.addAdjustment({ id: Number(req.params.id), amountCents, note, userId: req.user.id });
    await audit(req, 'settlement.adjusted', req.params.id, { amountCents, note });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

async function generateNow(req, res) {
  const created = await settlements.generateDueSettlements();
  res.json({ generated: created.length, settlements: created });
}

/** Validates and saves a vendor's payout account. */
async function saveBankAccount(vendorId, body, userId) {
  const holder = typeof body?.accountHolder === 'string' ? body.accountHolder.trim() : '';
  const number = typeof body?.accountNumber === 'string' ? body.accountNumber.replace(/\s/g, '') : '';
  const ifsc = typeof body?.ifsc === 'string' ? body.ifsc.trim().toUpperCase() : '';
  if (!holder || holder.length > 120) throw new settlements.SettlementError(400, 'Enter the account holder name.');
  if (!/^\d{9,18}$/.test(number)) throw new settlements.SettlementError(400, 'The account number is 9 to 18 digits.');
  if (!IFSC.test(ifsc)) throw new settlements.SettlementError(400, 'The IFSC looks like ABCD0123456.');
  await pool.query(
    `INSERT INTO vendor_bank_accounts (vendor_id, account_holder, account_number, ifsc, bank_name, added_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (vendor_id) DO UPDATE SET account_holder = EXCLUDED.account_holder, account_number = EXCLUDED.account_number,
       ifsc = EXCLUDED.ifsc, bank_name = EXCLUDED.bank_name, added_by = EXCLUDED.added_by, updated_at = now()`,
    [vendorId, holder, number, ifsc, typeof body?.bankName === 'string' ? body.bankName.trim() || null : null, userId]
  );
  return { accountHolder: holder, accountMasked: settlements.mask(number), ifsc };
}

async function adminSaveBankAccount(req, res) {
  try {
    const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE id = $1', [Number(req.params.vendorId)]);
    if (!rows[0]) return res.status(404).json({ message: 'Vendor not found' });
    const saved = await saveBankAccount(rows[0].id, req.body, req.user.id);
    // Never the full number in the audit trail.
    await recordAudit({ actorUserId: req.user.id, action: 'vendor.bank_account_set', module: MODULE, entityType: 'vendor', entityId: rows[0].id, newValue: saved });
    res.json(saved);
  } catch (err) {
    fail(res, err);
  }
}

// ---------------------------------------------------------- vendor portal

async function vendorGetBankAccount(req, res) {
  const { rows } = await pool.query('SELECT * FROM vendor_bank_accounts WHERE vendor_id = $1', [req.vendorId]);
  const b = rows[0];
  res.json(b ? { accountHolder: b.account_holder, accountMasked: settlements.mask(b.account_number), ifsc: b.ifsc, bankName: b.bank_name } : null);
}

async function vendorSaveBankAccount(req, res) {
  try {
    res.json(await saveBankAccount(req.vendorId, req.body, req.user.id));
  } catch (err) {
    fail(res, err);
  }
}

async function vendorListSettlements(req, res) {
  const { rows } = await pool.query(`${SELECT} WHERE s.vendor_id = $1 ORDER BY s.period_start DESC LIMIT 100`, [req.vendorId]);
  res.json({ items: rows.map(toJson) });
}

async function vendorGetSettlement(req, res) {
  const detail = await loadDetail(req.params.id, req.vendorId);
  if (!detail) return res.status(404).json({ message: 'Settlement not found' });
  res.json(detail);
}

module.exports = {
  listSettlements,
  settlementSummary,
  getSettlement,
  approveSettlements,
  holdSettlement,
  paySettlement,
  failSettlement,
  addAdjustment,
  generateNow,
  adminSaveBankAccount,
  vendorGetBankAccount,
  vendorSaveBankAccount,
  vendorListSettlements,
  vendorGetSettlement,
};
