/** GET /api/me — tells the SPA whether to show Login or the passkey banner. */

import { config } from '../config.js';
import { response, resolvePortal } from '../http.js';
import { readSession } from '../session.js';
import { getUser } from '../store.js';

export async function me(event) {
  const portal = resolvePortal(event);
  const session = await readSession(event);

  if (!session || session.portal !== portal.portalId) {
    return response(200, { authenticated: false, phase: config.phase });
  }

  const user = await getUser(session.sub);

  return response(200, {
    authenticated: true,
    phase: config.phase,
    sub: session.sub,
    passkeyEnrolled: Boolean(user?.passkeyEnrolled),
    displayName: user?.displayName ?? null,
  });
}
