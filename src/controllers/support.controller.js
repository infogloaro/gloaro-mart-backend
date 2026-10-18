const pool = require('../config/db');
const { recordAudit } = require('../services/auditLog');
const { sendMail } = require('../services/mailer');

/**
 * Support tickets (schema SUPPORT TICKETS, PHASE 36). Customers and vendors
 * open them from the app; staff work them from Admin → Support Tickets.
 *
 * Deadlines come from the priority: how long until the first staff reply is
 * owed, and until it should be resolved, both counted from when it was opened.
 */

const MODULE = 'support';
const PAGE_SIZE = 25;
const CATEGORIES = ['order', 'payment', 'delivery', 'vendor', 'product', 'account', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'pending_customer', 'pending_vendor', 'resolved', 'closed'];
const DONE = ['resolved', 'closed'];
const MAX_OPEN_PER_USER = 5;
const ATTACHMENT_PATH = /^\/uploads\/support\/[\w.-]+$/;

/** Minutes until the first reply and the resolution are due, by priority. */
const SLA = {
  urgent: { firstResponse: 60, resolution: 8 * 60 },
  high: { firstResponse: 4 * 60, resolution: 24 * 60 },
  normal: { firstResponse: 8 * 60, resolution: 48 * 60 },
  low: { firstResponse: 24 * 60, resolution: 96 * 60 },
};
// Money problems jump the queue; everything else starts normal and staff adjust.
const DEFAULT_PRIORITY = { payment: 'high' };

class SupportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (res, err) => {
  if (err instanceof SupportError) return res.status(err.status).json({ message: err.message });
  throw err;
};

const dueAt = (createdAt, minutes) => new Date(new Date(createdAt).getTime() + minutes * 60000);

/** Validates a message body + attachments; returns clean values or throws. */
function readMessage(body) {
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text || text.length > 5000) throw new SupportError(400, 'Write a message of up to 5000 characters.');
  const attachments = body?.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 5 || !attachments.every((a) => typeof a === 'string' && ATTACHMENT_PATH.test(a))) {
    throw new SupportError(400, 'attachments must be up to 5 paths returned by POST /api/support/attachments');
  }
  return { text, attachments };
}

const SELECT = `
  SELECT t.*,
         COALESCE(u.full_name, u.email) AS requester_name, u.email AS requester_email, u.phone_number AS requester_phone,
         vp.business_name AS vendor_name,
         a.full_name AS assignee_name,
         CASE WHEN t.order_id IS NULL THEN NULL ELSE COALESCE(cg.reference, '#' || t.order_id) END AS order_reference,
         (SELECT COUNT(*)::int FROM support_ticket_messages m WHERE m.ticket_id = t.id AND NOT m.internal) AS message_count
  FROM support_tickets t
  JOIN users u ON u.id = t.requester_user_id
  LEFT JOIN vendor_profiles vp ON vp.id = t.vendor_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN orders o ON o.id = t.order_id
  LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id`;

const BREACHED = `t.status NOT IN ('resolved', 'closed') AND (
  (t.first_responded_at IS NULL AND t.first_response_due_at < now()) OR t.resolution_due_at < now())`;

function adminJson(t) {
  return {
    id: t.id,
    reference: t.reference,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    requesterType: t.requester_type,
    requesterName: t.requester_name,
    requesterEmail: t.requester_email,
    requesterPhone: t.requester_phone,
    orderId: t.order_id,
    orderReference: t.order_reference,
    vendorName: t.vendor_name,
    assigneeId: t.assignee_id,
    assigneeName: t.assignee_name,
    messageCount: t.message_count,
    lastMessageAt: t.last_message_at,
    lastMessageFrom: t.last_message_from,
    firstResponseDueAt: t.first_response_due_at,
    firstRespondedAt: t.first_responded_at,
    resolutionDueAt: t.resolution_due_at,
    createdAt: t.created_at,
    resolvedAt: t.resolved_at,
  };
}

