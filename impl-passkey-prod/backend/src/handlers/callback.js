/** GET /auth/callback?code=...&state=... — OIDC + enrolment completion. */

import { config } from '../config.js';
import { TX_COOKIE, SESSION_COOKIE, clearCookie, readCookies, writeCookie } from '../cookies.js';
import { safeEqual, randomToken } from '../crypto.js';
import { redirect } from '../http.js';
import { completeAuthorization, hasPasskeyCredential } from '../oidc.js';
import { getClientSecret } from '../secrets.js';
import { FLOW_ENROLL, FLOW_LOGIN, readTransaction, sealSessionCookie } from '../session.js';
import { createSession, identityKey, recordLogin, setPasskeyStatus } from '../store.js';

function badRequest(portal, reason) {
  const url = new URL(portal.postLoginUrl);
  url.searchParams.set('login', 'error');
  url.searchParams.set('reason', reason);
  return redirect(url.toString(), [clearCookie(TX_COOKIE)]);
}

function currentUrlFrom(portal, event) {
  const base = new URL(portal.redirectUri);
  base.search = String(event.rawQueryString ?? '');
  return base.toString();
}

function withQuery(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export async function callback(event, portal) {
  const jar = readCookies(event.headers?.cookie);
  let tx = await readTransaction(jar[TX_COOKIE], { portal, flow: FLOW_LOGIN });
  if (!tx) tx = await readTransaction(jar[TX_COOKIE], { portal, flow: FLOW_ENROLL });
  if (!tx) return badRequest(portal, 'expired_transaction');

  const query = event.queryStringParameters ?? {};
  if (query.error) return badRequest(portal, 'provider_error');

  // Defence in depth: openid-client also checks state. We check it here first
  // against the browser-bound encrypted cookie, in constant time.
  if (!safeEqual(query.state, tx.state)) return badRequest(portal, 'invalid_state');
  if (!query.code || typeof query.code !== 'string') return badRequest(portal, 'missing_code');

  const secret = await getClientSecret(portal);
  const { sub, claims, accessToken } = await completeAuthorization({
    portal,
    secret,
    currentUrl: currentUrlFrom(portal, event),
    tx,
  });

  const identityId = identityKey(portal, sub);

  // A passkey enrolment must belong to the exact user who started it.
  if (tx.flow === FLOW_ENROLL && tx.expectedId !== identityId) {
    console.error(JSON.stringify({ level: 'error', event: 'enrolment_sub_mismatch', realm: portal.realm }));
    return badRequest(portal, 'identity_mismatch');
  }

  const now = Date.now();
  await recordLogin({ key: identityId, portal, claims, now });

  // kc_action_status is user-controllable. The Account API is authoritative.
  const hasPasskey = await hasPasskeyCredential({ portal, accessToken });
  if (hasPasskey === true) await setPasskeyStatus({ key: identityId, hasPasskey: true, now });

  const sid = randomToken(32);
  const expiresAt = now + config.sessionTtlSeconds * 1000;
  await createSession({ sid, key: identityId, portal, expiresAt, now });

  const cookies = [
    await writeCookie(SESSION_COOKIE, await sealSessionCookie({ sid, identityId, portal }), config.sessionTtlSeconds),
    clearCookie(TX_COOKIE), // single use: replaying the callback now fails
  ];

  if (tx.flow === FLOW_ENROLL) {
    const params = hasPasskey === true
      ? { passkey: 'created', login: 'success' }
      : { passkey: 'pending', login: 'success' };
    return redirect(withQuery(portal.postLoginUrl, params), cookies);
  }

  return redirect(withQuery(portal.postLoginUrl, { login: 'success' }), cookies);
}
