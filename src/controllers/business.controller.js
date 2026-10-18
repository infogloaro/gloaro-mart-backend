const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const { parseGstin, creditPosition, membershipFor, BusinessError } = require('../services/business');

/**
 * Business accounts: registration and team management from the app (/api/business),
 * and verification and credit from Admin → Business Accounts. Rules in services/business.js.
 */

const PAGE_SIZE = 25;
const ROLES = ['owner', 'approver', 'buyer'];
const DOC_TYPES = ['gstin', 'pan', 'bank', 'fssai', 'other'];
const FILE_PATH = /^(\/uploads\/business\/[\w.-]+|https:\/\/\S+)$/;
const PINCODE = /^[1-9][0-9]{5}$/;

const fail = (res, err) => {
  if (err instanceof BusinessError || (err.status && err.status < 500)) return res.status(err.status).json({ message: err.message });
  throw err;
};

const SELECT = `
  SELECT a.*, COALESCE(u.full_name, u.email) AS contact_user_name, u.email AS contact_email, u.phone_number AS contact_user_phone,
         vu.full_name AS verified_by_name,
         (SELECT COUNT(*)::int FROM business_members m WHERE m.account_id = a.id) AS member_count,
         (SELECT COUNT(*)::int FROM business_addresses ad WHERE ad.account_id = a.id) AS address_count
  FROM business_accounts a
  JOIN users u ON u.id = a.primary_user_id
  LEFT JOIN users vu ON vu.id = a.verified_by`;

