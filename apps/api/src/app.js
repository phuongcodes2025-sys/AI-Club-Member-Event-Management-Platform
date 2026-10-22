import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import QRCode from 'qrcode';

const roles = ['Member', 'Officer', 'Advisor', 'Administrator'];
const staff = ['Officer', 'Administrator'];
const readers = ['Officer', 'Advisor', 'Administrator'];
const kinds = ['Workshop', 'Hackathon', 'Competition', 'Mentoring', 'Other'];
const uuid = z.uuid();
const eventInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(''),
  kind: z.enum(kinds),
  location: z.string().trim().min(1).max(500),
  starts_at: z.iso.datetime({ offset: true }),
  ends_at: z.iso.datetime({ offset: true }),
  capacity: z.number().int().positive().max(100000),
}).strict();
const memberFields = 'id,name,email,role,bio,interests,created_at';
const eventFields = 'id,title,description,kind,location,starts_at,ends_at,capacity,created_by,cancelled_at,created_at';
const publicEvent = event => Object.fromEntries(eventFields.split(',').map(key => [key,event[key]]));
const fail = (status, message) => Object.assign(new Error(message), { status });
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw fail(400, 'Invalid request data');
  return result.data;
};
const requireRole = allowed => (req, res, next) =>
  allowed.includes(req.member.role) ? next() : res.status(403).json({ error: 'Insufficient permissions' });

async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function enqueue(client, kind, payload, key = null) {
  await client.query('INSERT INTO jobs(kind,payload,unique_key) VALUES($1,$2,$3) ON CONFLICT(unique_key) DO NOTHING',
    [kind, JSON.stringify(payload), key]);
}

async function notify(client, member, title, body) {
  await client.query('INSERT INTO notifications(member_id,title,body) VALUES($1,$2,$3)', [member.id, title, body]);
  if (member.email) await enqueue(client, 'email', { to: member.email, subject: title, body });
}

async function lockedEvent(client, id) {
  const { rows } = await client.query('SELECT * FROM events WHERE id=$1 FOR UPDATE', [id]);
  if (!rows[0]) throw fail(404, 'Event not found');
  return rows[0];
}

