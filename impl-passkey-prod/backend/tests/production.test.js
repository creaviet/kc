/**
 * Pure production tests. No mocks, no fakes, no network, no AWS calls.
 * They exercise the real crypto, cookie, config and routing code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const key1 = randomBytes(32).toString('base64url');
const key2 = randomBytes(32).toString('base64url');
const portals = [
  {
    portalHost: 'vw-baev.de', apiHost: 'api.vw-baev.de', realm: 'vw-beav',
    clientId: 'portal-bff', secretKey: 'vw-beav',
    redirectUri: 'https://api.vw-baev.de/api/auth/callback',
    postLoginUrl: 'https://vw-baev.de/', postLogoutUrl: 'https://vw-baev.de/?logged_out=1',
    verimiEnabled: true,
  },
];

process.env.KC_PUBLIC_URL = 'https://kc.gateway-vw.de:8443';
process.env.PORTALS_JSON = JSON.stringify(portals);
process.env.SECRETS_SECRET_ID = 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:vw-portal-secrets-abc123';
process.env.ENCRYPTION_KEYS_JSON = JSON.stringify({ '2026-11': key1, '2026-10': key2 });
process.env.ACTIVE_KEY_ID = '2026-11';
process.env.IDENTITY_TABLE = 'vw-identity-test';
process.env.SESSION_TABLE = 'vw-sessions-test';
process.env.STAGE = 'test';
process.env.NODE_ENV = 'production';

const cacheBust = `?t=${Date.now()}`;
const { config, portalForHost } = await import(`../src/config.js${cacheBust}`);
const { seal, open, safeEqual, randomToken, keyFingerprint } = await import(`../src/crypto.js${cacheBust}`);
const { TX_COOKIE, SESSION_COOKIE, writeCookie, clearCookie, readCookies } = await import(`../src/cookies.js${cacheBust}`);
const { normalizePath } = await import(`../src/router.js${cacheBust}`);
const { createTransaction, buildLogoutUrl } = await import(`../src/oidc.js${cacheBust}`);

test('configuration is derived only from validated environment', () => {
  assert.equal(config.kcPublicUrl, 'https://kc.gateway-vw.de:8443');
  assert.equal(config.portals.length, 1);
  assert.equal(config.byRealm.get('vw-beav').portalHost, 'vw-baev.de');
  assert.equal(portalForHost('api.vw-baev.de:443').realm, 'vw-beav');
  assert.equal(portalForHost('evil.example.org'), null);
});

test('fail closed: HTTP issuer URL is rejected', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.KC_PUBLIC_URL='http://kc.gateway-vw.de:8443';
    process.env.PORTALS_JSON=${JSON.stringify(JSON.stringify(portals))};
    process.env.SECRETS_SECRET_ID='x';
    process.env.ENCRYPTION_KEYS_JSON=${JSON.stringify(JSON.stringify({ k: key1 }))};
    process.env.ACTIVE_KEY_ID='k';
    process.env.IDENTITY_TABLE='i'; process.env.SESSION_TABLE='s'; process.env.STAGE='test';
    await import('file://${process.cwd()}/src/config.js?fail=${Date.now()}');
  `], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an HTTPS URL/);
});

test('JWE round-trip keeps payload confidential and authentic', async () => {
  const payload = { state: 'abc', nonce: 'def', exp: 9999999999 };
  const token = await seal(payload);
  assert.equal(token.split('.').length, 5);
  assert.ok(!token.includes('abc'));
  assert.deepEqual(await open(token), payload);

  const parts = token.split('.');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  assert.equal(await open(parts.join('.')), null);
  assert.equal(await open('not-a-jwe'), null);
});

test('a cookie sealed with a retired key can still be opened during rotation', async () => {
  const { CompactEncrypt } = await import('jose');
  const retiredKey = Buffer.from(config.encryptionKeys['2026-10'], 'base64url');
  const oldToken = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ v: 1, from: 'retired' })))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', cty: 'json', kid: '2026-10' })
    .encrypt(retiredKey);
  assert.deepEqual(await open(oldToken), { v: 1, from: 'retired' });
});

test('security tokens use constant-time comparison', () => {
  const a = randomToken(32);
  assert.equal(safeEqual(a, a), true);
  assert.equal(safeEqual(a, a.slice(0, -1) + 'X'), false);
  assert.equal(safeEqual(a, null), false);
  assert.equal(keyFingerprint('secret').length, 12);
});

test('cookies are __Host- compliant', () => {
  const cookie = writeCookie(TX_COOKIE, 'value', 600);
  assert.match(cookie, /^__Host-pk_tx=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/);
  assert.match(clearCookie(SESSION_COOKIE), /Max-Age=0/);
  assert.equal(readCookies(`${TX_COOKIE}=a; ${SESSION_COOKIE}=b`)[SESSION_COOKIE], 'b');
});

test('base path mapping and direct calls normalize to the same route', () => {
  assert.equal(normalizePath('/api/auth/login'), '/auth/login');
  assert.equal(normalizePath('/auth/login'), '/auth/login');
  assert.equal(normalizePath('/api/me'), '/me');
  assert.equal(normalizePath('/api/'), '/');
});

test('transactions are unique and logout URL is bound to the portal', async () => {
  const a = createTransaction();
  const b = createTransaction();
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.verifier, b.verifier);
  assert.equal(a.state.length, 43);

  const logout = new URL(buildLogoutUrl({ portal: config.portals[0], postLogoutUrl: 'https://vw-baev.de/?logged_out=1' }));
  assert.equal(logout.host, 'kc.gateway-vw.de:8443');
  assert.equal(logout.pathname, '/realms/vw-beav/protocol/openid-connect/logout');
  assert.equal(logout.searchParams.get('client_id'), 'portal-bff');
  assert.equal(logout.searchParams.get('post_logout_redirect_uri'), 'https://vw-baev.de/?logged_out=1');
});
