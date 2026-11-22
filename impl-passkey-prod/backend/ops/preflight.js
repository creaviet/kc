#!/usr/bin/env node
/**
 * Real production preflight.
 *
 * 1. Validates the portal manifest (hostnames, unique realms, exact callback URI).
 * 2. Calls the REAL Keycloak discovery endpoint of every realm and verifies
 *    issuer / authorization / token / JWKS URLs.
 * 3. Optionally verifies all client secrets exist in AWS Secrets Manager.
 *
 * There are no mocks. If a realm is not reachable the script exits non-zero.
 *
 * Usage:
 *   PORTALS_FILE=ops/portals.json KC_PUBLIC_URL=https://kc.gateway-vw.de:8443 \
 *     node ops/preflight.js [--with-secrets] [--secret-id <name>]
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const HOSTNAME = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const PortalSchema = z.object({
  portalHost: z.string().regex(HOSTNAME),
  apiHost: z.string().regex(HOSTNAME),
  realm: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  clientId: z.string().min(1),
  secretKey: z.string().min(1),
  redirectUri: z.string().url(),
  postLoginUrl: z.string().url(),
  postLogoutUrl: z.string().url(),
  verimiEnabled: z.boolean(),
}).strict();

function fail(message) {
  console.error(`PREFLIGHT FAILED: ${message}`);
  process.exit(1);
}

async function checkDiscovery(kcPublicUrl, portal) {
  const url = `${kcPublicUrl}/realms/${encodeURIComponent(portal.realm)}/.well-known/openid-configuration`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);

  const metadata = await response.json();
  const expectedIssuer = `${kcPublicUrl}/realms/${portal.realm}`;
  if (metadata.issuer !== expectedIssuer) {
    throw new Error(`issuer mismatch: expected ${expectedIssuer}, got ${metadata.issuer}`);
  }
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!String(metadata[field] ?? '').startsWith(kcPublicUrl)) {
      throw new Error(`${field} is not on ${kcPublicUrl}`);
    }
  }
  return metadata;
}

async function main() {
  const file = process.env.PORTALS_FILE ?? 'ops/portals.json';
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }

  if (manifest.expectedPortalCount !== 9) fail('expectedPortalCount must be 9');
  const parsed = z.array(PortalSchema).safeParse(manifest.portals);
  if (!parsed.success) fail(`portal schema invalid: ${parsed.error.message}`);
  if (parsed.data.length !== 9) fail(`expected 9 portals, found ${parsed.data.length}`);

  const kcPublicUrl = String(process.env.KC_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (!kcPublicUrl.startsWith('https://')) fail('KC_PUBLIC_URL must be an https URL');

  const realms = new Set();
  const hosts = new Set();

  for (const portal of parsed.data) {
    if (realms.has(portal.realm)) fail(`duplicate realm ${portal.realm}`);
    if (hosts.has(portal.portalHost) || hosts.has(portal.apiHost)) fail(`duplicate host for ${portal.realm}`);
    realms.add(portal.realm);
    hosts.add(portal.portalHost);
    hosts.add(portal.apiHost);

    const expected = `https://${portal.apiHost}/api/auth/callback`;
    if (portal.redirectUri !== expected) fail(`${portal.realm}: redirectUri must be ${expected}`);

    try {
      await checkDiscovery(kcPublicUrl, portal);
      console.log(`OK  discovery  ${portal.realm}`);
    } catch (error) {
      fail(`${portal.realm}: ${error.message}`);
    }
  }

  if (process.argv.includes('--with-secrets')) {
    const secretIdIndex = process.argv.indexOf('--secret-id');
    const secretId = secretIdIndex >= 0 ? process.argv[secretIdIndex + 1] : process.env.SECRETS_SECRET_ID;
    if (!secretId) fail('--with-secrets requires --secret-id or SECRETS_SECRET_ID');

    const sm = new SecretsManagerClient({});
    let result;
    try {
      result = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    } catch (error) {
      fail(`Secrets Manager: ${error.message}`);
    }
    let secrets;
    try {
      secrets = JSON.parse(result.SecretString);
    } catch {
      fail('Secrets Manager value is not valid JSON');
    }
    for (const portal of parsed.data) {
      if (typeof secrets[portal.secretKey] !== 'string' || secrets[portal.secretKey].length < 16) {
        fail(`missing/short secret for ${portal.secretKey}`);
      }
      console.log(`OK  secret     ${portal.secretKey}`);
    }
  }

  console.log(`PREFLIGHT OK — ${parsed.data.length} portals reachable`);
}

main().catch((error) => fail(error.message));
