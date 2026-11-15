'use strict';

/* ==========================================================================
 *  Configuration contract tests
 * ==========================================================================
 *  The demo's security posture lives in configuration, not in code: the
 *  WebAuthn RP ID, the client's redirect URIs, the IdP's PKCE/signature
 *  settings, the TLS hostnames and the edge routing all have to agree.
 *  These tests fail when one side drifts (e.g. renaming a host in nginx but
 *  not in the realm export).
 *
 *  No dependencies: the realm JSON is parsed, the text files are pattern
 *  matched on purpose so the tests stay readable.
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const IMPL = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(IMPL, rel), 'utf8');

const realm = JSON.parse(read('keycloak/realm-export.json'));
const envExample = read('.env.example');
const compose = read('docker-compose.yml');
const nginxConf = read('nginx/nginx.conf');
const vhostConf = fs
  .readdirSync(path.join(IMPL, 'nginx', 'conf.d'))
  .filter((name) => name.endsWith('.conf'))
  .map((name) => ({ name, text: read(path.join('nginx', 'conf.d', name)) }));
const genCerts = read('scripts/gen-certs.sh');
const portalHtml = read('portal/index.html');
const portalJs = read('portal/app.js');
const handlerJs = read('lambda/handler.js');

const envValue = (key) => {
  const match = envExample.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : undefined;
};

const kcHost = envValue('KC_PUBLIC_HOST');
const portalUrl = `https://portal.gateway-vw.de:8443`;
const verimiIssuer = envValue('VERIMI_ISSUER').replace(/\/+$/, '');
const verimiHost = new URL(verimiIssuer).hostname;

const client = realm.clients.find((entry) => entry.clientId === envValue('KEYCLOAK_CLIENT_ID'));
const idp = realm.identityProviders.find((entry) => entry.alias === 'verimi');

test('hostnames agree across nginx, .env, certificates and compose', () => {
  const served = vhostConf.flatMap(({ text }) => {
    const match = text.match(/server_name\s+([^;]+);/);
    return match ? match[1].split(/\s+/) : [];
  });

  const expected = [...new Set([kcHost, verimiHost, new URL(portalUrl).hostname, new URL(envValue('KC_HOSTNAME_ADMIN')).hostname])];

  for (const host of expected) {
    assert.ok(served.includes(host), `nginx must serve ${host} (served: ${served.join(', ')})`);
  }

  const domains = genCerts.match(/^DOMAINS=\$\{DOMAINS:-"([^"]+)"\}/m)[1].split(/\s+/);
  for (const host of expected) {
    assert.ok(domains.includes(host), `gen-certs.sh must include ${host} in its SANs`);
  }
  assert.ok(domains.includes('localhost'), 'gen-certs.sh should keep localhost for convenience');
  assert.match(genCerts, /IP\.1 = 127\.0\.0\.1/, 'certificate must cover 127.0.0.1');

  assert.match(compose, /KC_HOSTNAME: \$\{KC_HOSTNAME:-https:\/\/kc\.gateway-vw\.de:8443\}/);
  assert.match(compose, /KC_HOSTNAME_ADMIN: \$\{KC_HOSTNAME_ADMIN:-https:\/\/kc-admin\.gateway-vw\.de:8444\}/);
});

test('the admin console is separated from the public endpoint', () => {
  const publicVhost = vhostConf.find(({ name }) => name.startsWith('10-')).text;
  const adminVhost = vhostConf.find(({ name }) => name.startsWith('20-')).text;

  assert.match(publicVhost, /listen 8443 ssl;/, 'public Keycloak vhost must stay on 8443');
  assert.match(adminVhost, /listen 8444 ssl;/, 'admin vhost must stay on its own port');
  assert.ok(!/server_name[^;]*kc-admin/.test(publicVhost), 'admin host must not be served on 8443');
  assert.match(adminVhost, /#\s*deny all;/, 'admin vhost should ship a ready-to-enable deny block');
});

test('WebAuthn policy is phishing-resistant and bound to the public hostname', () => {
  assert.equal(realm.webAuthnPolicyPasswordlessRpId, kcHost);
  assert.equal(realm.webAuthnPolicyPasswordlessResidentKey, 'required');
  assert.equal(realm.webAuthnPolicyPasswordlessUserVerificationRequirement, 'required');
  assert.equal(realm.webAuthnPolicyRpId, kcHost);
});

test('the SPA client is public, PKCE-only and locked to the portal origin', () => {
  assert.ok(client, 'client from .env must exist in the realm export');
  assert.equal(client.publicClient, true);
  assert.equal(client.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(client.standardFlowEnabled, true);
  assert.equal(client.implicitFlowEnabled, undefined);
  assert.deepEqual(client.redirectUris, [`${portalUrl}/auth/callback`]);
  assert.deepEqual(client.webOrigins, [portalUrl]);
  assert.ok(
    client.attributes['post.logout.redirect.uris'].startsWith(`${portalUrl}/`),
    'post-logout redirect must stay on the portal origin'
  );
});

test('the Verimi IdP enforces PKCE and signature validation', () => {
  assert.ok(idp, 'identity provider "verimi" must exist');
  assert.equal(idp.providerId, 'oidc');
  assert.equal(idp.config.pkceEnabled, 'true');
  assert.equal(idp.config.pkceMethod, 'S256');
  assert.equal(idp.config.validateSignature, 'true');
  assert.equal(idp.config.useJwksUrl, 'true');
  assert.equal(idp.config.syncMode, 'IMPORT');
  assert.equal(idp.config.trustEmail, 'true');

  for (const key of ['authorizationUrl', 'tokenUrl', 'jwksUrl']) {
    assert.ok(idp.config[key].startsWith('https://'), `${key} must be https (Keycloak rejects http back-channels)`);
    assert.ok(idp.config[key].startsWith(verimiIssuer), `${key} must point at VERIMI_ISSUER`);
  }

  assert.equal(idp.config.clientSecret, envValue('VERIMI_CLIENT_SECRET'));
  assert.match(idp.config.clientSecret, /^CHANGE_ME_/, 'no real secret may be committed');
});

test('identity provisioning carries every claim the demo promises', () => {
  const byName = new Map(realm.identityProviderMappers.map((mapper) => [mapper.identityProviderMapper, mapper]));

  assert.ok(byName.has('oidc-username-idp-mapper'), 'username mapper is required');
  assert.ok(byName.has('oidc-user-attribute-idp-mapper'), 'attribute mappers are required');
  const attributes = realm.identityProviderMappers
    .filter((mapper) => mapper.identityProviderMapper === 'oidc-user-attribute-idp-mapper')
    .map((mapper) => mapper.config['user.attribute']);
  for (const attribute of ['email', 'firstName', 'lastName']) {
    assert.ok(attributes.includes(attribute), `${attribute} mapper is required`);
  }

  const roleMapper = realm.identityProviderMappers.find((mapper) => mapper.identityProviderMapper === 'oidc-hardcoded-role-idp-mapper');
  assert.ok(roleMapper, 'new users need a role mapper');
  assert.equal(roleMapper.config.role, 'portal_user');
});

test('both passkey required actions are enabled (AIA needs them)', () => {
  for (const alias of ['webauthn-register', 'webauthn-register-passwordless']) {
    const action = realm.requiredActions.find((entry) => entry.alias === alias);
    assert.ok(action, `${alias} must exist`);
    assert.equal(action.enabled, true, `${alias} must be enabled`);
  }
});

test('the API never talks to the Keycloak Admin API', () => {
  assert.ok(!handlerJs.includes('/admin/realms'), 'the Lambda must not use the Keycloak Admin API');
  assert.ok(!handlerJs.includes('SYSTEM_CLIENT_SECRET'), 'no admin credentials in the API');
  assert.ok(handlerJs.includes("'RS256'"), 'JWT verification must pin RS256');
  assert.ok(handlerJs.includes('claims.iss !== CONFIG.issuer'), 'issuer must be enforced');
});

test('the SPA is CSP-compatible (no inline script, no eval)', () => {
  const inlineScripts = portalHtml.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || [];
  assert.equal(inlineScripts.length, 0, 'inline <script> would be blocked by script-src \'self\'');
  assert.ok(!/\beval\s*\(/.test(portalJs), 'eval() must not be used');
  assert.ok(!/new\s+Function\s*\(/.test(portalJs), 'new Function() must not be used');

  const portalVhost = vhostConf.find(({ name }) => name.startsWith('30-')).text;
  assert.match(portalVhost, /Content-Security-Policy/, 'portal vhost must ship a CSP');
  assert.ok(!/unsafe-inline/.test(portalVhost), 'CSP must not allow inline code');
});

test('the stack pins images and exposes only the intended ports', () => {
  assert.ok(!/:latest\b/.test(compose), 'images must be pinned');
  const published = [...compose.matchAll(/^\s+-\s+"(\d+):(\d+)"/gm)].map((match) => Number(match[1]));
  assert.deepEqual(published.sort((a, b) => a - b), [8443, 8444, 3443]);
  assert.ok(!published.includes(8080), 'Keycloak must not be published directly');
  assert.ok(!published.includes(5432), 'PostgreSQL must not be published');
  assert.match(compose, /KC_TRUSTSTORE_PATHS: \/certs\/ca\.crt/, 'Keycloak must trust the demo CA');
  assert.match(compose, /aliases:\s*\n\s+- verimi\.gateway-vw\.de/, 'mock IdP needs the compose network alias');
  assert.match(nginxConf, /limit_req_zone/, 'the API should have a rate limit in front of it');
});

test('operational scripts are executable and syntax-documented', () => {
  for (const name of fs.readdirSync(path.join(IMPL, 'scripts'))) {
    const full = path.join(IMPL, 'scripts', name);
    const mode = fs.statSync(full).mode;
    assert.ok(mode & 0o100, `${name} must be executable by the owner`);
    const first = fs.readFileSync(full, 'utf8').split('\n')[0];
    assert.equal(first, '#!/bin/sh', `${name} must declare a POSIX shell`);
  }
});
