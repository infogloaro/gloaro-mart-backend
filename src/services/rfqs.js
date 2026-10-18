const pool = require('../config/db');

/**
 * RFQs and the quotations that answer them (schema RFQS & QUOTATIONS, PHASE 45).
 */

class RfqError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const LIVE_QUOTE = "q.status IN ('submitted', 'revision_requested', 'accepted')";

/**
 * Open RFQs past their closing time stop taking quotes: closed when someone
 * quoted (ready to compare), expired when nobody did. Run before reads, so the
 * pages never show an RFQ as open after it shut.
 */
async function closeDue(db = pool) {
  await db.query(
    `UPDATE rfqs r SET
       status = CASE WHEN EXISTS (SELECT 1 FROM quotations q WHERE q.rfq_id = r.id AND ${LIVE_QUOTE}) THEN 'closed' ELSE 'expired' END,
       closed_at = now(), updated_at = now()
     WHERE r.status = 'open' AND r.closes_at < now()`
  );
}

async function notify(db, userId, type, title, body, link = null) {
  if (!userId) return;
  await db.query('INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, $2, $3, $4, $5)', [userId, type, title, body, link]);
}

/** Invites shops (approved ones, not already invited) and tells them. Returns how many were new. */
async function inviteVendors(db, rfq, vendorIds, userId) {
  if (!Array.isArray(vendorIds) || vendorIds.length === 0 || !vendorIds.every(Number.isInteger)) {
    throw new RfqError(400, 'Pick at least one shop to invite.');
  }
  const { rows: vendors } = await db.query("SELECT id, user_id, business_name FROM vendor_profiles WHERE id = ANY($1) AND status = 'approved'", [vendorIds]);
  if (vendors.length !== new Set(vendorIds).size) throw new RfqError(400, 'One of those shops is not an approved vendor.');
  let added = 0;
  for (const v of vendors) {
    const { rowCount } = await db.query(
      'INSERT INTO rfq_vendors (rfq_id, vendor_id, invited_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [rfq.id, v.id, userId]
    );
    if (rowCount) {
      added += 1;
      await notify(db, v.user_id, 'rfq_invite', 'You are invited to quote', `${rfq.reference}: ${rfq.title}. Quotes close ${new Date(rfq.closes_at).toLocaleDateString('en-IN')}.`, `/vendor/rfqs/${rfq.id}`);
    }
  }
  return added;
}

/**
 * Shops worth inviting: for catalogue lines, shops selling the same item (match
 * key); for described lines, shops with a product whose name shares a word with
 * it. Ranked by how many lines they could cover, then rating. Already-invited
 * shops are left out.
 */
async function suggestionsFor(db, rfq) {
  const { rows: items } = await db.query(
    `SELECT ri.id, ri.product_name, p.match_key FROM rfq_items ri LEFT JOIN products p ON p.id = ri.product_id WHERE ri.rfq_id = $1`,
    [rfq.id]
  );
  const counts = new Map();
  for (const it of items) {
    let rows;
    if (it.match_key) {
      ({ rows } = await db.query(
        `SELECT DISTINCT p.vendor_id FROM products p JOIN vendor_profiles v ON v.id = p.vendor_id
         WHERE p.match_key = $1 AND p.is_active AND p.moderation_status = 'approved' AND v.status = 'approved'`,
        [it.match_key]
      ));
    } else {
      const words = [...new Set(it.product_name.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])].slice(0, 5);
      if (!words.length) continue;
      ({ rows } = await db.query(
        `SELECT DISTINCT p.vendor_id FROM products p JOIN vendor_profiles v ON v.id = p.vendor_id
         WHERE p.is_active AND p.moderation_status = 'approved' AND v.status = 'approved'
           AND p.name ILIKE ANY($1)`,
        [words.map((w) => `%${w}%`)]
      ));
    }
    for (const r of rows) counts.set(r.vendor_id, (counts.get(r.vendor_id) ?? 0) + 1);
  }
  if (!counts.size) return [];
  const { rows: vendors } = await db.query(
    `SELECT v.id, v.business_name, CASE WHEN m.rating_count > 0 THEN m.rating_sum::float / m.rating_count END AS rating
     FROM vendor_profiles v LEFT JOIN vendor_performance_metrics m ON m.vendor_id = v.id
     WHERE v.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM rfq_vendors rv WHERE rv.rfq_id = $2 AND rv.vendor_id = v.id)`,
    [[...counts.keys()], rfq.id]
  );
  return vendors
    .map((v) => ({ vendorId: v.id, vendorName: v.business_name, matchedItems: counts.get(v.id), distanceKm: null, ratingAvg: v.rating }))
    .sort((a, b) => b.matchedItems - a.matchedItems || (b.ratingAvg ?? 0) - (a.ratingAvg ?? 0))
    .slice(0, 10);
}

/**
 * A shop's quotation, or a new revision of it. Every line of the RFQ is
 * answered — priced or marked unavailable. Only while the RFQ is open.
 */
