import { createRemoteJWKSet, jwtVerify } from 'jose';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAuthenticate({ tenantId, audience, requiredScope = 'access_as_user', jwks }) {
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const keySet = jwks || createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
  return async function authenticate(req, res, next) {
    const parts = (req.get('authorization') || '').split(' ');
    const match = parts.length === 2 && parts[0].toLowerCase() === 'bearer' && parts[1] ? parts : null;
    if (!match) return res.status(401).json({ error: 'A valid bearer access token is required' });
    try {
      const { payload } = await jwtVerify(match[1], keySet, {
        issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'oid', 'tid'],
      });
      if (!uuid.test(payload.oid || '') || !uuid.test(payload.tid || '') || payload.tid.toLowerCase() !== tenantId.toLowerCase()) {
        return res.status(401).json({ error: 'Invalid identity' });
      }
      if (typeof payload.scp !== 'string' || !payload.scp.split(' ').includes(requiredScope)) {
        return res.status(403).json({ error: 'Required API scope is missing' });
      }
      req.identity = {
        oid: payload.oid.toLowerCase(), tid: payload.tid.toLowerCase(),
        name: typeof payload.name === 'string' ? payload.name.slice(0, 200) : 'Club member',
        email: typeof payload.email === 'string' ? payload.email.slice(0, 320) :
          typeof payload.preferred_username === 'string' ? payload.preferred_username.slice(0, 320) : '',
      };
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired access token' });
    }
  };
}

export default createAuthenticate;
