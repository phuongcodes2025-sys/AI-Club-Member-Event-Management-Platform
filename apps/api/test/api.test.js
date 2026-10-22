import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) console.warn('PostgreSQL integration tests skipped: set TEST_DATABASE_URL explicitly.');

test('proxy trust defaults to zero and honors explicitly configured hop count', () => {
  const options = { pool: {}, authenticate(req, res, next) { next(); } };
  assert.equal(createApp(options).get('trust proxy'), 0);
  assert.equal(createApp({ ...options, config: { trustProxyHops: 2 } }).get('trust proxy'), 2);
});

test('PostgreSQL API: role boundaries, atomic capacity, cancellation, history, QR, exports and reports', { skip: !databaseUrl }, async t => {
  const schema = `api_test_${randomUUID().replaceAll('-', '')}`;
  const admin = randomUUID(), member = randomUUID(), second = randomUUID(), advisor = randomUUID(), officer = randomUUID();
  const tenant = randomUUID();
  const management = new pg.Pool({ connectionString: databaseUrl });
  await management.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  let server;
  try {
    await migrate(pool);
    await migrate(pool);
    assert.equal((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 1);
    const app = createApp({ pool, config: { adminObjectIds: [admin] }, authenticate(req, res, next) {
      const id = req.get('x-test-member');
      if (!id) return res.status(401).json({ error: 'Unauthenticated' });
      req.identity = { oid: id, tid: req.get('x-test-tenant') || tenant, name: `Member ${id}`, email: 'person@example.org' };
      next();
    } });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function request(path, { method = 'GET', body, as = member, headers = {} } = {}) {
      return fetch(`${origin}${path}`, { method, headers: { ...(as ? { 'x-test-member': as } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    }
    async function json(path, opts) {
      const response = await request(path, opts);
      const body = await response.json();
      return { status: response.status, body };
    }
    const newEvent = extra => ({ title: 'Workshop', description: 'Learn', kind: 'Workshop', location: 'Club',
      starts_at: new Date(Date.now() + 3600000).toISOString(), ends_at: new Date(Date.now() + 7200000).toISOString(),
      capacity: 1, ...extra });
    await t.test('public health, strict origins, authentication and default member provisioning', async () => {
      assert.equal((await request('/health', { as: null })).status, 200);
      assert.equal((await request('/api/me', { as: null })).status, 401);
      assert.equal((await request('/api/me', { headers: { origin: 'https://evil.example' } })).status, 403);
      assert.equal((await json('/api/me')).body.role, 'Member');
      assert.equal((await json('/api/me', { as: admin })).body.role, 'Administrator');
      assert.equal((await json('/api/me', { as: second })).body.role, 'Member');
      assert.equal((await request('/api/me', { headers: { 'x-test-tenant': randomUUID() } })).status, 403);
      await json('/api/me', { as: advisor });
      await json('/api/me', { as: officer });
      await pool.query("UPDATE members SET role='Advisor' WHERE id=$1", [advisor]);
      await pool.query("UPDATE members SET role='Officer' WHERE id=$1", [officer]);
      assert.equal((await json('/api/me', { method: 'PATCH', body: { role: 'Administrator' } })).status, 400);
      assert.equal((await json('/api/me', { method: 'PATCH', body: { bio: 'AI enthusiast', interests: 'ML', name: 'New name' } })).body.name, 'New name');
      assert.equal((await request('/api/members')).status, 403);
      assert.equal((await request('/api/reports')).status, 403);
      assert.equal((await request('/api/members', { as: advisor })).status, 200);
      assert.equal((await request('/api/events', { method: 'POST', body: newEvent(), as: advisor })).status, 403);
      assert.equal((await request('/api/attendance/check-in', { method: 'POST', body: { token: randomUUID() }, as: advisor })).status, 403);
      assert.equal((await request(`/api/members/${admin}/role`, { method: 'PATCH', as: admin, body: { role: 'Member' } })).status, 409);
      await pool.query("UPDATE members SET role='Member' WHERE id=$1", [admin]);
      assert.equal((await json('/api/me', { as: admin })).body.role, 'Member');
      await pool.query("UPDATE members SET role='Administrator' WHERE id=$1", [admin]);
    });
    let event, registration, owner, other;
    await t.test('event input validation and transactional outbox', async () => {
      assert.equal((await request('/api/events', { method: 'POST', as: member, body: newEvent() })).status, 403);
      for (const body of [newEvent({ capacity: 0 }),newEvent({ title: '' }),newEvent({ kind: 'Wrong' }),
        newEvent({ starts_at: '2026-01-01T00:00:00' }),newEvent({ starts_at: '2020-01-01T00:00:00Z' }),
        newEvent({ ends_at: new Date().toISOString() }),newEvent({ unexpected: true })]) {
        assert.equal((await request('/api/events', { method: 'POST', as: officer, body })).status, 400);
      }
      const result = await json('/api/events', { method: 'POST', as: officer, body: newEvent({ title: '=HYPERLINK("bad")\r\nBEGIN:BAD' }) });
      assert.equal(result.status, 201);
      event = result.body;
      assert.equal('outlook_event_id' in event, false);
      const jobs = await pool.query('SELECT kind FROM jobs ORDER BY id');
      assert.deepEqual(jobs.rows.map(x => x.kind), ['announce','calendar']);
      assert.equal((await request('/api/events/not-an-id')).status, 400);
      assert.equal((await request(`/api/events/${randomUUID()}`)).status, 404);
    });
    await t.test('concurrent capacity-one registrations never overbook and duplicate is conflict', async () => {
      const responses = await Promise.all([member,second].map(as => json(`/api/events/${event.id}/register`, { method: 'POST', as })));
      assert.deepEqual(responses.map(x => x.status).sort(), [201,409]);
      owner = responses[0].status === 201 ? member : second;
      other = owner === member ? second : member;
      registration = responses.find(x => x.status === 201).body;
      assert.equal((await request(`/api/events/${event.id}/register`, { method: 'POST', as: owner })).status, 409);
      const detail = await json(`/api/events/${event.id}`, { as: owner });
      assert.equal(detail.body.registered_count, 1);
      assert.equal(detail.body.registered, true);
      assert.equal((await json(`/api/events/${event.id}`, { as: other })).body.registered, false);
      assert.equal((await json('/api/me/registrations', { as: owner })).body[0].checkin_token, registration.checkin_token);
      assert.equal(JSON.stringify((await json('/api/events')).body).includes(registration.checkin_token), false);
      assert.equal((await pool.query('SELECT count(*)::int n FROM notifications')).rows[0].n, 1);
      assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='email'")).rows[0].n, 1);
    });
    await t.test('QR ownership, safe ICS and CSV, report aggregates, notification ownership', async () => {
      assert.equal((await request(`/api/registrations/${registration.id}/qr`, { as: other })).status, 403);
      const qr = await request(`/api/registrations/${registration.id}/qr`, { as: owner });
      assert.match(qr.headers.get('content-type'), /image\/svg/);
      assert.equal(qr.headers.get('cache-control'), 'no-store');
      assert.match(await qr.text(), /<svg/);
      assert.equal((await request(`/api/registrations/${registration.id}/qr`, { as: officer })).status, 200);
      const ics = await (await request(`/api/events/${event.id}/calendar`)).text();
      assert.match(ics, /BEGIN:VCALENDAR\r\n/);
      assert.equal(ics.includes('\r\nBEGIN:BAD'), false);
      const csv = await (await request('/api/reports/export', { as: advisor })).text();
      assert.match(csv, /"'=HYPERLINK/);
      const report = (await json('/api/reports', { as: advisor })).body;
      assert.equal(report.members, 5);
      assert.equal(report.events, 1);
      assert.equal(report.registrations, 1);
      assert.equal(report.attendance, 0);
      assert.equal(report.by_member.find(x => x.id === other).registrations, 0);
      assert.equal(report.by_kind.length, 5);
      const notification = (await json('/api/notifications', { as: owner })).body[0];
      assert.equal((await request(`/api/notifications/${notification.id}/read`, { method: 'PATCH', as: other })).status, 404);
      assert.ok((await json(`/api/notifications/${notification.id}/read`, { method: 'PATCH', as: owner })).body.read_at);
    });
    await t.test('cancellation releases capacity, removes queued reminders and preserves checked-in history', async () => {
      await pool.query("INSERT INTO jobs(kind,payload,unique_key) VALUES('email',$1,$2)",
        [{ registration_id: registration.id }, `registration:${registration.id}:reminder:test`]);
      assert.equal((await request(`/api/events/${event.id}/register`, { method: 'DELETE', as: owner })).status, 204);
      assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE unique_key LIKE 'registration:%:reminder:%'")).rows[0].n, 0);
      registration = (await json(`/api/events/${event.id}/register`, { method: 'POST', as: owner })).body;
      assert.equal((await request('/api/attendance/check-in', { method: 'POST', as: officer, body: { token: registration.checkin_token } })).status, 200);
      assert.equal((await request('/api/attendance/check-in', { method: 'POST', as: officer, body: { token: registration.checkin_token } })).status, 409);
      assert.equal((await request(`/api/events/${event.id}/register`, { method: 'DELETE', as: owner })).status, 409);
      const report = (await json('/api/reports', { as: advisor })).body;
      assert.equal(report.attendance, 1);
      assert.equal(report.engagement_rate, 1);
      assert.equal(report.by_event[0].attendance, 1);
      assert.equal(report.by_member.find(x => x.id === owner).attendance, 1);
    });
    await t.test('capacity edits and event cancellations serialize with registration; check-in windows enforced', async () => {
      const result = await json('/api/events', { method: 'POST', as: admin, body: newEvent({ capacity: 2 }) });
      const id = result.body.id;
      await request(`/api/events/${id}/register`, { method: 'POST', as: member });
      await request(`/api/events/${id}/register`, { method: 'POST', as: second });
      assert.equal((await request(`/api/events/${id}`, { method: 'PATCH', as: officer, body: { capacity: 1 } })).status, 409);
      assert.equal((await json(`/api/events/${id}`)).body.capacity, 2);
      assert.equal((await request(`/api/events/${id}`, { method: 'PATCH', as: officer, body: { cancelled: true } })).status, 200);
      const reactivation = await json(`/api/events/${id}`, { method: 'PATCH', as: officer, body: { cancelled: false } });
      assert.equal(reactivation.status, 409);
      assert.equal(reactivation.body.error, 'Event cancellation is permanent');
      assert.ok((await json(`/api/events/${id}`)).body.cancelled_at);
      const reg = (await json('/api/me/registrations', { as: member })).body.find(x => x.event_id === id);
      assert.equal((await request('/api/attendance/check-in', { method: 'POST', as: officer, body: { token: reg.checkin_token } })).status, 409);
      assert.equal((await request(`/api/events/${id}/register`, { method: 'POST', as: admin })).status, 409);
      await pool.query("UPDATE events SET cancelled_at=NULL,starts_at=now()+interval '4 hours',ends_at=now()+interval '5 hours' WHERE id=$1", [id]);
      assert.equal((await request('/api/attendance/check-in', { method: 'POST', as: officer, body: { token: reg.checkin_token } })).status, 409);
      await pool.query("UPDATE events SET starts_at=now()-interval '4 hours',ends_at=now()-interval '3 hours' WHERE id=$1", [id]);
      assert.equal((await request('/api/attendance/check-in', { method: 'POST', as: officer, body: { token: reg.checkin_token } })).status, 409);
      assert.equal((await request(`/api/events/${id}/register`, { method: 'DELETE', as: member })).status, 409);
    });
    await t.test('capacity edit races cannot reduce capacity below registrations', async () => {
      const { body: e } = await json('/api/events', { method: 'POST', as: officer, body: newEvent({ capacity: 2 }) });
      await request(`/api/events/${e.id}/register`, { method: 'POST', as: member });
      const raced = await Promise.all([
        request(`/api/events/${e.id}`, { method: 'PATCH', as: officer, body: { capacity: 1 } }),
        request(`/api/events/${e.id}/register`, { method: 'POST', as: second }),
      ]);
      assert.ok([[200,409],[409,201]].some(expected => expected.every((status,i) => raced[i].status === status)));
      const detail = (await json(`/api/events/${e.id}`)).body;
      assert.ok(detail.capacity >= detail.registered_count);
    });
    await t.test('partial event edits preserve omitted descriptions and reject empty patches', async () => {
      const description = 'A description that must survive partial edits.';
      const { body: e } = await json('/api/events', { method: 'POST', as: officer, body: newEvent({ description }) });
      const capacityUpdate = await json(`/api/events/${e.id}`, { method: 'PATCH', as: officer, body: { capacity: 2 } });
      assert.equal(capacityUpdate.status, 200);
      assert.equal(capacityUpdate.body.description, description);
      const titleUpdate = await json(`/api/events/${e.id}`, { method: 'PATCH', as: officer, body: { title: 'Renamed workshop' } });
      assert.equal(titleUpdate.status, 200);
      assert.equal(titleUpdate.body.description, description);
      assert.equal((await request(`/api/events/${e.id}`, { method: 'PATCH', as: officer, body: {} })).status, 400);
      const persisted = (await json(`/api/events/${e.id}`)).body;
      assert.equal(persisted.description, description);
      assert.equal(persisted.title, 'Renamed workshop');
      assert.equal(persisted.capacity, 2);
      const clearDescription = await json(`/api/events/${e.id}`, { method: 'PATCH', as: officer, body: { description: '' } });
      assert.equal(clearDescription.status, 200);
      assert.equal(clearDescription.body.description, '');
    });
    await t.test('rescheduling resets reminder eligibility and removes pending reminder jobs by registration', async () => {
      const { body: e } = await json('/api/events', { method: 'POST', as: officer, body: newEvent() });
      const { body: r } = await json(`/api/events/${e.id}/register`, { method: 'POST', as: member });
      await pool.query('UPDATE registrations SET reminder_queued_at=now() WHERE id=$1', [r.id]);
      await pool.query("INSERT INTO jobs(kind,payload,unique_key) VALUES('email',$1,$2)",
        [{ registration_id: r.id, starts_at: e.starts_at }, `registration:${r.id}:reminder:${e.starts_at}`]);
      assert.equal((await request(`/api/events/${e.id}`, { method: 'PATCH', as: officer, body: { starts_at: e.starts_at } })).status, 200);
      assert.ok((await pool.query('SELECT reminder_queued_at FROM registrations WHERE id=$1', [r.id])).rows[0].reminder_queued_at);
      assert.equal((await request(`/api/events/${e.id}`, { method: 'PATCH', as: officer,
        body: { starts_at: new Date(Date.now() + 5400000).toISOString() } })).status, 200);
      assert.equal((await pool.query('SELECT reminder_queued_at FROM registrations WHERE id=$1', [r.id])).rows[0].reminder_queued_at, null);
      assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE payload->>'registration_id'=$1", [r.id])).rows[0].n, 0);
    });
    await t.test('registration and notification/outbox writes roll back together on database failure', async () => {
      const { body: e } = await json('/api/events', { method: 'POST', as: officer, body: newEvent() });
      const beforeJobs = (await pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n;
      await pool.query("ALTER TABLE notifications ADD CONSTRAINT test_notification_failure CHECK(title <> 'Registration confirmed') NOT VALID");
      try {
        const response = await json(`/api/events/${e.id}/register`, { method: 'POST', as: member });
        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { error: 'Internal server error' });
        assert.equal((await pool.query('SELECT count(*)::int n FROM registrations WHERE event_id=$1', [e.id])).rows[0].n, 0);
        assert.equal((await pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n, beforeJobs);
      } finally {
        await pool.query('ALTER TABLE notifications DROP CONSTRAINT test_notification_failure');
      }
    });
    await t.test('role edits are administrator-only and concurrent demotions retain an administrator', async () => {
      assert.equal((await request(`/api/members/${member}/role`, { method: 'PATCH', as: officer, body: { role: 'Administrator' } })).status, 403);
      assert.equal((await request(`/api/members/${member}/role`, { method: 'PATCH', as: admin, body: { role: 'Owner' } })).status, 400);
      assert.equal((await request(`/api/members/${member}/role`, { method: 'PATCH', as: admin, body: { role: 'Administrator' } })).status, 200);
      const raced = await Promise.all([
        request(`/api/members/${admin}/role`, { method: 'PATCH', as: admin, body: { role: 'Member' } }),
        request(`/api/members/${member}/role`, { method: 'PATCH', as: member, body: { role: 'Member' } }),
      ]);
      assert.equal(raced.filter(x => x.status === 200).length, 1);
      assert.ok([403,409].includes(raced.find(x => x.status !== 200).status));
      assert.equal((await pool.query("SELECT count(*)::int n FROM members WHERE role='Administrator'")).rows[0].n, 1);
    });
    await t.test('malformed JSON, bounded body, unknown routes and DB errors do not disclose internals', async () => {
      const badJson = await fetch(`${origin}/api/me`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{' });
      assert.equal(badJson.status, 400);
      assert.equal((await request('/api/me', { method: 'PATCH', body: { bio: 'x'.repeat(40000) } })).status, 413);
      assert.equal((await request('/missing')).status, 404);
      const unhealthy = createApp({ pool: { query: async () => { throw new Error('sensitive database error'); } },
        authenticate: (req,res,next) => next() });
      const probe = unhealthy.listen(0, '127.0.0.1');
      await new Promise(resolve => probe.once('listening', resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${probe.address().port}/health`);
        assert.equal(response.status, 503);
        assert.equal((await response.text()).includes('sensitive'), false);
      } finally { await new Promise(resolve => probe.close(resolve)); }
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    await management.query(`DROP SCHEMA ${schema} CASCADE`);
    await management.end();
  }
});
