export function loadConfig(env = process.env) {
  for (const key of ['DATABASE_URL', 'ENTRA_TENANT_ID', 'ENTRA_API_AUDIENCE']) {
    if (!env[key]) throw new Error(`Missing required configuration: ${key}`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.ENTRA_TENANT_ID)) {
    throw new Error('ENTRA_TENANT_ID must be a UUID');
  }
  const port = Number(env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0 || String(env.TRUST_PROXY_HOPS ?? '0').trim() === '') {
    throw new Error('TRUST_PROXY_HOPS must be a nonnegative integer');
  }
  const webOrigin = env.WEB_ORIGIN || 'http://localhost:3000';
  if (new URL(webOrigin).origin !== webOrigin) throw new Error('WEB_ORIGIN must be an origin');
  return {
    databaseUrl: env.DATABASE_URL,
    tenantId: env.ENTRA_TENANT_ID.toLowerCase(),
    audience: env.ENTRA_API_AUDIENCE,
    requiredScope: env.ENTRA_REQUIRED_SCOPE || 'access_as_user',
    webOrigin,
    port,
    trustProxyHops,
    adminObjectIds: (env.ADMIN_OBJECT_IDS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
  };
}
