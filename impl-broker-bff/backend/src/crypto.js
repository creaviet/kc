/**
 * Crypto helpers — we use the audited `jose` library and Node's crypto module.
 * Nothing here implements cryptography by hand.
 *
 * - JWE (dir + A256GCM) for cookies: confidentiality AND integrity.
 * - CSPRNG tokens for transaction/session identifiers.
 * - Constant-time comparison for state/nonce to defeat timing attacks.
 *
 * OIDC/PKCE/JWT work is intentionally NOT here; openid-client handles that.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';

export const TX_ISSUER = 'vw-bff-transaction';
export const SESSION_ISSUER = 'vw-bff-session';
export const SESSION_AUDIENCE = 'vw-portal-bff';
export const ENROLLED_ISSUER = 'vw-bff-enrolled';

/** CSPRNG token, base64url encoded (URL-safe, no padding). */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison; returns false on length mismatch. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Seal a JSON payload into a compact JWE suitable for a cookie.
 * `typ` is not set to JWT because this is encrypted, not signed-only.
 */
export async function seal(payload, key, { ttl, issuer, audience }) {
  return new EncryptJWT({ ...payload })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .encrypt(key);
}

/** Decrypt + verify a JWE. Throws on tamper, expiry, wrong issuer/audience. */
export async function open(token, key, { issuer, audience }) {
  if (!token || typeof token !== 'string') throw new Error('missing_token');
  const { payload } = await jwtDecrypt(token, key, {
    issuer,
    audience,
    clockTolerance: 5,
    algorithms: ['dir'],
  });
  return payload;
}

/**
 * Try the active key, then the previous key (key rotation without downtime).
 */
export async function openWithRotation(token, { issuer, audience, key, previousKey }) {
  try {
    return await open(token, key, { issuer, audience });
  } catch (err) {
    if (previousKey) return open(token, previousKey, { issuer, audience });
    throw err;
  }
}
