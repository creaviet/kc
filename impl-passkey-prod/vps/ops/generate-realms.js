#!/usr/bin/env node
/**
 * Real Keycloak realm provisioning via the Admin REST API. No Java, no mocks.
 *
 * Inputs (all real values, no defaults that could be mistaken for production):
 *   VPS_PORTALS_FILE   - portal manifest from backend/ops/portals.json
 *   VPS_VERIMI_FILE    - real Verimi endpoints + client credentials (gitignored)
 *   KC_ADMIN_URL       - https://kc-admin.gateway-vw.de:8444 (IP allowlisted)
 *   KC_ADMIN_USERNAME / KC_ADMIN_PASSWORD  - bootstrap admin (password grant), or
 *   KC_ADMIN_CLIENT_ID / KC_ADMIN_CLIENT_SECRET - service account (client credentials)
 *
 * Effects:
 *   - creates/updates one realm per portal
 *   - writes secrets to Keycloak's file vault (chmod 0600)
 *   - writes boot-import realm JSON to keycloak/generated/
 *   - writes portal client secrets to generated/portal-secrets.json for AWS import
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function required(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
  return value.trim();
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${path}: ${error.message}`);
  }
}

function replaceAll(text, replacements) {
  let result = text;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.split(`__${key}__`).join(String(value));
  }
  return result;
}

async function adminToken(adminUrl) {
  const useServiceAccount = Boolean(process.env.KC_ADMIN_CLIENT_SECRET);
  const body = new URLSearchParams();
  body.set('grant_type', useServiceAccount ? 'client_credentials' : 'password');
  if (useServiceAccount) {
    body.set('client_id', required(process.env.KC_ADMIN_CLIENT_ID, 'KC_ADMIN_CLIENT_ID'));
    body.set('client_secret', required(process.env.KC_ADMIN_CLIENT_SECRET, 'KC_ADMIN_CLIENT_SECRET'));
  } else {
    body.set('client_id', process.env.KC_ADMIN_CLIENT_ID || 'admin-cli');
    body.set('username', required(process.env.KC_ADMIN_USERNAME, 'KC_ADMIN_USERNAME'));
    body.set('password', required(process.env.KC_ADMIN_PASSWORD, 'KC_ADMIN_PASSWORD'));
  }
  body.set('scope', 'openid');

  const response = await fetch(`${adminUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`admin token request failed: ${response.status} ${await response.text()}`);
  const json = await response.json();
  return required(json.access_token, 'admin access_token');
}

async function adminFetch(adminUrl, token, path, options = {}) {
  const response = await fetch(`${adminUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(20000),
  });
  return response;
}

function writeSecretFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function newSecret() {
  return randomBytes(32).toString('base64url');
}

async function main() {
  const adminUrl = required(process.env.KC_ADMIN_URL, 'KC_ADMIN_URL').replace(/\/+$/, '');
  const portalsFile = required(process.env.VPS_PORTALS_FILE, 'VPS_PORTALS_FILE');
  const verimiFile = required(process.env.VPS_VERIMI_FILE, 'VPS_VERIMI_FILE');
  const templatePath = resolve(ROOT, 'keycloak/realm-template.json');
  const template = readFileSync(templatePath, 'utf8');

  const portals = readJson(portalsFile).portals;
  if (!Array.isArray(portals) || portals.length === 0) throw new Error('no portals in manifest');
  const verimi = readJson(verimiFile);

  const token = await adminToken(adminUrl);
  const generatedDir = resolve(ROOT, 'keycloak/generated');
  const vaultDir = resolve(ROOT, 'keycloak/vault');
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });

  const portalSecrets = {};

  for (const portal of portals) {
    if (portal.verimiEnabled) {
      for (const field of ['authorizationUrl', 'tokenUrl', 'userInfoUrl', 'jwksUrl', 'issuer', 'clientId', 'clientSecret']) {
        required(verimi[field], `verimi.${field}`);
      }
    }

    const portalSecretPath = resolve(vaultDir, `${portal.realm}-portal-secret`);
    const verimiSecretPath = resolve(vaultDir, `${portal.realm}-verimi-secret`);
    const portalSecret = existsSync(portalSecretPath)
      ? readFileSync(portalSecretPath, 'utf8').trim()
      : newSecret();
    writeSecretFile(portalSecretPath, portalSecret);
    if (portal.verimiEnabled) writeSecretFile(verimiSecretPath, verimi.clientSecret);

    let realmJson = replaceAll(template, {
      REALM: portal.realm,
      DISPLAY_NAME: portal.displayName || portal.portalHost,
      CLIENT_ID: portal.clientId,
      PORTAL_HOST: portal.portalHost,
      API_HOST: portal.apiHost,
      VERIMI_AUTHORIZATION_URL: verimi.authorizationUrl || '',
      VERIMI_TOKEN_URL: verimi.tokenUrl || '',
      VERIMI_USERINFO_URL: verimi.userInfoUrl || '',
      VERIMI_LOGOUT_URL: verimi.logoutUrl || '',
      VERIMI_JWKS_URL: verimi.jwksUrl || '',
      VERIMI_ISSUER: verimi.issuer || '',
      VERIMI_CLIENT_ID: verimi.clientId || '',
    });

    const realm = JSON.parse(realmJson);
    if (!portal.verimiEnabled) {
      realm.identityProviders = [];
      realm.identityProviderMappers = [];
    }

    const realmPath = resolve(generatedDir, `${portal.realm}-realm.json`);
    writeFileSync(realmPath, JSON.stringify(realm, null, 2) + '\n', { mode: 0o600 });

    const exists = await adminFetch(adminUrl, token, `/admin/realms/${encodeURIComponent(portal.realm)}`);
    if (exists.status === 404) {
      const created = await adminFetch(adminUrl, token, '/admin/realms', {
        method: 'POST',
        body: JSON.stringify(realm),
      });
      if (!created.ok) throw new Error(`create realm ${portal.realm} failed: ${created.status} ${await created.text()}`);
      console.log(`CREATED realm ${portal.realm}`);
    } else if (exists.ok) {
      const updated = await adminFetch(adminUrl, token, `/admin/realms/${encodeURIComponent(portal.realm)}`, {
        method: 'PUT',
        body: JSON.stringify(realm),
      });
      if (!updated.ok) throw new Error(`update realm ${portal.realm} failed: ${updated.status} ${await updated.text()}`);
      console.log(`UPDATED realm ${portal.realm}`);
    } else {
      throw new Error(`cannot check realm ${portal.realm}: ${exists.status}`);
    }

    portalSecrets[portal.secretKey] = portalSecret;
  }

  const secretsOut = resolve(ROOT, 'generated/portal-secrets.json');
  mkdirSync(dirname(secretsOut), { recursive: true });
  writeFileSync(secretsOut, JSON.stringify(portalSecrets, null, 2) + '\n', { mode: 0o600 });
  chmodSync(secretsOut, 0o600);
  console.log(`Wrote ${secretsOut} — import this into AWS Secrets Manager (chmod 0600, never commit).`);
}

main().catch((error) => {
  console.error(`REALM PROVISIONING FAILED: ${error.message}`);
  process.exit(1);
});
