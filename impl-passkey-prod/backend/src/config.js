/**
 * Fail-closed configuration.
 *
 * Nothing in this file accepts values from an HTTP request. Every value comes
 * from the Lambda environment, which is owned by CloudFormation/Secrets
 * Manager. If a value is missing or invalid, the module throws at cold start
 * and Lambda stays down instead of running with insecure defaults.
 */

import { z } from 'zod';

const HOSTNAME = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const REALM = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const PortalSchema = z
  .object({
    portalHost: z.string().regex(HOSTNAME, 'portalHost must be a bare hostname'),
    apiHost: z.string().regex(HOSTNAME, 'apiHost must be a bare hostname'),
    realm: z.string().regex(REALM, 'invalid Keycloak realm name'),
    clientId: z.string().min(1).max(200),
    secretKey: z.string().min(1).max(200),
    redirectUri: z.string().url(),
    postLoginUrl: z.string().url(),
    postLogoutUrl: z.string().url(),
    verimiEnabled: z.boolean().default(false),
  })
  .strict();

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function assertOrigin(url, expectedHost) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== expectedHost) {
    throw new Error(`URL ${url} does not use https://${expectedHost}`);
  }
}

function parsePortals(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PORTALS_JSON is not valid JSON');
  }

  const list = z.array(PortalSchema).min(1).max(50).safeParse(parsed);
  if (!list.success) {
    throw new Error(`PORTALS_JSON invalid: ${list.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`);
  }

  const portals = list.data;
  const seenHosts = new Set();
  const seenRealms = new Set();

  for (const portal of portals) {
    if (seenHosts.has(portal.portalHost)) throw new Error(`duplicate portalHost ${portal.portalHost}`);
    if (seenHosts.has(portal.apiHost)) throw new Error(`duplicate apiHost ${portal.apiHost}`);
    if (seenRealms.has(portal.realm)) throw new Error(`duplicate realm ${portal.realm}`);
    seenHosts.add(portal.portalHost);
    seenHosts.add(portal.apiHost);
    seenRealms.add(portal.realm);

    // The callback must live on the API host. Otherwise the __Host- cookies
    // would be sent to a different site and the OIDC transaction would break.
    assertOrigin(portal.redirectUri, portal.apiHost);
    if (new URL(portal.redirectUri).pathname !== '/api/auth/callback') {
      throw new Error(`redirectUri for ${portal.portalHost} must end in /api/auth/callback`);
    }
    if (!isHttpsUrl(portal.postLoginUrl) || !isHttpsUrl(portal.postLogoutUrl)) {
      throw new Error(`postLoginUrl and postLogoutUrl for ${portal.portalHost} must be HTTPS`);
    }
  }

  return portals;
}

function parseKeys(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ENCRYPTION_KEYS_JSON is not valid JSON');
  }
  const schema = z.record(z.string().min(1), z.string().min(43)).refine(
    (obj) => Object.values(obj).every((value) => {
      try {
        return Buffer.from(value, 'base64url').length === 32;
      } catch {
        return false;
      }
    }),
    'every key must be a base64url-encoded 32-byte AES-256 key',
  );
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`ENCRYPTION_KEYS_JSON invalid: ${result.error.message}`);
  return result.data;
}

const EnvSchema = z.object({
  KC_PUBLIC_URL: z.string().url(),
  PORTALS_JSON: z.string().min(2),
  SECRETS_SECRET_ID: z.string().min(1),
  ENCRYPTION_KEYS_JSON: z.string().min(2),
  ACTIVE_KEY_ID: z.string().min(1),
  IDENTITY_TABLE: z.string().min(1),
  SESSION_TABLE: z.string().min(1),
  STAGE: z.string().min(1),
  NODE_ENV: z.string().min(1).default('production'),
  TX_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(28800),
  SECRETS_CACHE_MS: z.coerce.number().int().min(1000).max(3600000).default(300000),
});

const env = EnvSchema.parse(process.env);

if (!isHttpsUrl(env.KC_PUBLIC_URL)) {
  throw new Error('KC_PUBLIC_URL must be an HTTPS URL');
}
// Trailing slashes break discovery/issuer comparisons. Normalize once.
const kcPublicUrl = env.KC_PUBLIC_URL.replace(/\/+$/, '');

const portals = parsePortals(env.PORTALS_JSON);
const encryptionKeys = parseKeys(env.ENCRYPTION_KEYS_JSON);
if (!encryptionKeys[env.ACTIVE_KEY_ID]) {
  throw new Error(`ACTIVE_KEY_ID ${env.ACTIVE_KEY_ID} is not present in ENCRYPTION_KEYS_JSON`);
}

function indexBy(items, keyFn) {
  const map = new Map();
  for (const item of items) map.set(keyFn(item), item);
  return map;
}

export const config = Object.freeze({
  stage: env.STAGE,
  nodeEnv: env.NODE_ENV,
  kcPublicUrl,
  secretsSecretId: env.SECRETS_SECRET_ID,
  encryptionKeys,
  activeKeyId: env.ACTIVE_KEY_ID,
  identityTable: env.IDENTITY_TABLE,
  sessionTable: env.SESSION_TABLE,
  txTtlSeconds: env.TX_TTL_SECONDS,
  sessionTtlSeconds: env.SESSION_TTL_SECONDS,
  secretsCacheMs: env.SECRETS_CACHE_MS,
  portals,
  byApiHost: indexBy(portals, (p) => p.apiHost),
  byPortalHost: indexBy(portals, (p) => p.portalHost),
  byRealm: indexBy(portals, (p) => p.realm),
});

/** Resolve a portal strictly from the forwarded host header. */
export function portalForHost(rawHost) {
  const host = String(rawHost || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  return config.byApiHost.get(host) ?? config.byPortalHost.get(host) ?? null;
}
