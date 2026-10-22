import pg from 'pg';
import { loadConfig } from './config.js';
import { createAuthenticate } from './auth.js';
import { createApp } from './app.js';
import { migrate } from './migrate.js';

try {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  await migrate(pool);
  const app = createApp({ pool, authenticate: createAuthenticate(config), config });
  const server = app.listen(config.port, () => console.log(`API listening on port ${config.port}`));
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  console.error('API startup failed; check configuration and database availability');
  process.exitCode = 1;
}
