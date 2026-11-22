/** GET /auth/login?method=verimi|passkey|auto */

import { config } from '../config.js';
import { TX_COOKIE, SESSION_COOKIE, clearCookie, readCookies, writeCookie } from '../cookies.js';
import { corsHeaders, response } from '../http.js';
import { createTransaction, buildAuthorizationUrl } from '../oidc.js';
import { getClientSecret } from '../secrets.js';
import { readSession, sealTransaction } from '../session.js';

const METHODS = new Set(['verimi', 'passkey', 'auto']);

export async function login(event, portal) {
  const method = String(event.queryStringParameters?.method ?? 'auto').toLowerCase();
  if (!METHODS.has(method)) {
    return response(400, { error: 'invalid_login_method' }, { headers: corsHeaders(event, portal) });
  }

  const jar = readCookies(event.headers?.cookie);
  const existingSession = await readSession(jar[SESSION_COOKIE], portal);
  const hasPasskeyHint = existingSession?.passkeyEnrolled === true;
  const secret = await getClientSecret(portal);

  const tx = createTransaction({
    portalHost: portal.portalHost,
    realm: portal.realm,
    flow: 'login',
    method,
    expectedId: null,
    hasPasskeyHint,
  });

  const authorizationUrl = await buildAuthorizationUrl({ portal, secret, tx, flow: 'login', method });

  return response(
    200,
    { authorizationUrl },
    {
      headers: corsHeaders(event, portal),
      cookies: [
        await writeCookie(TX_COOKIE, await sealTransaction({ portal, flow: 'login', method, tx, hasPasskeyHint }), config.txTtlSeconds),
        // Starting a new login invalidates the previous portal session cookie.
        clearCookie(SESSION_COOKIE),
      ],
    },
  );
}
