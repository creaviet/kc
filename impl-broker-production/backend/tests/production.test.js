/**
 * Production unit tests — deterministic, no network, no mock services.
 *
 * These tests verify the fail-closed configuration, cookie/JWE guarantees,
 * host binding, callback URL reconstruction, and pure DynamoDB update shapes.
 * Real OIDC/JWKS behaviour is verified against Keycloak with
 * `npm run ops:verify:keycloak` before deployment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as oidcClient from 'openid-client';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');

const portalHosts = [
  'vw-baev.de',
  'ltkv.de',
  'portal3.vw-baev.de',
  'portal4.vw-baev.de',
  'portal5.vw-baev.de',
  'portal6.vw-baev.de',
  'portal7.vw-baev.de',
  'portal8.vw-baev.de',
  'portal9.vw-baev.de',
];

const portals = Object.fromEntries(
  portalHosts.map((host, index) => [
    host,
    {
      realm: `rw-${index + 1}`,
      clientId: 'portal-spa',
      clientSecret: `test-client-secret-${index + 1}-0123456789abcdef`,
      redirectUri: `https://${host}/api/auth/callback`,
    },
  ]),
);

// Env MUST be set before any src module is imported (config fails closed).
process.env.KC_BASE_URL = 'https://kc.gateway-vw.de:8443';
process.env.KC_PUBLIC_URL = 'https://kc.gateway-vw.de:8443';
process.env.PHASE = 'B';
process.env.PORTALS_JSON = JSON.stringify(portals);
process.env.EXPECTED_PORTAL_COUNT = '9';
process.env.SESSION_ENC_KEY_B64U = randomBytes(32).toString('base64url');
process.env.TX_ENC_KEY_B64U = randomBytes(32).toString('base64url');
process.env.ENROLLED_ENC_KEY_B64U = randomBytes(32).toString('base64url');

const configModuleUrl = new URL('../src/config.js', import.meta.url).href;

const { config } = await import('../src/config.js');
const { seal, open, safeEqual, randomToken } = await import('../src/crypto.js');
const { COOKIES, setCookie } = await import('../src/cookies.js');
const { createOidcTransaction } = await import('../src/oidc.js');
const { callback } = await import('../src/handlers/callback.js');
const { enroll } = await import('../src/handlers/enroll.js');
const { me } = await import('../src/handlers/me.js');
const { resolvePortal, requestUrl, portalHomeUrl, safeReason } = await import('../src/http.js');
const { buildLinkUserUpdate } = await import('../src/store.js');
const { route, normalizePath } = await import('../src/router.js');

function event(overrides = {}) {
  return {
    rawPath: '/me',
    requestContext: {
      http: { method: 'GET' },
      domainName: 'vw-baev.de',
      requestId: 'test-request-id',
    },
    headers: {},
    queryStringParameters: {},
    ...overrides,
    requestContext: { ...{ http: { method: 'GET' }, domainName: 'vw-baev.de', requestId: 'test-request-id' }, ...(overrides.requestContext || {}) },
  };
}

function configImportFailsWith(overrides) {
  const code = `import(${JSON.stringify(configModuleUrl)}).then(()=>process.exit(0)).catch(()=>process.exit(1))`;
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: backendRoot,
    env: { ...process.env, ...overrides },
    encoding: 'utf8',
  });
  return result.status !== 0;
}

test('PKCE S256 matches the RFC 7636 reference vector', async () => {
  assert.equal(
    await oidcClient.calculatePKCECodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('config fails closed on local/dev escape hatches and bad URLs', () => {
  assert.equal(configImportFailsWith({ INSECURE_COOKIES: 'true' }), true);
  assert.equal(configImportFailsWith({ ALLOW_INSECURE_OIDC: 'true' }), true);
  assert.equal(configImportFailsWith({ DEV_PORTAL_HOST: 'vw-baev.de' }), true);
  assert.equal(configImportFailsWith({ STORE: 'memory' }), true);
  assert.equal(configImportFailsWith({ KC_BASE_URL: 'http://kc.gateway-vw.de:8443' }), true);
  assert.equal(
    configImportFailsWith({
      PORTALS_JSON: JSON.stringify(
        Object.fromEntries(
          Object.entries(portals).filter(([host]) => host !== 'portal9.vw-baev.de'),
        ),
      ),
    }),
    true,
  );
});

test('JWE seal/open round-trips and rejects tampering and wrong audience', async () => {
  const token = await seal({ hello: 'world' }, config.txKey, {
    ttl: 60,
    issuer: 'test-issuer',
    audience: 'vw-baev.de',
  });
  const payload = await open(token, config.txKey, {
    issuer: 'test-issuer',
    audience: 'vw-baev.de',
  });
  assert.equal(payload.hello, 'world');

  const broken = `${token.slice(0, -4)}AAAA`;
  await assert.rejects(() =>
    open(broken, config.txKey, { issuer: 'test-issuer', audience: 'vw-baev.de' }),
  );
  await assert.rejects(() =>
    open(token, config.txKey, { issuer: 'test-issuer', audience: 'evil.example.org' }),
  );
});

test('CSPRNG tokens and constant-time comparison behave correctly', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false);
  assert.ok(randomToken().length > 20);

  const a = createOidcTransaction();
  const b = createOidcTransaction();
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.verifier, b.verifier);
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

test('portal is resolved from API Gateway domainName, not Host header', () => {
  const resolved = resolvePortal(
    event({ headers: { host: 'evil.example.org' } }),
  );
  assert.equal(resolved.portalId, 'vw-baev.de');
  assert.throws(() => resolvePortal(event({ requestContext: { domainName: 'evil.example.org' } })));
  assert.throws(() =>
    resolvePortal({
      requestContext: { http: { method: 'GET' } },
      headers: {},
      queryStringParameters: {},
    }),
  );
});

test('callback URL is reconstructed with the /api base path', () => {
  const url = requestUrl(
    event({
      rawPath: '/auth/callback',
      rawQueryString: 'code=abc&state=s',
    }),
  );
  assert.equal(url, 'https://vw-baev.de/api/auth/callback?code=abc&state=s');

  const alreadyPrefixed = requestUrl(
    event({
      rawPath: '/api/auth/callback',
      rawQueryString: 'code=abc&state=s',
    }),
  );
  assert.equal(alreadyPrefixed, url);
});

test('router normalizes both custom-domain and direct Lambda paths', () => {
  assert.equal(normalizePath('/api/auth/login'), '/auth/login');
  assert.equal(normalizePath('/auth/login'), '/auth/login');
  assert.equal(normalizePath('/'), '/');
});

test('post-logout URL is derived from the registered redirectUri', () => {
  assert.equal(portalHomeUrl(portals['vw-baev.de']), 'https://vw-baev.de/?logged_out=1');
});

test('only fixed reason codes are reflected to the SPA', () => {
  assert.equal(safeReason('state_mismatch'), 'state_mismatch');
  assert.equal(safeReason('<script>'), 'internal_error');
});

test('DynamoDB link update never overwrites verimiSub with null', () => {
  const withSub = buildLinkUserUpdate({
    kcSub: 'sub-x',
    portal: 'vw-baev.de',
    realm: 'rw-1',
    verimiSub: 'verimi-x',
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(withSub.ExpressionAttributeValues[':v'], 'verimi-x');

  const passkeyOnly = buildLinkUserUpdate({
    kcSub: 'sub-x',
    portal: 'vw-baev.de',
    realm: 'rw-1',
    verimiSub: null,
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(passkeyOnly.ExpressionAttributeValues[':v'], undefined);
  assert.doesNotMatch(passkeyOnly.UpdateExpression, /#vs/);
});

test('callback rejects a mismatched state before any token exchange', async () => {
  const tx = await seal(
    {
      state: 'expected',
      nonce: 'n',
      verifier: 'v',
      flow: 'login',
      portal: 'vw-baev.de',
      hasPasskey: false,
    },
    config.txKey,
    { ttl: 600, issuer: 'vw-bff-transaction', audience: 'vw-baev.de' },
  );

  const result = await callback(
    event({
      rawPath: '/auth/callback',
      headers: { cookie: `${COOKIES.tx}=${tx}` },
      queryStringParameters: { code: 'stolen-code', state: 'attacker' },
    }),
  );

  assert.equal(result.statusCode, 302);
  assert.match(result.headers.location, /reason=state_mismatch/);
  assert.equal(result.cookies.length, 1);
});

test('enrolment without a portal session is refused', async () => {
  const result = await enroll(event({ rawPath: '/auth/enroll' }));
  assert.equal(result.statusCode, 401);
});

test('/me without a session reports unauthenticated', async () => {
  const result = await me(event({ rawPath: '/me' }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { authenticated: false, phase: 'B' });
});

test('unknown portal returns a controlled 400 response', async () => {
  const result = await route(
    event({
      rawPath: '/me',
      requestContext: { domainName: 'evil.example.org', http: { method: 'GET' } },
    }),
  );
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).error, 'bad_request');
});
