/**
 * Cookie handling via the `cookie` library — no manual string concatenation.
 *
 * __Host- prefix requirements: Secure, Path=/, NO Domain attribute.
 * For local HTTP development we drop the prefix and the Secure flag, gated by
 * INSECURE_COOKIES=true (never set in production).
 */

import { parse, serialize } from 'cookie';
import { config } from './config.js';

const prefix = config.insecureCookies ? '' : '__Host-';

export const COOKIES = Object.freeze({
  tx: `${prefix}pk_tx`,
  session: `${prefix}pksid`,
  enrolled: `${prefix}pk_enrolled`,
});

const BASE = Object.freeze({
  httpOnly: true,
  secure: !config.insecureCookies,
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
