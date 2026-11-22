/**
 * Unit tests — no AWS, no Keycloak, no network.
 * Run: cd backend && npm install && npm test
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import * as oidcClient from 'openid-client';

/**
 * Minimal discovery/JWKS server. We still use the real openid-client code path:
 * discovery, buildAuthorizationUrl(), authorizationCodeGrant() and claim checks.
 * No real Keycloak or network is needed.
 */
const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-kc-1', use: 'sig', alg: 'RS256' };
const { privateKey: wrongPrivateKey } = await generateKeyPair('RS256');
const testCodes = new Map();

const discoveryServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const origin = `http://127.0.0.1:${discoveryServer.address().port}`;
  const realmBase = `${origin}/realms/vw-beav`;

  const sendJson = (body) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/realms/vw-beav/.well-known/openid-configuration') {
    return sendJson({
      issuer: realmBase,
      authorization_endpoint: `${realmBase}/protocol/openid-connect/auth`,
      token_endpoint: `${realmBase}/protocol/openid-connect/token`,
      jwks_uri: `${realmBase}/protocol/openid-connect/certs`,
      end_session_endpoint: `${realmBase}/protocol/openid-connect/logout`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    });
  }

  if (url.pathname === '/realms/vw-beav/protocol/openid-connect/certs') {
    return sendJson({ keys: [publicJwk] });
  }

  if (url.pathname === '/realms/vw-beav/protocol/openid-connect/token' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = new URLSearchParams(raw);
    const entry = testCodes.get(body.get('code'));

    if (!entry || body.get('code_verifier') !== entry.verifier) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_grant' }));
    }

    const now = Math.floor(Date.now() / 1000);
    const signingKey = entry.wrongKey ? wrongPrivateKey : privateKey;
    const idToken = await new SignJWT({
      nonce: entry.nonce,
      azp: 'portal-spa',
      email: 'test@example.de',
    })
      .setProtectedHeader({ alg: 'RS256', kid: entry.wrongKey ? 'wrong-kid' : 'test-kc-1' })
      .setSubject('test-sub')
      .setIssuer(realmBase)
      .setAudience('portal-spa')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signingKey);

    return sendJson({
      id_token: idToken,
      access_token: 'test-access-token',
      token_type: 'Bearer',
      expires_in: 300,
    });
  }

  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => discoveryServer.listen(0, '127.0.0.1', resolve));
const kcOrigin = `http://127.0.0.1:${discoveryServer.address().port}`;

after(async () => {
  await new Promise((resolve) => discoveryServer.close(resolve));
});

// Env MUST be set before any src module is imported (config fails closed).
process.env.STORE = 'memory';
process.env.KC_BASE_URL = kcOrigin;
process.env.KC_PUBLIC_URL = kcOrigin;
process.env.ALLOW_INSECURE_OIDC = 'true';
process.env.PORTALS_JSON = JSON.stringify({
  'vw-baev.de': {
    realm: 'vw-beav',
    clientId: 'portal-spa',
    clientSecret: 'test-secret',
    redirectUri: 'https://vw-baev.de/api/auth/callback',
  },
});
process.env.SESSION_ENC_KEY_B64U = randomBytes(32).toString('base64url');
process.env.TX_ENC_KEY_B64U = randomBytes(32).toString('base64url');
process.env.ENROLLED_ENC_KEY_B64U = randomBytes(32).toString('base64url');

const { seal, open, safeEqual, randomToken } = await import('../src/crypto.js');
const { COOKIES, setCookie } = await import('../src/cookies.js');
const { createAuthorizationUrl, completeAuthorization } = await import('../src/oidc.js');
const { login } = await import('../src/handlers/login.js');
const { enroll } = await import('../src/handlers/enroll.js');
const { callback } = await import('../src/handlers/callback.js');
const { me } = await import('../src/handlers/me.js');
const { route, normalizePath } = await import('../src/router.js');
const {
  buildLinkUserUpdate,
  createSession,
  isSessionActive,
  revokeSession,
  linkUser,
  markPasskeyVerified,
  setPasskeyVerified,
  getUser,
} = await import('../src/store.js');
const { config } = await import('../src/config.js');
const { readSession, setEnrolledHint, readEnrolledHint } = await import('../src/session.js');