function escapeICS(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}
function foldICS(line) {
  const lines = [];
  let part = '';
  for (const char of line) {
    if (Buffer.byteLength(part + char) > 75) { lines.push(part); part = ' '; }
    part += char;
  }
  return [...lines, part].join('\r\n');
}
function calendar(event) {
  const date = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//AI Club//Events//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'BEGIN:VEVENT',`UID:${event.id}@ai-club`,`DTSTAMP:${date(new Date())}`,`DTSTART:${date(event.starts_at)}`,
    `DTEND:${date(event.ends_at)}`,`SUMMARY:${escapeICS(event.title)}`,`DESCRIPTION:${escapeICS(event.description)}`,
    `LOCATION:${escapeICS(event.location)}`,`STATUS:${event.cancelled_at ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT','END:VCALENDAR'].map(foldICS).join('\r\n') + '\r\n';
}

async function reports(pool) {
  const [totals, byKind, byEvent, byMember] = await Promise.all([
    pool.query(`SELECT (SELECT count(*)::int FROM members) members,(SELECT count(*)::int FROM events) events,
      count(*)::int registrations,count(checked_in_at)::int attendance FROM registrations`),
    pool.query(`SELECT e.kind,count(r.id)::int registrations,count(r.checked_in_at)::int attendance
      FROM events e LEFT JOIN registrations r ON r.event_id=e.id GROUP BY e.kind ORDER BY e.kind`),
    pool.query(`SELECT e.id,e.title,count(r.id)::int registrations,count(r.checked_in_at)::int attendance
      FROM events e LEFT JOIN registrations r ON r.event_id=e.id GROUP BY e.id ORDER BY e.starts_at`),
    pool.query(`SELECT m.id,m.name,count(r.id)::int registrations,count(r.checked_in_at)::int attendance
      FROM members m LEFT JOIN registrations r ON r.member_id=m.id GROUP BY m.id ORDER BY m.name`),
  ]);
  const total = totals.rows[0];
  return { ...total, engagement_rate: total.registrations ? total.attendance / total.registrations : 0,
    by_kind: kinds.map(kind => byKind.rows.find(row => row.kind === kind) || { kind, registrations: 0, attendance: 0 }),
    by_event: byEvent.rows, by_member: byMember.rows };
}

export function createApp({ pool, authenticate, config = {} }) {
  if (!pool || typeof authenticate !== 'function') throw new Error('Pool and authentication middleware are required');
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  const webOrigin = config.webOrigin || process.env.WEB_ORIGIN || 'http://localhost:3000';
  app.use(cors({ origin(origin, callback) {
    if (!origin || origin === webOrigin) callback(null, true);
    else callback(fail(403, 'Origin not allowed'));
  }, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type'] }));
  app.use(express.json({ limit: '32kb' }));
  app.use(rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.get('/health', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/api', authenticate, async (req, res, next) => {
    if (!req.identity || !uuid.safeParse(req.identity.oid).success || !uuid.safeParse(req.identity.tid).success) {
      return res.status(401).json({ error: 'Invalid identity' });
    }
    const { oid, tid, name = 'Club member', email = '' } = req.identity;
    const admins = config.adminObjectIds || (process.env.ADMIN_OBJECT_IDS || '').split(',').map(x => x.trim().toLowerCase());
    const { rows } = await pool.query(`INSERT INTO members(id,tenant_id,name,email,role) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id WHERE members.tenant_id=EXCLUDED.tenant_id
      RETURNING ${memberFields}`, [oid, tid, name, email, admins.includes(oid.toLowerCase()) ? 'Administrator' : 'Member']);
    if (!rows[0]) return res.status(403).json({ error: 'Identity tenant mismatch' });
    req.member = rows[0];
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/me', (req, res) => res.json(req.member));
  app.patch('/api/me', async (req, res) => {
    const data = parse(z.object({
      name: z.string().trim().min(1).max(200).optional(),
      bio: z.string().max(2000).optional(), interests: z.string().max(2000).optional(),
    }).strict().refine(x => Object.keys(x).length > 0), req.body);
    const keys = Object.keys(data);
    const { rows } = await pool.query(`UPDATE members SET ${keys.map((key, i) => `${key}=$${i + 2}`).join(',')}
      WHERE id=$1 RETURNING ${memberFields}`, [req.member.id, ...Object.values(data)]);
    res.json(rows[0]);
  });
  const eventQuery = `SELECT ${eventFields.split(',').map(key => `e.${key}`).join(',')}, count(r.id)::int registered_count,
    COALESCE(bool_or(r.member_id=$1),false) registered FROM events e LEFT JOIN registrations r ON r.event_id=e.id`;
  app.get('/api/events', async (req, res) => {
    res.json((await pool.query(`${eventQuery} GROUP BY e.id ORDER BY e.starts_at`, [req.member.id])).rows);
  });
  app.get('/api/events/:id', async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { rows } = await pool.query(`${eventQuery} WHERE e.id=$2 GROUP BY e.id`, [req.member.id, id]);
    if (!rows[0]) throw fail(404, 'Event not found');
    res.json(rows[0]);
  });
  app.post('/api/events', requireRole(staff), async (req, res) => {
    const data = parse(eventInput, req.body);
    if (new Date(data.ends_at) <= new Date(data.starts_at) || new Date(data.starts_at) <= new Date()) {
      throw fail(400, 'Event must start in the future and end after its start');
    }
    const event = await transaction(pool, async client => {
      const { rows } = await client.query(`INSERT INTO events(title,description,kind,location,starts_at,ends_at,capacity,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [data.title,data.description,data.kind,data.location,data.starts_at,data.ends_at,data.capacity,req.member.id]);
      const e = rows[0];
      await enqueue(client, 'announce', { event_id: e.id, title: e.title, description: e.description, starts_at: e.starts_at, location: e.location }, `announce:${e.id}`);
      await enqueue(client, 'calendar', { event_id: e.id }, `calendar:${e.id}`);
      return e;
    });
    res.status(201).json(publicEvent(event));
  });
  app.patch('/api/events/:id', requireRole(staff), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const data = parse(eventInput.partial().extend({ cancelled: z.boolean().optional() })
      .refine(x => Object.keys(x).length > 0), req.body);
    const event = await transaction(pool, async client => {
      const old = await lockedEvent(client, id);
      const merged = { ...old, ...data };
      if (new Date(merged.ends_at) <= new Date(merged.starts_at)) throw fail(400, 'Event end must follow start');
      const count = await client.query('SELECT count(*)::int n FROM registrations WHERE event_id=$1', [id]);
      if (merged.capacity < count.rows[0].n) throw fail(409, 'Capacity cannot be below registered count');
      const cancelledAt = data.cancelled === undefined ? old.cancelled_at : data.cancelled ? old.cancelled_at || new Date() : null;
      const { rows } = await client.query(`UPDATE events SET title=$2,description=$3,kind=$4,location=$5,starts_at=$6,
        ends_at=$7,capacity=$8,cancelled_at=$9 WHERE id=$1 RETURNING *`,
      [id,merged.title,merged.description,merged.kind,merged.location,merged.starts_at,merged.ends_at,merged.capacity,cancelledAt]);
      const members = await client.query('SELECT m.id,m.email FROM members m JOIN registrations r ON r.member_id=m.id WHERE r.event_id=$1', [id]);
      for (const member of members.rows) await notify(client, member, cancelledAt ? 'Event cancelled' : 'Event updated', `${merged.title}: check the event page for details.`);
      const startChanged = data.starts_at !== undefined && +new Date(data.starts_at) !== +old.starts_at;
      if (cancelledAt || startChanged) {
        await client.query(`DELETE FROM jobs WHERE completed_at IS NULL AND locked_at IS NULL
          AND kind='email' AND payload->>'registration_id' IN
            (SELECT id::text FROM registrations WHERE event_id=$1)`, [id]);
        await client.query('UPDATE registrations SET reminder_queued_at=NULL WHERE event_id=$1', [id]);
      }
      await enqueue(client, 'calendar', { event_id: id });
      return rows[0];
    });
    res.json(publicEvent(event));
  });
  app.post('/api/events/:id/register', async (req, res) => {
    const id = parse(uuid, req.params.id);
    const registration = await transaction(pool, async client => {
      const event = await lockedEvent(client, id);
      if (event.cancelled_at || event.starts_at <= new Date()) throw fail(409, 'Event is cancelled or has started');
      const existing = await client.query('SELECT id FROM registrations WHERE event_id=$1 AND member_id=$2', [id, req.member.id]);
      if (existing.rowCount) throw fail(409, 'Already registered');
      const count = await client.query('SELECT count(*)::int n FROM registrations WHERE event_id=$1', [id]);
      if (count.rows[0].n >= event.capacity) throw fail(409, 'Event is full');
      const { rows } = await client.query('INSERT INTO registrations(event_id,member_id) VALUES($1,$2) RETURNING *', [id,req.member.id]);
      await notify(client, req.member, 'Registration confirmed', `You are registered for ${event.title}.`);
      return rows[0];
    });
    res.status(201).json(registration);
  });
  app.delete('/api/events/:id/register', async (req, res) => {
    const id = parse(uuid, req.params.id);
    await transaction(pool, async client => {
      const event = await lockedEvent(client, id);
      const { rows } = await client.query('SELECT * FROM registrations WHERE event_id=$1 AND member_id=$2 FOR UPDATE', [id,req.member.id]);
      if (!rows[0]) throw fail(404, 'Registration not found');
      if (rows[0].checked_in_at || event.starts_at <= new Date()) throw fail(409, 'Attendance history cannot be removed after the event starts');
      await client.query('DELETE FROM registrations WHERE id=$1', [rows[0].id]);
      await client.query(`DELETE FROM jobs WHERE completed_at IS NULL AND locked_at IS NULL AND kind='email'
        AND payload->>'registration_id'=$1`, [rows[0].id]);
    });
    res.status(204).end();
  });
  app.get('/api/me/registrations', async (req, res) => {
    res.json((await pool.query(`SELECT r.id,r.event_id,r.checked_in_at,r.checkin_token,r.created_at,
      e.title,e.kind,e.starts_at,e.ends_at,e.location,e.cancelled_at FROM registrations r
      JOIN events e ON e.id=r.event_id WHERE r.member_id=$1 ORDER BY e.starts_at`, [req.member.id])).rows);
  });
  app.get('/api/registrations/:id/qr', async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { rows } = await pool.query('SELECT member_id,checkin_token FROM registrations WHERE id=$1', [id]);
    if (!rows[0]) throw fail(404, 'Registration not found');
    if (rows[0].member_id !== req.member.id && !staff.includes(req.member.role)) throw fail(403, 'Insufficient permissions');
    res.type('image/svg+xml').send(await QRCode.toString(rows[0].checkin_token, { type: 'svg' }));
  });
  app.post('/api/attendance/check-in', requireRole(staff), async (req, res) => {
    const { token } = parse(z.object({ token: uuid }).strict(), req.body);
    const registration = await transaction(pool, async client => {
      const found = await client.query('SELECT event_id FROM registrations WHERE checkin_token=$1', [token]);
      if (!found.rows[0]) throw fail(404, 'Registration not found');
      const event = await lockedEvent(client, found.rows[0].event_id);
      const { rows } = await client.query(`SELECT r.*,m.name member_name FROM registrations r
        JOIN members m ON m.id=r.member_id WHERE r.checkin_token=$1 FOR UPDATE OF r`, [token]);
      if (!rows[0]) throw fail(404, 'Registration not found');
      if (event.cancelled_at) throw fail(409, 'Event is cancelled');
      if (rows[0].checked_in_at) throw fail(409, 'Already checked in');
      const now = Date.now();
      if (now < +event.starts_at - 7200000 || now > +event.ends_at + 7200000) throw fail(409, 'Outside check-in window');
      const updated = await client.query('UPDATE registrations SET checked_in_at=now() WHERE id=$1 RETURNING *', [rows[0].id]);
      return { ...updated.rows[0], member_name: rows[0].member_name, event_title: event.title };
    });
    res.json(registration);
  });
  app.get('/api/members', requireRole(readers), async (req, res) => {
    res.json((await pool.query(`SELECT ${memberFields} FROM members ORDER BY name`)).rows);
  });
  app.patch('/api/members/:id/role', requireRole(['Administrator']), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { role } = parse(z.object({ role: z.enum(roles) }).strict(), req.body);
    const member = await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(741820032)');
      const { rows } = await client.query('SELECT * FROM members WHERE id=$1 FOR UPDATE', [id]);
      if (!rows[0]) throw fail(404, 'Member not found');
      if (rows[0].role === 'Administrator' && role !== 'Administrator') {
        const count = await client.query("SELECT count(*)::int n FROM members WHERE role='Administrator'");
        if (count.rows[0].n <= 1) throw fail(409, 'Cannot demote the last administrator');
      }
      return (await client.query(`UPDATE members SET role=$2 WHERE id=$1 RETURNING ${memberFields}`, [id,role])).rows[0];
    });
    res.json(member);
  });
  app.get('/api/reports', requireRole(readers), async (req, res) => res.json(await reports(pool)));
  app.get('/api/reports/export', requireRole(readers), async (req, res) => {
    const report = await reports(pool);
    const cell = value => {
      let text = String(value ?? '');
      if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const rows = [['event_id','title','registrations','attendance'],
      ...report.by_event.map(e => [e.id,e.title,e.registrations,e.attendance])];
    res.attachment('engagement.csv').type('text/csv').send(rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n');
  });
  app.get('/api/notifications', async (req, res) => {
    res.json((await pool.query('SELECT * FROM notifications WHERE member_id=$1 ORDER BY created_at DESC,id DESC', [req.member.id])).rows);
  });
  app.patch('/api/notifications/:id/read', async (req, res) => {
    const id = parse(z.string().regex(/^[1-9]\d{0,17}$/), req.params.id);
    const { rows } = await pool.query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND member_id=$2 RETURNING *', [id, req.member.id]);
    if (!rows[0]) throw fail(404, 'Notification not found');
    res.json(rows[0]);
  });
  app.get('/api/events/:id/calendar', async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { rows } = await pool.query('SELECT * FROM events WHERE id=$1', [id]);
    if (!rows[0]) throw fail(404, 'Event not found');
    res.attachment(`event-${id}.ics`).type('text/calendar; charset=utf-8').send(calendar(rows[0]));
  });
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === 'entity.too.large' ? 413 :
      error.type === 'entity.parse.failed' ? 400 : error.code === '23505' ? 409 :
      Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'Internal server error' :
      status === 413 ? 'Request body is too large' : status === 400 ? 'Invalid request data' :
      error.code === '23505' ? 'Resource already exists' : error.message });
  });
  return app;
}
