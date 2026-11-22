/** GET /api/auth/logout — revokes the portal session and ends Keycloak SSO. */

import { config } from '../config.js';
import { COOKIES, clearCookie } from '../cookies.js';
import { portalHomeUrl, redirect, resolvePortal, requestId } from '../http.js';
import { revokeSessionFromEvent } from '../session.js';

export async function logout(event) {
  const portal = resolvePortal(event);
  const rid = requestId(event);

  let revoked = false;
  try {
    revoked = await revokeSessionFromEvent(event);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'session_revoke_failed',
        portal: portal.portalId,
        request_id: rid,
        detail: err.message,
      }),
    );
  }

  const params = new URLSearchParams({
    client_id: portal.clientId,
    post_logout_redirect_uri: portalHomeUrl(portal),
  });

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'logout',
      portal: portal.portalId,
      session_revoked: revoked,
      request_id: rid,
    }),
  );

  return redirect(
    `${config.kcPublicUrl}/realms/${encodeURIComponent(portal.realm)}/protocol/openid-connect/logout?${params}`,
    [clearCookie(COOKIES.tx), clearCookie(COOKIES.session), clearCookie(COOKIES.enrolled)],
  );
}
