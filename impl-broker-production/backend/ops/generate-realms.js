#!/usr/bin/env node
/**
 * Generate one Keycloak realm export per portal from keycloak/realm-template.json.
 *
 * Required env:
 *   VERIMI_AUTHORIZATION_URL, VERIMI_TOKEN_URL, VERIMI_USERINFO_URL,
 *   VERIMI_JWKS_URL, VERIMI_ISSUER, VERIMI_CLIENT_ID
 * Optional:
 *   VERIMI_LOGOUT_URL, PORTALS_FILE
 *
 * Client secrets are NOT generated here. They are Keycloak vault references:
 *   ${vault.<realm>_portal-spa-secret}
 *   ${vault.<realm>_verimi-client-secret}
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPortals } from './portals.js';

const here = dirname(fileURLToPath(import.meta.url));
const implRoot = resolve(here, '..', '..');
const portalsFile = process.env.PORTALS_FILE || join(here, 'portals.json');
const templateFile = join(implRoot, 'keycloak', 'realm-template.json');
const outDir = join(implRoot, 'keycloak', 'generated');

function required(name) {
  const value = process.env[name];
  if (!value || /REPLACE_/i.test(value)) throw new Error(`missing or placeholder env ${name}`);
  return value;
}

function httpsUrl(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use https`);
  return value;
}

const verimi = {
  authorizationUrl: httpsUrl('VERIMI_AUTHORIZATION_URL', required('VERIMI_AUTHORIZATION_URL')),
  tokenUrl: httpsUrl('VERIMI_TOKEN_URL', required('VERIMI_TOKEN_URL')),
  userInfoUrl: httpsUrl('VERIMI_USERINFO_URL', required('VERIMI_USERINFO_URL')),
  jwksUrl: httpsUrl('VERIMI_JWKS_URL', required('VERIMI_JWKS_URL')),
  issuer: httpsUrl('VERIMI_ISSUER', required('VERIMI_ISSUER')),
  logoutUrl: process.env.VERIMI_LOGOUT_URL
    ? httpsUrl('VERIMI_LOGOUT_URL', process.env.VERIMI_LOGOUT_URL)
    : '',
  clientId: required('VERIMI_CLIENT_ID'),
};

const template = JSON.parse(await readFile(templateFile, 'utf8'));
const portals = await loadPortals(portalsFile);
await mkdir(outDir, { recursive: true });

for (const portal of portals) {
  const rendered = JSON.stringify(template)
    .replaceAll('__REALM__', portal.realm)
    .replaceAll('__DISPLAY_NAME__', portal.displayName)
    .replaceAll('__PORTAL_HOST__', portal.host)
    .replaceAll('__VERIMI_AUTHORIZATION_URL__', verimi.authorizationUrl)
    .replaceAll('__VERIMI_TOKEN_URL__', verimi.tokenUrl)
    .replaceAll('__VERIMI_USERINFO_URL__', verimi.userInfoUrl)
    .replaceAll('__VERIMI_JWKS_URL__', verimi.jwksUrl)
    .replaceAll('__VERIMI_ISSUER__', verimi.issuer.replace(/\/$/, ''))
    .replaceAll('__VERIMI_LOGOUT_URL__', verimi.logoutUrl)
    .replaceAll('__VERIMI_CLIENT_ID__', verimi.clientId);

  const outFile = join(outDir, `realm-${portal.realm}.json`);
  await writeFile(outFile, `${JSON.stringify(JSON.parse(rendered), null, 2)}\n`);
  console.log(`Wrote ${outFile}`);
}

console.log('\nCreate Keycloak vault files (one per realm):');
for (const portal of portals) {
  console.log(`  ${portal.realm}_portal-spa-secret`);
  console.log(`  ${portal.realm}_verimi-client-secret`);
}