/** The requester's view: no staff internals, no other customers' details. */
function requesterJson(t) {
  return {
    id: t.id,
    reference: t.reference,
    subject: t.subject,
    category: t.category,
    status: t.status,
    order_id: t.order_id,
    order_reference: t.order_reference,
    message_count: t.message_count,
    last_message_at: t.last_message_at,
    last_message_from: t.last_message_from,
    // "Waiting on you" is the one thing a requester needs from the status.
    awaiting_you: t.status === 'pending_customer' || (t.status === 'open' && t.last_message_from === 'admin'),
    created_at: t.created_at,
    resolved_at: t.resolved_at,
  };
}

async function loadMessages(ticketId, { includeInternal }) {
  const { rows } = await pool.query(
    `SELECT m.*, COALESCE(u.full_name, u.email) AS author_name
     FROM support_ticket_messages m LEFT JOIN users u ON u.id = m.author_user_id
     WHERE m.ticket_id = $1 ${includeInternal ? '' : 'AND NOT m.internal'}
     ORDER BY m.created_at, m.id`,
    [ticketId]
  );
  return rows;
}

async function addMessage(client, { ticketId, userId, role, text, internal = false, attachments = [] }) {
  await client.query(
    `INSERT INTO support_ticket_messages (ticket_id, author_user_id, author_role, body, internal, attachments)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [ticketId, userId, role, text, internal, JSON.stringify(attachments)]
  );
}

/** Tells the requester in the app, and by email when mail is configured (never fails the request). */
async function tellRequester(ticket, title, text) {
  await pool.query('INSERT INTO notifications (user_id, type, title, body, deep_link) VALUES ($1, $2, $3, $4, $5)', [
    ticket.requester_user_id,
    'support_reply',
    title,
    text.slice(0, 500),
    `/support/tickets/${ticket.id}`,
  ]);
  if (!ticket.requester_email || !process.env.RESEND_API_KEY) return;
  try {
    await sendMail({
      to: ticket.requester_email,
      subject: `[${ticket.reference}] ${ticket.subject}`,
      text: `${title}\n\n${text}\n\nReply in the Gloaro Mart app under Help & Support.`,
    });
  } catch (err) {
    console.error(`[support] email for ${ticket.reference} failed: ${err.message}`);
  }
}

async function loadTicket(id) {
  const { rows } = await pool.query(`${SELECT} WHERE t.id = $1`, [Number(id)]);
  return rows[0] ?? null;
}

// ------------------------------------------------------------- requesters

const requesterRole = (req) => (req.user.role === 'vendor' ? 'vendor' : 'customer');

/** The requester's own ticket or a 404 — someone else's ticket doesn't exist for them. */
async function ownTicket(req) {
  const t = await loadTicket(req.params.id);
  if (!t || t.requester_user_id !== req.user.id) throw new SupportError(404, 'Ticket not found');
  return t;
}

async function createTicket(req, res) {
  try {
    const role = requesterRole(req);
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    if (!subject || subject.length > 160) throw new SupportError(400, 'subject must be 1 to 160 characters');
    const category = req.body?.category ?? 'other';
    if (!CATEGORIES.includes(category)) throw new SupportError(400, `category must be one of ${CATEGORIES.join(', ')}`);
    const message = readMessage(req.body);

    // The shop involved, and the order if one was named — which must be the requester's own.
    let vendorId = null;
    if (role === 'vendor') {
      const { rows } = await pool.query('SELECT id FROM vendor_profiles WHERE user_id = $1', [req.user.id]);
      vendorId = rows[0]?.id ?? null;
    }
    let orderId = null;
    if (req.body?.orderId != null) {
      const { rows } = await pool.query(
        role === 'vendor' ? 'SELECT id, vendor_id FROM orders WHERE id = $1 AND vendor_id = $2' : 'SELECT id, vendor_id FROM orders WHERE id = $1 AND user_id = $2',
        [req.body.orderId, role === 'vendor' ? vendorId : req.user.id]
      );
      if (!rows[0]) throw new SupportError(404, 'Order not found');
      orderId = rows[0].id;
      vendorId = rows[0].vendor_id;
    }

    const { rows: openRows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM support_tickets WHERE requester_user_id = $1 AND status NOT IN ('resolved', 'closed')",
      [req.user.id]
    );
    if (openRows[0].n >= MAX_OPEN_PER_USER) {
      throw new SupportError(429, `You already have ${MAX_OPEN_PER_USER} open tickets. Add to one of them instead.`);
    }

    const priority = DEFAULT_PRIORITY[category] ?? 'normal';
    const now = new Date();
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      const { rows: seq } = await client.query("SELECT nextval('support_ticket_ref_seq') AS n");
      const reference = `TKT-${now.getFullYear()}-${String(seq[0].n).padStart(5, '0')}`;
      const { rows } = await client.query(
        `INSERT INTO support_tickets (reference, requester_user_id, requester_type, vendor_id, order_id, subject, category,
           priority, first_response_due_at, resolution_due_at, last_message_at, last_message_from, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $3, $11) RETURNING id`,
        [reference, req.user.id, role, vendorId, orderId, subject, category, priority,
          dueAt(now, SLA[priority].firstResponse), dueAt(now, SLA[priority].resolution), now]
      );
      id = rows[0].id;
      await addMessage(client, { ticketId: id, userId: req.user.id, role, text: message.text, attachments: message.attachments });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json(requesterJson(await loadTicket(id)));
  } catch (err) {
    fail(res, err);
  }
}

async function listMyTickets(req, res) {
  const { rows } = await pool.query(`${SELECT} WHERE t.requester_user_id = $1 ORDER BY t.last_message_at DESC LIMIT 100`, [
    req.user.id,
  ]);
  res.json({ items: rows.map(requesterJson), categories: CATEGORIES });
}

async function getMyTicket(req, res) {
  try {
    const t = await ownTicket(req);
    const messages = await loadMessages(t.id, { includeInternal: false });
    res.json({
      ...requesterJson(t),
      messages: messages.map((m) => ({
        id: m.id,
        from: m.author_role,
        // Staff appear as the team, not by name.
        author_name: m.author_role === 'admin' ? 'Gloaro Mart Support' : m.author_role === 'system' ? null : m.author_name,
        body: m.body,
        attachments: m.attachments,
        created_at: m.created_at,
      })),
    });
  } catch (err) {
    fail(res, err);
  }
}

/** The requester adding to their ticket. Re-opens one that was waiting on them or resolved. */
async function replyToMyTicket(req, res) {
  try {
    const t = await ownTicket(req);
    if (t.status === 'closed') throw new SupportError(409, 'This ticket is closed. Open a new one if you still need help.');
    const message = readMessage(req.body);
    const role = t.requester_type;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await addMessage(client, { ticketId: t.id, userId: req.user.id, role, text: message.text, attachments: message.attachments });
      await client.query(
        `UPDATE support_tickets SET status = 'open', resolved_at = NULL, last_message_at = now(), last_message_from = $2, updated_at = now()
         WHERE id = $1`,
        [t.id, role]
      );
      if (t.status !== 'open') {
        await addMessage(client, { ticketId: t.id, userId: null, role: 'system', text: 'Reopened by the requester\'s reply', internal: true });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    req.params.id = t.id;
    return getMyTicket(req, res);
  } catch (err) {
    fail(res, err);
  }
}

/** The requester saying it's sorted. */
async function resolveMyTicket(req, res) {
  try {
    const t = await ownTicket(req);
    if (DONE.includes(t.status)) throw new SupportError(409, `This ticket is already ${t.status}.`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE support_tickets SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1", [t.id]);
      await addMessage(client, { ticketId: t.id, userId: null, role: 'system', text: 'Marked resolved by the requester' });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json(requesterJson(await loadTicket(t.id)));
  } catch (err) {
    fail(res, err);
  }
}

// ------------------------------------------------------------------ admin

const ADMIN_FILTERS = {
  open: "t.status NOT IN ('resolved', 'closed')",
  unassigned: "t.status NOT IN ('resolved', 'closed') AND t.assignee_id IS NULL",
  breached: BREACHED,
  resolved: "t.status IN ('resolved', 'closed')",
};
// Open work: most urgent first, then whichever deadline comes soonest.
const OPEN_ORDER = `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
  COALESCE(CASE WHEN t.first_responded_at IS NULL THEN t.first_response_due_at END, t.resolution_due_at) ASC`;

async function adminListTickets(req, res) {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const conditions = [];
  const params = [];
  if (req.query.filter) {
    if (!ADMIN_FILTERS[req.query.filter]) return res.status(400).json({ message: 'Unknown filter' });
    conditions.push(ADMIN_FILTERS[req.query.filter]);
  }
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(t.subject ILIKE ${p} OR t.reference ILIKE ${p} OR u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR cg.reference ILIKE ${p} OR vp.business_name ILIKE ${p})`
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = ['resolved', undefined].includes(req.query.filter) ? 't.last_message_at DESC' : OPEN_ORDER;
  const [{ rows }, { rows: count }] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY ${order}, t.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM support_tickets t JOIN users u ON u.id = t.requester_user_id
       LEFT JOIN vendor_profiles vp ON vp.id = t.vendor_id LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN checkout_groups cg ON cg.id = o.checkout_group_id ${where}`,
      params
    ),
  ]);
  res.json({ items: rows.map(adminJson), total: count[0].total, page, pageSize: PAGE_SIZE });
}

async function adminSummary(req, res) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE t.status NOT IN ('resolved', 'closed'))::int AS open,
       COUNT(*) FILTER (WHERE t.status NOT IN ('resolved', 'closed') AND t.assignee_id IS NULL)::int AS unassigned,
       COUNT(*) FILTER (WHERE ${BREACHED})::int AS breached,
       COUNT(*) FILTER (WHERE t.status = 'open' AND t.last_message_from IN ('customer', 'vendor'))::int AS awaiting_us,
       COUNT(*) FILTER (WHERE t.resolved_at >= date_trunc('day', now()))::int AS resolved_today,
       AVG(EXTRACT(EPOCH FROM (t.first_responded_at - t.created_at)) / 60)
         FILTER (WHERE t.first_responded_at IS NOT NULL AND t.created_at >= now() - interval '30 days')::float AS avg_first_response
     FROM support_tickets t`
  );
  const s = rows[0];
  res.json({
    open: s.open,
    unassigned: s.unassigned,
    breached: s.breached,
    awaitingUs: s.awaiting_us,
    resolvedToday: s.resolved_today,
    avgFirstResponseMinutes: s.avg_first_response,
  });
}

