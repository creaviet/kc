/**
 * Cookie handling.
 *
 * Every cookie uses the `__Host-` prefix, which forces browsers to require:
 *   - Secure
 *   - Path=/
 *   - no Domain attribute
 *
 * That prevents a sibling subdomain from overwriting our session cookies.
 */

import { parse, serialize } from 'cookie';

export const TX_COOKIE = '__Host-pk_tx';
export const SESSION_COOKIE = '__Host-pksid';

const BASE = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
});

export function readCookies(header) {
  return parse(typeof header === 'string' ? header : '');
}

export function writeCookie(name, value, maxAgeSeconds) {
  return serialize(name, value, { ...BASE, maxAge: Math.max(1, Math.floor(maxAgeSeconds)) });
}

export function clearCookie(name) {
  return serialize(name, '', { ...BASE, maxAge: 0, expires: new Date(0) });
}
