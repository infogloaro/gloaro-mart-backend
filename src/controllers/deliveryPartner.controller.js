const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const shipments = require('../services/shipments');

/**
 * Admin → Delivery Partners (schema DELIVERY PARTNERS, PHASE 38). Riders and
 * courier agencies, added by staff, onboarded once their paperwork is in, and
 * given shipments from the Shipments page (assignment lives in
 * shipment.controller.js and uses `canTakeWork` from here).
 */

const MODULE = 'orders';
const PAGE_SIZE = 25;
const TYPES = ['rider', 'agency'];
const DOC_TYPES = ['licence', 'rc', 'insurance', 'id_proof', 'other'];
const REQUIRED_DOCS = ['licence', 'id_proof'];
const FILE_PATH = /^(\/uploads\/partners\/[\w.-]+|https:\/\/\S+)$/;

class PartnerError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (res, err) => {
  if (err instanceof PartnerError) return res.status(err.status).json({ message: err.message, ...err.extra });
  throw err;
};

const OPEN = `s.status IN ('created', 'picked_up', 'in_transit', 'out_for_delivery')`;
const SELECT = `
  SELECT p.*, st.*, COALESCE(ho.handed, 0)::bigint AS handed_cents, ho.last_handover
  FROM delivery_partners p
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE ${OPEN})::int AS active_assignments,
           COUNT(*) FILTER (WHERE s.status = 'delivered')::int AS delivered_total,
           COUNT(*) FILTER (WHERE s.status = 'failed')::int AS failed_total,
           COUNT(*) FILTER (WHERE s.status = 'delivered' AND s.delivered_at >= date_trunc('day', now()))::int AS delivered_today,
           COUNT(*) FILTER (WHERE s.status = 'failed' AND s.updated_at >= date_trunc('day', now()))::int AS failed_today,
           COUNT(*) FILTER (WHERE s.status = 'delivered' AND s.estimated_delivery_at IS NOT NULL)::int AS with_eta,
           COUNT(*) FILTER (WHERE s.status = 'delivered' AND s.delivered_at <= s.estimated_delivery_at)::int AS on_time,
           COALESCE(SUM(s.cod_amount_cents) FILTER (WHERE s.status = 'delivered'), 0)::bigint AS cod_collected
    FROM shipments s WHERE s.partner_id = p.id
  ) st ON TRUE
  LEFT JOIN LATERAL (
    SELECT SUM(amount_cents) AS handed, MAX(created_at) AS last_handover
    FROM delivery_partner_cod_handovers h WHERE h.partner_id = p.id
  ) ho ON TRUE`;

function toJson(p) {
  const finished = p.delivered_total + p.failed_total;
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    phone: p.phone,
    email: p.email,
    status: p.status,
    statusReason: p.status_reason,
    vehicleType: p.vehicle_type,
    vehicleNumber: p.vehicle_number,
    serviceAreas: p.service_areas,
    isOnline: p.is_online,
    activeAssignments: p.active_assignments,
    dailyCapacity: p.daily_capacity,
    deliveriesTotal: p.delivered_total,
    deliveredToday: p.delivered_today,
    failedToday: p.failed_today,
    onTimeRate: p.with_eta > 0 ? p.on_time / p.with_eta : null,
    failureRate: finished > 0 ? p.failed_total / finished : null,
    // Customers can't rate partners yet.
    ratingAvg: null,
    ratingCount: 0,
    codHeldCents: Math.max(0, Number(p.cod_collected) - Number(p.handed_cents)),
    lastSettlementAt: p.last_handover,
    onboardedAt: p.onboarded_at,
    createdAt: p.created_at,
  };
}

async function documentsFor(partnerId, db = pool) {
  const { rows } = await db.query(
    'SELECT * FROM delivery_partner_documents WHERE partner_id = $1 ORDER BY uploaded_at DESC, id DESC',
    [partnerId]
  );
  return rows;
}

/**
 * What stops this partner working, in words — the same rule the page shows.
 * The newest document of each required type is the one that counts.
 */
function paperworkBlockers(docs) {
  const today = new Date(new Date().toDateString());
  const reasons = [];
  for (const type of REQUIRED_DOCS) {
    const label = type.replace('_', ' ');
    const doc = docs.find((d) => d.type === type);
    if (!doc) reasons.push(`No ${label} on file`);
    else if (doc.expires_at && new Date(doc.expires_at) < today) reasons.push(`The ${label} has expired`);
    else if (doc.status === 'rejected') reasons.push(`The ${label} was rejected`);
  }
  return reasons;
}

