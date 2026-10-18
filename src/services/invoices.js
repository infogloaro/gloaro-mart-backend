const pool = require('../config/db');

/**
 * Issues the tax invoice for a delivered shop order (schema INVOICES & GST,
 * PHASE 40). Called after every path that marks an order delivered; safe to
 * call twice — an order with a live invoice gets that invoice back.
 */

// Delivery is a service: SAC 9968 (postal and courier services).
const DELIVERY_SAC = '9968';

/** The Indian financial year a date falls in, e.g. 2026-10-14 → "2026-27". */
function financialYear(date) {
  const d = new Date(date);
  // Financial years turn over on 1 April, India time.
  const ist = new Date(d.getTime() + 330 * 60000);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** "Tamil Nadu", "tamilnadu" and "TAMIL NADU" are the same state. */
const sameState = (a, b) => {
  const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return !norm(a) || !norm(b) || norm(a) === norm(b);
};

function addressText(a) {
  if (!a) return null;
  const parts = [a.receiver_name, a.house_building, a.street, a.area, a.landmark, a.city, a.state, a.pincode]
    .filter((p) => p && String(p).trim());
  return parts.join('\n') + (a.mobile_number ? `\nPh: ${a.mobile_number}` : '');
}

/** Splits `total` across `weights` in proportion, the remainder on the last share, so the parts add up exactly. */
function allocate(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!total || !sum) return weights.map(() => 0);
  let given = 0;
  return weights.map((w, i) => {
    if (i === weights.length - 1) return total - given;
    const share = Math.floor((total * w) / sum);
    given += share;
    return share;
  });
}