async function adminGetTicket(req, res) {
  const t = await loadTicket(req.params.id);
  if (!t) return res.status(404).json({ message: 'Ticket not found' });
  const messages = await loadMessages(t.id, { includeInternal: true });
  res.json({
    ...adminJson(t),
    messages: messages.map((m) => ({
      id: m.id,
      from: m.author_role,
      authorName: m.author_name,
      body: m.body,
      internal: m.internal,
      attachments: m.attachments,
      createdAt: m.created_at,
    })),
  });
}

/** Staff who can work tickets: super admins and roles with support edit. */
async function listAgents(req, res) {
  const { rows } = await pool.query(
    `SELECT u.id, COALESCE(u.full_name, u.email) AS name,
            (SELECT COUNT(*)::int FROM support_tickets t WHERE t.assignee_id = u.id AND t.status NOT IN ('resolved', 'closed')) AS open_tickets
     FROM users u JOIN staff_roles r ON r.id = u.staff_role_id
     WHERE u.role = 'admin' AND (r.slug = 'super_admin' OR EXISTS (
       SELECT 1 FROM staff_role_permissions p WHERE p.role_id = r.id AND p.permission IN ('support.edit', 'support.delete')))
     ORDER BY name`
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.name, openTickets: r.open_tickets })));
}