async function submitQuotation({ rfqId, vendorId, userId, body }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await closeDue(client);
    const { rows: rfqRows } = await client.query('SELECT * FROM rfqs WHERE id = $1 FOR UPDATE', [rfqId]);
    const rfq = rfqRows[0];
    if (!rfq) throw new RfqError(404, 'RFQ not found');
    const { rows: invite } = await client.query('SELECT * FROM rfq_vendors WHERE rfq_id = $1 AND vendor_id = $2', [rfq.id, vendorId]);
    if (!invite[0]) throw new RfqError(404, 'RFQ not found');
    if (invite[0].status === 'declined') throw new RfqError(409, 'You declined this RFQ.');
    const { rows: latest } = await client.query(
      'SELECT status FROM quotations WHERE rfq_id = $1 AND vendor_id = $2 ORDER BY revision DESC LIMIT 1',
      [rfq.id, vendorId]
    );
    if (latest[0]?.status === 'rejected') throw new RfqError(409, 'Your quotation was rejected, so you cannot quote on this RFQ again.');
    // Closed to new quotes — except a revision someone asked for, which is how
    // negotiation carries on once the quotes are being compared.
    const revisionAsked = latest[0]?.status === 'revision_requested';
    if (rfq.status !== 'open' && !(rfq.status === 'closed' && revisionAsked)) {
      throw new RfqError(409, `This RFQ is ${rfq.status} and no longer takes quotes.`);
    }

    const { rows: items } = await client.query('SELECT * FROM rfq_items WHERE rfq_id = $1 ORDER BY id', [rfq.id]);
    const lines = body?.lines;
    if (!Array.isArray(lines) || lines.length !== items.length) throw new RfqError(400, 'Answer every line of the RFQ — price it or mark it unavailable.');
    const built = items.map((it) => {
      const l = lines.find((x) => x?.rfqItemId === it.id);
      if (!l) throw new RfqError(400, `No answer for "${it.product_name}".`);
      const unavailable = l.unavailable === true;
      const price = unavailable ? 0 : l.unitPriceCents;
      const tax = unavailable ? 0 : Number(l.taxPercent ?? 0);
      if (!unavailable && !(Number.isInteger(price) && price > 0)) throw new RfqError(400, `"${it.product_name}" needs a unit price.`);
      if (!Number.isFinite(tax) || tax < 0 || tax > 28) throw new RfqError(400, 'taxPercent must be from 0 to 28.');
      const lineTotal = price * it.quantity;
      return { item: it, unavailable, price, tax, lineTotal, taxCents: Math.round((lineTotal * tax) / 100), note: typeof l.note === 'string' ? l.note.trim() || null : null };
    });
    if (built.every((b) => b.unavailable)) throw new RfqError(400, 'A quotation has to price at least one line — decline the RFQ instead.');
    const delivery = body.deliveryCents ?? 0;
    if (!Number.isInteger(delivery) || delivery < 0) throw new RfqError(400, 'deliveryCents must be zero or more.');
    const validUntil = body.validUntil ?? null;
    if (validUntil && (Number.isNaN(Date.parse(validUntil)) || new Date(validUntil) < new Date(new Date().toDateString()))) {
      throw new RfqError(400, 'validUntil must be a date from today on.');
    }
    const intOrNull = (v, max, name) => {
      if (v == null) return null;
      if (!Number.isInteger(v) || v < 0 || v > max) throw new RfqError(400, `${name} must be 0 to ${max}.`);
      return v;
    };
    const deliveryDays = intOrNull(body.deliveryDays, 365, 'deliveryDays');
    const terms = intOrNull(body.paymentTermsDays, 180, 'paymentTermsDays');

    // A new price is a new revision; the live one it replaces is kept as 'revised'.
    const { rows: live } = await client.query(
      `SELECT * FROM quotations WHERE rfq_id = $1 AND vendor_id = $2 AND status IN ('submitted', 'revision_requested', 'accepted') FOR UPDATE`,
      [rfq.id, vendorId]
    );
    if (live[0]?.status === 'accepted') throw new RfqError(409, 'Your quotation was already accepted.');
    const { rows: last } = await client.query('SELECT MAX(revision) AS n, MIN(reference) AS ref FROM quotations WHERE rfq_id = $1 AND vendor_id = $2', [rfq.id, vendorId]);
    if (live[0]) await client.query("UPDATE quotations SET status = 'revised' WHERE id = $1", [live[0].id]);
    let reference = last[0].ref;
    if (!reference) {
      const { rows: seq } = await client.query("SELECT nextval('quotation_ref_seq') AS n");
      reference = `QT-${new Date().getFullYear()}-${String(seq[0].n).padStart(5, '0')}`;
    }
    const subtotal = built.reduce((s, b) => s + b.lineTotal, 0);
    const taxTotal = built.reduce((s, b) => s + b.taxCents, 0);
    const { rows: q } = await client.query(
      `INSERT INTO quotations (reference, rfq_id, vendor_id, revision, subtotal_cents, tax_cents, delivery_cents, total_cents,
         valid_until, delivery_days, payment_terms_days, notes, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [reference, rfq.id, vendorId, (last[0].n ?? 0) + 1, subtotal, taxTotal, delivery, subtotal + taxTotal + delivery,
        validUntil, deliveryDays, terms, typeof body.notes === 'string' ? body.notes.trim() || null : null, userId]
    );
    for (const b of built) {
      await client.query(
        `INSERT INTO quotation_lines (quotation_id, rfq_item_id, unit_price_cents, tax_percent, line_total_cents, unavailable, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [q[0].id, b.item.id, b.price, b.tax, b.lineTotal, b.unavailable, b.note]
      );
    }
    await client.query("UPDATE rfq_vendors SET status = 'quoted', viewed_at = COALESCE(viewed_at, now()) WHERE rfq_id = $1 AND vendor_id = $2", [rfq.id, vendorId]);
    const { rows: shop } = await client.query('SELECT business_name FROM vendor_profiles WHERE id = $1', [vendorId]);
    await notify(client, rfq.created_by, 'rfq_quote', live[0] ? 'A quotation was revised' : 'New quotation on your RFQ',
      `${shop[0].business_name} quoted ₹${((subtotal + taxTotal + delivery) / 100).toFixed(2)} on ${rfq.reference}.`, `/business/rfqs/${rfq.id}`);
    await client.query('COMMIT');
    return q[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { RfqError, LIVE_QUOTE, closeDue, notify, inviteVendors, suggestionsFor, submitQuotation };