const event = (overrides = {}) => ({
  rawPath: '/',
  requestContext: { http: { method: 'GET' } },
  headers: { host: 'vw-baev.de' },
  queryStringParameters: {},
  ...overrides,
});

test('PKCE S256 matches the RFC 7636 reference vector (openid-client)', async () => {
  assert.equal(
    await oidcClient.calculatePKCECodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('openid-client validates ID token signature, nonce and PKCE', async () => {
  testCodes.set('good-code', { nonce: 'nonce-good', verifier: 'verifier-good' });

  const result = await completeAuthorization({
    realm: 'vw-beav',
    clientId: 'portal-spa',
    clientSecret: 'test-secret',
    currentUrl: `${kcOrigin}/api/auth/callback?code=good-code&state=state-good`,
    tx: { state: 'state-good', nonce: 'nonce-good', verifier: 'verifier-good' },
  });
  assert.equal(result.sub, 'test-sub');

  testCodes.set('wrong-key-code', { nonce: 'nonce-good', verifier: 'verifier-good', wrongKey: true });
  await assert.rejects(() =>
    completeAuthorization({
      realm: 'vw-beav',
      clientId: 'portal-spa',
      clientSecret: 'test-secret',
      currentUrl: `${kcOrigin}/api/auth/callback?code=wrong-key-code&state=state-good`,
      tx: { state: 'state-good', nonce: 'nonce-good', verifier: 'verifier-good' },
    }),
  );

  testCodes.set('wrong-nonce-code', { nonce: 'other-nonce', verifier: 'verifier-good' });
  await assert.rejects(() =>
    completeAuthorization({
      realm: 'vw-beav',
      clientId: 'portal-spa',
      clientSecret: 'test-secret',
      currentUrl: `${kcOrigin}/api/auth/callback?code=wrong-nonce-code&state=state-good`,
      tx: { state: 'state-good', nonce: 'nonce-good', verifier: 'verifier-good' },
    }),
  );
});

test('JWE seal/open round-trips and rejects tampering', async () => {
  const token = await seal({ hello: 'world' }, config.txKey, {
    ttl: 60,
    issuer: 'test-issuer',
    audience: 'vw-baev.de',
  });
  const payload = await open(token, config.txKey, { issuer: 'test-issuer', audience: 'vw-baev.de' });
  assert.equal(payload.hello, 'world');

  const broken = token.slice(0, -4) + 'AAAA';
  await assert.rejects(() => open(broken, config.txKey, { issuer: 'test-issuer', audience: 'vw-baev.de' }));
  await assert.rejects(() => open(token, config.txKey, { issuer: 'wrong-issuer', audience: 'vw-baev.de' }));
});

test('constant-time comparison handles unequal lengths', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false);
  assert.ok(randomToken().length > 20);
});

test('cookies use __Host- prefix and hardened attributes', () => {
  const header = setCookie(COOKIES.tx, 'value', 600);
  assert.ok(header.startsWith('__Host-pk_tx='));
  assert.match(header, /HttpOnly/i);
  assert.match(header, /Secure/i);
  assert.match(header, /SameSite=Lax/i);
  assert.match(header, /Path=\//);
  assert.doesNotMatch(header, /Domain=/);
});

test('authorize URL: login forces Verimi only when no passkey cookie', async () => {
  const base = {
    realm: 'vw-beav',
    clientId: 'portal-spa',
    clientSecret: 'test-secret',
    redirectUri: 'https://vw-baev.de/api/auth/callback',
    flow: 'login',
  };
  const tx = { state: 's', nonce: 'n', verifier: 'v' };

  const withVerimi = new URL(
    await createAuthorizationUrl({ ...base, tx: { ...tx, hasPasskey: false } }),
  );
  assert.equal(withVerimi.searchParams.get('kc_idp_hint'), 'verimi');
  assert.equal(withVerimi.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    withVerimi.searchParams.get('code_challenge'),
    await oidcClient.calculatePKCECodeChallenge('v'),
  );

  const withPasskey = new URL(
    await createAuthorizationUrl({ ...base, tx: { ...tx, hasPasskey: true } }),
  );
  assert.equal(withPasskey.searchParams.has('kc_idp_hint'), false);
});

test('authorize URL: explicit passkey method omits kc_idp_hint even without enrolled cookie', async () => {
  const url = new URL(
    await createAuthorizationUrl({
      realm: 'vw-beav',
      clientId: 'portal-spa',
      clientSecret: 'test-secret',
      redirectUri: 'https://vw-baev.de/api/auth/callback',
      flow: 'login',
      loginMethod: 'passkey',
      tx: { state: 's', nonce: 'n', verifier: 'v', hasPasskey: false },
    }),
  );
  assert.equal(url.searchParams.has('kc_idp_hint'), false);
});

test('authorize URL: explicit verimi method forces kc_idp_hint even with enrolled cookie', async () => {
  const url = new URL(
    await createAuthorizationUrl({
      realm: 'vw-beav',
      clientId: 'portal-spa',
      clientSecret: 'test-secret',
      redirectUri: 'https://vw-baev.de/api/auth/callback',
      flow: 'login',
      loginMethod: 'verimi',
      tx: { state: 's', nonce: 'n', verifier: 'v', hasPasskey: true },
    }),
  );
  assert.equal(url.searchParams.get('kc_idp_hint'), 'verimi');
});

test('login handler: method=passkey produces a passkey login URL', async () => {
  const result = await login(event({ queryStringParameters: { method: 'passkey' } }));
  assert.equal(result.statusCode, 200);
  const url = new URL(JSON.parse(result.body).authorizationUrl);
  assert.equal(url.searchParams.has('kc_idp_hint'), false);
});

test('authorize URL: enrolment uses AIA and never hints Verimi', async () => {
  const url = new URL(
    await createAuthorizationUrl({
      realm: 'vw-beav',
      clientId: 'portal-spa',
      clientSecret: 'test-secret',
      redirectUri: 'https://vw-baev.de/api/auth/callback',
      flow: 'enroll',
      tx: { state: 's', nonce: 'n', verifier: 'v', hasPasskey: true },
    }),
  );
  assert.equal(url.searchParams.get('kc_action'), 'webauthn-register-passwordless:skip_if_exists');
  assert.equal(url.searchParams.has('kc_idp_hint'), false);
});

test('login returns a discovered authorization URL and an encrypted transaction cookie', async () => {
  const result = await login(event());
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.ok(
    body.authorizationUrl.startsWith(`${kcOrigin}/realms/vw-beav/protocol/openid-connect/auth?`),
  );
  assert.ok(result.cookies[0].startsWith('__Host-pk_tx='));
});

test('unknown host is rejected (no open redirect)', async () => {
  const result = await route(
    event({
      rawPath: '/api/auth/login',
      headers: { host: 'evil.example.com' },
    }),
  );
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).error, 'bad_request');
});

