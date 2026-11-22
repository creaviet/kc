/** GET /auth/logout — revoke the server-side session and end the Keycloak SSO session. */

import { SESSION_COOKIE, TX_COOKIE, clearCookie, readCookies } from '../cookies.js';
import { redirect } from '../http.js';
import { buildLogoutUrl } from '../oidc.js';
import { readSession } from '../session.js';
import { revokeSession } from '../store.js';

export async function logout(event, portal) {
  const jar = readCookies(event.headers?.cookie);
  const session = await readSession(jar[SESSION_COOKIE], portal);

  if (session) await revokeSession(session.sid);

  const cookies = [clearCookie(SESSION_COOKIE), clearCookie(TX_COOKIE)];
  return redirect(buildLogoutUrl({ portal, postLogoutUrl: portal.postLogoutUrl }), cookies);
}
