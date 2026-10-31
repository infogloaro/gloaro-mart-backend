const pool = require('../config/db');

/**
 * Weekly vendor settlements (schema SETTLEMENTS, PHASE 42).
 *
 * generateDueSettlements() closes every finished week that has something to
 * settle: delivered orders not yet settled, completed refunds on settled orders
 * not yet deducted, and balances a negative cycle carried forward. It is safe to
 * run any number of times — orders and refunds can only ever be taken once.
 */

const IST = "'Asia/Kolkata'";
const DELIVERED_AT = `COALESCE(
  (SELECT MAX(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'delivered'),
  o.updated_at)`;

class SettlementError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Per-line commission: vendor plan, else the item's category plan, else global; flat fee once per order. */
async function commissionFor(client, order) {
  // A free replacement isn't a sale: no commission on it.
  if (order.replacement_of_order_id) return 0;
  const { rows: plans } = await client.query(
    `SELECT p.scope, p.vendor_id, p.category_id, c.name AS category_name, p.commission_percent::float AS pct, p.flat_fee_cents
     FROM commission_plans p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.is_active AND (p.scope = 'global' OR (p.scope = 'vendor' AND p.vendor_id = $1) OR p.scope = 'category')`,
    [order.vendor_id]
  );
  const vendorPlan = plans.find((p) => p.scope === 'vendor');
  const globalPlan = plans.find((p) => p.scope === 'global') ?? { pct: 0, flat_fee_cents: 0 };
  const { rows: items } = await client.query(
    `SELECT oi.unit_price_cents * oi.quantity AS value, p.category FROM order_items oi
     LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
    [order.id]
  );
  let cents = 0;
  for (const it of items) {
    const categoryPlan = plans.find((p) => p.scope === 'category' && p.category_name?.toLowerCase() === it.category?.toLowerCase());
    const pct = (vendorPlan ?? categoryPlan ?? globalPlan).pct;
    cents += Math.round((Number(it.value) * pct) / 100);
  }
  return cents + (vendorPlan ?? globalPlan).flat_fee_cents;
}

/** What the platform owes the shop for one order: what the customer paid + discounts the platform funded. */
async function grossFor(client, order) {
  const { rows } = await client.query(
    `SELECT COALESCE((SELECT platform_cents FROM order_campaigns WHERE order_id = $1), 0)::int AS campaign_platform,
            (SELECT vendor_id IS NULL FROM coupons WHERE id = $2) AS platform_coupon`,
    [order.id, order.coupon_id]
  );
  // A replacement's "discount" is the whole price, given free; the platform pays only what platform_paid_cents says.
  if (order.replacement_of_order_id) return order.total_cents + order.platform_paid_cents;
  // Reward points (SB11) sit inside discount_cents and are always Gloaro Mart's.
  const pointsPart = order.points_discount_cents || 0;
  const couponPart = order.discount_cents - order.campaign_discount_cents - pointsPart;
  return order.total_cents + rows[0].campaign_platform + pointsPart + (rows[0].platform_coupon ? couponPart : 0);
}

const rupees = (c) => `₹${(c / 100).toFixed(2)}`;

/** Recomputes a settlement's totals from its orders and deductions. */
async function recalc(client, settlementId) {
  await client.query(
    `UPDATE settlements s SET
       order_count = t.n, gross_cents = t.gross, commission_cents = t.commission,
       deduction_cents = d.deductions, adjustment_cents = d.adjustments,
       net_payable_cents = t.gross - t.commission - d.deductions + d.adjustments, updated_at = now()
     FROM (SELECT COUNT(*)::int AS n, COALESCE(SUM(gross_cents), 0)::int AS gross, COALESCE(SUM(commission_cents), 0)::int AS commission
           FROM settlement_orders WHERE settlement_id = $1) t,
          (SELECT COALESCE(SUM(amount_cents) FILTER (WHERE kind <> 'adjustment'), 0)::int AS deductions,
                  COALESCE(-SUM(amount_cents) FILTER (WHERE kind = 'adjustment'), 0)::int AS adjustments
           FROM settlement_deductions WHERE settlement_id = $1) d
     WHERE s.id = $1`,
    [settlementId]
  );
}

async function generateDueSettlements() {
  const { rows: cfgRows } = await pool.query('SELECT * FROM settlement_config WHERE id = 1');
  const cfg = cfgRows[0];
  const thisWeek = `date_trunc('week', now() AT TIME ZONE ${IST})::date`;

  // Every (vendor, finished week) with delivered, unsettled orders.
  const { rows: weeks } = await pool.query(
    `SELECT DISTINCT o.vendor_id, to_char(date_trunc('week', ${DELIVERED_AT} AT TIME ZONE ${IST}), 'YYYY-MM-DD') AS week
     FROM orders o
     WHERE o.status = 'delivered' AND NOT EXISTS (SELECT 1 FROM settlement_orders so WHERE so.order_id = o.id)
       AND date_trunc('week', ${DELIVERED_AT} AT TIME ZONE ${IST})::date < ${thisWeek}
       AND (${DELIVERED_AT} AT TIME ZONE ${IST})::date >= $1
     ORDER BY week, o.vendor_id`,
    [cfg.generate_from]
  );
  // …and finished weeks where only a refund on an already-settled order completed.
  const { rows: refundWeeks } = await pool.query(
    `SELECT DISTINCT o.vendor_id, to_char(date_trunc('week', r.updated_at AT TIME ZONE ${IST}), 'YYYY-MM-DD') AS week
     FROM refunds r JOIN orders o ON o.id = r.order_id
     WHERE r.status = 'completed' AND NOT EXISTS (SELECT 1 FROM settlement_deductions d WHERE d.refund_id = r.id)
       AND EXISTS (SELECT 1 FROM settlement_orders so WHERE so.order_id = o.id)
       AND date_trunc('week', r.updated_at AT TIME ZONE ${IST})::date < ${thisWeek}`
  );
  // …and finished weeks where the shop was charged (or credited) outside its
  // orders — advertising — so a shop with no sales still settles what it owes.
  const { rows: chargeWeeks } = await pool.query(
    `SELECT DISTINCT vendor_id, to_char(date_trunc('week', created_at AT TIME ZONE ${IST}), 'YYYY-MM-DD') AS week
     FROM vendor_charges WHERE settlement_id IS NULL AND date_trunc('week', created_at AT TIME ZONE ${IST})::date < ${thisWeek}`
  );
  const due = new Map();
  for (const w of [...weeks, ...refundWeeks, ...chargeWeeks]) due.set(`${w.vendor_id}:${w.week}`, w);

  const created = [];
  for (const { vendor_id: vendorId, week } of [...due.values()].sort((a, b) => a.week.localeCompare(b.week))) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Plain dates ('2026-10-05'), so the server's own timezone never shifts a cycle.
      // A week whose settlement is already approved or paid is closed: whatever
      // turned up late for it goes into the next finished week that is still open.
      const { rows: target } = await client.query(
        `WITH RECURSIVE w(start) AS (
           SELECT $2::date
           UNION ALL
           SELECT w.start + 7 FROM w
           WHERE w.start + 7 < ${thisWeek} AND EXISTS (
             SELECT 1 FROM settlements s WHERE s.vendor_id = $1 AND s.period_start = w.start
               AND s.status NOT IN ('draft', 'pending_approval', 'on_hold'))
         )
         SELECT to_char(MAX(start), 'YYYY-MM-DD') AS start FROM w`,
        [vendorId, week]
      );
      const start = target[0].start;
      const { rows: existing } = await client.query(
        'SELECT * FROM settlements WHERE vendor_id = $1 AND period_start = $2::date FOR UPDATE',
        [vendorId, start]
      );
      let settlement = existing[0];
      if (settlement && !['draft', 'pending_approval', 'on_hold'].includes(settlement.status)) {
        // Every week up to now is closed; it waits for this week to finish.
        await client.query('ROLLBACK');
        continue;
      }
      if (!settlement) {
        const { rows: seq } = await client.query("SELECT nextval('settlement_ref_seq') AS n");
        const { rows } = await client.query(
          `INSERT INTO settlements (reference, vendor_id, period_start, period_end)
           VALUES ($1, $2, $3::date, $3::date + 6) RETURNING *`,
          [`STL-${start.slice(0, 4)}-${String(seq[0].n).padStart(5, '0')}`, vendorId, start]
        );
        settlement = rows[0];
      }

      const { rows: orders } = await client.query(
        `SELECT o.*, ${DELIVERED_AT} AS delivered_at FROM orders o
         WHERE o.vendor_id = $1 AND o.status = 'delivered'
           AND NOT EXISTS (SELECT 1 FROM settlement_orders so WHERE so.order_id = o.id)
           AND date_trunc('week', ${DELIVERED_AT} AT TIME ZONE ${IST})::date <= $2::date
           AND (${DELIVERED_AT} AT TIME ZONE ${IST})::date >= $3
         FOR UPDATE OF o`,
        [vendorId, start, cfg.generate_from]
      );
      let gross = 0;
      let taxable = 0;
      for (const o of orders) {
        const g = await grossFor(client, o);
        const c = await commissionFor(client, o);
        gross += g;
        // TCS is on taxable sales; a free replacement isn't one.
        if (!o.replacement_of_order_id) taxable += o.subtotal_cents;
        await client.query(
          `INSERT INTO settlement_orders (settlement_id, order_id, delivered_at, gross_cents, commission_cents, net_cents)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [settlement.id, o.id, o.delivered_at, g, c, g - c]
        );
      }

      // Taxes withheld on this cycle's sales.
      const tds = Math.round((gross * Number(cfg.tds_percent)) / 100);
      const tcs = Math.round((taxable * Number(cfg.tcs_percent)) / 100);
      if (tds > 0) {
        await client.query(
          `INSERT INTO settlement_deductions (settlement_id, kind, label, amount_cents, note) VALUES ($1, 'tds', $2, $3, $4)`,
          [settlement.id, `TDS ${Number(cfg.tds_percent)}% (income tax, s.194-O)`, tds, `On gross ${rupees(gross)}`]
        );
      }
      if (tcs > 0) {
        await client.query(
          `INSERT INTO settlement_deductions (settlement_id, kind, label, amount_cents, note) VALUES ($1, 'tcs', $2, $3, $4)`,
          [settlement.id, `TCS ${Number(cfg.tcs_percent)}% (GST, s.52)`, tcs, `On taxable value ${rupees(taxable)}`]
        );
      }

      // Refunds paid back to customers on this shop's settled orders.
      const { rows: refunds } = await client.query(
        `SELECT r.* FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE o.vendor_id = $1 AND r.status = 'completed'
           AND NOT EXISTS (SELECT 1 FROM settlement_deductions d WHERE d.refund_id = r.id)
           AND EXISTS (SELECT 1 FROM settlement_orders so WHERE so.order_id = o.id)
           AND date_trunc('week', r.updated_at AT TIME ZONE ${IST})::date <= $2::date
         FOR UPDATE OF r`,
        [vendorId, start]
      );
      for (const r of refunds) {
        await client.query(
          `INSERT INTO settlement_deductions (settlement_id, kind, label, amount_cents, note, refund_id)
           VALUES ($1, 'refund', $2, $3, $4, $5)`,
          [settlement.id, `Refund on order #${r.order_id}`, r.amount_cents, r.reason, r.id]
        );
      }

      // Charges and credits outside orders (advertising, ad refunds), each once.
      const { rows: charges } = await client.query(
        `SELECT * FROM vendor_charges WHERE vendor_id = $1 AND settlement_id IS NULL
           AND date_trunc('week', created_at AT TIME ZONE ${IST})::date <= $2::date
         ORDER BY id FOR UPDATE`,
        [vendorId, start]
      );
      for (const ch of charges) {
        // A charge is a deduction; a credit is an adjustment paid to the shop
        // (adjustments are stored as amounts taken, so a credit is negative).
        await client.query(
          `INSERT INTO settlement_deductions (settlement_id, kind, label, amount_cents, note, vendor_charge_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [settlement.id, ch.amount_cents > 0 ? 'advertising' : 'adjustment', ch.label, ch.amount_cents, ch.kind, ch.id]
        );
        await client.query('UPDATE vendor_charges SET settlement_id = $2 WHERE id = $1', [ch.id, settlement.id]);
      }

      // A balance an earlier negative cycle left behind.
      const { rows: carried } = await client.query(
        `SELECT * FROM settlements WHERE vendor_id = $1 AND status = 'draft' AND net_payable_cents < 0 AND id <> $2
           AND carried_into IS NULL FOR UPDATE`,
        [vendorId, settlement.id]
      );
      for (const c of carried) {
        await client.query(
          `INSERT INTO settlement_deductions (settlement_id, kind, label, amount_cents, note) VALUES ($1, 'adjustment', $2, $3, $4)`,
          [settlement.id, `Carried forward from ${c.reference}`, -c.net_payable_cents, 'Balance owed from an earlier cycle']
        );
        await client.query('UPDATE settlements SET carried_into = $2 WHERE id = $1', [c.id, settlement.id]);
      }

      await recalc(client, settlement.id);
      const { rows: after } = await client.query('SELECT * FROM settlements WHERE id = $1', [settlement.id]);
      // Nothing to pay: kept as a draft whose balance goes to the next cycle.
      const status = after[0].net_payable_cents <= 0 ? 'draft' : after[0].status === 'draft' ? 'pending_approval' : after[0].status;
      await client.query(
        `UPDATE settlements SET status = $2::varchar, hold_reason = CASE WHEN $2::varchar = 'draft' THEN $3 ELSE hold_reason END WHERE id = $1`,
        [settlement.id, status, 'Nothing to pay this cycle — any balance is carried to the next one.']
      );
      await client.query('COMMIT');
      created.push({ id: settlement.id, vendorId, periodStart: start, status });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[settlements] vendor ${vendorId} week ${week}: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return created;
}

const mask = (n) => `•••• ${String(n).slice(-4)}`;

async function notifyVendor(client, vendorId, title, body) {
  await client.query(
    `INSERT INTO notifications (user_id, type, title, body) SELECT user_id, 'settlement', $2, $3 FROM vendor_profiles WHERE id = $1`,
    [vendorId, title, body]
  );
}

/** Approves several at once, all or none, so a batch never half-goes. */
async function approve({ ids, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT s.*, b.account_number, b.ifsc, vp.business_name FROM settlements s
       JOIN vendor_profiles vp ON vp.id = s.vendor_id
       LEFT JOIN vendor_bank_accounts b ON b.vendor_id = s.vendor_id
       WHERE s.id = ANY($1) FOR UPDATE OF s`,
      [ids]
    );
    if (rows.length !== ids.length) throw new SettlementError(404, 'One of the settlements was not found.');
    for (const s of rows) {
      if (!['pending_approval', 'on_hold'].includes(s.status)) throw new SettlementError(409, `${s.reference} is ${s.status.replace('_', ' ')}, not awaiting approval.`);
      if (s.net_payable_cents <= 0) throw new SettlementError(409, `${s.reference} has nothing to pay.`);
      if (!s.account_number) throw new SettlementError(409, `${s.business_name} has no bank account on file.`);
    }
    for (const s of rows) {
      await client.query(
        `UPDATE settlements SET status = 'approved', approved_by = $2, approved_at = now(), hold_reason = NULL,
           bank_account_number = $3, bank_account_masked = $4, bank_ifsc = $5, updated_at = now()
         WHERE id = $1`,
        [s.id, userId, s.account_number, mask(s.account_number), s.ifsc]
      );
      await notifyVendor(client, s.vendor_id, 'Payout approved', `${s.reference}: ${rupees(s.net_payable_cents)} will be transferred to ${mask(s.account_number)}.`);
    }
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Moves one settlement from one of `from` to `to`, with the extra columns. */
async function transition(id, { from, to, set = {}, notify }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM settlements WHERE id = $1 FOR UPDATE', [id]);
    const s = rows[0];
    if (!s) throw new SettlementError(404, 'Settlement not found');
    if (!from.includes(s.status)) throw new SettlementError(409, `This settlement is ${s.status.replace('_', ' ')}.`);
    const cols = Object.keys(set);
    await client.query(
      `UPDATE settlements SET status = $2${cols.map((c, i) => `, ${c} = $${i + 3}`).join('')}, updated_at = now() WHERE id = $1`,
      [id, to, ...cols.map((c) => set[c])]
    );
    if (notify) await notifyVendor(client, s.vendor_id, notify.title, notify.body(s));
    await client.query('COMMIT');
    return s;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') throw new SettlementError(409, 'That UTR is already recorded on another payout.');
    throw err;
  } finally {
    client.release();
  }
}

