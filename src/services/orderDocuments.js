/**
 * VD7: an order's printable documents for the shop — invoice, packing slip
 * and shipping label — as HTML pages laid out for paper. The shop opens one in
 * the browser from the app and prints it or saves it as a PDF there, so the
 * rupee sign and Tamil or Hindi names print as they are.
 *
 * The page is reached through a short-lived signed link (a browser tab can't
 * send the app's login), made by the shop for its own order only.
 */
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const AUDIENCE = 'order-document';
const LINK_MINUTES = 15;
const KINDS = ['invoice', 'packing-slip', 'label'];

/** [shipmentId] (DR7, admin): print that shipment rather than the order's latest. */
function linkToken(orderId, vendorId, kind, shipmentId) {
  return jwt.sign({ o: orderId, v: vendorId, k: kind, ...(shipmentId ? { s: shipmentId } : {}) }, SECRET, {
    audience: AUDIENCE,
    expiresIn: `${LINK_MINUTES}m`,
  });
}

/** { orderId, vendorId, kind, shipmentId? } from a link, or null when bad or expired. */
function readToken(token) {
  try {
    const p = jwt.verify(token, SECRET, { audience: AUDIENCE });
    return KINDS.includes(p.k) ? { orderId: p.o, vendorId: p.v, kind: p.k, shipmentId: p.s ?? null } : null;
  } catch {
    return null;
  }
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** ₹ with Indian grouping: 1234550 paise → ₹12,345.50 */
function rupees(paise) {
  const n = Number(paise || 0) / 100;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

const istDate = (d) =>
  d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

const PAYMENT = { cod: 'Cash on delivery', credit: 'Business credit', online: 'Paid online', upi: 'Paid online (UPI)', card: 'Paid online (card)', netbanking: 'Paid online', wallet: 'Gloaro wallet' };

function addressLines(snap, fallback) {
  if (!snap) return fallback ? [fallback] : [];
  return [
    [snap.houseBuilding, snap.street].filter(Boolean).join(', '),
    [snap.area, snap.landmark].filter(Boolean).join(', '),
    [snap.city, snap.state].filter(Boolean).join(', ') + (snap.pincode ? ` – ${snap.pincode}` : ''),
  ].filter((l) => l.trim());
}

/** Everything the three documents print, for the shop's own order; null if not its order. */
async function loadOrder(orderId, vendorId, shipmentId = null) {
  const { rows } = await pool.query(
    `SELECT o.*, cg.reference AS group_reference,
            vp.business_name, vp.address_line, vp.city AS shop_city, vp.state AS shop_state, vp.pincode AS shop_pincode,
            vp.gst_number, vp.contact, u.phone_number AS owner_phone
     FROM orders o
     JOIN vendor_profiles vp ON vp.id = o.vendor_id
     LEFT JOIN users u ON u.id = vp.user_id
     LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id
     WHERE o.id = $1 AND o.vendor_id = $2`,
    [orderId, vendorId]
  );
  const order = rows[0];
  if (!order) return null;
  const [items, invoice, shipment] = await Promise.all([
    pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]).then((r) => r.rows),
    pool
      .query(`SELECT * FROM invoices WHERE order_id = $1 AND status = 'issued' ORDER BY id DESC LIMIT 1`, [orderId])
      .then(async ({ rows: inv }) => {
        if (!inv[0]) return null;
        const { rows: lines } = await pool.query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY id', [inv[0].id]);
        return { ...inv[0], lines };
      }),
    pool
      .query(
        // $2 null: the order's latest shipment (the shop's link).
        `SELECT s.*, dp.name AS rider_name FROM shipments s LEFT JOIN delivery_partners dp ON dp.id = s.partner_id
         WHERE s.order_id = $1 AND ($2::int IS NULL OR s.id = $2) ORDER BY s.id DESC LIMIT 1`,
        [orderId, shipmentId]
      )
      .then((r) => r.rows[0] || null)
      .catch(() => null),
  ]);
  return { order, items, invoice, shipment };
}

