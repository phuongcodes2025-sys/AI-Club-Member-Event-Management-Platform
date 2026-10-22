import { pathToFileURL } from "node:url";
import pg from "pg";
import { createIntegrations, integrationConfig, IntegrationUnavailable } from "./integrations.js";

export async function queueReminders(pool) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(`
      SELECT r.id, r.member_id, m.email, e.id AS event_id, e.title, e.starts_at, e.location
      FROM registrations r
      JOIN events e ON e.id = r.event_id
      JOIN members m ON m.id = r.member_id
      WHERE r.reminder_queued_at IS NULL AND r.checked_in_at IS NULL
        AND e.cancelled_at IS NULL
        AND e.starts_at > now() AND e.starts_at <= now() + interval '24 hours'
      FOR UPDATE OF r SKIP LOCKED
    `);
    for (const row of rows) {
      const body = `${row.title} starts at ${new Date(row.starts_at).toISOString()} at ${row.location}.`;
      const key = `reminder:${row.id}:${new Date(row.starts_at).toISOString()}`;
      const queued = await db.query(`
        INSERT INTO jobs (kind, payload, unique_key) VALUES ('email', $1, $2)
        ON CONFLICT (unique_key) DO NOTHING RETURNING id
      `, [JSON.stringify({
        to: row.email,
        subject: `Reminder: ${row.title}`,
        body,
        registration_id: row.id,
        starts_at: new Date(row.starts_at).toISOString(),
      }), key]);
      if (queued.rowCount) {
        await db.query(
          "INSERT INTO notifications (member_id, title, body) VALUES ($1, $2, $3)",
          [row.member_id, `Reminder: ${row.title}`, body],
        );
      }
      await db.query("UPDATE registrations SET reminder_queued_at = now() WHERE id = $1", [row.id]);
    }
    await db.query("COMMIT");
    return rows.length;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

async function processJob(pool, integrations, job) {
  if (job.kind === "email") {
    if (job.payload.registration_id) {
      const { rows } = await pool.query(`
        SELECT e.starts_at, e.cancelled_at, e.title, e.location, r.checked_in_at
        FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.id = $1
      `, [job.payload.registration_id]);
      const event = rows[0];
      if (!event || event.cancelled_at || event.checked_in_at ||
          new Date(event.starts_at) <= new Date() ||
          new Date(event.starts_at).toISOString() !== job.payload.starts_at) return;
      job.payload.subject = `Reminder: ${event.title}`;
      job.payload.body = `${event.title} starts at ${new Date(event.starts_at).toISOString()} at ${event.location}.`;
    }
    await integrations.email(job.payload);
  } else if (job.kind === "announce") {
    const { rows } = await pool.query("SELECT * FROM events WHERE id = $1", [job.payload.event_id]);
    if (!rows[0] || rows[0].cancelled_at || rows[0].starts_at <= new Date()) return;
    const event = rows[0];
    for (const channel of integrations.channels) {
      await pool.query(`
        INSERT INTO jobs (kind, payload, unique_key) VALUES ($1, $2, $3)
        ON CONFLICT (unique_key) DO NOTHING
      `, [channel, {
        event_id: event.id, title: event.title, description: event.description,
        starts_at: event.starts_at, location: event.location,
      }, `announce:${job.id}:${channel}`]);
    }
  } else if (["teams", "discord"].includes(job.kind)) {
    const { rows } = await pool.query("SELECT * FROM events WHERE id = $1", [job.payload.event_id]);
    const event = rows[0];
    if (!event || event.cancelled_at || event.starts_at <= new Date()) return;
    await integrations.announce(job.kind, event);
  } else if (job.kind === "calendar") {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      // Serialize calendar updates for one event, including initial ID persistence.
      const { rows } = await db.query("SELECT * FROM events WHERE id = $1 FOR UPDATE", [job.payload.event_id]);
      if (rows[0]) {
        const id = await integrations.calendar(rows[0]);
        if (id !== undefined) {
          await db.query("UPDATE events SET outlook_event_id = $1 WHERE id = $2", [id, rows[0].id]);
        }
      }
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  } else {
    throw new Error("Unknown integration job kind");
  }
}

export async function runOnce(pool, integrations) {
  await queueReminders(pool);
  const { rows } = await pool.query(`
    UPDATE jobs SET locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE completed_at IS NULL AND available_at <= now() AND attempts < 8
        AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
      ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING *
  `);
  const job = rows[0];
  if (!job) return false;
  try {
    await processJob(pool, integrations, job);
    await pool.query(
      "UPDATE jobs SET completed_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1",
      [job.id],
    );
  } catch (error) {
    const unavailable = error instanceof IntegrationUnavailable;
    const delay = unavailable ? 3600 : Math.min(3600, 30 * 2 ** job.attempts);
    // Never persist raw provider errors, tokens, webhook URLs, or member data.
    await pool.query(`
      UPDATE jobs SET locked_at = NULL, available_at = now() + $2 * interval '1 second',
        attempts = attempts - $3, last_error = $4 WHERE id = $1
    `, [job.id, delay, unavailable ? 1 : 0,
      unavailable ? "Integration not configured; deferred" : "Delivery failed; check provider configuration"]);
    console.error(`Integration job ${job.id}: ${unavailable ? "not configured" : "delivery failed"}`);
  }
  return true;
}

export async function startWorker(env = process.env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const integrations = createIntegrations(integrationConfig(env));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      try {
        if (await runOnce(pool, integrations)) continue;
      } catch {
        console.error("Notification worker cycle failed; verify database connectivity and migrations");
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker().catch(() => {
    console.error("Notification worker could not start; verify environment configuration");
    process.exitCode = 1;
  });
}
