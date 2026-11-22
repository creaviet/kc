/**
 * Crypto helpers. We do NOT implement encryption or signing ourselves.
 *
 * - Randomness: Node's `node:crypto` CSPRNG.
 * - Confidentiality + integrity of cookies: `jose` JWE with `dir` + `A256GCM`
 *   (an AEAD; tampering is detected by the tag, not by a homemade HMAC).
 * - Constant-time equality for security tokens: `crypto.timingSafeEqual`.
 *
 * The JWE protected header carries `kid` so keys can be rotated without
 * invalidating existing sessions.
 */

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { CompactEncrypt, compactDecrypt } from 'jose';
import { config } from './config.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16) throw new Error('bytes must be an integer >= 16');
  return randomBytes(bytes).toString('base64url');
}

export function keyFingerprint(raw) {
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/** Constant-time comparison; different lengths are handled without leaking length via early timing. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Seal a JSON-serializable payload into a compact JWE string. */
export async function seal(payload) {
  const kid = config.activeKeyId;
  const key = Buffer.from(config.encryptionKeys[kid], 'base64url');
  const jwe = await new CompactEncrypt(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', cty: 'json', kid })
    .encrypt(key);
  return jwe;
}

function keyForKid(kid) {
  const raw = config.encryptionKeys[kid];
  return raw ? Buffer.from(raw, 'base64url') : null;
}

/**
 * Decrypt a JWE and parse JSON.
 * Tries the header `kid` first, then all other configured keys (rotation).
 * Returns null on any failure — callers must treat null as "no valid state".
 */
export async function open(token) {
  if (typeof token !== 'string' || token.split('.').length !== 5) return null;

  let headerKid = null;
  try {
    const protectedHeader = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    headerKid = typeof protectedHeader.kid === 'string' ? protectedHeader.kid : null;
  } catch {
    return null;
  }

  const candidates = [
    ...(headerKid && config.encryptionKeys[headerKid] ? [headerKid] : []),
    ...Object.keys(config.encryptionKeys).filter((kid) => kid !== headerKid),
  ];

  for (const kid of candidates) {
    const key = keyForKid(kid);
    if (!key) continue;
    try {
      const { plaintext, protectedHeader } = await compactDecrypt(token, key);
      if (protectedHeader.enc !== 'A256GCM') return null;
      const value = JSON.parse(decoder.decode(plaintext));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      return value;
    } catch {
      // Try the next key.
    }
  }
  return null;
}
