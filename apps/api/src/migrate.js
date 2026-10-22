import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from './config.js';

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741820031)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const folder = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(folder)).filter(x => /^\d+.*\.sql$/.test(x)).sort()) {
      const existing = await client.query('SELECT version FROM schema_migrations WHERE version=$1', [name]);
      if (existing.rowCount) continue;
      await client.query(await readFile(new URL(name, folder), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new pg.Pool({ connectionString: loadConfig().databaseUrl });
  try { await migrate(pool); console.log('Database migrations applied'); }
  catch { console.error('Database migration failed'); process.exitCode = 1; }
  finally { await pool.end(); }
}