async function toJson(a) {
  const pos = await creditPosition(pool, a.id);
  // RFQs arrive with the next step; until their table exists there are none.
  const { rows: rfq } = await pool.query(
    `SELECT CASE WHEN to_regclass('public.rfqs') IS NULL THEN 0
       ELSE (SELECT COUNT(*)::int FROM rfqs r WHERE r.business_account_id = $1) END AS n`,
    [a.id]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return {
    id: a.id,
    legalName: a.legal_name,
    tradeName: a.trade_name,
    gstin: a.gstin,
    pan: a.pan,
    status: a.status,
    statusReason: a.status_reason,
    primaryContactName: a.contact_name ?? a.contact_user_name,
    primaryContactEmail: a.contact_email,
    primaryContactPhone: a.contact_phone ?? a.contact_user_phone,
    city: a.city,
    state: a.state,
    creditLimitCents: pos.limitCents,
    creditUsedCents: pos.usedCents,
    creditAvailableCents: pos.availableCents,
    overdueCents: pos.overdueCents,
    paymentTermsDays: a.payment_terms_days,
    memberCount: a.member_count,
    addressCount: a.address_count,
    ordersCount: pos.ordersCount,
    rfqCount: rfq[0]?.n ?? 0,
    lifetimeValueCents: pos.lifetimeValueCents,
    lastOrderAt: pos.lastOrderAt,
    verifiedAt: a.verified_at,
    verifiedByName: a.verified_by_name,
    createdAt: a.created_at,
  };
}

async function loadDetail(id) {
  const { rows } = await pool.query(`${SELECT} WHERE a.id = $1`, [Number(id)]);
  if (!rows[0]) return null;
  const [{ rows: members }, { rows: addresses }, { rows: docs }, { rows: payments }] = await Promise.all([
    pool.query(
      `SELECT m.*, COALESCE(u.full_name, u.email) AS name, u.email, u.phone_number FROM business_members m
       JOIN users u ON u.id = m.user_id WHERE m.account_id = $1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'approver' THEN 1 ELSE 2 END, m.added_at`,
      [rows[0].id]
    ),
    pool.query('SELECT * FROM business_addresses WHERE account_id = $1 ORDER BY is_default DESC, id', [rows[0].id]),
    pool.query('SELECT * FROM business_documents WHERE account_id = $1 ORDER BY uploaded_at DESC', [rows[0].id]),
    pool.query(
      `SELECT p.*, u.full_name AS recorded_by_name FROM business_credit_payments p LEFT JOIN users u ON u.id = p.recorded_by
       WHERE p.account_id = $1 ORDER BY p.received_at DESC LIMIT 50`,
      [rows[0].id]
    ),
  ]);
  return {
    ...(await toJson(rows[0])),
    members: members.map((m) => ({
      id: m.id, userId: m.user_id, name: m.name, email: m.email, phone: m.phone_number, role: m.role,
      orderLimitCents: m.order_limit_cents == null ? null : Number(m.order_limit_cents), addedAt: m.added_at,
    })),
    addresses: addresses.map((a) => ({
      id: a.id, label: a.label, line1: a.line1, line2: a.line2, city: a.city, state: a.state, pincode: a.pincode,
      gstin: a.gstin, isDefault: a.is_default, contactName: a.contact_name, contactPhone: a.contact_phone,
    })),
    documents: docs.map((d) => ({ id: d.id, type: d.type, fileUrl: d.file_url, status: d.status, uploadedAt: d.uploaded_at })),
    creditPayments: payments.map((p) => ({
      id: p.id, amountCents: Number(p.amount_cents), reference: p.reference, note: p.note, receivedAt: p.received_at, recordedByName: p.recorded_by_name,
    })),
  };
}

// ------------------------------------------------------------- app side

function readAddress(b) {
  const label = typeof b?.label === 'string' ? b.label.trim() : '';
  const line1 = typeof b?.line1 === 'string' ? b.line1.trim() : '';
  const city = typeof b?.city === 'string' ? b.city.trim() : '';
  const state = typeof b?.state === 'string' ? b.state.trim() : '';
  const pincode = typeof b?.pincode === 'string' ? b.pincode.trim() : '';
  if (!label || !line1 || !city || !state) throw new BusinessError(400, 'An address needs a label, a first line, a city and a state.');
  if (!PINCODE.test(pincode)) throw new BusinessError(400, 'The pincode is 6 digits.');
  let gstin = null;
  if (b.gstin) {
    const parsed = parseGstin(b.gstin);
    if (parsed.error) throw new BusinessError(400, `Branch GSTIN: ${parsed.error}`);
    gstin = parsed.gstin;
  }
  return {
    label: label.slice(0, 80), line1, line2: typeof b.line2 === 'string' ? b.line2.trim() || null : null, city, state, pincode, gstin,
    contactName: typeof b.contactName === 'string' ? b.contactName.trim() || null : null,
    contactPhone: typeof b.contactPhone === 'string' ? b.contactPhone.trim() || null : null,
  };
}

/** Registers a business; the caller becomes its owner. One business per person. */
async function registerAccount(req, res) {
  const b = req.body || {};
  try {
    const legalName = typeof b.legalName === 'string' ? b.legalName.trim() : '';
    if (!legalName || legalName.length > 200) throw new BusinessError(400, 'Enter the legal name as on the GST certificate.');
    const parsed = parseGstin(b.gstin);
    if (parsed.error) throw new BusinessError(400, parsed.error);
    if (await membershipFor(pool, req.user.id)) throw new BusinessError(409, 'You already belong to a business account.');
    const address = b.address ? readAddress(b.address) : null;
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO business_accounts (legal_name, trade_name, gstin, pan, state, city, primary_user_id, contact_name, contact_phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [legalName, typeof b.tradeName === 'string' ? b.tradeName.trim() || null : null, parsed.gstin, parsed.pan, parsed.state,
          address?.city ?? null, req.user.id, typeof b.contactName === 'string' ? b.contactName.trim() || null : null,
          typeof b.contactPhone === 'string' ? b.contactPhone.trim() || null : null]
      );
      id = rows[0].id;
      await client.query('INSERT INTO business_members (account_id, user_id, role, added_by) VALUES ($1, $2, $3, $2)', [id, req.user.id, 'owner']);
      if (address) await insertAddress(client, id, address, true);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') throw new BusinessError(409, 'That GSTIN is already registered on Gloaro Mart.');
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json(await loadDetail(id));
  } catch (err) {
    fail(res, err);
  }
}

async function insertAddress(db, accountId, a, isDefault) {
  if (isDefault) await db.query('UPDATE business_addresses SET is_default = FALSE WHERE account_id = $1', [accountId]);
  const { rows } = await db.query(
    `INSERT INTO business_addresses (account_id, label, line1, line2, city, state, pincode, gstin, is_default, contact_name, contact_phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [accountId, a.label, a.line1, a.line2, a.city, a.state, a.pincode, a.gstin, isDefault, a.contactName, a.contactPhone]
  );
  return rows[0].id;
}

/** The caller's business, with their own role — or null. */
async function getMine(req, res) {
  const m = await membershipFor(pool, req.user.id);
  if (!m) return res.json(null);
  const detail = await loadDetail(m.account_id);
  // Buyers see the account, not their colleagues' limits or the payment history.
  if (m.role === 'buyer') {
    detail.members = detail.members.filter((x) => x.userId === req.user.id);
    detail.creditPayments = [];
  }
  res.json({ ...detail, myRole: m.role, myOrderLimitCents: m.order_limit_cents == null ? null : Number(m.order_limit_cents) });
}

/** Owner-only guard; returns the membership. */
async function ownerOf(req) {
  const m = await membershipFor(pool, req.user.id);
  if (!m) throw new BusinessError(404, 'You are not part of a business account.');
  if (m.role !== 'owner') throw new BusinessError(403, 'Only an owner can change the business account.');
  return m;
}

/** Corrects the details; a refused account goes back for verification. */
async function updateMine(req, res) {
  try {
    const m = await ownerOf(req);
    const b = req.body || {};
    const sets = [];
    const params = [m.account_id];
    const set = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if ('legalName' in b) {
      const v = String(b.legalName ?? '').trim();
      if (!v) throw new BusinessError(400, 'The legal name cannot be empty.');
      if (m.account_status === 'verified') throw new BusinessError(409, 'A verified business changes its legal name through support.');
      set('legal_name', v);
    }
    if ('tradeName' in b) set('trade_name', String(b.tradeName ?? '').trim() || null);
    if ('contactName' in b) set('contact_name', String(b.contactName ?? '').trim() || null);
    if ('contactPhone' in b) set('contact_phone', String(b.contactPhone ?? '').trim() || null);
    if ('gstin' in b) {
      if (m.account_status === 'verified') throw new BusinessError(409, 'A verified GSTIN cannot be changed.');
      const parsed = parseGstin(b.gstin);
      if (parsed.error) throw new BusinessError(400, parsed.error);
      set('gstin', parsed.gstin);
      set('pan', parsed.pan);
      set('state', parsed.state);
    }
    if (!sets.length) throw new BusinessError(400, 'Nothing to change');
    // Fixing a refused application sends it back to the queue.
    if (m.account_status === 'rejected') sets.push("status = 'pending', status_reason = NULL");
    await pool.query(`UPDATE business_accounts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params).catch((err) => {
      if (err.code === '23505') throw new BusinessError(409, 'That GSTIN is already registered on Gloaro Mart.');
      throw err;
    });
    return getMine(req, res);
  } catch (err) {
    fail(res, err);
  }
}