async function isAgent(userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM users u JOIN staff_roles r ON r.id = u.staff_role_id
     WHERE u.id = $1 AND u.role = 'admin' AND (r.slug = 'super_admin' OR EXISTS (
       SELECT 1 FROM staff_role_permissions p WHERE p.role_id = r.id AND p.permission IN ('support.edit', 'support.delete')))`,
    [userId]
  );
  return rows.length > 0;
}

/** Owner, priority and status. Each change is noted in the thread and the audit log. */
async function adminUpdateTicket(req, res) {
  try {
    const b = req.body || {};
    const t = await loadTicket(req.params.id);
    if (!t) throw new SupportError(404, 'Ticket not found');
    const sets = [];
    const params = [t.id];
    const notes = [];
    let tell = null;
    const set = (sql, value) => {
      params.push(value);
      sets.push(sql.replace('?', `$${params.length}`));
    };

    if ('assigneeId' in b && b.assigneeId !== t.assignee_id) {
      if (b.assigneeId !== null && !(Number.isInteger(b.assigneeId) && (await isAgent(b.assigneeId)))) {
        throw new SupportError(400, 'That person cannot work support tickets.');
      }
      set('assignee_id = ?', b.assigneeId);
      const { rows } = b.assigneeId ? await pool.query('SELECT COALESCE(full_name, email) AS n FROM users WHERE id = $1', [b.assigneeId]) : { rows: [] };
      notes.push(b.assigneeId ? `Assigned to ${rows[0].n}` : 'Unassigned');
    }
    if ('priority' in b && b.priority !== t.priority) {
      if (!PRIORITIES.includes(b.priority)) throw new SupportError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
      // Deadlines follow the priority, counted from when the ticket was opened.
      set('priority = ?', b.priority);
      set('first_response_due_at = ?', dueAt(t.created_at, SLA[b.priority].firstResponse));
      set('resolution_due_at = ?', dueAt(t.created_at, SLA[b.priority].resolution));
      notes.push(`Priority ${t.priority} → ${b.priority}`);
    }
    if ('status' in b && b.status !== t.status) {
      if (!STATUSES.includes(b.status)) throw new SupportError(400, `status must be one of ${STATUSES.join(', ')}`);
      if (t.status === 'closed') throw new SupportError(409, 'A closed ticket stays closed. The requester can open a new one.');
      set('status = ?', b.status);
      if (DONE.includes(b.status)) {
        sets.push('resolved_at = COALESCE(resolved_at, now())');
        tell = b.status === 'resolved' ? 'Your ticket was resolved' : 'Your ticket was closed';
      } else {
        sets.push('resolved_at = NULL');
      }
      notes.push(`Status ${t.status.replace('_', ' ')} → ${b.status.replace('_', ' ')}`);
    }
    if (sets.length === 0) return res.json(adminJson(t));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE support_tickets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
      for (const note of notes) {
        await addMessage(client, { ticketId: t.id, userId: req.user.id, role: 'system', text: note, internal: true });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    if (tell) await tellRequester(t, tell, `${t.reference}: ${t.subject}`);
    await recordAudit({
      actorUserId: req.user.id,
      action: 'support_ticket.updated',
      module: MODULE,
      entityType: 'support_ticket',
      entityId: t.id,
      previousValue: { assigneeId: t.assignee_id, priority: t.priority, status: t.status },
      newValue: notes,
    });
    res.json(adminJson(await loadTicket(t.id)));
  } catch (err) {
    fail(res, err);
  }
}

/**
 * A staff reply or internal note. A reply is the first response if none went
 * out yet, and tells the requester (app notification + email when configured).
 * Replying to a resolved ticket re-opens it; a closed one is refused.
 */
async function adminAddMessage(req, res) {
  try {
    const t = await loadTicket(req.params.id);
    if (!t) throw new SupportError(404, 'Ticket not found');
    if (t.status === 'closed') throw new SupportError(409, 'This ticket is closed.');
    const message = readMessage(req.body);
    const internal = req.body?.internal === true;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await addMessage(client, { ticketId: t.id, userId: req.user.id, role: 'admin', text: message.text, internal, attachments: message.attachments });
      if (!internal) {
        await client.query(
          `UPDATE support_tickets SET first_responded_at = COALESCE(first_responded_at, now()),
             last_message_at = now(), last_message_from = 'admin',
             status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
             resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END,
             -- Whoever answers an unowned ticket owns it.
             assignee_id = COALESCE(assignee_id, $2), updated_at = now()
           WHERE id = $1`,
          [t.id, req.user.id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    if (!internal) await tellRequester(t, `New reply on ${t.reference}`, message.text);
    res.status(201).json(adminJson(await loadTicket(t.id)));
  } catch (err) {
    fail(res, err);
  }
}

module.exports = {
  SLA,
  createTicket,
  listMyTickets,
  getMyTicket,
  replyToMyTicket,
  resolveMyTicket,
  adminListTickets,
  adminSummary,
  adminGetTicket,
  listAgents,
  adminUpdateTicket,
  adminAddMessage,
};
