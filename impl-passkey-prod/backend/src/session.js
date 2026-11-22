/** Encrypted-cookie helpers for OIDC transactions and portal sessions. */

import { z } from 'zod';
import { config } from './config.js';
import { open, seal, randomToken } from './crypto.js';
import { getActiveSession, getIdentity } from './store.js';

export const FLOW_LOGIN = 'login';
export const FLOW_ENROLL = 'enroll';

const TransactionSchema = z.object({
  v: z.literal(1),
  kind: z.literal('tx'),
  jti: z.string().min(8),
  portalHost: z.string().min(1),
  realm: z.string().min(1),
  flow: z.enum([FLOW_LOGIN, FLOW_ENROLL]),
  method: z.enum(['verimi', 'passkey', 'auto']),
  state: z.string().min(20),
  nonce: z.string().min(20),
  verifier: z.string().min(20),
  expectedId: z.string().nullable(),
  hasPasskeyHint: z.boolean(),
  exp: z.number().int(),
});

const SessionCookieSchema = z.object({
  v: z.literal(1),
  kind: z.literal('session'),
  sid: z.string().min(20),
  identityId: z.string().min(1),
  portalHost: z.string().min(1),
  exp: z.number().int(),
});

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export async function sealTransaction({ portal, flow, method, expectedId = null, hasPasskeyHint = false, tx }) {
  return seal({
    v: 1,
    kind: 'tx',
    jti: randomToken(16),
    portalHost: portal.portalHost,
    realm: portal.realm,
    flow,
    method,
    state: tx.state,
    nonce: tx.nonce,
    verifier: tx.verifier,
    expectedId,
    hasPasskeyHint,
    exp: nowSeconds() + config.txTtlSeconds,
  });
}

export async function readTransaction(token, { portal, flow }) {
  const raw = await open(token);
  if (!raw) return null;
  const parsed = TransactionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const tx = parsed.data;
  if (tx.exp <= nowSeconds()) return null;
  if (tx.portalHost !== portal.portalHost || tx.realm !== portal.realm || tx.flow !== flow) return null;
  return tx;
}

export async function sealSessionCookie({ sid, identityId, portal }) {
  return seal({
    v: 1,
    kind: 'session',
    sid,
    identityId,
    portalHost: portal.portalHost,
    exp: nowSeconds() + config.sessionTtlSeconds,
  });
}

/**
 * Decrypt the cookie AND verify the server-side session record.
 * Returns null unless both agree — this is the revocation check.
 */
export async function readSession(token, portal) {
  const raw = await open(token);
  if (!raw) return null;
  const parsed = SessionCookieSchema.safeParse(raw);
  if (!parsed.success) return null;
  const cookie = parsed.data;
  if (cookie.exp <= nowSeconds()) return null;
  if (cookie.portalHost !== portal.portalHost) return null;

  const record = await getActiveSession(cookie.sid);
  if (!record || record.identityId !== cookie.identityId || record.portalHost !== portal.portalHost) {
    return null;
  }

  const identity = await getIdentity(cookie.identityId);
  return {
    sid: cookie.sid,
    identityId: cookie.identityId,
    record,
    identity,
    passkeyEnrolled: identity?.passkeyEnrolled === true,
    email: typeof identity?.email === 'string' ? identity.email : null,
  };
}
