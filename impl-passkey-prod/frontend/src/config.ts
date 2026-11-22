/**
 * Frontend configuration and URL validation.
 *
 * The BFF returns an authorizationUrl. A compromised or misconfigured backend
 * must never be able to send the browser to an arbitrary origin, so we enforce
 * an allowlist here as an independent control.
 */

const DEFAULT_AUTH_ORIGINS = 'https://kc.gateway-vw.de:8443';
const DEFAULT_API_BASE = '/api';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export const API_BASE = trimTrailingSlash(import.meta.env.VITE_API_BASE || DEFAULT_API_BASE);

const allowedAuthOrigins = new Set(
  (import.meta.env.VITE_ALLOWED_AUTH_ORIGINS || DEFAULT_AUTH_ORIGINS)
    .split(',')
    .map((entry) => trimTrailingSlash(entry.trim()))
    .filter(Boolean),
);

export const VERIMI_AVAILABLE = (import.meta.env.VITE_VERIMI_AVAILABLE ?? 'true') !== 'false';

export function assertSafeAuthorizationUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Ungültige Anmelde-URL vom Server.');
  }
  if (url.protocol !== 'https:' || !allowedAuthOrigins.has(url.origin)) {
    throw new Error('Die Anmelde-URL hat einen nicht erlaubten Ursprung.');
  }
  if (!url.pathname.startsWith('/realms/') || !url.pathname.includes('/protocol/openid-connect/auth')) {
    throw new Error('Die Anmelde-URL ist keine gültige Keycloak-URL.');
  }
  return url.toString();
}
