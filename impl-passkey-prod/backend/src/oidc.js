/**
 * The ONLY place that performs OIDC protocol work.
 *
 * We deliberately use `openid-client` instead of hand-written HTTP calls so
 * that PKCE computation, state/nonce binding, JWKS signature validation and
 * iss/aud/exp checks are implemented by a vetted library.
 *
 * Browser: GET kc.gateway-vw.de:8443/realms/<realm>/protocol/openid-connect/auth
 * Backend: discovery, /token, JWKS, /account/credentials
 */

import { createHash } from 'node:crypto';
import * as client from 'openid-client';
import { config } from './config.js';
import { randomToken } from './crypto.js';

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map();

/** A fresh, browser-bound OIDC transaction. Values live only in an encrypted cookie. */
export function createTransaction(extra = {}) {
  return {
    state: randomToken(32),
    nonce: randomToken(32),
    verifier: client.randomPKCECodeVerifier(),
    iat: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

function cacheKey(portal, secret) {
  // Never use the secret itself as part of a loggable key.
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  return `${config.kcPublicUrl}|${portal.realm}|${portal.clientId}|${fingerprint}`;
}

async function getClientConfig(portal, secret) {
  const key = cacheKey(portal, secret);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const issuer = new URL(`${config.kcPublicUrl}/realms/${encodeURIComponent(portal.realm)}`);
  const discovered = await client.discovery(
    issuer,
    portal.clientId,
    {},
    client.ClientSecretBasic(secret),
    { timeout: 10, execute: [client.enableNonRepudiationChecks] },
  );

  discoveryCache.set(key, { value: discovered, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return discovered;
}

/**
 * Build the Keycloak authorization URL.
 *
 * method=verimi  -> kc_idp_hint=verimi (bootstrap only; controlled per portal)
 * method=passkey -> NO hint, so Keycloak's passkey-capable login form runs
 * method=auto    -> hint Verimi only if enabled and no passkey is known
 * flow=enroll    -> AIA parameter, NO hint (SSO session already exists)
 */
export async function buildAuthorizationUrl({ portal, secret, tx, flow, method = 'auto' }) {
  const oidcConfig = await getClientConfig(portal, secret);

  const params = {
    response_type: 'code',
    redirect_uri: portal.redirectUri,
    scope: 'openid profile email',
    state: tx.state,
    nonce: tx.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(tx.verifier),
    code_challenge_method: 'S256',
    ui_locales: 'de',
  };

  if (flow === 'login') {
    const useVerimi = portal.verimiEnabled && (method === 'verimi' || (method === 'auto' && !tx.hasPasskeyHint));
    if (useVerimi) params.kc_idp_hint = 'verimi';
    if (method === 'verimi' && !portal.verimiEnabled) {
      const err = new Error('verimi_disabled_for_portal');
      err.statusCode = 400;
      throw err;
    }
  } else if (flow === 'enroll') {
    // No kc_idp_hint: the browser already has a Keycloak SSO session.
    params.kc_action = 'webauthn-register-passwordless:skip_if_exists';
  } else {
    throw new Error('unknown_flow');
  }

  return client.buildAuthorizationUrl(oidcConfig, params).toString();
}

/**
 * Exchange the code and validate everything:
 * state, nonce, PKCE S256 verifier, ID token signature (JWKS), iss, aud, exp.
 */
export async function completeAuthorization({ portal, secret, currentUrl, tx }) {
  const oidcConfig = await getClientConfig(portal, secret);

  let tokens;
  try {
    tokens = await client.authorizationCodeGrant(oidcConfig, new URL(currentUrl), {
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      pkceCodeVerifier: tx.verifier,
    });
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', event: 'token_exchange_failed', realm: portal.realm, detail: err?.message }));
    const wrapped = new Error('token_exchange_failed');
    wrapped.statusCode = 400;
    throw wrapped;
  }

  const claims = tokens.claims();
  if (!claims?.sub || typeof claims.sub !== 'string') {
    const err = new Error('missing_sub_claim');
    err.statusCode = 400;
    throw err;
  }

  return {
    sub: claims.sub,
    claims,
    accessToken: tokens.access_token,
  };
}

/**
 * Authoritative credential check via the Keycloak Account REST API using the
 * END USER's access token. No admin/service account is involved.
 *
 * true  -> credential definitely exists
 * false -> Keycloak answered and credential definitely does not exist
 * null  -> check unavailable/denied -> keep last known state, never guess
 */
export async function hasPasskeyCredential({ portal, accessToken }) {
  const url = `${config.kcPublicUrl}/realms/${encodeURIComponent(portal.realm)}/account/credentials`;

  let response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    console.warn(JSON.stringify({ level: 'warn', event: 'account_api_unreachable', realm: portal.realm }));
    return null;
  }

  if (!response.ok) {
    console.warn(JSON.stringify({ level: 'warn', event: 'account_api_denied', realm: portal.realm, status: response.status }));
    return null;
  }

  let credentials;
  try {
    credentials = await response.json();
  } catch {
    console.warn(JSON.stringify({ level: 'warn', event: 'account_api_invalid_json', realm: portal.realm }));
    return null;
  }
  if (!Array.isArray(credentials)) return null;

  return credentials.some(
    (entry) =>
      entry?.type === 'webauthn-passwordless' &&
      Array.isArray(entry.userCredentialMetadatas) &&
      entry.userCredentialMetadatas.length > 0,
  );
}

/** URL for RP-initiated logout (OIDC logout endpoint). */
export function buildLogoutUrl({ portal, postLogoutUrl }) {
  const url = new URL(`${config.kcPublicUrl}/realms/${encodeURIComponent(portal.realm)}/protocol/openid-connect/logout`);
  url.searchParams.set('client_id', portal.clientId);
  url.searchParams.set('post_logout_redirect_uri', postLogoutUrl);
  return url.toString();
}
