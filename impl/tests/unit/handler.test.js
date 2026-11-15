'use strict';

/* ==========================================================================
 *  Unit tests for lambda/handler.js  (node:test, no dependencies)
 * ==========================================================================
 *  Run:  cd impl/tests && npm test        (or: node --test unit/)
 *
 *  The handler is loaded fresh per configuration group (module cache bust) so
 *  its module-level CONFIG/JWKS/session state never leaks between tests.
 *  A local HTTP server stands in for the realm JWKS endpoint, so no network
 *  egress and no Keycloak instance are required.
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const IMPL = path.resolve(__dirname, '..', '..');
const HANDLER_PATH = path.join(IMPL, 'lambda', 'handler.js');

const KC_PUBLIC = 'https://kc.gateway-vw.de:8443';
const ISSUER = `${KC_PUBLIC}/realms/vw-beav`;
const CLIENT_ID = 'portal-spa';

/* -------------------------------------------------------------------------- */
/* Signing keys + JWKS double                                                */
/* -------------------------------------------------------------------------- */

const KID = 'unit-test-kid';
const good = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const publicJwk = { ...good.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

let jwksServer;
let jwksUrl;

test.before(async () => {
  jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/certs`;
});

test.after(async () => {
  if (jwksServer) await new Promise((resolve) => jwksServer.close(resolve));
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(claims = {}, opts = {}) {
  const alg = opts.alg || 'RS256';
  const kid = opts.kid || KID;
  const key = opts.key || good.privateKey;
  const now = Math.floor(Date.now() / 1000);
  const header = alg === 'none' ? { alg: 'none' } : { alg, typ: 'JWT', kid };
  const payload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'kc-sub-default',
    exp: now + 300,
    iat: now,
    ...claims,
  };
  const input = `${b64url(header)}.${b64url(payload)}`;
  const signature = alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
  return `${input}.${signature}`;
}

let storeCounter = 0;
function storePath() {
  storeCounter += 1;
  return path.join(os.tmpdir(), `vw-unit-${process.pid}-${storeCounter}-${Date.now()}.json`);
}

const ENV_KEYS = [
  'KEYCLOAK_PUBLIC_URL',
  'KEYCLOAK_INTERNAL_URL',
  'KEYCLOAK_JWKS_URL',
  'KEYCLOAK_REALM',
  'KEYCLOAK_CLIENT_ID',
  'STORE_PATH',
  'DEMO_MODE',
  'DEMO_PORTAL_ACCOUNT_ID',
  'CLOCK_SKEW_SECONDS',
  'PORTAL_SESSION_TTL_MS',
];

/** Load a fresh handler instance with a fresh module-level cache. */
function loadHandler(env = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    KEYCLOAK_PUBLIC_URL: KC_PUBLIC,
    KEYCLOAK_JWKS_URL: jwksUrl,
    KEYCLOAK_REALM: 'vw-beav',
    KEYCLOAK_CLIENT_ID: CLIENT_ID,
    DEMO_MODE: 'true',
    STORE_PATH: storePath(),
    ...env,
  });
  delete require.cache[require.resolve(HANDLER_PATH)];
  return require(HANDLER_PATH);
}

function event(method, pathname, { headers = {}, body } = {}) {
  return {
    requestContext: { http: { method } },
    rawPath: pathname,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  };
}

const call = (handler, method, pathname, opts) => handler.handler(event(method, pathname, opts));

async function newSession(handler, accountId) {
  const res = await call(handler, 'POST', '/api/demo/portal-session', { body: { accountId } });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body).portalSession;
}

function link(handler, session, bearer, body = {}) {
  const headers = { 'x-portal-session': session };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return call(handler, 'POST', '/api/link-account', { headers, body });
}

/* -------------------------------------------------------------------------- */
/* Health + demo session                                                     */
/* -------------------------------------------------------------------------- */

test('GET /api/healthz reports the configured issuer', async () => {
  const h = loadHandler();
  const res = await call(h, 'GET', '/api/healthz');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ok');
  assert.equal(body.issuer, ISSUER);
  assert.equal(body.demoMode, true);
});

test('POST /api/demo/portal-session issues an opaque token and validates the account id', async () => {
  const h = loadHandler({ DEMO_PORTAL_ACCOUNT_ID: 'K-4711' });

  const ok = await call(h, 'POST', '/api/demo/portal-session', { body: {} });
  assert.equal(ok.statusCode, 200);
  const issued = JSON.parse(ok.body);
  assert.equal(issued.accountId, 'K-4711');
  assert.match(issued.portalSession, /^[A-Za-z0-9_-]{43}$/);

  const bad = await call(h, 'POST', '/api/demo/portal-session', { body: { accountId: 'bad id!' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(JSON.parse(bad.body).error, 'invalid_account_id');
});

test('POST /api/demo/portal-session is unavailable when DEMO_MODE=false', async () => {
  const h = loadHandler({ DEMO_MODE: 'false' });
  const res = await call(h, 'POST', '/api/demo/portal-session', { body: { accountId: 'K-1' } });
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, 'not_found');
});

/* -------------------------------------------------------------------------- */
/* Token verification (the security core)                                    */
/* -------------------------------------------------------------------------- */

test('kc_action_status=success alone authorises nothing', async () => {
  const h = loadHandler();
  const session = await newSession(h, 'K-1001');
  const res = await call(h, 'POST', '/api/link-account', {
    headers: { 'x-portal-session': session },
    body: { kcActionStatus: 'success' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error, 'missing_token');
});

test('link rejects malformed, unsigned, foreign-signed and mis-claimed tokens', async (t) => {
  const h = loadHandler();
  const session = await newSession(h, 'K-1002');

  const cases = [
    ['Malformed JWT', 'not-a-jwt'],
    ['Unsupported algorithm', token({}, { alg: 'none' })],
    ['Unsupported algorithm', token({}, { alg: 'HS256' })],
    ['Unknown signing key id', token({}, { kid: 'rotated-away' })],
    ['Bad signature', token({}, { key: other.privateKey })],
    ['Wrong audience', token({ aud: 'some-other-client' })],
    ['Wrong issuer', token({ iss: 'https://evil.example/realms/vw-beav' })],
    ['Token expired', token({ exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['Token issued in the future', token({ iat: Math.floor(Date.now() / 1000) + 3600 })],
    ['Token not yet valid', token({ nbf: Math.floor(Date.now() / 1000) + 3600 })],
    ['Missing subject', token({ sub: '' })],
  ];

  for (const [expected, bearer] of cases) {
    const res = await link(h, session, bearer);
    assert.equal(res.statusCode, 401, `${expected}: expected 401`);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'invalid_token', expected);
    assert.equal(body.error_description, expected);
    t.diagnostic(`ok: ${expected}`);
  }
});

test('link accepts a correctly signed ID token and persists the mapping', async () => {
  const store = storePath();
  const h = loadHandler({ STORE_PATH: store });
  const session = await newSession(h, 'K-1003');

  const res = await link(h, session, token({ sub: 'kc-sub-1003', preferred_username: 'anna.beispiel', email: 'anna@example.org', email_verified: true }), { kcActionStatus: 'success' });
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.equal(body.portalAccountId, 'K-1003');
  assert.equal(body.keycloakSub, 'kc-sub-1003');
  assert.equal(body.username, 'anna.beispiel');
  assert.equal(body.kcActionStatus, 'success');

  const onDisk = JSON.parse(await fsp.readFile(store, 'utf8'));
  assert.equal(onDisk.links['K-1003'].keycloakSub, 'kc-sub-1003');
  assert.equal(onDisk.links['K-1003'].lastKcActionStatus, 'success');

  const mode = (await fsp.stat(store)).mode & 0o777;
  assert.equal(mode, 0o600, 'mapping file must not be world-readable');

  const read = await call(h, 'GET', '/api/link-account', { headers: { 'x-portal-session': session } });
  assert.equal(read.statusCode, 200);
  assert.equal(JSON.parse(read.body).linked, true);
});

test('re-linking the same pair is idempotent (200, original linkedAt)', async () => {
  const h = loadHandler();
  const session = await newSession(h, 'K-1004');
  const idToken = token({ sub: 'kc-sub-1004' });

  const first = await link(h, session, idToken);
  const second = await link(h, session, idToken);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body).linkedAt, JSON.parse(first.body).linkedAt);
});

test('conflicts are rejected in both directions', async () => {
  const h = loadHandler();
  const sessionA = await newSession(h, 'K-1005');
  const sessionB = await newSession(h, 'K-1006');

  assert.equal((await link(h, sessionA, token({ sub: 'kc-sub-1005' }))).statusCode, 201);

  const stolenIdentity = await link(h, sessionB, token({ sub: 'kc-sub-1005' }));
  assert.equal(stolenIdentity.statusCode, 409);
  assert.equal(JSON.parse(stolenIdentity.body).error, 'identity_already_linked');

  const repointedAccount = await link(h, sessionA, token({ sub: 'kc-sub-other' }));
  assert.equal(repointedAccount.statusCode, 409);
  assert.equal(JSON.parse(repointedAccount.body).error, 'portal_account_already_linked');
});

test('mappings survive a handler restart (same STORE_PATH)', async () => {
  const store = storePath();
  const first = loadHandler({ STORE_PATH: store });
  const session = await newSession(first, 'K-1007');
  // portal sessions are in memory, so the surviving assertion is the stored mapping
  assert.equal((await link(first, session, token({ sub: 'kc-sub-1007' }))).statusCode, 201);

  const second = loadHandler({ STORE_PATH: store });
  const fresh = await newSession(second, 'K-1007');
  const res = await call(second, 'GET', '/api/link-account', { headers: { 'x-portal-session': fresh } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.linked, true);
  assert.equal(body.keycloakSub, 'kc-sub-1007');
});

/* -------------------------------------------------------------------------- */
/* Portal session + routing                                                  */
/* -------------------------------------------------------------------------- */

test('portal session header is mandatory and must be known', async () => {
  const h = loadHandler();
  const idToken = token();

  const missing = await call(h, 'POST', '/api/link-account', { headers: { authorization: `Bearer ${idToken}` }, body: {} });
  assert.equal(missing.statusCode, 401);
  assert.equal(JSON.parse(missing.body).error, 'missing_portal_session');

  const forged = await link(h, 'forged-session', idToken);
  assert.equal(forged.statusCode, 401);
  assert.equal(JSON.parse(forged.body).error, 'invalid_portal_session');

  const read = await call(h, 'GET', '/api/link-account', { headers: { 'x-portal-session': 'forged-session' } });
  assert.equal(read.statusCode, 401);
});

test('unknown routes 404 and CORS preflight is answered', async () => {
  const h = loadHandler();

  const missing = await call(h, 'GET', '/api/nope');
  assert.equal(missing.statusCode, 404);
  assert.equal(JSON.parse(missing.body).error, 'not_found');

  const preflight = await call(h, 'OPTIONS', '/api/link-account');
  assert.equal(preflight.statusCode, 204);
  assert.match(preflight.headers['access-control-allow-headers'], /x-portal-session/);
  assert.match(preflight.headers['access-control-allow-methods'], /POST/);
});

test('body guards reject invalid JSON and oversized payloads', async () => {
  const h = loadHandler({ DEMO_MODE: 'true' });

  const broken = await call(h, 'POST', '/api/demo/portal-session', { body: '{not json' });
  assert.equal(broken.statusCode, 400);
  assert.equal(JSON.parse(broken.body).error, 'invalid_body');

  const huge = await call(h, 'POST', '/api/demo/portal-session', { body: JSON.stringify({ accountId: 'K-1', pad: 'x'.repeat(64 * 1024) }) });
  assert.equal(huge.statusCode, 413);
  assert.equal(JSON.parse(huge.body).error, 'body_too_large');
});

test('store file stays private and is created next to its directory', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vw-store-'));
  const store = path.join(dir, 'nested', 'mappings.json');
  const h = loadHandler({ STORE_PATH: store });
  const session = await newSession(h, 'K-1008');

  assert.equal((await link(h, session, token({ sub: 'kc-sub-1008' }))).statusCode, 201);
  assert.ok(fs.existsSync(store));
  const parsed = JSON.parse(await fsp.readFile(store, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.links['K-1008'].keycloakSub, 'kc-sub-1008');
});