function shopBlock(o) {
  const phone = o.contact?.phone || o.owner_phone;
  return [
    `<strong>${esc(o.business_name)}</strong>`,
    esc(o.address_line),
    esc([o.shop_city, o.shop_state].filter(Boolean).join(', ') + (o.shop_pincode ? ` – ${o.shop_pincode}` : '')),
    phone ? `Phone ${esc(phone)}` : '',
    o.gst_number ? `GSTIN ${esc(o.gst_number)}` : '',
  ]
    .filter(Boolean)
    .join('<br>');
}

function customerBlock(o) {
  const s = o.delivery_address_snapshot;
  return [
    `<strong>${esc(s?.receiverName || 'Customer')}</strong>`,
    ...addressLines(s, o.delivery_address).map(esc),
    s?.mobileNumber ? `Phone ${esc(s.mobileNumber)}` : '',
  ]
    .filter(Boolean)
    .join('<br>');
}

const page = (title, body, { label = false } = {}) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  @page { size: ${label ? '4in 6in' : 'A4'}; margin: ${label ? '0.2in' : '14mm'}; }
  * { box-sizing: border-box; }
  body { font-family: "Noto Sans", "Segoe UI", Roboto, Arial, sans-serif; color: #0F2547; margin: 0; background: #F3F7FA; }
  .paper { background: #fff; max-width: ${label ? '4in' : '210mm'}; margin: 16px auto; padding: ${label ? '0.2in' : '14mm'}; box-shadow: 0 4px 20px rgba(16,42,82,.12); }
  .bar { position: sticky; top: 0; display: flex; gap: 8px; justify-content: center; padding: 10px; background: #102A52; }
  .bar button { font: inherit; font-weight: 700; padding: 10px 18px; border-radius: 24px; border: 0; background: #D5A233; color: #0F2547; cursor: pointer; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #5E6D88; margin: 0 0 6px; }
  .row { display: flex; gap: 24px; justify-content: space-between; margin: 14px 0; } .row > div { flex: 1; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  th { text-align: left; background: #E9EEF5; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td { padding: 7px 8px; border-bottom: 1px solid #E1E7EF; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; } .muted { color: #5E6D88; font-size: 12px; }
  .total td { font-weight: 800; border-bottom: 0; } .note { background: #FBF3E0; padding: 8px 10px; border-radius: 8px; font-size: 12px; margin-top: 12px; }
  .box { width: 16px; height: 16px; border: 2px solid #0F2547; border-radius: 3px; display: inline-block; }
  .label { border: 2px solid #0F2547; border-radius: 8px; padding: 10px; font-size: 13px; }
  .label .big { font-size: 30px; font-weight: 900; letter-spacing: .02em; } .label .cod { font-size: 20px; font-weight: 900; border: 2px solid #0F2547; padding: 4px 8px; display: inline-block; }
  .label hr { border: 0; border-top: 2px dashed #0F2547; margin: 10px 0; }
  @media print { body { background: #fff; } .bar { display: none; } .paper { box-shadow: none; margin: 0; max-width: none; padding: 0; } }
</style></head>
<body><div class="bar"><button onclick="window.print()">Print or save as PDF</button></div>
<div class="paper">${body}</div></body></html>`;

function invoiceHtml({ order: o, items, invoice: inv }) {
  const ref = `#${o.id}${o.group_reference ? ` · ${esc(o.group_reference)}` : ''}`;
  if (inv) {
    const intra = !inv.igst_cents;
    const rows = inv.lines
      .map(
        (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}<div class="muted">HSN ${esc(l.hsn_code || '—')} · GST ${Number(l.gst_rate_percent)}%</div></td>
        <td class="num">${l.quantity}</td><td class="num">${rupees(l.unit_price_cents)}</td><td class="num">${rupees(l.taxable_cents)}</td>
        <td class="num">${intra ? `${rupees(l.cgst_cents)} + ${rupees(l.sgst_cents)}` : rupees(l.igst_cents)}</td><td class="num">${rupees(l.total_cents)}</td></tr>`
      )
      .join('');
    return page(
      `Tax invoice ${inv.invoice_number}`,
      `<h1>Tax invoice</h1><div class="muted">${esc(inv.invoice_number)} · ${istDate(inv.invoice_date)} · Order ${ref}</div>
      <div class="row"><div><h2>Sold by</h2>${shopBlock(o)}</div><div><h2>Bill to</h2><strong>${esc(inv.buyer_name)}</strong>${inv.buyer_gstin ? `<br>GSTIN ${esc(inv.buyer_gstin)}` : ''}<br>${customerBlock(o)}</div></div>
      <div class="muted">Place of supply: ${esc(inv.place_of_supply || '—')}</div>
      <table><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">${intra ? 'CGST + SGST' : 'IGST'}</th><th class="num">Amount</th></tr>${rows}
      ${inv.discount_cents ? `<tr><td colspan="6">Discount</td><td class="num">−${rupees(inv.discount_cents)}</td></tr>` : ''}
      ${inv.round_off_cents ? `<tr><td colspan="6">Round off</td><td class="num">${rupees(inv.round_off_cents)}</td></tr>` : ''}
      <tr class="total"><td colspan="6">Total</td><td class="num">${rupees(inv.total_cents)}</td></tr></table>
      <div class="note">${esc(PAYMENT[o.payment_method] || o.payment_method)}. This is a computer-generated invoice.</div>`
    );
  }
  // Before delivery there is no tax invoice yet (it is issued on delivery): an order bill, clearly labelled.
  const rows = items
    .map(
      (it, i) => `<tr><td>${i + 1}</td><td>${esc(it.product_name_snapshot)}${it.variant_label_snapshot ? `<div class="muted">${esc(it.variant_label_snapshot)}</div>` : ''}</td>
      <td class="num">${it.quantity}</td><td class="num">${rupees(it.unit_price_cents)}</td><td class="num">${rupees(it.unit_price_cents * it.quantity)}</td></tr>`
    )
    .join('');
  const discount = (o.discount_cents || 0) + (o.campaign_discount_cents || 0) + (o.points_discount_cents || 0);
  return page(
    `Order bill #${o.id}`,
    `<h1>Order bill</h1><div class="muted">Order ${ref} · ${istDate(o.created_at)}</div>
    <div class="row"><div><h2>From</h2>${shopBlock(o)}</div><div><h2>To</h2>${customerBlock(o)}</div></div>
    <table><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr>${rows}
    <tr><td colspan="4">Items</td><td class="num">${rupees(o.subtotal_cents)}</td></tr>
    ${discount ? `<tr><td colspan="4">Discounts</td><td class="num">−${rupees(discount)}</td></tr>` : ''}
    ${o.delivery_charge_cents ? `<tr><td colspan="4">Delivery</td><td class="num">${rupees(o.delivery_charge_cents)}</td></tr>` : ''}
    ${o.gst_cents ? `<tr><td colspan="4">GST</td><td class="num">${rupees(o.gst_cents)}</td></tr>` : ''}
    <tr class="total"><td colspan="4">Total</td><td class="num">${rupees(o.total_cents)}</td></tr></table>
    <div class="note">Not a tax invoice. Gloaro Mart issues the GST tax invoice when the order is delivered. ${esc(PAYMENT[o.payment_method] || o.payment_method)}.</div>`
  );
}

function packingSlipHtml({ order: o, items }) {
  const count = items.reduce((n, it) => n + it.quantity, 0);
  const rows = items
    .map(
      (it) => `<tr><td><span class="box"></span></td><td class="num" style="font-size:16px;font-weight:800">${it.quantity}×</td>
      <td>${esc(it.product_name_snapshot)}${it.variant_label_snapshot ? `<div class="muted">${esc(it.variant_label_snapshot)}</div>` : ''}</td></tr>`
    )
    .join('');
  return page(
    `Packing slip #${o.id}`,
    `<h1>Packing slip · Order #${o.id}</h1><div class="muted">${istDate(o.created_at)} · ${count} ${count === 1 ? 'item' : 'items'} · ${o.delivery_method === 'pickup' ? 'Customer picks up at the shop' : 'Delivery'}</div>
    <div class="row"><div><h2>${o.delivery_method === 'pickup' ? 'Customer' : 'Deliver to'}</h2>${customerBlock(o)}</div><div><h2>Payment</h2>${esc(PAYMENT[o.payment_method] || o.payment_method)}${o.payment_method === 'cod' ? `<br><strong>Collect ${rupees(o.total_cents)}</strong>` : ''}</div></div>
    <table><tr><th style="width:32px">Packed</th><th class="num" style="width:56px">Qty</th><th>Item</th></tr>${rows}</table>
    <div class="note">Tick each line as you pack it. Packed by: ____________________</div>`
  );
}

/**
 * Code 128 (set B) as an inline SVG, so a courier or rider can scan the
 * tracking number off the label. Printable ASCII only; anything else → null.
 */
const CODE128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232',
  '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122',
  '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311',
  '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113',
  '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422',
  '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111',
  '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121',
  '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];
function barcodeSvg(text, height = 56) {
  if (!text || !/^[\x20-\x7E]{1,40}$/.test(text)) return null;
  const codes = [104, ...[...text].map((ch) => ch.charCodeAt(0) - 32)];
  const check = codes.reduce((sum, c, i) => sum + c * (i || 1), 0) % 103;
  const pattern = [...codes, check, 106].map((c) => CODE128[c]).join('');
  let x = 10; // quiet zone
  let bars = '';
  [...pattern].forEach((w, i) => {
    if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="${height}"/>`;
    x += Number(w);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + 10} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img" aria-label="Barcode ${esc(text)}" shape-rendering="crispEdges">${bars}</svg>`;
}

const CARRIER = { gokart: 'GoKart', shiprocket: 'Shiprocket', manual: 'Own delivery' };

function labelHtml({ order: o, shipment: s, items = [] }) {
  const cod = o.payment_method === 'cod' ? (s?.cod_amount_cents ?? o.total_cents) : null;
  // DR7: the courier's AWB when there is one (it's what their scanners read), else our number.
  const tracking = s?.external_tracking_id || s?.tracking_number;
  const barcode = barcodeSvg(tracking);
  const carrier = [CARRIER[s?.provider], s?.rider_name || s?.partner_name].filter(Boolean).join(' · ');
  const pieces = items.reduce((n, i) => n + Number(i.quantity || 0), 0);
  const weight = s?.weight_grams ? (s.weight_grams >= 1000 ? `${(s.weight_grams / 1000).toFixed(2).replace(/\.?0+$/, '')} kg` : `${s.weight_grams} g`) : null;
  return page(
    `Label #${o.id}`,
    `<div class="label">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div><div class="muted">ORDER</div><div class="big">#${o.id}</div>${o.group_reference ? `<div class="muted">${esc(o.group_reference)}</div>` : ''}</div>
      ${carrier ? `<div style="text-align:right"><div class="muted">CARRIER</div><strong style="font-size:15px">${esc(carrier)}</strong></div>` : ''}
    </div>
    ${tracking ? `<div style="margin-top:8px">${barcode ?? ''}<div style="text-align:center;font-family:monospace;font-size:13px;letter-spacing:.08em">${s?.external_tracking_id ? 'AWB ' : ''}${esc(tracking)}</div></div>` : ''}
    <hr><h2>Deliver to</h2><div style="font-size:15px">${customerBlock(o)}</div>
    <hr><div>${cod != null ? `<span class="cod">COD ${rupees(cod)}</span>` : '<span class="cod">PREPAID</span>'}
      &nbsp; ${[s?.package_count > 1 ? `${s.package_count} boxes` : null, pieces ? `${pieces} item${pieces === 1 ? '' : 's'}` : null, weight].filter(Boolean).join(' · ')}</div>
    <hr><h2>From</h2><div class="muted" style="color:#0F2547">${shopBlock(o)}</div></div>`,
    { label: true }
  );
}

const RENDER = { invoice: invoiceHtml, 'packing-slip': packingSlipHtml, label: labelHtml };

async function render(kind, orderId, vendorId, shipmentId = null) {
  const data = await loadOrder(orderId, vendorId, shipmentId);
  return data ? RENDER[kind](data) : null;
}

module.exports = { KINDS, LINK_MINUTES, linkToken, readToken, render, rupees, esc };