async function issueForOrder(orderId, { at = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: orderRows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = orderRows[0];
    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (order.status !== 'delivered') {
      throw Object.assign(new Error('An invoice is issued once the order is delivered.'), { status: 409 });
    }
    if (order.replacement_of_order_id) {
      throw Object.assign(new Error('A free replacement is not a new sale, so it has no tax invoice.'), { status: 409 });
    }
    const { rows: existing } = await client.query("SELECT * FROM invoices WHERE order_id = $1 AND status = 'issued'", [order.id]);
    if (existing[0]) {
      await client.query('ROLLBACK');
      return { invoice: existing[0], created: false };
    }

    // One at a time: a transaction's client runs one query at once.
    const { rows: settings } = await client.query('SELECT invoice_prefix FROM platform_settings WHERE id = 1');
    const { rows: vendorRows } = await client.query('SELECT * FROM vendor_profiles WHERE id = $1', [order.vendor_id]);
    const { rows: buyerRows } = await client.query('SELECT id, full_name, email FROM users WHERE id = $1', [order.user_id]);
    const { rows: items } = await client.query(
      `SELECT oi.*, p.hsn_code FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 ORDER BY oi.id`,
      [order.id]
    );
    const vendor = vendorRows[0];
    const buyer = buyerRows[0];
    // Bought for a business: its legal name and GSTIN make this a B2B invoice,
    // billed to its default address.
    let businessBuyer = null;
    if (order.business_account_id) {
      const { rows } = await client.query(
        `SELECT a.legal_name, a.gstin, ad.label, ad.line1, ad.line2, ad.city, ad.state, ad.pincode, ad.gstin AS branch_gstin
         FROM business_accounts a LEFT JOIN business_addresses ad ON ad.account_id = a.id AND ad.is_default
         WHERE a.id = $1`,
        [order.business_account_id]
      );
      businessBuyer = rows[0] ?? null;
    }
    const snapshot = order.delivery_address_snapshot ?? null;
    const date = at ? new Date(at) : new Date();
    const fy = financialYear(date);

    // Gapless: the counter row is taken under lock and only moves if this commits.
    const { rows: counter } = await client.query(
      `INSERT INTO invoice_series (financial_year, last_number) VALUES ($1, 1)
       ON CONFLICT (financial_year) DO UPDATE SET last_number = invoice_series.last_number + 1
       RETURNING last_number`,
      [fy]
    );
    const prefix = settings[0]?.invoice_prefix || 'GLM';
    const invoiceNumber = `${prefix}/${fy}/${String(counter[0].last_number).padStart(6, '0')}`;

    const placeOfSupply = snapshot?.state || vendor.state || 'Not stated';
    const supplyType = sameState(placeOfSupply, vendor.state) ? 'intra_state' : 'inter_state';

    // Exactly what checkout charged: GST on each line's value, rounded per line.
    const lines = items.map((it) => {
      const value = it.unit_price_cents * it.quantity;
      const rate = Number(it.gst_rate_percent_snapshot);
      const tax = Math.round((value * rate) / 100);
      const cgst = supplyType === 'intra_state' ? Math.floor(tax / 2) : 0;
      return {
        description: it.variant_label_snapshot ? `${it.product_name_snapshot} (${it.variant_label_snapshot})` : it.product_name_snapshot,
        hsnCode: it.hsn_code ?? null,
        quantity: it.quantity,
        unitPriceCents: it.unit_price_cents,
        taxableCents: value,
        rate,
        cgst,
        sgst: supplyType === 'intra_state' ? tax - cgst : 0,
        igst: supplyType === 'inter_state' ? tax : 0,
        tax,
      };
    });
    // The order's discount (coupon + campaign) was taken off after tax; it's
    // shown against each line in proportion to the line's value.
    const discounts = allocate(order.discount_cents, lines.map((l) => l.taxableCents));
    lines.forEach((l, i) => {
      l.discountCents = discounts[i];
      l.totalCents = l.taxableCents + l.tax - l.discountCents;
    });
    if (order.delivery_charge_cents > 0) {
      lines.push({
        description: 'Delivery charge',
        hsnCode: DELIVERY_SAC,
        quantity: 1,
        unitPriceCents: order.delivery_charge_cents,
        taxableCents: order.delivery_charge_cents,
        rate: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        tax: 0,
        discountCents: 0,
        totalCents: order.delivery_charge_cents,
      });
    }

    const sum = (key) => lines.reduce((s, l) => s + l[key], 0);
    const computed = sum('totalCents');
    // Whatever rounding checkout did differently lands here, so the invoice equals what was paid.
    const roundOff = order.total_cents - computed;

    const { rows: inv } = await client.query(
      `INSERT INTO invoices (invoice_number, invoice_date, financial_year, order_id, vendor_id, vendor_name, vendor_gstin,
         vendor_state, vendor_address, buyer_user_id, buyer_name, buyer_gstin, billing_address, shipping_address,
         place_of_supply, supply_type, taxable_cents, cgst_cents, sgst_cents, igst_cents, discount_cents,
         round_off_cents, total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $22, $23, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING *`,
      [
        invoiceNumber, date, fy, order.id, vendor.id, vendor.business_name, vendor.gst_number || null, vendor.state || null,
        [vendor.address_line, vendor.city, vendor.state, vendor.pincode].filter(Boolean).join(', ') || null,
        buyer?.id ?? null,
        businessBuyer?.legal_name || snapshot?.receiver_name || buyer?.full_name || buyer?.email || 'Customer',
        addressText(snapshot) ?? order.delivery_address ?? null,
        placeOfSupply, supplyType, sum('taxableCents'), sum('cgst'), sum('sgst'), sum('igst'), order.discount_cents,
        roundOff, order.total_cents,
        // A branch in another state invoices under its own GSTIN.
        businessBuyer ? businessBuyer.branch_gstin || businessBuyer.gstin : null,
        businessBuyer?.line1
          ? [businessBuyer.legal_name, businessBuyer.line1, businessBuyer.line2, businessBuyer.city, businessBuyer.state, businessBuyer.pincode].filter(Boolean).join('\n')
          : addressText(snapshot) ?? order.delivery_address ?? null,
      ]
    );
    for (const l of lines) {
      await client.query(
        `INSERT INTO invoice_lines (invoice_id, description, hsn_code, quantity, unit_price_cents, discount_cents,
           taxable_cents, gst_rate_percent, cgst_cents, sgst_cents, igst_cents, total_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [inv[0].id, l.description, l.hsnCode, l.quantity, l.unitPriceCents, l.discountCents, l.taxableCents, l.rate,
          l.cgst, l.sgst, l.igst, l.totalCents]
      );
    }
    await client.query('COMMIT');
    return { invoice: inv[0], created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The delivered-order hook: never lets an invoicing problem undo a delivery.
 * A miss is logged and picked up by re-running `npm run migrate:invoices`.
 */
async function issueAfterDelivery(orderId) {
  try {
    const { rows } = await pool.query('SELECT replacement_of_order_id FROM orders WHERE id = $1', [orderId]);
    if (rows[0]?.replacement_of_order_id) return;
    await issueForOrder(orderId);
  } catch (err) {
    console.error(`[invoices] could not issue for order ${orderId}: ${err.message}`);
  }
}

module.exports = { financialYear, issueForOrder, issueAfterDelivery };