async function loadPartner(id, db = pool) {
  const { rows } = await db.query(`${SELECT} WHERE p.id = $1`, [Number(id)]);
  return rows[0] ?? null;
}

async function loadDetail(id) {
  const p = await loadPartner(id);
  if (!p) return null;
  const [docs, { rows: carrying }] = await Promise.all([
    documentsFor(p.id),
    pool.query(
      `SELECT s.id, s.tracking_number, s.status, s.assigned_at, s.cod_amount_cents,
              COALESCE(o.delivery_address_snapshot->>'area', o.delivery_address_snapshot->>'city') AS area
       FROM shipments s JOIN orders o ON o.id = s.order_id
       WHERE s.partner_id = $1 AND ${OPEN} ORDER BY s.assigned_at`,
      [p.id]
    ),
  ]);
  return {
    ...toJson(p),
    documents: docs.map((d) => ({
      id: d.id,
      type: d.type,
      fileUrl: d.file_url,
      status: d.status,
      expiresAt: d.expires_at,
      uploadedAt: d.uploaded_at,
    })),
    assignments: carrying.map((s) => ({
      shipmentId: s.id,
      trackingNumber: s.tracking_number,
      status: s.status,
      area: s.area,
      assignedAt: s.assigned_at,
      codAmountCents: s.cod_amount_cents,
    })),
    blockers: paperworkBlockers(docs),
  };
}

/**
 * Whether a partner may be given one more shipment right now, and why not.
 * Used by assignment on the Shipments page.
 */
async function canTakeWork(db, partnerId) {
  const p = await loadPartner(partnerId, db);
  if (!p) return { ok: false, message: 'Delivery partner not found', partner: null };
  if (p.status !== 'active') return { ok: false, message: `${p.name} is ${p.status}, not active.`, partner: p };
  if (!p.is_online) return { ok: false, message: `${p.name} is offline.`, partner: p };
  const blockers = paperworkBlockers(await documentsFor(p.id, db));
  if (blockers.length) return { ok: false, message: `${p.name}: ${blockers.join('; ')}.`, partner: p };
  if (p.active_assignments >= p.daily_capacity) {
    return { ok: false, message: `${p.name} is at capacity (${p.active_assignments} of ${p.daily_capacity}).`, partner: p };
  }
  return { ok: true, partner: p };
}

const audit = (req, action, entityId, previousValue, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: MODULE, entityType: 'delivery_partner', entityId, previousValue, newValue });

// ------------------------------------------------------------------ lists

