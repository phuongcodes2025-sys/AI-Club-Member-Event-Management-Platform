import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../src/migrate.js";
import { queueReminders, runOnce } from "../src/worker.js";
import { IntegrationUnavailable } from "../src/integrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL notification worker: reminders, retries, stale jobs and channel fanout",
  { skip: !databaseUrl }, async (t) => {
    const schema = `worker_test_${randomUUID().replaceAll("-", "")}`;
    const management = new pg.Pool({ connectionString: databaseUrl });
    await management.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const member = randomUUID();
    let event;
    let registration;
    const sent = [];
    const integrations = {
      channels: ["teams", "discord"],
      email: async (payload) => { sent.push(payload); },
      announce: async (channel, payload) => { sent.push({ channel, ...payload }); },
      calendar: async () => "outlook-saved-id",
    };
    try {
      await migrate(pool);
      await pool.query(
        "INSERT INTO members(id,tenant_id,name,email) VALUES ($1,$2,'Member','member@example.invalid')",
        [member, randomUUID()],
      );
      event = (await pool.query(`
        INSERT INTO events(title,kind,location,starts_at,ends_at,capacity,created_by)
        VALUES ('Workshop','Workshop','Lab',now()+interval '3 hours',now()+interval '4 hours',10,$1)
        RETURNING *
      `, [member])).rows[0];
      registration = (await pool.query(
        "INSERT INTO registrations(event_id,member_id) VALUES ($1,$2) RETURNING *",
        [event.id, member],
      )).rows[0];

      await t.test("concurrent reminder scans enqueue one email and one in-app notification", async () => {
        await Promise.all([queueReminders(pool), queueReminders(pool)]);
        await queueReminders(pool);
        assert.equal((await pool.query("SELECT count(*)::int n FROM jobs")).rows[0].n, 1);
        assert.equal((await pool.query("SELECT count(*)::int n FROM notifications")).rows[0].n, 1);
        assert.ok((await pool.query("SELECT reminder_queued_at FROM registrations")).rows[0].reminder_queued_at);
        assert.equal(await runOnce(pool, integrations), true);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].to, "member@example.invalid");
        assert.equal(await runOnce(pool, integrations), false);
      });

      await t.test("rescheduled and deleted registrations suppress stale reminder emails", async () => {
        await pool.query("UPDATE jobs SET completed_at=NULL, available_at=now()");
        await pool.query("UPDATE events SET starts_at=starts_at + interval '10 minutes' WHERE id=$1", [event.id]);
        await runOnce(pool, integrations);
        assert.equal(sent.length, 1);
        await pool.query("UPDATE jobs SET completed_at=NULL, available_at=now()");
        await pool.query("DELETE FROM registrations WHERE id=$1", [registration.id]);
        await runOnce(pool, integrations);
        assert.equal(sent.length, 1);
      });

      await t.test("provider failures back off without exposing private errors", async () => {
        await pool.query("DELETE FROM jobs");
        const job = (await pool.query(`
          INSERT INTO jobs(kind,payload) VALUES ('email','{"to":"member@example.invalid"}') RETURNING id
        `)).rows[0];
        await runOnce(pool, {
          ...integrations,
          email: async () => { throw new Error("private provider diagnostic"); },
        });
        const retried = (await pool.query("SELECT * FROM jobs WHERE id=$1", [job.id])).rows[0];
        assert.equal(retried.attempts, 1);
        assert.equal(retried.locked_at, null);
        assert.equal(retried.completed_at, null);
        assert.ok(retried.available_at > new Date());
        assert.equal(retried.last_error.includes("private"), false);
        await pool.query("UPDATE jobs SET available_at=now()");
        await runOnce(pool, {
          ...integrations,
          email: async () => { throw new IntegrationUnavailable("No secret configured"); },
        });
        const deferred = (await pool.query("SELECT * FROM jobs WHERE id=$1", [job.id])).rows[0];
        assert.equal(deferred.attempts, 1);
        assert.equal(deferred.last_error, "Integration not configured; deferred");
      });

      await t.test("announcements fan out once per channel and calendar IDs persist", async () => {
        await pool.query("DELETE FROM jobs");
        await pool.query(
          "INSERT INTO jobs(kind,payload) VALUES ('announce',$1),('calendar',$2)",
          [JSON.stringify({ title: "Workshop", event_id: event.id }), JSON.stringify({ event_id: event.id })],
        );
        const before = sent.length;
        await Promise.all([runOnce(pool, integrations), runOnce(pool, integrations)]);
        while (await runOnce(pool, integrations)) { /* drain ready jobs */ }
        assert.deepEqual(sent.slice(before).map((x) => x.channel).sort(), ["discord", "teams"]);
        assert.equal((await pool.query("SELECT outlook_event_id FROM events WHERE id=$1", [event.id])).rows[0].outlook_event_id,
          "outlook-saved-id");
        assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE completed_at IS NULL")).rows[0].n, 0);
      });

      await t.test("failed jobs stop after eight attempts and expired leases recover", async () => {
        await pool.query("DELETE FROM jobs");
        await pool.query(`
          INSERT INTO jobs(kind,payload,attempts,locked_at)
          VALUES ('email','{}',8,NULL), ('email','{}',1,now()-interval '6 minutes')
        `);
        assert.equal(await runOnce(pool, integrations), true);
        assert.equal(await runOnce(pool, integrations), false);
        const jobs = (await pool.query("SELECT attempts,completed_at FROM jobs ORDER BY id")).rows;
        assert.equal(jobs[0].attempts, 8);
        assert.equal(jobs[0].completed_at, null);
        assert.equal(jobs[1].attempts, 2);
        assert.ok(jobs[1].completed_at);
      });

      await t.test("cancelled events are not announced and calendar cancellation clears the saved ID", async () => {
        await pool.query("DELETE FROM jobs");
        await pool.query("UPDATE events SET cancelled_at=now() WHERE id=$1", [event.id]);
        await pool.query(
          "INSERT INTO jobs(kind,payload) VALUES ('announce',$1),('calendar',$1),('discord',$1),('teams',$1)",
          [JSON.stringify({ event_id: event.id })],
        );
        const before = sent.length;
        const cancelling = { ...integrations, calendar: async () => null };
        while (await runOnce(pool, cancelling)) { /* drain ready jobs */ }
        assert.equal(sent.length, before);
        assert.equal((await pool.query("SELECT outlook_event_id FROM events WHERE id=$1", [event.id])).rows[0].outlook_event_id, null);
        assert.equal((await pool.query("SELECT count(*)::int n FROM jobs")).rows[0].n, 4);
      });
    } finally {
      await pool.end();
      await management.query(`DROP SCHEMA ${schema} CASCADE`);
      await management.end();
    }
  });
