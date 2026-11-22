/** Router. Normalizes both /api/... and base-path-mapped /... forms. */

import { login } from './handlers/login.js';
import { enroll } from './handlers/enroll.js';
import { callback } from './handlers/callback.js';
import { me } from './handlers/me.js';
import { logout } from './handlers/logout.js';
import { portalFromEvent, preflightResponse, requestId, response } from './http.js';

const routes = new Map([
  ['GET /auth/login', login],
  ['GET /auth/enroll', enroll],
  ['GET /auth/callback', callback],
  ['GET /auth/logout', logout],
  ['GET /me', me],
]);

export function normalizePath(rawPath) {
  let path = String(rawPath || '/');
  if (path === '/api') return '/';
  if (path.startsWith('/api/')) path = path.slice(4);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

export async function route(event) {
  const path = normalizePath(event.rawPath || event.path || '/');
  const method = String(event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  const rid = requestId(event);

  try {
    if (method === 'OPTIONS') {
      const portal = portalFromEvent(event);
      return preflightResponse(event, portal);
    }

    if (path === '/health' && method === 'GET') {
      return response(200, { ok: true, stage: process.env.STAGE ?? 'unknown' });
    }

    const handler = routes.get(`${method} ${path}`);
    if (!handler) return response(404, { error: 'not_found' });

    const portal = portalFromEvent(event);
    return await handler(event, portal);
  } catch (err) {
    const status = Number.isInteger(err?.statusCode) && err.statusCode < 500 ? err.statusCode : 500;
    console.error(JSON.stringify({
      level: 'error',
      event: 'request_failed',
      path,
      method,
      request_id: rid,
      detail: status === 500 ? err?.message : err?.message,
    }));
    return response(status, { error: status === 400 ? 'bad_request' : status === 401 ? 'unauthorized' : 'internal_error' });
  }
}
