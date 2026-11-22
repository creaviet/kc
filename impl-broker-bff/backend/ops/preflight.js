#!/usr/bin/env node
/**
 * Deploy preflight. Fails closed on common "it worked locally" mistakes.
 *
 * Env (when checking keys): SESSION_ENC_KEY_B64U, TX_ENC_KEY_B64U,
 * ENROLLED_ENC_KEY_B64U. Optional: PORTALS_FILE.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPortals } from './portals.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');
const implRoot = resolve(backendRoot, '..');

const failures = [];
const ok = [];

function check(name, condition, detail = '') {
  if (condition) ok.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function isBase64Url32(value) {
  if (!value) return false;
  const buf = Buffer.from(value, 'base64url');
  return buf.length === 32 && buf.toString('base64url') === value;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// 1. Portal manifest
const portalsFile = process.env.PORTALS_FILE || join(here, 'portals.json');
try {
  const portals = await loadPortals(portalsFile);
  check('portal manifest', true);
  check('portal count = 9', portals.length === 9, `got ${portals.length}`);
} catch (err) {
  check('portal manifest', false, err.message);
}

// 2. Encryption keys (provided in deploy env or .env.production)
for (const key of ['SESSION_ENC_KEY_B64U', 'TX_ENC_KEY_B64U', 'ENROLLED_ENC_KEY_B64U']) {
  check(`${key} is 32-byte base64url`, isBase64Url32(process.env[key]));
}

// 3. AWS template must use dynamic refs, not plaintext secrets.
const template = await readFile(join(backendRoot, 'template.yaml'), 'utf8');
check(
  'AWS template uses Secrets Manager dynamic ref',
  template.includes('{{resolve:secretsmanager:vw/passkey-bff/portals'),
);
check(
  'AWS template uses Secrets Manager dynamic refs for all keys',
  (template.match(/\{\{resolve:secretsmanager:vw\/passkey-bff\/.*:SecretString:value\}\}/g) || [])
    .length >= 6,
);
check(
  'AWS template has no version-pinned SSM secrets',
  !template.includes('{{resolve:ssm-secure:'),
);
check(
  'AWS template disables execute-api endpoint',
  template.includes('DisableExecuteApiEndpoint: true'),
);
check(
  'AWS template has no plaintext REPLACE secrets',
  !/REPLACE_(CLIENT_SECRET|VERIMI)/i.test(template),
);

// 4. Keycloak realm template must enforce signature validation + vault refs.
const realmTemplate = await readFile(join(implRoot, 'keycloak', 'realm-template.json'), 'utf8');
check('Keycloak IdP validates Verimi signatures', /"validateSignature": "true"/.test(realmTemplate));
check('Keycloak uses jwksUrl', /"jwksUrl"/.test(realmTemplate));
check('Keycloak client secret uses vault', /\$\{vault\.__REALM___portal-spa-secret\}/.test(realmTemplate));
check('Keycloak Verimi secret uses vault', /\$\{vault\.__REALM___verimi-client-secret\}/.test(realmTemplate));
check(
  'Keycloak account audience mapper present',
  realmTemplate.includes('account-audience-for-credential-check'),
);

// 5. Generated realms must not contain unresolved placeholders.
const generatedDir = join(implRoot, 'keycloak', 'generated');
if (await exists(generatedDir)) {
  const files = (await readdir(generatedDir)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const body = await readFile(join(generatedDir, file), 'utf8');
    check(`${file} has no placeholders`, !body.includes('__') && !/REPLACE_/i.test(body));
  }
}

// 6. Docker/nginx fail-closed checks.
const compose = await readFile(join(implRoot, 'docker-compose.yml'), 'utf8');
check('docker-compose does not use start-dev', !/command:\s*start-dev/.test(compose));
check('docker-compose has no default admin password', !/KC_ADMIN_PASSWORD:.*change/i.test(compose));
check('docker-compose has no default postgres password', !/POSTGRES_PASSWORD:.*change/i.test(compose));

const adminNginx = await readFile(join(implRoot, 'nginx', 'conf.d', '20-keycloak-admin.conf'), 'utf8');
check('admin vhost denies all by default', /^\s*deny all;/m.test(adminNginx));

// 7. No stale localhost build artifact may ship.
const distDir = join(implRoot, 'frontend', 'dist');
if (await exists(distDir)) {
  const assetsDir = join(distDir, 'assets');
  let stale = false;
  if (await exists(assetsDir)) {
    for (const file of await readdir(assetsDir)) {
      if (!file.endsWith('.js')) continue;
      const body = await readFile(join(assetsDir, file), 'utf8');
      if (body.includes('localhost:9443') || body.includes('localhost:8443')) stale = true;
    }
  }
  check('frontend/dist has no localhost URLs', !stale, 'delete frontend/dist and rebuild');
}

console.log(`PASS (${ok.length}):`);
for (const item of ok) console.log(`  ✓ ${item}`);

if (failures.length) {
  console.error(`\nFAIL (${failures.length}):`);
  for (const item of failures) console.error(`  ✗ ${item}`);
  process.exit(1);
}

console.log('\nPreflight OK.');
