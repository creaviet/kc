/** Small HTTP helpers for the API Gateway HTTP API v2 proxy event. */

import { config } from './config.js';

const NO_STORE = Object.freeze({
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
});

const JSON_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function response(statusCode, body, { headers = {}, cookies = [] } = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-security-policy': JSON_CSP,
      ...NO_STORE,
      ...headers,
    },
    cookies,
    body: JSON.stringify(body),
  };
}

export function redirect(location, cookies = []) {
  return {
    statusCode: 302,
    headers: { location, ...NO_STORE },
    cookies,
    body: '',
  };
}

function normalizeHost(raw) {
  if (!raw) return '';
  let host = String(raw).trim().toLowerCase();

  // IPv6 literals are not valid portal hosts here.
  if (host.startsWith('[') || host.includes('@')) return '';

  const portIndex = host.lastIndexOf(':');
  if (portIndex > 0) host = host.slice(0, portIndex);

  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * Resolve the portal from the request.
 *
 * requestContext.domainName is set by API Gateway from the custom domain and
 * cannot be replaced by a browser-supplied Host header. That matters because
 * each portal has its own realm/client/secret.
 */
export function resolvePortal(event) {
  const rawHost = event.requestContext?.domainName;
  if (!rawHost) {
    const err = new Error('missing_domain_name');
    err.statusCode = 400;
    throw err;
  }

  const host = normalizeHost(rawHost);
  const portal = config.portals?.[host];
  if (!portal) {
    const err = new Error(`unknown_portal:${host}`);
    err.statusCode = 400;
    throw err;
  }
  return { portalId: host, ...portal };
}

/** Only fixed, internal reason codes may appear in the redirect URL. */
const REASONS = new Set([
  'access_denied',
  'invalid_transaction',
  'state_mismatch',
  'missing_params',
  'token_exchange_failed',
  'invalid_token',
  'session_revoked',
  'internal_error',
]);

export function safeReason(raw) {
  return REASONS.has(raw) ? raw : 'internal_error';
}

export function requestId(event) {
  return event.requestContext?.requestId || null;
}

/**
 * Reconstruct the exact public callback URL.
 *
 * The API Gateway custom domain maps /api -> the BFF HTTP API, so `rawPath`
 * may be `/auth/callback`. Keycloak, however, registered
 * `https://portal.tld/api/auth/callback` as redirect_uri. openid-client uses
 * this URL verbatim in the token request, so it must include `/api`.
 */
function publicPath(event) {
  const internal = String(event.rawPath || event.path || '/');
  if (internal === '/api') return '/';
  if (internal.startsWith('/api/')) return internal;
  return `/api${internal.startsWith('/') ? internal : `/${internal}`}`;
}

export function requestUrl(event) {
  const rawHost = event.requestContext?.domainName;
  if (!rawHost) {
    const err = new Error('missing_request_host');
    err.statusCode = 400;
    throw err;
  }

  const host = normalizeHost(rawHost);
  if (!host) {
    const err = new Error('invalid_request_host');
    err.statusCode = 400;
    throw err;
  }

  const path = publicPath(event);
  const rawQuery =
    event.rawQueryString ||
    new URLSearchParams(event.queryStringParameters || {}).toString();

  return `https://${host}${path}${rawQuery ? `?${rawQuery}` : ''}`;
}

/** Derive the post-logout page from the validated redirectUri — never from a query parameter. */
export function portalHomeUrl(portal) {
  const url = new URL(portal.redirectUri);
  return `${url.origin}/?logged_out=1`;
}
