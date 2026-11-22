import { login } from './handlers/login.js';
import { enroll } from './handlers/enroll.js';
import { callback } from './handlers/callback.js';
import { me } from './handlers/me.js';
import { logout } from './handlers/logout.js';
import { requestId, response } from './http.js';

const routes = [
  ['GET', '/auth/login', login],
  ['GET', '/auth/enroll', enroll],
  ['GET', '/auth/callback', callback],
  ['GET', '/auth/logout', logout],
  ['GET', '/me', me],
];

/**
 * API Gateway custom domains may map /api -> Lambda, in which case rawPath is
 * /auth/login. Direct Lambda/execute-api calls still use /api/auth/login.
 * Both forms are normalized to the canonical /auth/... route here.
 */
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
    const match = routes.find(([m, p]) => m === method && p === path);
    if (!match) return response(404, { error: 'not_found' });
    return await match[2](event);
  } catch (err) {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'unhandled',
        path,
        method,
        request_id: rid,
        detail: err.message,
      }),
    );
    return response(status, {
      error: status === 400 ? 'bad_request' : 'internal_error',
    });
  }
}
