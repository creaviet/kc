/** GET /auth/enroll — start the WebAuthn passkey registration AIA. */

import { config } from '../config.js';
import { TX_COOKIE, SESSION_COOKIE, readCookies, writeCookie } from '../cookies.js';
import { corsHeaders, response } from '../http.js';
import { createTransaction, buildAuthorizationUrl } from '../oidc.js';
import { getClientSecret } from '../secrets.js';
import { readSession, sealTransaction } from '../session.js';

export async function enroll(event, portal) {
  const jar = readCookies(event.headers?.cookie);
  const session = await readSession(jar[SESSION_COOKIE], portal);

  if (!session) {
    return response(401, { error: 'authentication_required' }, { headers: corsHeaders(event, portal) });
  }

  // Do not restart an enrolment for an account that already has a passkey.
  if (session.passkeyEnrolled) {
    return response(200, { alreadyEnrolled: true }, { headers: corsHeaders(event, portal) });
  }

  const secret = await getClientSecret(portal);
  const tx = createTransaction({
    portalHost: portal.portalHost,
    realm: portal.realm,
    flow: 'enroll',
    method: 'auto',
    // Critical: the callback must authenticate the SAME user.
    expectedId: session.identityId,
    hasPasskeyHint: false,
  });

  const authorizationUrl = await buildAuthorizationUrl({ portal, secret, tx, flow: 'enroll' });

  return response(
    200,
    { authorizationUrl },
    {
      headers: corsHeaders(event, portal),
      cookies: [
        await writeCookie(
          TX_COOKIE,
          await sealTransaction({ portal, flow: 'enroll', method: 'auto', tx, expectedId: session.identityId }),
          config.txTtlSeconds,
        ),
      ],
    },
  );
}