test('callback rejects a mismatched state before any token exchange', async () => {
  const tx = await seal(
    { state: 'expected', nonce: 'n', verifier: 'v', flow: 'login', portal: 'vw-baev.de', hasPasskey: false },
    config.txKey,
    { ttl: 600, issuer: 'vw-bff-transaction', audience: 'vw-baev.de' },
  );

  const result = await callback(
    event({
      headers: { host: 'vw-baev.de', cookie: `${COOKIES.tx}=${tx}` },
      queryStringParameters: { code: 'stolen-code', state: 'attacker' },
    }),
  );

  assert.equal(result.statusCode, 302);
  assert.match(result.headers.location, /reason=state_mismatch/);
  assert.equal(result.cookies.length, 1); // clears the tx cookie
});

test('enrolment without a portal session is refused', async () => {
  const result = await enroll(event());
  assert.equal(result.statusCode, 401);
});

test('/me with no session reports unauthenticated', async () => {
  const result = await me(event());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { authenticated: false, phase: config.phase });
});

test('enrolment flag is idempotent and survives a re-link', async () => {
  await linkUser({ kcSub: 'sub-1', portal: 'vw-baev.de', realm: 'vw-beav', verimiSub: 'verimi-1' });
  await markPasskeyVerified('sub-1');
  await linkUser({ kcSub: 'sub-1', portal: 'vw-baev.de', realm: 'vw-beav', verimiSub: 'verimi-1' });
  const user = await getUser('sub-1');
  assert.equal(user.passkeyEnrolled, true);
  assert.equal(user.verimiSub, 'verimi-1');
});

