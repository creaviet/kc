import { config } from './config.js';
import { COOKIES, readCookies } from './cookies.js';
import {
  openWithRotation,
  seal,
  TX_ISSUER,
  SESSION_ISSUER,
  SESSION_AUDIENCE,
  ENROLLED_ISSUER,
  safeEqual,
} from './crypto.js';
import { isSessionActive, revokeSession } from './store.js';

/** Returns null for missing, expired, tampered or revoked session cookies. */
export async function readSession(event) {
  const token = readCookies(event)[COOKIES.session];
  if (!token) return null;

  try {
    const payload = await openWithRotation(token, {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      key: config.sessionKey,
      previousKey: config.sessionKeyPrevious,
    });

    if (!payload || typeof payload.sub !== 'string' || typeof payload.portal !== 'string') {
      return null;
    }
    if (typeof payload.sid !== 'string') return null; // old cookies are invalid on purpose
    if (!(await isSessionActive(payload.sid))) return null;

    return payload;
  } catch {
    return null;
  }
}

export async function readTransaction(event, portalId) {
  const token = readCookies(event)[COOKIES.tx];
  if (!token) throw new Error('invalid_transaction');

  return openWithRotation(token, {
    issuer: TX_ISSUER,
    audience: portalId,
    key: config.txKey,
    previousKey: config.txKeyPrevious,
  });
}

/**
 * The enrolled hint is an encrypted, portal-bound cookie. It is UX metadata
 * only: the authoritative value is re-checked against Keycloak Account API on
 * every successful callback and exposed by /api/me from the portal store.
 */
export async function setEnrolledHint({ portalId, sub, enrolled }) {
  return seal(
    { sub, enrolled: Boolean(enrolled) },
    config.enrolledKey,
    {
      ttl: config.enrolledTtl,
      issuer: ENROLLED_ISSUER,
      audience: portalId,
    },
  );
}

export async function readEnrolledHint(event, portalId, expectedSub) {
  const token = readCookies(event)[COOKIES.enrolled];
  if (!token) return null;

  try {
    const payload = await openWithRotation(token, {
      issuer: ENROLLED_ISSUER,
      audience: portalId,
      key: config.enrolledKey,
      previousKey: config.enrolledKeyPrevious,
    });

    if (typeof payload.enrolled !== 'boolean') return null;
    if (typeof payload.sub !== 'string') return null;
    if (expectedSub && !safeEqual(payload.sub, expectedSub)) return null;

    return payload.enrolled;
  } catch {
    return null;
  }
}

/** Used by logout: revoke the server-side session before clearing cookies. */
export async function revokeSessionFromEvent(event) {
  const token = readCookies(event)[COOKIES.session];
  if (!token) return false;

  try {
    const payload = await openWithRotation(token, {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      key: config.sessionKey,
      previousKey: config.sessionKeyPrevious,
    });
    return await revokeSession(payload?.sid);
  } catch {
    return false;
  }
}
