import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createAuthenticate } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const oid = '22222222-2222-4222-8222-222222222222';
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const pair = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
const jwk = await exportJWK(pair.publicKey);
jwk.kid = 'test-key';
const authenticate = createAuthenticate({ tenantId, audience: 'api://club', jwks: createLocalJWKSet({ keys: [jwk] }) });
async function token(claims = {}, key = pair.privateKey, overrides = {}) {
  return new SignJWT({ oid, tid: tenantId, scp: 'access_as_user', name: 'Member', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt().setExpirationTime('5m').setIssuer(issuer).setAudience('api://club')
    .setIssuer(overrides.issuer || issuer).setAudience(overrides.audience || 'api://club').sign(key);
}
async function check(value) {
  const req = { get: () => value };
  let status = 200;
  let next = false;
  const res = { status(code) { status = code; return this; }, json() {} };
  await authenticate(req, res, () => { next = true; });
  return { status, next, identity: req.identity };
}
test('verified delegated tokens produce tenant and object identity', async () => {
  const result = await check(['Bearer', await token()].join(' '));
  assert.equal(result.status, 200);
  assert.equal(result.next, true);
  assert.equal(result.identity.oid, oid);
});
test('scope, identity, signature, issuer, audience, expiration and missing bearer are enforced', async () => {
  assert.equal((await check('')).status, 401);
  for (const claims of [{ scp: '' }, { scp: 'other' }, { scp: undefined }]) {
    assert.equal((await check(['Bearer', await token(claims)].join(' '))).status, 403);
  }
  for (const claims of [{ tid: oid }, { oid: 'not-uuid' }, { exp: 1 }]) {
    const value = claims.exp ? await new SignJWT({ oid, tid: tenantId, scp: 'access_as_user' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setAudience('api://club')
      .setExpirationTime(1).sign(pair.privateKey) : await token(claims);
    assert.equal((await check(['Bearer', value].join(' '))).status, 401);
  }
  assert.equal((await check(['Bearer', await token({}, other.privateKey)].join(' '))).status, 401);
  assert.equal((await check(['Bearer', await token({}, pair.privateKey, { issuer: 'https://invalid' })].join(' '))).status, 401);
  assert.equal((await check(['Bearer', await token({}, pair.privateKey, { audience: 'other' })].join(' '))).status, 401);
  const noExpiry = await new SignJWT({ oid, tid: tenantId, scp: 'access_as_user' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuedAt().setIssuer(issuer)
    .setAudience('api://club').sign(pair.privateKey);
  assert.equal((await check(['Bearer', noExpiry].join(' '))).status, 401);
});
test('configuration is validated only when loaded', () => {
  assert.throws(() => loadConfig({}), /Missing required/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x', ENTRA_TENANT_ID: 'invalid', ENTRA_API_AUDIENCE: 'api' }), /UUID/);
  const config = loadConfig({ DATABASE_URL: 'postgres://x', ENTRA_TENANT_ID: tenantId, ENTRA_API_AUDIENCE: 'api' });
  assert.equal(config.requiredScope, 'access_as_user');
  assert.equal(config.port, 4000);
  assert.equal(config.webOrigin, 'http://localhost:3000');
  assert.equal(config.trustProxyHops, 0);
  const base = { DATABASE_URL: 'postgres://x', ENTRA_TENANT_ID: tenantId, ENTRA_API_AUDIENCE: 'api' };
  assert.equal(loadConfig({ ...base, TRUST_PROXY_HOPS: '2' }).trustProxyHops, 2);
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '', ' ', '9007199254740992']) {
    assert.throws(() => loadConfig({ ...base, TRUST_PROXY_HOPS: value }), /TRUST_PROXY_HOPS/);
  }
});