test('credential check can clear a stale passkey flag', async () => {
  await markPasskeyVerified('sub-stale');
  assert.equal((await getUser('sub-stale')).passkeyEnrolled, true);

  await setPasskeyVerified('sub-stale', false);
  assert.equal((await getUser('sub-stale')).passkeyEnrolled, false);

  await setPasskeyVerified('sub-stale', true);
  assert.equal((await getUser('sub-stale')).passkeyEnrolled, true);
});

test('DynamoDB link update never overwrites verimiSub with null', () => {
  const withSub = buildLinkUserUpdate({
    kcSub: 'sub-x',
    portal: 'vw-baev.de',
    realm: 'vw-beav',
    verimiSub: 'verimi-x',
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(withSub.ExpressionAttributeValues[':v'], 'verimi-x');

  const passkeyOnly = buildLinkUserUpdate({
    kcSub: 'sub-x',
    portal: 'vw-baev.de',
    realm: 'vw-beav',
    verimiSub: null,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(passkeyOnly.ExpressionAttributeValues[':v'], undefined);
  assert.doesNotMatch(passkeyOnly.UpdateExpression, /#vs/);
});

test('router accepts both custom-domain and direct Lambda paths', () => {
  assert.equal(normalizePath('/api/auth/login'), '/auth/login');
  assert.equal(normalizePath('/auth/login'), '/auth/login');
  assert.equal(normalizePath('/'), '/');
});

test('portal sessions become invalid after revocation', async () => {
  const sid = 'sid-test';
  await createSession({
    sid,
    kcSub: 'sub-session',
    portal: 'vw-baev.de',
    realm: 'vw-beav',
  });
  assert.equal(await isSessionActive(sid), true);

  const token = await seal(
    { sub: 'sub-session', portal: 'vw-baev.de', sid },
    config.sessionKey,
    {
      ttl: 600,
      issuer: 'vw-bff-session',
      audience: 'vw-portal-bff',
    },
  );
  const evt = event({ headers: { host: 'vw-baev.de', cookie: `${COOKIES.session}=${token}` } });
  assert.equal((await readSession(evt))?.sid, sid);

  assert.equal(await revokeSession(sid), true);
  assert.equal(await isSessionActive(sid), false);
  assert.equal(await readSession(evt), null);
});

test('enrolled hint is encrypted, portal-bound and sub-bound', async () => {
  const token = await setEnrolledHint({
    portalId: 'vw-baev.de',
    sub: 'sub-hint',
    enrolled: true,
  });
  const evt = event({ headers: { host: 'vw-baev.de', cookie: `${COOKIES.enrolled}=${token}` } });

  assert.equal(await readEnrolledHint(evt, 'vw-baev.de', 'sub-hint'), true);
  assert.equal(await readEnrolledHint(evt, 'vw-baev.de', 'other-sub'), null);
  assert.equal(await readEnrolledHint(evt, 'other.example', 'sub-hint'), null);
});
