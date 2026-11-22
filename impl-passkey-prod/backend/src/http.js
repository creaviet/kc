/** API Gateway v2 response helpers, host binding and CORS. */

import { config } from './config.js';

export function requestId(event) {
  return String(event?.requestContext?.requestId ?? 'unknown');
}

export function response(statusCode, body, { cookies = [], headers = {} } = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
    cookies,
    body: JSON.stringify(body),
  };
}

export function redirect(location, cookies = []) {
  return {
    statusCode: 302,
    headers: {
      location,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
    cookies,
    body: '',
  };
}

/**
 * Determine which portal a request belongs to. The host comes from the
 * API Gateway domain, never from a body/query parameter. Unknown hosts are
 * rejected — this is what stops cross-portal login mix-ups.
 */
export function portalFromEvent(event) {
  const headers = event?.headers ?? {};
  const forwarded = String(headers['x-forwarded-host'] ?? headers.host ?? '');
  const firstHost = forwarded.split(',')[0].trim();
  const proto = String(headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim();

  if (config.nodeEnv === 'production' && proto !== 'https') {
    const err = new Error('insecure_transport');
    err.statusCode = 400;
    throw err;
  }

  const portal = config.byApiHost.get(firstHost.toLowerCase().replace(/:\d+$/, ''))
    ?? config.byPortalHost.get(firstHost.toLowerCase().replace(/:\d+$/, ''));

  if (!portal) {
    console.warn(JSON.stringify({ level: 'warn', event: 'unknown_host', host: firstHost, request_id: requestId(event) }));
    const err = new Error('unknown_host');
    err.statusCode = 400;
    throw err;
  }
  return portal;
}

/**
 * CORS: only the portal origin that belongs to the resolved API host is
 * allowed, and only when the request actually comes from that portal.
 */
export function corsHeaders(event, portal) {
  const origin = String(event?.headers?.origin ?? '');
  const allowed = `https://${portal.portalHost}`;
  if (origin && origin !== allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': 'content-type',
    vary: 'Origin',
  };
}

export function preflightResponse(event, portal) {
  const requestedMethod = String(event?.headers?.['access-control-request-method'] ?? 'GET').toUpperCase();
  const requestedHeaders = String(event?.headers?.['access-control-request-headers'] ?? 'content-type');
  const origin = String(event?.headers?.origin ?? '');
  const allowed = `https://${portal.portalHost}`;

  if (origin !== allowed || !['GET', 'POST', 'OPTIONS'].includes(requestedMethod)) {
    return response(403, { error: 'forbidden_origin' });
  }

  return {
    statusCode: 204,
    headers: {
      ...corsHeaders(event, portal),
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': requestedHeaders.split(',').map((s) => s.trim()).filter(Boolean).join(', '),
      'access-control-max-age': '600',
    },
    cookies: [],
    body: '',
  };
}
