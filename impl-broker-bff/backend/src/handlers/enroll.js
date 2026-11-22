/**
 * GET /api/auth/enroll
 * Second redirect (your step 9-10). Requires an existing portal session.
 * NO kc_idp_hint: Keycloak's SSO cookie is already present, so Verimi is not
 * contacted again. AIA runs the WebAuthn ceremony on Keycloak's own origin.
 */

import { config } from '../config.js';
import { COOKIES, setCookie } from '../cookies.js';
import { seal, TX_ISSUER } from '../crypto.js';
import { createAuthorizationUrl, createOidcTransaction } from '../oidc.js';
import { response, resolvePortal } from '../http.js';
import { readSession } from '../session.js';

export async function enroll(event) {
  const portal = resolvePortal(event);
  const session = await readSession(event);

  if (!session || session.portal !== portal.portalId) {
    return response(401, { error: 'not_authenticated' });
  }

  const tx = createOidcTransaction({
    flow: 'enroll',
    portal: portal.portalId,
    sub: session.sub, // bind the AIA transaction to this portal account
    hasPasskey: true,
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
    flow: 'enroll',
    tx,
  });

  console.log(
    JSON.stringify({ level: 'info', event: 'passkey_enrolment_started', portal: portal.portalId, sub: session.sub }),
  );

  return response(200, { authorizationUrl }, {
    cookies: [setCookie(COOKIES.tx, sealedTx, config.txTtl)],
  });
}
