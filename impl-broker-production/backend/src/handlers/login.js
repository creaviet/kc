/**
 * GET /api/auth/login?method=auto|passkey|verimi
 * Browser -> BFF -> { authorizationUrl } -> browser navigates to Keycloak.
 * No body, no token in JS. The PKCE verifier stays in an encrypted cookie.
 *
 * `method` is an explicit user choice from the portal UI. It is allowlisted
 * here; anything unknown falls back to `auto`. It is only a routing hint —
 * Keycloak remains the credential authority.
 */

import { config } from '../config.js';
import { COOKIES, setCookie } from '../cookies.js';
import { seal, TX_ISSUER } from '../crypto.js';
import { createAuthorizationUrl, createOidcTransaction } from '../oidc.js';
import { response, resolvePortal, requestId } from '../http.js';
import { readEnrolledHint, readSession } from '../session.js';
import { getUser } from '../store.js';

const LOGIN_METHODS = new Set(['auto', 'passkey', 'verimi']);

export async function login(event) {
  const portal = resolvePortal(event);
  const rid = requestId(event);

  const requestedMethod = String(event.queryStringParameters?.method || 'auto').toLowerCase();
  const loginMethod = LOGIN_METHODS.has(requestedMethod) ? requestedMethod : 'auto';

  if (config.phase === 'C' && loginMethod === 'verimi') {
    return response(403, { error: 'verimi_disabled' });
  }

  const session = await readSession(event);
  const hinted = await readEnrolledHint(event, portal.portalId, session?.sub);

  // Portal state is a cache, not the credential authority. A DynamoDB hiccup
  // must not prevent a legitimate Keycloak/Verimi login.
  let stored = false;
  if (session) {
    try {
      stored = Boolean((await getUser(session.sub))?.passkeyEnrolled);
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'passkey_cache_unavailable',
          portal: portal.portalId,
          request_id: rid,
          detail: err.message,
        }),
      );
    }
  }

  const hasPasskey = hinted === true || stored;

  const tx = createOidcTransaction({
    flow: 'login',
    portal: portal.portalId,
    hasPasskey,
    loginMethod,
  });

  const sealedTx = await seal(tx, config.txKey, {
    ttl: config.txTtl,
    issuer: TX_ISSUER,
    audience: portal.portalId,
  });

  const authorizationUrl = await createAuthorizationUrl({
    realm: portal.realm,
    clientId: portal.clientId,
    clientSecret: portal.clientSecret,
    redirectUri: portal.redirectUri,
    flow: 'login',
    tx,
    loginMethod,
  });

  const effectiveHint = new URL(authorizationUrl).searchParams.get('kc_idp_hint') || 'passkey';

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'auth_login_started',
      portal: portal.portalId,
      flow: 'login',
      login_method: loginMethod,
      effective_hint: effectiveHint,
      has_passkey: hasPasskey,
      request_id: rid,
    }),
  );

  return response(200, { authorizationUrl }, {
    cookies: [setCookie(COOKIES.tx, sealedTx, config.txTtl)],
  });
}
