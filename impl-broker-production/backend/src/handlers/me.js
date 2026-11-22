/** GET /api/me — tells the SPA whether to show Login or the passkey banner. */

import { config } from '../config.js';
import { response, resolvePortal, requestId } from '../http.js';
import { readSession } from '../session.js';
import { getUser } from '../store.js';

export async function me(event) {
  const portal = resolvePortal(event);
  const session = await readSession(event);

  if (!session || session.portal !== portal.portalId) {
    return response(200, { authenticated: false, phase: config.phase });
  }

  let user = null;
  try {
    user = await getUser(session.sub);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'me_cache_unavailable',
        portal: portal.portalId,
        request_id: requestId(event),
        detail: err.message,
      }),
    );
  }

  return response(200, {
    authenticated: true,
    phase: config.phase,
    sub: session.sub,
    // Fail safe for UX: if the cache is unavailable, show the enrolment banner.
    passkeyEnrolled: Boolean(user?.passkeyEnrolled),
    displayName: user?.displayName ?? null,
  });
}
