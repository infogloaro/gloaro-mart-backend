/**
 * SV9 — the invoice of a completed service booking: the shop's bill for the
 * work (the shop is the seller; Gloaro Mart is the marketplace), built from
 * the booking's own snapshot — service or package, add-ons, visit fee, the
 * shop's offer and any coupon, the total, and how it was paid. As JSON for
 * the app's page and as a small text PDF (services/simplePdf) to share.
 * Nothing is stored: the booking is the record; the number is derived.
 */
const pool = require('../config/db');
const simplePdf = require('./simplePdf');
const { EnquiryError: BookingError } = require('./shopEnquiries');

const rs = (cents) => (Number(cents) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const when = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The booking as its invoice, or 404 / 409. [side] = who asks (owner check). */
async function load(rawId, side, ownerId, db = pool) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new BookingError(404, 'Booking not found');
  const col = side === 'vendor' ? 'b.vendor_id' : 'b.user_id';
  const { rows } = await db.query(
    `SELECT b.*, vp.business_name, vp.gst_number, vp.address_line, vp.city, vp.state, vp.pincode, vp.contact AS shop_contact,
            u.full_name AS customer_name, u.phone_number AS customer_phone, u.email AS customer_email,
            sp.status AS pay_status, sp.amount_cents AS pay_cents, sp.instrument AS pay_instrument, sp.paid_at,
            (SELECT MAX(created_at) FROM service_booking_events e WHERE e.booking_id = b.id AND e.status = 'completed') AS completed_at
     FROM service_bookings b
     JOIN vendor_profiles vp ON vp.id = b.vendor_id
     JOIN users u ON u.id = b.user_id
     LEFT JOIN service_payments sp ON sp.booking_id = b.id
     WHERE b.id = $1 AND ${col} = $2`,
    [id, ownerId]
  );
  const b = rows[0];
  if (!b) throw new BookingError(404, 'Booking not found');
  if (b.status !== 'completed') throw new BookingError(409, 'The invoice is ready once the work is marked done.');

  const addons = Array.isArray(b.addons) ? b.addons : [];
  const lines = [];
  const priceLabel = { fixed: null, from: 'from', range: 'range', per_hour: 'per hour', on_request: 'on request' }[b.price_type];
  if (b.package_name) lines.push({ label: `${b.service_title} — ${b.package_name}`, cents: b.package_cents });
  else lines.push({ label: b.service_title + (priceLabel ? ` (price ${priceLabel}, as agreed with the shop)` : ''), cents: b.price_type === 'on_request' ? null : b.price_cents });
  if (!b.package_name && b.list_price_cents != null && b.price_cents != null && b.list_price_cents > b.price_cents) {
    lines[0].listCents = b.list_price_cents;
    lines.push({ label: 'Shop offer', cents: -(b.list_price_cents - b.price_cents) });
  }
  for (const a of addons) lines.push({ label: `Add-on: ${a.name}`, cents: a.cents });
  if (b.visit_fee_cents) lines.push({ label: 'Visit fee', cents: b.visit_fee_cents });
  if (b.coupon_code && b.discount_cents) lines.push({ label: `Coupon ${b.coupon_code}`, cents: -b.discount_cents });

  const paidOnline = ['successful', 'refund_pending', 'refunded', 'refund_failed'].includes(b.pay_status);
  const total = b.total_cents ?? (b.price_type === 'on_request' ? null : (b.price_cents ?? 0) + (b.visit_fee_cents ?? 0) + addons.reduce((n, a) => n + a.cents, 0) - (b.discount_cents ?? 0));
  const completedAt = b.completed_at ?? b.updated_at;
  return {
    number: `SVC-${b.reference.replace(/^BKG-/, '')}`,
    date: completedAt,
    booking: { id: b.id, reference: b.reference, startsAt: b.starts_at, completedAt, atHome: b.at_home, visitAddress: b.visit_address },
    seller: {
      name: b.business_name,
      gstin: b.gst_number || null,
      address: [b.address_line, b.city, b.state, b.pincode].filter(Boolean).join(', ') || null,
      phone: b.shop_contact?.phone ?? null,
    },
    buyer: { name: b.customer_name, phone: side === 'vendor' ? b.customer_phone : null, email: side === 'vendor' ? null : b.customer_email },
    lines,
    totalCents: total,
    payment: paidOnline
      ? { mode: 'online', amountCents: b.pay_cents, instrument: b.pay_instrument, paidAt: b.paid_at, status: b.pay_status }
      : { mode: 'shop', amountCents: total, instrument: null, paidAt: null, status: null },
    note: 'Bill for a service booked through Gloaro Mart. The shop is the provider and the seller; prices include any tax the shop charges.',
  };
}

/** The same invoice as PDF bytes. */
function pdf(inv) {
  const L = [];
  const text = (t, o = {}) => L.push({ text: t, ...o });
  text('SERVICE INVOICE', { font: 'bold', size: 15, gap: 18 });
  text(inv.seller.name, { font: 'bold', size: 11 });
  if (inv.seller.address) text(inv.seller.address, { size: 8.5, gap: 11 });
  if (inv.seller.phone) text(`Phone: ${inv.seller.phone}`, { size: 8.5, gap: 11 });
  if (inv.seller.gstin) text(`GSTIN: ${inv.seller.gstin}`, { size: 8.5, gap: 11 });
  L.push({ rule: true, gap: 10 });
  text(`Invoice no: ${inv.number}     Date: ${day(inv.date)}     Booking: ${inv.booking.reference}`, { font: 'bold', size: 9 });
  text(`Service on ${when(inv.booking.startsAt)} ${inv.booking.atHome ? `at ${inv.booking.visitAddress ?? "the customer's address"}` : 'at the shop'}`, { size: 8.5 });
  L.push({ rule: true, gap: 10 });
  text('Bill to', { font: 'bold', size: 8.5 });
  text([inv.buyer.name, inv.buyer.phone, inv.buyer.email].filter(Boolean).join('  ·  ') || '-', { size: 8.5, gap: 11 });
  L.push({ rule: true, gap: 10 });
  const W = 105;
  text(`${'Item'.padEnd(W - 14)}${'Amount'.padStart(14)}`, { font: 'monoBold', size: 8 });
  for (const l of inv.lines) {
    const amt = l.cents == null ? 'as agreed' : l.cents < 0 ? `-${rs(-l.cents)}` : rs(l.cents);
    text(`${String(l.label).slice(0, W - 15).padEnd(W - 14)}${amt.padStart(14)}`, { font: 'mono', size: 8, gap: 11 });
  }
  L.push({ rule: true, gap: 10 });
  text(`${'Total (Rs.)'.padStart(W - 14)}${(inv.totalCents == null ? 'as agreed' : rs(inv.totalCents)).padStart(14)}`, { font: 'monoBold', size: 8, gap: 12 });
  const p = inv.payment;
  text(
    p.mode === 'online'
      ? `Paid online through Gloaro Mart (${(p.instrument ?? 'Razorpay').toUpperCase()}) on ${p.paidAt ? day(p.paidAt) : day(inv.date)}: Rs. ${rs(p.amountCents)}${p.status && p.status !== 'successful' ? ` — ${p.status.replace('_', ' ')}` : ''}`
      : 'Paid to the shop after the work (cash / UPI).',
    { size: 8.5 }
  );
  L.push({ rule: true, gap: 14 });
  text(inv.note, { size: 7.5 });
  text('Computer-generated; needs no signature.', { size: 7.5 });
  return { buffer: simplePdf.render(L), filename: `${inv.number}.pdf` };
}

module.exports = { load, pdf };