async function listPartners(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const conditions = [];
  const params = [];
  if (req.query.status) {
    if (!['pending', 'active', 'suspended', 'rejected'].includes(req.query.status)) {
      return res.status(400).json({ message: 'Unknown status' });
    }
    params.push(req.query.status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const q = `$${params.length}`;
    conditions.push(`(p.name ILIKE ${q} OR p.phone ILIKE ${q} OR p.vehicle_number ILIKE ${q} OR p.email ILIKE ${q})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // The onboarding queue is worked oldest first.
  const order = req.query.status === 'pending' ? 'p.created_at ASC' : 'p.name ASC';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY ${order}, p.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(`SELECT COUNT(*)::int AS total FROM delivery_partners p ${where}`, params),
  ]);
  res.json({ items: rows.map(toJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

async function partnerSummary(req, res) {
  const { rows } = await pool.query(`${SELECT}`);
  const partners = rows.map(toJson);
  const { rows: docs } = await pool.query(
    `SELECT COUNT(DISTINCT d.partner_id)::int AS n FROM delivery_partner_documents d
     JOIN delivery_partners p ON p.id = d.partner_id
     WHERE p.status IN ('pending', 'active') AND d.status <> 'rejected'
       AND d.expires_at IS NOT NULL AND d.expires_at < (now() + interval '30 days')::date`
  );
  res.json({
    pending: partners.filter((p) => p.status === 'pending').length,
    active: partners.filter((p) => p.status === 'active').length,
    online: partners.filter((p) => p.status === 'active' && p.isOnline).length,
    deliveredToday: partners.reduce((n, p) => n + p.deliveredToday, 0),
    failedToday: partners.reduce((n, p) => n + p.failedToday, 0),
    codHeldCents: partners.reduce((n, p) => n + p.codHeldCents, 0),
    expiringDocuments: docs[0].n,
  });
}

async function getPartner(req, res) {
  const detail = await loadDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'Delivery partner not found' });
  res.json(detail);
}

/**
 * Partners who could take a given shipment now, best fit first: covering the
 * delivery area, then least loaded. Ones that can't are listed with why.
 */
async function availableForShipment(req, res) {
  const { rows: shipmentRows } = await pool.query(
    `SELECT o.delivery_address_snapshot AS a FROM shipments s JOIN orders o ON o.id = s.order_id WHERE s.id = $1`,
    [Number(req.params.id)]
  );
  if (!shipmentRows[0]) return res.status(404).json({ message: 'Shipment not found' });
  const a = shipmentRows[0].a;
  const area = a ? [a.pincode, a.area, a.city].filter(Boolean).map((x) => String(x).toLowerCase()) : null;
  const { rows } = await pool.query(`${SELECT} WHERE p.status = 'active' ORDER BY p.name`);
  const out = [];
  for (const p of rows) {
    const check = await canTakeWork(pool, p.id);
    const covers = area ? p.service_areas.some((s) => area.includes(String(s).toLowerCase())) : null;
    out.push({ id: p.id, name: p.name, type: p.type, phone: p.phone, activeAssignments: p.active_assignments,
      dailyCapacity: p.daily_capacity, isOnline: p.is_online, coversArea: covers, available: check.ok, reason: check.ok ? null : check.message });
  }
  out.sort((a, b) => Number(b.available) - Number(a.available) || Number(b.coversArea) - Number(a.coversArea) || a.activeAssignments - b.activeAssignments);
  res.json(out);
}

// ---------------------------------------------------------------- changes

/** Validates the editable fields; `creating` makes name and phone required. */
function readFields(b, creating) {
  const out = {};
  const text = (key, max, required = false) => {
    if (!(key in b)) {
      if (required) throw new PartnerError(400, `${key} is required`);
      return;
    }
    const v = typeof b[key] === 'string' ? b[key].trim() : b[key] == null ? '' : null;
    if (v === null || v.length > max) throw new PartnerError(400, `${key} must be text of at most ${max} characters`);
    if (required && !v) throw new PartnerError(400, `${key} is required`);
    out[key] = v || null;
  };
  text('name', 120, creating);
  text('phone', 20, creating);
  text('email', 160);
  text('vehicleType', 30);
  text('vehicleNumber', 20);
  if (out.phone && !/^\+?[0-9 -]{7,20}$/.test(out.phone)) throw new PartnerError(400, 'Enter a valid phone number');
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new PartnerError(400, 'Enter a valid email');
  if ('type' in b) {
    if (!TYPES.includes(b.type)) throw new PartnerError(400, "type must be 'rider' or 'agency'");
    out.type = b.type;
  }
  if ('serviceAreas' in b) {
    if (!Array.isArray(b.serviceAreas) || b.serviceAreas.length > 50 || !b.serviceAreas.every((s) => typeof s === 'string' && s.trim().length <= 60)) {
      throw new PartnerError(400, 'serviceAreas must be a list of pincodes or area names');
    }
    out.serviceAreas = [...new Set(b.serviceAreas.map((s) => s.trim()).filter(Boolean))];
  }
  if ('dailyCapacity' in b) {
    if (!Number.isInteger(b.dailyCapacity) || b.dailyCapacity < 0 || b.dailyCapacity > 500) {
      throw new PartnerError(400, 'dailyCapacity must be a whole number from 0 to 500');
    }
    out.dailyCapacity = b.dailyCapacity;
  }
  if ('isOnline' in b) {
    if (typeof b.isOnline !== 'boolean') throw new PartnerError(400, 'isOnline must be true or false');
    out.isOnline = b.isOnline;
  }
  return out;
}

const COLUMNS = {
  name: 'name', phone: 'phone', email: 'email', type: 'type', vehicleType: 'vehicle_type', vehicleNumber: 'vehicle_number',
  serviceAreas: 'service_areas', dailyCapacity: 'daily_capacity', isOnline: 'is_online',
};

const duplicatePhone = (err) => err.code === '23505' && /phone/.test(err.constraint ?? err.detail ?? '');

async function createPartner(req, res) {
  try {
    const f = readFields(req.body || {}, true);
    const cols = Object.keys(f).map((k) => COLUMNS[k]);
    const { rows } = await pool.query(
      `INSERT INTO delivery_partners (${cols.join(', ')}, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING id`,
      [...Object.values(f), req.user.id]
    );
    await audit(req, 'delivery_partner.created', rows[0].id, null, f);
    res.status(201).json(await loadDetail(rows[0].id));
  } catch (err) {
    if (duplicatePhone(err)) return res.status(409).json({ message: 'A partner with that phone number already exists.' });
    fail(res, err);
  }
}

async function updatePartner(req, res) {
  try {
    const f = readFields(req.body || {}, false);
    const keys = Object.keys(f);
    if (!keys.length) throw new PartnerError(400, 'Nothing to change');
    const before = await loadPartner(req.params.id);
    if (!before) throw new PartnerError(404, 'Delivery partner not found');
    if (f.isOnline === true && before.status !== 'active') throw new PartnerError(409, 'Only an active partner can go online.');
    await pool.query(
      `UPDATE delivery_partners SET ${keys.map((k, i) => `${COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [before.id, ...Object.values(f)]
    );
    // Shipments carry a copy of the name and phone the customer sees.
    if (f.name || f.phone) {
      await pool.query(
        `UPDATE shipments s SET partner_name = p.name, partner_phone = p.phone FROM delivery_partners p
         WHERE s.partner_id = p.id AND p.id = $1 AND ${OPEN}`,
        [before.id]
      );
    }
    await audit(req, 'delivery_partner.updated', before.id, Object.fromEntries(keys.map((k) => [k, before[COLUMNS[k]]])), f);
    res.json(await loadDetail(before.id));
  } catch (err) {
    if (duplicatePhone(err)) return res.status(409).json({ message: 'A partner with that phone number already exists.' });
    fail(res, err);
  }
}

/** Onboard a pending partner, or reinstate a suspended or rejected one. Paperwork must be in. */
async function approvePartner(req, res) {
  try {
    const p = await loadPartner(req.params.id);
    if (!p) throw new PartnerError(404, 'Delivery partner not found');
    if (p.status === 'active') throw new PartnerError(409, `${p.name} is already active.`);
    const blockers = paperworkBlockers(await documentsFor(p.id));
    if (blockers.length) throw new PartnerError(409, `Paperwork incomplete: ${blockers.join('; ')}.`, { blockers });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Onboarding is the review: the paperwork looked at in the window is approved with it.
      await client.query(
        `UPDATE delivery_partner_documents SET status = 'approved', reviewed_by = $2, reviewed_at = now()
         WHERE partner_id = $1 AND status = 'pending'`,
        [p.id, req.user.id]
      );
      await client.query(
        `UPDATE delivery_partners SET status = 'active', status_reason = NULL, onboarded_at = COALESCE(onboarded_at, now()), updated_at = now()
         WHERE id = $1`,
        [p.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await audit(req, p.status === 'pending' ? 'delivery_partner.onboarded' : 'delivery_partner.reinstated', p.id, { status: p.status }, { status: 'active' });
    res.json(await loadDetail(p.id));
  } catch (err) {
    fail(res, err);
  }
}

function readReason(req) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) throw new PartnerError(400, 'Give a reason (up to 500 characters).');
  return reason;
}

async function rejectPartner(req, res) {
  try {
    const reason = readReason(req);
    const p = await loadPartner(req.params.id);
    if (!p) throw new PartnerError(404, 'Delivery partner not found');
    if (p.status !== 'pending') throw new PartnerError(409, 'Only a partner waiting to be onboarded can be turned down.');
    await pool.query(
      "UPDATE delivery_partners SET status = 'rejected', status_reason = $2, is_online = FALSE, updated_at = now() WHERE id = $1",
      [p.id, reason]
    );
    await audit(req, 'delivery_partner.rejected', p.id, { status: p.status }, { status: 'rejected', reason });
    res.json(await loadDetail(p.id));
  } catch (err) {
    fail(res, err);
  }
}

/** Stops an active partner. Whatever they were carrying goes back to unassigned, with a note on its trail. */
async function suspendPartner(req, res) {
  try {
    const reason = readReason(req);
    const p = await loadPartner(req.params.id);
    if (!p) throw new PartnerError(404, 'Delivery partner not found');
    if (p.status !== 'active') throw new PartnerError(409, 'Only an active partner can be suspended.');
    const client = await pool.connect();
    let released;
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE delivery_partners SET status = 'suspended', status_reason = $2, is_online = FALSE, updated_at = now() WHERE id = $1",
        [p.id, reason]
      );
      const { rows } = await client.query(
        `UPDATE shipments s SET partner_id = NULL, partner_name = NULL, partner_phone = NULL, assigned_at = NULL, updated_at = now()
         WHERE s.partner_id = $1 AND ${OPEN} RETURNING id, status`,
        [p.id]
      );
      released = rows;
      for (const s of rows) {
        await shipments.addEvent(client, s.id, {
          status: s.status,
          description: `${p.name} was suspended — needs a new delivery partner`,
          actorRole: 'admin',
          userId: req.user.id,
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await audit(req, 'delivery_partner.suspended', p.id, { status: p.status }, { status: 'suspended', reason, released: released.map((s) => s.id) });
    res.json({ ...(await loadDetail(p.id)), releasedShipments: released.length });
  } catch (err) {
    fail(res, err);
  }
}

async function addDocument(req, res) {
  try {
    const b = req.body || {};
    if (!DOC_TYPES.includes(b.type)) throw new PartnerError(400, `type must be one of ${DOC_TYPES.join(', ')}`);
    if (typeof b.fileUrl !== 'string' || !FILE_PATH.test(b.fileUrl.trim())) {
      throw new PartnerError(400, 'Upload the document first (or give an https link).');
    }
    if (b.expiresAt != null && Number.isNaN(Date.parse(b.expiresAt))) throw new PartnerError(400, 'expiresAt must be a date');
    const p = await loadPartner(req.params.id);
    if (!p) throw new PartnerError(404, 'Delivery partner not found');
    const { rows } = await pool.query(
      'INSERT INTO delivery_partner_documents (partner_id, type, file_url, expires_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [p.id, b.type, b.fileUrl.trim(), b.expiresAt || null]
    );
    await audit(req, 'delivery_partner.document_added', p.id, null, { documentId: rows[0].id, type: b.type, expiresAt: b.expiresAt || null });
    res.status(201).json(await loadDetail(p.id));
  } catch (err) {
    fail(res, err);
  }
}

async function reviewDocument(req, res) {
  try {
    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) throw new PartnerError(400, "status must be 'approved' or 'rejected'");
    const { rows } = await pool.query(
      `UPDATE delivery_partner_documents SET status = $3, reviewed_by = $4, reviewed_at = now()
       WHERE id = $2 AND partner_id = $1 RETURNING id`,
      [req.params.id, req.params.docId, status, req.user.id]
    );
    if (!rows[0]) throw new PartnerError(404, 'Document not found');
    await audit(req, `delivery_partner.document_${status}`, req.params.id, null, { documentId: rows[0].id });
    res.json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

/** Cash the partner handed over. Can't exceed what they hold. */
async function recordCodHandover(req, res) {
  try {
    const amount = req.body?.amountCents;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) || null : null;
    if (!Number.isInteger(amount) || amount <= 0) throw new PartnerError(400, 'amountCents must be a positive whole number');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Locked so two handovers recorded at once can't both pass the check.
      const { rows: locked } = await client.query('SELECT id FROM delivery_partners WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!locked[0]) throw new PartnerError(404, 'Delivery partner not found');
      const held = toJson(await loadPartner(req.params.id, client)).codHeldCents;
      if (amount > held) throw new PartnerError(409, `They hold ₹${(held / 100).toFixed(2)} — the handover can't be more than that.`);
      await client.query(
        'INSERT INTO delivery_partner_cod_handovers (partner_id, amount_cents, note, recorded_by) VALUES ($1, $2, $3, $4)',
        [req.params.id, amount, note, req.user.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await audit(req, 'delivery_partner.cod_handover', req.params.id, null, { amountCents: amount, note });
    res.status(201).json(await loadDetail(req.params.id));
  } catch (err) {
    fail(res, err);
  }
}

module.exports = {
  canTakeWork,
  listPartners,
  partnerSummary,
  getPartner,
  availableForShipment,
  createPartner,
  updatePartner,
  approvePartner,
  rejectPartner,
  suspendPartner,
  addDocument,
  reviewDocument,
  recordCodHandover,
};
