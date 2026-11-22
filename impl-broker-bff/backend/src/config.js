/**
 * Configuration — fail closed at cold start.
 *
 * Security principle: a misconfiguration must break the deploy, not silently
 * weaken the login flow. zod validates every structural value; the two JWE
 * keys must be exactly 256 bits. In AWS, dev-only escape hatches are forbidden.
 */

import { z } from 'zod';

const isAws = Boolean(process.env.AWS_EXECUTION_ENV || process.env.LAMBDA_TASK_ROOT);
const insecureCookies = process.env.INSECURE_COOKIES === 'true';
const allowInsecureOidc = process.env.ALLOW_INSECURE_OIDC === 'true';
const devPortalHost = process.env.DEV_PORTAL_HOST || null;
const allowInsecureLocal = !isAws && insecureCookies;

const HOST_RE = /^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

const PortalSchema = z.object({
  realm: z.string().regex(/^[A-Za-z0-9_-]+$/, 'invalid realm name'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
});

const PortalsSchema = z
  .record(z.string(), PortalSchema)
  .superRefine((portals, ctx) => {
    const expected = Number(process.env.EXPECTED_PORTAL_COUNT || (isAws ? 9 : 1));
    if (!Number.isInteger(expected) || expected <= 0) {
      ctx.addIssue({ code: 'custom', message: 'EXPECTED_PORTAL_COUNT must be positive' });
      return;
    }
    if (Object.keys(portals).length !== expected) {
      ctx.addIssue({
        code: 'custom',
        message: `PORTALS_JSON must contain exactly ${expected} portals, got ${Object.keys(portals).length}`,
      });
    }

    const realms = new Set();

    for (const [host, portal] of Object.entries(portals)) {
      if (!HOST_RE.test(host)) {
        ctx.addIssue({ code: 'custom', message: `invalid portal host: ${host}` });
      }
      if (realms.has(portal.realm)) {
        ctx.addIssue({ code: 'custom', message: `duplicate realm: ${portal.realm}` });
      }
      realms.add(portal.realm);

      if (/REPLACE_/i.test(portal.clientId) || /REPLACE_/i.test(portal.clientSecret)) {
        ctx.addIssue({ code: 'custom', message: `placeholder credential for ${host}` });
      }

      const minSecret = isAws ? 32 : 8;
      if (portal.clientSecret.length < minSecret) {
        ctx.addIssue({
          code: 'custom',
          message: `clientSecret for ${host} must be at least ${minSecret} characters`,
        });
      }

      let url;
      try {
        url = new URL(portal.redirectUri);
      } catch {
        ctx.addIssue({ code: 'custom', message: `invalid redirectUri for ${host}` });
        continue;
      }

      if (url.protocol !== 'https:' && !(allowInsecureLocal && url.protocol === 'http:')) {
        ctx.addIssue({ code: 'custom', message: `redirectUri for ${host} must be https` });
      }
      const isLocalhost = ['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase());
      if (!allowInsecureLocal && url.hostname.toLowerCase() !== host.toLowerCase()) {
        ctx.addIssue({ code: 'custom', message: `redirectUri host must equal portal host: ${host}` });
      }
      if (allowInsecureLocal && !isLocalhost && url.hostname.toLowerCase() !== host.toLowerCase()) {
        ctx.addIssue({ code: 'custom', message: `local redirectUri host must be localhost or ${host}` });
      }
      if (url.pathname !== '/api/auth/callback') {
        ctx.addIssue({ code: 'custom', message: `redirectUri path must be /api/auth/callback: ${host}` });
      }
      if (url.search || url.hash || url.username || url.password) {
        ctx.addIssue({ code: 'custom', message: `redirectUri must not contain query/hash/userinfo: ${host}` });
      }
    }
  });

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
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
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

if (isAws && devPortalHost) {
  throw new Error('DEV_PORTAL_HOST is forbidden in AWS');
}
if (isAws && insecureCookies) {
  throw new Error('INSECURE_COOKIES is forbidden in AWS');
}
if (isAws && allowInsecureOidc) {
  throw new Error('ALLOW_INSECURE_OIDC is forbidden in AWS');
}
if (isAws && process.env.STORE === 'memory') {
  throw new Error('STORE=memory is forbidden in AWS');
}

const portals = PortalsSchema.parse(parseJsonEnv('PORTALS_JSON', {}));
const kcBaseUrl = (process.env.KC_BASE_URL || 'https://kc.gateway-vw.de:8443').replace(/\/+$/, '');
const kcPublicUrl = (process.env.KC_PUBLIC_URL || kcBaseUrl).replace(/\/+$/, '');

if (isAws && !kcBaseUrl.startsWith('https://')) {
  throw new Error('KC_BASE_URL must be https in AWS');
}
if (isAws && !kcPublicUrl.startsWith('https://')) {
  throw new Error('KC_PUBLIC_URL must be https in AWS');
}

export const config = Object.freeze({
  isAws,
  kcBaseUrl,      // server-side: Account API credential check
  kcPublicUrl,    // browser URLs, OIDC discovery and token issuer
  phase: process.env.PHASE === 'C' ? 'C' : 'B',
  portals,
  expectedPortalCount: Number(process.env.EXPECTED_PORTAL_COUNT || (isAws ? 9 : 1)),

  sessionKey: decodeKey('SESSION_ENC_KEY_B64U'),
  txKey: decodeKey('TX_ENC_KEY_B64U'),
  enrolledKey: decodeKey('ENROLLED_ENC_KEY_B64U'),
  sessionKeyPrevious: optionalKey('SESSION_ENC_KEY_PREVIOUS_B64U'),
  txKeyPrevious: optionalKey('TX_ENC_KEY_PREVIOUS_B64U'),
  enrolledKeyPrevious: optionalKey('ENROLLED_ENC_KEY_PREVIOUS_B64U'),

  store: process.env.STORE === 'memory' ? 'memory' : 'dynamodb',
  tableName: process.env.TABLE_NAME || 'passkey-migration',
  sessionTableName: process.env.SESSION_TABLE_NAME || `${process.env.TABLE_NAME || 'passkey-migration'}-sessions`,
  awsRegion: process.env.AWS_REGION || 'eu-central-1',

  sessionTtl: positiveInt('SESSION_TTL_SECONDS', 8 * 60 * 60),
  txTtl: positiveInt('TX_TTL_SECONDS', 10 * 60),
  enrolledTtl: positiveInt('ENROLLED_COOKIE_TTL_SECONDS', 365 * 24 * 60 * 60),

  // Local dev only. Forbidden in AWS by the checks above.
  devPortalHost,
  insecureCookies,
  allowInsecureOidc,
});

export function portalFor(host) {
  return config.portals[host] ?? null;
}
