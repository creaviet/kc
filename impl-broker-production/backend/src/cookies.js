/**
 * Cookie handling via the `cookie` library — no manual string concatenation.
 *
 * Production uses __Host- cookies exclusively.
 * __Host- requirements: Secure, Path=/, no Domain attribute.
 */

import { parse, serialize } from 'cookie';

export const COOKIES = Object.freeze({
  tx: '__Host-pk_tx',
  session: '__Host-pksid',
  enrolled: '__Host-pk_enrolled',
});

const BASE = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax', // sent on the top-level GET coming back from Keycloak
  path: '/',
});

export function readCookies(event) {
  const raw = event.headers?.cookie || event.headers?.Cookie || '';
  return raw ? parse(raw) : {};
}

export function setCookie(name, value, maxAge) {
  return serialize(name, value, { ...BASE, maxAge });
}

export function clearCookie(name) {
  return serialize(name, '', { ...BASE, maxAge: 0 });
}