/** Adds a colleague who already has a Gloaro Mart login, by email. */
async function addMember(req, res) {
  try {
    const m = await ownerOf(req);
    const b = req.body || {};
    const role = b.role ?? 'buyer';
    if (!ROLES.includes(role)) throw new BusinessError(400, `role must be one of ${ROLES.join(', ')}`);
    const limit = b.orderLimitCents ?? null;
    if (limit !== null && !(Number.isInteger(limit) && limit > 0)) throw new BusinessError(400, 'orderLimitCents must be a positive whole number, or null for no cap');
    const { rows: users } = await pool.query("SELECT id, role FROM users WHERE lower(email) = lower($1)", [String(b.email ?? '').trim()]);
    if (!users[0]) throw new BusinessError(404, 'No Gloaro Mart account has that email. Ask them to sign up first.');
    if (users[0].role !== 'customer') throw new BusinessError(409, 'Only a customer login can buy for a business.');
    await pool.query(
      'INSERT INTO business_members (account_id, user_id, role, order_limit_cents, added_by) VALUES ($1, $2, $3, $4, $5)',
      [m.account_id, users[0].id, role, limit, req.user.id]
    ).catch((err) => {
      if (err.code === '23505') throw new BusinessError(409, 'That person already belongs to a business account.');
      throw err;
    });
    return getMine(req, res);
  } catch (err) {
    fail(res, err);
  }
}

