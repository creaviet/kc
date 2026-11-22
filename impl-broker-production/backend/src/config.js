/**
 * Production-only configuration.
 *
 * Security principle: fail closed. If anything looks like a local/dev/mock
 * setting, the Lambda must not start. The BFF uses:
 *
 *   - zod for structural validation
 *   - Node Buffer/base64url checks for 256-bit cookie keys
 *   - URL parsing for strict HTTPS and host validation
 *
 * There is intentionally no `isAws`, no `INSECURE_COOKIES`, no
 * `ALLOW_INSECURE_OIDC`, no `DEV_PORTAL_HOST` and no memory store.
 */

import { z } from 'zod';

const EXPECTED_PORTAL_COUNT = 9;
const HOST_RE = /^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const REALM_RE = /^[A-Za-z0-9_-]+$/;

const FORBIDDEN_ENV = [
  'INSECURE_COOKIES',
  'ALLOW_INSECURE_OIDC',
  'DEV_PORTAL_HOST',
];

for (const name of FORBIDDEN_ENV) {
  if (process.env[name] !== undefined) {
    throw new Error(`${name} is forbidden in the production build`);
  }
}

if (process.env.STORE !== undefined && process.env.STORE !== 'dynamodb') {
  throw new Error('STORE must be dynamodb (memory storage is not available in production)');
}

function requireHttpsOrigin(name, raw) {
  if (!raw) throw new Error(`Missing required environment variable: ${name}`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }

  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use https`);
  }
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Error(`${name} must not point to localhost`);
  }
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(`${name} must be a public DNS name`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain userinfo, query or fragment`);
  }
  if (url.pathname !== '/') {
    throw new Error(`${name} must not contain a path`);
  }

  return url.origin;
}

function decodeKey(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);

  const buf = Buffer.from(value, 'base64url');
  // Buffer.from(..., 'base64url') ignores bad characters — verify round-trip.
  if (buf.length !== 32 || buf.toString('base64url') !== value) {
    throw new Error(`${name} must be exactly 32 bytes encoded as base64url`);
  }
  return new Uint8Array(buf);
}

function optionalKey(name) {
  if (!process.env[name]) return null;
  return decodeKey(name);
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const PortalSchema = z.object({
  realm: z.string().regex(REALM_RE, 'invalid realm name'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(32),
  redirectUri: z.string().url(),
});

const PortalsSchema = z
  .record(z.string(), PortalSchema)
  .superRefine((portals, ctx) => {
    const hosts = Object.keys(portals);
    if (hosts.length !== EXPECTED_PORTAL_COUNT) {
      ctx.addIssue({
        code: 'custom',
        message: `PORTALS_JSON must contain exactly ${EXPECTED_PORTAL_COUNT} portals, got ${hosts.length}`,
      });
    }

    const realms = new Set();

    for (const [host, portal] of Object.entries(portals)) {
      if (host !== host.toLowerCase()) {
        ctx.addIssue({ code: 'custom', message: `portal host must be lowercase: ${host}` });
      }
      if (!HOST_RE.test(host)) {
        ctx.addIssue({ code: 'custom', message: `invalid portal host: ${host}` });
      }
      if (/\.example\.(com|org|net)$/i.test(host) || /REPLACE_/i.test(host)) {
        ctx.addIssue({ code: 'custom', message: `placeholder portal host: ${host}` });
      }
      if (realms.has(portal.realm)) {
        ctx.addIssue({ code: 'custom', message: `duplicate realm: ${portal.realm}` });
      }
      realms.add(portal.realm);

      if (/REPLACE_/i.test(portal.clientId) || /REPLACE_/i.test(portal.clientSecret)) {
        ctx.addIssue({ code: 'custom', message: `placeholder credential for ${host}` });
      }

      let url;
      try {
        url = new URL(portal.redirectUri);
      } catch {
        ctx.addIssue({ code: 'custom', message: `invalid redirectUri for ${host}` });
        continue;
      }

      if (url.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', message: `redirectUri for ${host} must be https` });
      }
      if (url.hostname.toLowerCase() !== host.toLowerCase()) {
        ctx.addIssue({ code: 'custom', message: `redirectUri host must equal portal host: ${host}` });
      }
      if (url.pathname !== '/api/auth/callback') {
        ctx.addIssue({
          code: 'custom',
          message: `redirectUri path must be /api/auth/callback: ${host}`,
        });
      }
      if (url.search || url.hash || url.username || url.password) {
        ctx.addIssue({
          code: 'custom',
          message: `redirectUri must not contain query/hash/userinfo: ${host}`,
        });
      }
    }
  });

const configuredCount = Number(process.env.EXPECTED_PORTAL_COUNT || EXPECTED_PORTAL_COUNT);
if (configuredCount !== EXPECTED_PORTAL_COUNT) {
  throw new Error(`EXPECTED_PORTAL_COUNT must be ${EXPECTED_PORTAL_COUNT}`);
}

const rawPortals = process.env.PORTALS_JSON;
if (!rawPortals) throw new Error('Missing required environment variable: PORTALS_JSON');

let parsedPortals;
try {
  parsedPortals = JSON.parse(rawPortals);
} catch {
  throw new Error('PORTALS_JSON is not valid JSON');
}
if (!parsedPortals || typeof parsedPortals !== 'object' || Array.isArray(parsedPortals)) {
  throw new Error('PORTALS_JSON must be an object keyed by portal host');
}

const phase = process.env.PHASE || 'B';
if (phase !== 'B' && phase !== 'C') {
  throw new Error('PHASE must be B or C');
}

const kcBaseUrl = requireHttpsOrigin('KC_BASE_URL', process.env.KC_BASE_URL || 'https://kc.gateway-vw.de:8443');
const kcPublicUrl = requireHttpsOrigin('KC_PUBLIC_URL', process.env.KC_PUBLIC_URL || kcBaseUrl);

if (kcBaseUrl !== kcPublicUrl) {
  throw new Error('KC_BASE_URL and KC_PUBLIC_URL must have the same origin in production');
}

export const config = Object.freeze({
  kcBaseUrl,
  kcPublicUrl,
  phase,
  portals: Object.freeze(PortalsSchema.parse(parsedPortals)),
  expectedPortalCount: EXPECTED_PORTAL_COUNT,

  sessionKey: decodeKey('SESSION_ENC_KEY_B64U'),
  txKey: decodeKey('TX_ENC_KEY_B64U'),
  enrolledKey: decodeKey('ENROLLED_ENC_KEY_B64U'),
  sessionKeyPrevious: optionalKey('SESSION_ENC_KEY_PREVIOUS_B64U'),
  txKeyPrevious: optionalKey('TX_ENC_KEY_PREVIOUS_B64U'),
  enrolledKeyPrevious: optionalKey('ENROLLED_ENC_KEY_PREVIOUS_B64U'),

  tableName: process.env.TABLE_NAME || 'passkey-migration',
  sessionTableName: process.env.SESSION_TABLE_NAME || `${process.env.TABLE_NAME || 'passkey-migration'}-sessions`,
  awsRegion: process.env.AWS_REGION || 'eu-central-1',

  sessionTtl: positiveInt('SESSION_TTL_SECONDS', 8 * 60 * 60),
  txTtl: positiveInt('TX_TTL_SECONDS', 10 * 60),
  enrolledTtl: positiveInt('ENROLLED_COOKIE_TTL_SECONDS', 365 * 24 * 60 * 60),
});

export function portalFor(host) {
  if (!host) return null;
  return config.portals[String(host).toLowerCase()] ?? null;
}
