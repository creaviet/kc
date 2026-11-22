/**
 * GET /api/auth/callback?code=...&state=...[&kc_action_status=...]
 *
 * This is the single security choke point:
 *  1. state must match the encrypted transaction cookie (constant time)
 *  2. enrolment additionally requires a valid session for the same `sub`
 *  3. code is exchanged with PKCE verifier from the cookie (never from JS)
 *  4. ID token is verified against JWKS (iss/aud/azp/nonce/alg)
 *  5. the ID token `sub` is re-bound to the AIA transaction
 *  6. passkey enrolment is proven via Keycloak Account API, NOT via the
 *     attacker-controllable `kc_action_status` query parameter
 *  7. a revocable portal session record is created
 */

import { config } from '../config.js';
import { COOKIES, setCookie, clearCookie } from '../cookies.js';
import {
  randomToken,
  safeEqual,
  seal,
  SESSION_ISSUER,
  SESSION_AUDIENCE,
} from '../crypto.js';
import { completeAuthorization, hasPasskey } from '../oidc.js';
import {
  createSession,
  getUser,
  linkUser,
  setPasskeyVerified,
} from '../store.js';
import { redirect, resolvePortal, requestId, requestUrl, safeReason } from '../http.js';
import {
  readSession,
  readTransaction,
  setEnrolledHint,
} from '../session.js';

function fail(reason, extraCookies = []) {
  return redirect(`/?login=error&reason=${encodeURIComponent(safeReason(reason))}`, [
    clearCookie(COOKIES.tx),
    ...extraCookies,
  ]);
}

export async function callback(event) {
  const portal = resolvePortal(event);
  const rid = requestId(event);
  const query = event.queryStringParameters || {};

  if (query.error) return fail(query.error);
  if (!query.code || !query.state) return fail('missing_params');

  let tx;
  try {
    tx = await readTransaction(event, portal.portalId);
  } catch {
    return fail('invalid_transaction');
  }

  if (!safeEqual(tx.state, query.state) || tx.portal !== portal.portalId) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'state_mismatch', portal: portal.portalId, request_id: rid }),
    );
    return fail('state_mismatch');
  }

  if (tx.flow === 'enroll') {
    const session = await readSession(event);
    if (
      !session ||
      !safeEqual(session.sub, tx.sub) ||
      session.portal !== portal.portalId
    ) {
      return fail('invalid_transaction');
    }
  }

  let authorization;
  try {
    authorization = await completeAuthorization({
      realm: portal.realm,
      clientId: portal.clientId,
      clientSecret: portal.clientSecret,
      currentUrl: requestUrl(event),
      tx,
    });
  } catch (err) {
    const reason = err.stage === 'token_exchange' ? 'token_exchange_failed' : 'invalid_token';
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: reason,
        portal: portal.portalId,
        request_id: rid,
        detail: err.message,
      }),
    );
    return fail(reason);
  }

  const { sub, claims, accessToken } = authorization;

  // Critical rebind: the AIA enrolment transaction was created for a specific
  // portal user. Never accept a token for a different Keycloak sub.
  if (tx.flow === 'enroll' && !safeEqual(claims.sub, tx.sub)) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'enroll_sub_mismatch', portal: portal.portalId, request_id: rid }),
    );
    return fail('invalid_transaction');
  }

  // Portal-owned state. A failure here must NOT block a valid Keycloak login:
  // Keycloak remains the credential authority; this record is a cache.
  let passkeyEnrolled = false;
  try {
    await linkUser({
      kcSub: claims.sub,
      portal: portal.portalId,
      realm: portal.realm,
      verimiSub: claims.verimi_sub ?? null,
    });

    const credentialCheck = await hasPasskey({
      realm: portal.realm,
      accessToken,
    });

    if (typeof credentialCheck === 'boolean') {
      passkeyEnrolled = credentialCheck;
      await setPasskeyVerified(claims.sub, credentialCheck);
    } else {
      const existing = await getUser(claims.sub);
      passkeyEnrolled = Boolean(existing?.passkeyEnrolled);
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'account_api_unknown',
          portal: portal.portalId,
          realm: portal.realm,
          request_id: rid,
        }),
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'portal_state_write_failed',
        portal: portal.portalId,
        request_id: rid,
        detail: err.message,
      }),
    );
  }

  // Fresh session id on every successful callback => no session fixation.
  const sid = randomToken(16);
  try {
    await createSession({
      sid,
      kcSub: claims.sub,
      portal: portal.portalId,
      realm: portal.realm,
      expiresAt: Math.floor(Date.now() / 1000) + config.sessionTtl,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'session_create_failed',
        portal: portal.portalId,
        request_id: rid,
        detail: err.message,
      }),
    );
    return fail('internal_error', [clearCookie(COOKIES.session), clearCookie(COOKIES.enrolled)]);
  }

  const sealedSession = await seal(
    { sub: claims.sub, portal: portal.portalId, sid },
    config.sessionKey,
    {
      ttl: config.sessionTtl,
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    },
  );
  const signedHint = await setEnrolledHint({
    portalId: portal.portalId,
    sub: claims.sub,
    enrolled: passkeyEnrolled,
  });

  const cookies = [
    clearCookie(COOKIES.tx),
    setCookie(COOKIES.session, sealedSession, config.sessionTtl),
  ];

  if (passkeyEnrolled) {
    cookies.push(setCookie(COOKIES.enrolled, signedHint, config.enrolledTtl));
  } else {
    cookies.push(clearCookie(COOKIES.enrolled));
  }

  const result = new URLSearchParams({ login: 'success' });
  if (tx.flow === 'enroll') {
    result.set('passkey', passkeyEnrolled ? 'created' : 'not_confirmed');
  }

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'auth_callback_success',
      portal: portal.portalId,
      flow: tx.flow,
      passkey_enrolled: passkeyEnrolled,
      request_id: rid,
      // kc_action_status is logged for UX debugging only, never trusted.
      kc_action_status: query.kc_action_status ?? null,
    }),
  );

  return redirect(`/?${result.toString()}`, cookies);
}