const hold = ({ id, reason }) =>
  transition(id, {
    from: ['pending_approval', 'approved'],
    to: 'on_hold',
    set: { hold_reason: reason },
    notify: { title: 'Payout on hold', body: (s) => `${s.reference} is on hold: ${reason}` },
  });

const pay = ({ id, utr }) =>
  transition(id, {
    from: ['approved', 'failed'],
    to: 'paid',
    set: { payout_utr: utr, paid_at: new Date(), failure_reason: null },
    notify: { title: 'Payout sent', body: (s) => `${s.reference}: ${rupees(s.net_payable_cents)} transferred (UTR ${utr}).` },
  });

const fail = ({ id, reason }) =>
  transition(id, {
    from: ['approved'],
    to: 'failed',
    set: { failure_reason: reason },
    notify: { title: 'Payout failed', body: (s) => `${s.reference} could not be transferred: ${reason}` },
  });

/** A manual correction before approval. Positive credits the vendor, negative takes off. */
async function addAdjustment({ id, amountCents, note, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM settlements WHERE id = $1 FOR UPDATE', [id]);
    const s = rows[0];
    if (!s) throw new SettlementError(404, 'Settlement not found');
    if (!['draft', 'pending_approval', 'on_hold'].includes(s.status)) {
      throw new SettlementError(409, 'Only a settlement not yet approved can be adjusted; put corrections on the next cycle.');
    }
    await client.query(
      `INSERT INTO settlement_deductions (settlement_id, kind, label, amount_cents, note, created_by)
       VALUES ($1, 'adjustment', 'Manual adjustment', $2, $3, $4)`,
      [s.id, -amountCents, note, userId]
    );
    await recalc(client, s.id);
    const { rows: after } = await client.query('SELECT net_payable_cents, status FROM settlements WHERE id = $1', [s.id]);
    const status = after[0].net_payable_cents <= 0 ? 'draft' : after[0].status === 'draft' ? 'pending_approval' : after[0].status;
    await client.query('UPDATE settlements SET status = $2 WHERE id = $1', [s.id, status]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { SettlementError, generateDueSettlements, approve, hold, pay, fail, addAdjustment, mask, grossFor, commissionFor, DELIVERED_AT };