async function updateMember(req, res) {
  try {
    const m = await ownerOf(req);
    const b = req.body || {};
    const sets = [];
    const params = [Number(req.params.memberId), m.account_id];
    if ('role' in b) {
      if (!ROLES.includes(b.role)) throw new BusinessError(400, `role must be one of ${ROLES.join(', ')}`);
      params.push(b.role);
      sets.push(`role = $${params.length}`);
    }
    if ('orderLimitCents' in b) {
      const v = b.orderLimitCents;
      if (v !== null && !(Number.isInteger(v) && v > 0)) throw new BusinessError(400, 'orderLimitCents must be a positive whole number, or null');
      params.push(v);
      sets.push(`order_limit_cents = $${params.length}`);
    }
    if (!sets.length) throw new BusinessError(400, 'Nothing to change');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`UPDATE business_members SET ${sets.join(', ')} WHERE id = $1 AND account_id = $2 RETURNING id`, params);
      if (!rows[0]) throw new BusinessError(404, 'Member not found');
      await assertAnOwnerLeft(client, m.account_id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return getMine(req, res);
  } catch (err) {
    fail(res, err);
  }
}

async function removeMember(req, res) {
  try {
    const m = await ownerOf(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('DELETE FROM business_members WHERE id = $1 AND account_id = $2 RETURNING id', [Number(req.params.memberId), m.account_id]);
      if (!rows[0]) throw new BusinessError(404, 'Member not found');
      await assertAnOwnerLeft(client, m.account_id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return getMine(req, res);
  } catch (err) {
    fail(res, err);
  }
}

/** A business always has someone who can manage it. */
async function assertAnOwnerLeft(client, accountId) {
  const { rows } = await client.query("SELECT COUNT(*)::int AS n FROM business_members WHERE account_id = $1 AND role = 'owner'", [accountId]);
  if (rows[0].n === 0) throw new BusinessError(409, 'The business needs at least one owner.');
}

async function addAddress(req, res) {
  try {
    const m = await ownerOf(req);
    const a = readAddress(req.body);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM business_addresses WHERE account_id = $1', [m.account_id]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAddress(client, m.account_id, a, req.body?.isDefault === true || rows[0].n === 0);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return getMine(req, res);
  } catch (err) {
    fail(res, err);
  }
}

async function removeAddress(req, res) {
  try {
    const m = await ownerOf(req);
    const { rows } = await pool.query('DELETE FROM business_addresses WHERE id = $1 AND account_id = $2 RETURNING is_default', [Number(req.params.addressId), m.account_id]);
    if (!rows[0]) throw new BusinessError(404, 'Address not found');
    // Another address takes over as the default.
    if (rows[0].is_default) {
      await pool.query(
        `UPDATE business_addresses SET is_default = TRUE WHERE id = (SELECT id FROM business_addresses WHERE account_id = $1 ORDER BY id LIMIT 1)`,
        [m.account_id]
      );
    }
    return getMine(req, res);
  } catch (err) {
    fail(res, err);
  }
}

async function addDocument(req, res) {
  try {
    const m = await ownerOf(req);
    const { type, fileUrl } = req.body || {};
    if (!DOC_TYPES.includes(type)) throw new BusinessError(400, `type must be one of ${DOC_TYPES.join(', ')}`);
    if (typeof fileUrl !== 'string' || !FILE_PATH.test(fileUrl.trim())) throw new BusinessError(400, 'Upload the document first (POST /api/business/uploads).');
    await pool.query('INSERT INTO business_documents (account_id, type, file_url) VALUES ($1, $2, $3)', [m.account_id, type, fileUrl.trim()]);
    return getMine(req, res);
  } catch (err) {
    fail(res, err);
  }
}

/** The credit statement: credit orders and payments, newest first. Owners and approvers only. */
async function myStatement(req, res) {
  const m = await membershipFor(pool, req.user.id);
  if (!m) return res.status(404).json({ message: 'You are not part of a business account.' });
  if (m.role === 'buyer') return res.status(403).json({ message: 'Ask an owner or approver for the statement.' });
  const [{ rows: orders }, { rows: payments }, pos] = await Promise.all([
    pool.query(
      `SELECT o.id, o.total_cents, o.status, o.created_at, COALESCE(cg.reference, '#' || o.id) AS reference, u.full_name AS placed_by
       FROM orders o LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id JOIN users u ON u.id = o.user_id
       WHERE o.business_account_id = $1 AND o.payment_method = 'credit' ORDER BY o.created_at DESC LIMIT 200`,
      [m.account_id]
    ),
    pool.query('SELECT id, amount_cents, reference, received_at FROM business_credit_payments WHERE account_id = $1 ORDER BY received_at DESC', [m.account_id]),
    creditPosition(pool, m.account_id),
  ]);
  res.json({
    credit: pos,
    orders: orders.map((o) => ({ orderId: o.id, reference: o.reference, totalCents: o.total_cents, status: o.status, placedAt: o.created_at, placedBy: o.placed_by })),
    payments: payments.map((p) => ({ id: p.id, amountCents: Number(p.amount_cents), reference: p.reference, receivedAt: p.received_at })),
  });
}

// ---------------------------------------------------------------- admin

async function adminList(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const params = [];
  const conditions = [];
  if (req.query.status) {
    if (!['pending', 'verified', 'suspended', 'rejected'].includes(req.query.status)) return res.status(400).json({ message: 'Unknown status' });
    params.push(req.query.status);
    conditions.push(`a.status = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(`(a.legal_name ILIKE ${p} OR a.trade_name ILIKE ${p} OR a.gstin ILIKE ${p} OR u.email ILIKE ${p} OR u.full_name ILIKE ${p} OR a.contact_name ILIKE ${p})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = req.query.status === 'pending' ? 'a.created_at ASC' : 'a.legal_name ASC';
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY ${order}, a.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(`SELECT COUNT(*)::int AS total FROM business_accounts a JOIN users u ON u.id = a.primary_user_id ${where}`, params),
  ]);
  res.json({ items: await Promise.all(rows.map(toJson)), total: count[0].total, page, pageSize: PAGE_SIZE });
}

async function adminSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'verified')::int AS verified,
            COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
            COALESCE(SUM(credit_limit_cents) FILTER (WHERE status = 'verified'), 0)::bigint AS credit_limit
     FROM business_accounts`
  );
  const { rows: ids } = await pool.query('SELECT id FROM business_accounts');
  let exposure = 0;
  let lifetime = 0;
  for (const { id } of ids) {
    const pos = await creditPosition(pool, id);
    exposure += pos.usedCents;
    lifetime += pos.lifetimeValueCents;
  }
  res.json({
    pending: rows[0].pending,
    verified: rows[0].verified,
    suspended: rows[0].suspended,
    creditExposureCents: exposure,
    creditLimitCents: Number(rows[0].credit_limit),
    lifetimeValueCents: lifetime,
  });
}

async function adminGet(req, res) {
  const detail = await loadDetail(req.params.id);
  if (!detail) return res.status(404).json({ message: 'Business account not found' });
  res.json(detail);
}

async function notifyOwners(db, accountId, title, body) {
  await db.query(
    `INSERT INTO notifications (user_id, type, title, body, deep_link)
     SELECT user_id, 'business_account', $2, $3, '/business' FROM business_members WHERE account_id = $1 AND role = 'owner'`,
    [accountId, title, body]
  );
}

const audit = (req, action, id, newValue) =>
  recordAudit({ actorUserId: req.user.id, action, module: 'customers', entityType: 'business_account', entityId: id, newValue });

/** Verifies (or reinstates). Pending documents are approved with it — reviewing them is the verification. */
async function adminVerify(req, res) {
  const client = await pool.connect();
  let account;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM business_accounts WHERE id = $1 FOR UPDATE', [Number(req.params.id)]);
    account = rows[0];
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Business account not found' });
    }
    if (account.status === 'verified') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Already verified.' });
    }
    await client.query(
      `UPDATE business_accounts SET status = 'verified', status_reason = NULL, verified_by = $2,
         verified_at = COALESCE(verified_at, now()), updated_at = now() WHERE id = $1`,
      [account.id, req.user.id]
    );
    await client.query("UPDATE business_documents SET status = 'approved' WHERE account_id = $1 AND status = 'pending'", [account.id]);
    await notifyOwners(client, account.id, account.status === 'pending' ? 'Business account verified' : 'Business account reinstated',
      `${account.legal_name} can now order as a business.`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await audit(req, account.status === 'pending' ? 'business_account.verified' : 'business_account.reinstated', account.id, { gstin: account.gstin });
  res.json(await loadDetail(account.id));
}

async function setStatus(req, res, { from, to, action, title }) {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) return res.status(400).json({ message: 'Give a reason (up to 500 characters).' });
  const { rows } = await pool.query(
    `UPDATE business_accounts SET status = $2, status_reason = $3, updated_at = now()
     WHERE id = $1 AND status = ANY($4) RETURNING *`,
    [Number(req.params.id), to, reason, from]
  );
  if (!rows[0]) return res.status(409).json({ message: `Only a ${from.join(' or ')} account can be ${to}.` });
  await notifyOwners(pool, rows[0].id, title, reason);
  await audit(req, action, rows[0].id, { reason });
  res.json(await loadDetail(rows[0].id));
}

const adminReject = (req, res) => setStatus(req, res, { from: ['pending'], to: 'rejected', action: 'business_account.rejected', title: 'Business account not verified' });
const adminSuspend = (req, res) => setStatus(req, res, { from: ['verified'], to: 'suspended', action: 'business_account.suspended', title: 'Business account suspended' });

/** Credit limit and terms. Can't go below what's already drawn. */
async function adminSetCredit(req, res) {
  const { creditLimitCents, paymentTermsDays } = req.body || {};
  if (!Number.isInteger(creditLimitCents) || creditLimitCents < 0) return res.status(400).json({ message: 'creditLimitCents must be zero or more.' });
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 180) {
    return res.status(400).json({ message: 'paymentTermsDays must be 0 to 180.' });
  }
  const client = await pool.connect();
  let before;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM business_accounts WHERE id = $1 FOR UPDATE', [Number(req.params.id)]);
    before = rows[0];
    if (!before) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Business account not found' });
    }
    const pos = await creditPosition(client, before.id);
    if (creditLimitCents < pos.usedCents) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `₹${(pos.usedCents / 100).toFixed(2)} is already drawn. Collect first, then lower the limit.` });
    }
    await client.query(
      'UPDATE business_accounts SET credit_limit_cents = $2, payment_terms_days = $3, updated_at = now() WHERE id = $1',
      [before.id, creditLimitCents, paymentTermsDays]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await recordAudit({
    actorUserId: req.user.id, action: 'business_account.credit_changed', module: 'customers', entityType: 'business_account', entityId: before.id,
    previousValue: { creditLimitCents: Number(before.credit_limit_cents), paymentTermsDays: before.payment_terms_days },
    newValue: { creditLimitCents, paymentTermsDays },
  });
  res.json(await loadDetail(before.id));
}

/** Money the business paid against its credit. Can't be more than it owes. */
async function adminRecordPayment(req, res) {
  const { amountCents } = req.body || {};
  const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim() : '';
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() || null : null;
  if (!Number.isInteger(amountCents) || amountCents <= 0) return res.status(400).json({ message: 'amountCents must be a positive whole number.' });
  if (!reference || reference.length > 60) return res.status(400).json({ message: 'Enter the payment reference (UTR, cheque no.).' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM business_accounts WHERE id = $1 FOR UPDATE', [Number(req.params.id)]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Business account not found' });
    }
    const pos = await creditPosition(client, rows[0].id);
    if (amountCents > pos.usedCents) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `They owe ₹${(pos.usedCents / 100).toFixed(2)} — the payment can't be more.` });
    }
    await client.query(
      'INSERT INTO business_credit_payments (account_id, amount_cents, reference, note, recorded_by) VALUES ($1, $2, $3, $4, $5)',
      [rows[0].id, amountCents, reference, note, req.user.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ message: 'That reference is already recorded for this business.' });
    throw err;
  } finally {
    client.release();
  }
  await audit(req, 'business_account.payment_recorded', req.params.id, { amountCents, reference });
  res.status(201).json(await loadDetail(req.params.id));
}

module.exports = {
  registerAccount, getMine, updateMine, addMember, updateMember, removeMember, addAddress, removeAddress, addDocument, myStatement,
  adminList, adminSummary, adminGet, adminVerify, adminReject, adminSuspend, adminSetCredit, adminRecordPayment,
};
