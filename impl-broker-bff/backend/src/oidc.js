/**
 * OIDC layer — the ONLY place that performs the Keycloak OIDC protocol.
 *
 * We use `openid-client` (the server-side OIDC/RP library built on
 * oauth4webapi) for:
 *   - realm discovery
 *   - authorization URL construction
 *   - PKCE challenge calculation
 *   - authorization-code exchange
 *   - state/nonce/PKCE checks
 *   - ID token signature/claim validation against the realm JWKS
 *
 * `jose` is deliberately NOT used here anymore. It remains in crypto.js for
 * encrypting our own BFF cookies, which is a different job.
 *
 * Network paths:
 *   browser -> Keycloak /authorize            (URL built by openid-client)
 *   BFF     -> Keycloak discovery + /token    (openid-client)
 *   BFF     -> Keycloak /account/credentials  (user's own access token)
 *
 * There is no Admin API and no service account anywhere in this layer.
 */

import { createHash } from 'node:crypto';
import * as client from 'openid-client';
import { config } from './config.js';
import { randomToken } from './crypto.js';

const CONFIG_TTL_MS = 10 * 60 * 1000;
const configCache = new Map();

/**
 * Create one browser-bound OIDC transaction.
 * state/nonce use Node's CSPRNG; the PKCE verifier uses openid-client's helper.
 */
export function createOidcTransaction(extra = {}) {
  return {
    state: randomToken(32),
    nonce: randomToken(32),
    verifier: client.randomPKCECodeVerifier(),
    ...extra,
  };
}

function clientCacheKey({ realm, clientId, clientSecret }) {
  const secretFingerprint = createHash('sha256').update(clientSecret).digest('hex').slice(0, 16);
  return `${config.kcPublicUrl}|${realm}|${clientId}|${secretFingerprint}`;
}

/**
 * Discover one OIDC Configuration per realm/client/secret.
 *
 * We discover from KC_PUBLIC_URL, not KC_BASE_URL, because the discovered
 * `issuer` must match the `iss` claim Keycloak writes. The public hostname must
 * therefore be resolvable from Lambda as well as from the browser.
 *
 * In local emulator mode only, allowInsecureRequests is enabled. In AWS,
 * ALLOW_INSECURE_OIDC is rejected at cold start, so this can never weaken
 * production.
 */
async function getClientConfig({ realm, clientId, clientSecret }) {
  const key = clientCacheKey({ realm, clientId, clientSecret });
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const issuer = new URL(`${config.kcPublicUrl}/realms/${encodeURIComponent(realm)}`);

  // By default openid-client validates ID token claims (iss/aud/exp/nonce)
  // but relies on TLS + client authentication for provenance. For a production
  // broker we also want cryptographic non-repudiation: verify the JWS against
  // the realm JWKS. This is opt-in in openid-client.
  const execute = [client.enableNonRepudiationChecks];

  if (config.allowInsecureOidc) {
    execute.push(client.allowInsecureRequests);
  }

  const discoveryOptions = { timeout: 5, execute };

  // Explicit confidential-client authentication. Keycloak supports
  // client_secret_basic; using it avoids putting the secret in the request body.
  const clientAuth = client.ClientSecretBasic(clientSecret);

  const discovered = await client.discovery(issuer, clientId, {}, clientAuth, discoveryOptions);

  configCache.set(key, { config: discovered, expiresAt: Date.now() + CONFIG_TTL_MS });
  return discovered;
}

/**
 * Build the Keycloak authorize URL with openid-client.
 *
 * LOGIN flow:
 *   method=verimi  -> kc_idp_hint=verimi (explicit fallback, Phase B only)
 *   method=passkey -> NO kc_idp_hint; Keycloak's passkey-capable login form runs
 *   method=auto    -> hint Verimi only in Phase B when no enrolled cookie exists
 *
 * ENROL flow:
 *   No kc_idp_hint (Keycloak SSO session already exists), plus the AIA
 *   parameter. `skip_if_exists` makes retries no-ops.
 */
export async function createAuthorizationUrl({
  realm,
  clientId,
  clientSecret,
  redirectUri,
  flow,
  tx,
  loginMethod = 'auto',
}) {
  const oidcConfig = await getClientConfig({ realm, clientId, clientSecret });

  const params = {
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid profile email roles', // roles -> Account API profile access
    state: tx.state,
    nonce: tx.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(tx.verifier),
    code_challenge_method: 'S256',
  };

  if (flow === 'login' && config.phase === 'B') {
    const wantsVerimi = loginMethod === 'verimi';
    const wantsPasskey = loginMethod === 'passkey';

    if (wantsVerimi || (!wantsPasskey && !tx.hasPasskey)) {
      params.kc_idp_hint = 'verimi';
    }
  }

  if (flow === 'enroll') {
    params.kc_action = 'webauthn-register-passwordless:skip_if_exists';
  }

  return client.buildAuthorizationUrl(oidcConfig, params).toString();
}

/**
 * Exchange the code and validate the authorization response/ID token.
 *
 * openid-client checks:
 *   - state (CSRF)
 *   - nonce (replay / ID token binding)
 *   - PKCE S256 verifier
 *   - ID token signature against JWKS
 *   - issuer, audience, expiry and signing algorithm
 *
 * We still check `state` against our encrypted transaction cookie before we
 * get here. That is defence in depth and binds the callback to this browser.
 */
export async function completeAuthorization({ realm, clientId, clientSecret, currentUrl, tx }) {
  const oidcConfig = await getClientConfig({ realm, clientId, clientSecret });

  let tokens;
  try {
    tokens = await client.authorizationCodeGrant(oidcConfig, new URL(currentUrl), {
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      pkceCodeVerifier: tx.verifier,
    });
  } catch (err) {
    const wrapped = new Error(err?.message || 'authorization_code_grant_failed');
    wrapped.stage = 'token_exchange';
    throw wrapped;
  }

  const claims = tokens.claims();
  if (!claims?.sub) {
    const err = new Error('missing_sub_claim');
    err.stage = 'id_token';
    throw err;
  }

  return {
    sub: claims.sub,
    claims,
    accessToken: tokens.access_token,
  };
}

/**
 * Ask Keycloak — with the USER's access token — whether a passwordless
 * WebAuthn credential really exists. This is the authoritative enrolment check.
 *
 * Returns:
 *   true  -> credential definitely exists
 *   false -> Keycloak answered and credential definitely does not exist
 *   null  -> check was unavailable/denied; keep last known state, do not guess
 *
 * We deliberately ignore `kc_action_status` from the redirect URL for the
 * security decision: it is user-controllable and only useful for UX debugging.
 */
export async function hasPasskey({ realm, accessToken }) {
  const type = encodeURIComponent('webauthn-passwordless');
  const url = `${config.kcBaseUrl}/realms/${encodeURIComponent(realm)}/account/credentials?type=${type}`;

  let response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    console.warn(JSON.stringify({ level: 'warn', event: 'account_api_unreachable', realm }));
    return null;
  }

  if (!response.ok) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'account_api_denied', realm, status: response.status }),
    );
    return null;
  }

  let containers;
  try {
    containers = await response.json();
  } catch {
    console.warn(JSON.stringify({ level: 'warn', event: 'account_api_invalid_json', realm }));
    return null;
  }
  if (!Array.isArray(containers)) return null;

  return containers.some(
    (entry) =>
      entry?.type === 'webauthn-passwordless' &&
      Array.isArray(entry.userCredentialMetadatas) &&
      entry.userCredentialMetadatas.length > 0,
  );
}
