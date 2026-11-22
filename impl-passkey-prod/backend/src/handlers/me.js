/** GET /me — session status for the SPA. No tokens are ever returned. */

import { SESSION_COOKIE, readCookies } from '../cookies.js';
import { corsHeaders, response } from '../http.js';
import { readSession } from '../session.js';

export async function me(event, portal) {
  const jar = readCookies(event.headers?.cookie);
  const session = await readSession(jar[SESSION_COOKIE], portal);

  if (!session) {
    return response(200, { authenticated: false, passkeyEnrolled: false }, { headers: corsHeaders(event, portal) });
  }

  return response(
    200,
    {
      authenticated: true,
      passkeyEnrolled: session.passkeyEnrolled,
      email: session.email,
      portal: portal.portalHost,
    },
    { headers: corsHeaders(event, portal) },
  );
}
