'use strict';

/**
 * ============================================================================
 *  MOCK VERIMI (OIDC IDENTITY PROVIDER)  --  DEMO ONLY, DO NOT USE IN PROD
 * ============================================================================
 *
 * Why this exists
 * ---------------
 * The real Verimi is an external IdP that is being shut down. This process is
 * a *stand-in* so the whole Identity-Brokering + AIA flow can be exercised
 * locally without a Verimi contract. It implements just enough OIDC for
 * Keycloak's "oidc" identity provider:
 *
 *   Browser  --(GET /authorize)-->  This mock  --(302 code)-->  Keycloak
 *   Keycloak --(POST /token)----->  This mock  --(id_token)-->  Keycloak
 *   Keycloak --(GET /jwks)------->  This mock  (public key)
 *
 * It simulates a user that still has a live Verimi SSO session: /authorize
 * returns a code immediately, no login form. Replace it with the real Verimi
 * endpoints in keycloak/realm-export.json for anything real.
 *
 * Security notes
 * --------------
 * - The RSA key pair is persisted to SIGNING_KEY_PATH (or generated in memory
 *   when unset). Nothing is committed. A stable key matters: Keycloak caches
 *   the IdP's JWKS and rejects id_tokens signed with an unknown kid until that
 *   cache expires, so a key that changes on every restart breaks brokering.
 * - The client secret is read from the environment; the committed realm JSON
 *   only contains the placeholder CHANGE_ME_VERIMI_CLIENT_SECRET.
 * - Redirect URIs are allow-listed to Keycloak broker endpoints.
 * - No token, code, or secret is ever logged.
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3443);
const ISSUER = (process.env.ISSUER || `https://verimi.gateway-vw.de:${PORT}`).replace(/\/+$/, '');
const CLIENT_ID = process.env.CLIENT_ID || 'portal-spa';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'CHANGE_ME_VERIMI_CLIENT_SECRET';
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
const SIGNING_KEY_PATH = process.env.SIGNING_KEY_PATH || '';
const CODE_TTL_MS = 5 * 60 * 1000;

// The only redirect URI the mock will send an authorization code to.
// Keycloak's broker callback is always:
//   {keycloak}/realms/{realm}/broker/{alias}/endpoint
const ALLOWED_REDIRECT_HOSTS = new Set(
  (process.env.ALLOWED_REDIRECT_HOSTS || 'kc.gateway-vw.de')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
);
const BROKER_PATH = process.env.BROKER_PATH || '/realms/vw-beav/broker/verimi/endpoint';

const DEMO_USER = {
  sub: process.env.DEMO_SUB || 'verimi-user-anna-1001',
  preferred_username: process.env.DEMO_USERNAME || 'anna.beispiel',
  email: process.env.DEMO_EMAIL || 'anna.beispiel@example.org',
  email_verified: true,
  given_name: process.env.DEMO_GIVEN_NAME || 'Anna',
  family_name: process.env.DEMO_FAMILY_NAME || 'Beispiel',
  name: `${process.env.DEMO_GIVEN_NAME || 'Anna'} ${process.env.DEMO_FAMILY_NAME || 'Beispiel'}`,
  locale: 'de-DE',
};

/* -------------------------------------------------------------------------- */
/* In-memory state (demo only)                                                */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, {clientId:string, redirectUri:string, nonce?:string, codeChallenge?:string, codeChallengeMethod?:string, expiresAt:number, used:boolean}>} */
const codes = new Map();
/** @type {Map<string, {sub:string, expiresAt:number}>} */
const accessTokens = new Map();

/* -------------------------------------------------------------------------- */
/* Signing key                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Load the RSA signing key from SIGNING_KEY_PATH, or create it on first start.
 * A persisted key keeps the JWKS `kid` stable across restarts; Keycloak caches
 * IdP keys, so rotating them on every restart breaks brokering until its cache
 * expires ("token signature validation failed").
 */
function loadSigningKey() {
  if (SIGNING_KEY_PATH) {
    try {
      const pem = fs.readFileSync(SIGNING_KEY_PATH, 'utf8');
      console.log(`[mock-verimi] signing key loaded from ${SIGNING_KEY_PATH}`);
      return crypto.createPrivateKey(pem);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[mock-verimi] cannot read ${SIGNING_KEY_PATH}: ${err.message}`);
        process.exit(1);
      }
    }
  }

  const { privateKey: generated } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  if (SIGNING_KEY_PATH) {
    try {
      fs.mkdirSync(path.dirname(SIGNING_KEY_PATH), { recursive: true });
      fs.writeFileSync(SIGNING_KEY_PATH, generated.export({ format: 'pem', type: 'pkcs8' }), {
        mode: 0o600,
      });
      console.log(`[mock-verimi] signing key created at ${SIGNING_KEY_PATH}`);
    } catch (err) {
      console.error(`[mock-verimi] cannot write ${SIGNING_KEY_PATH}: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log('[mock-verimi] WARNING: in-memory signing key, kid changes on every restart');
  }
  return generated;
}

const privateKey = loadSigningKey();
const publicKey = crypto.createPublicKey(privateKey);

const publicJwk = publicKey.export({ format: 'jwk' });
const KID = crypto
  .createHash('sha256')
  .update(publicJwk.n + publicJwk.e)
  .digest('hex')
  .slice(0, 32);

publicJwk.kid = KID;
publicJwk.use = 'sig';
publicJwk.alg = 'RS256';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const b64url = (input) => Buffer.from(input).toString('base64url');

function signJwt(payload) {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey);
  return `${input}.${b64url(signature)}`;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

function text(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isAllowedRedirect(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Keycloak refuses plain-HTTP token URLs, so this mock does not offer HTTP.
  if (url.protocol !== 'https:') return false;
  if (!ALLOWED_REDIRECT_HOSTS.has(url.hostname)) return false;
  // Keycloak broker callback (exact path). Keeps this mock from becoming an
  // open redirector.
  return url.pathname === BROKER_PATH;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verifyPkce(verifier, challenge, method) {
  if (!challenge) return true; // Keycloak may not send PKCE in older versions.
  if (!verifier) return false;
  if ((method || 'S256').toUpperCase() === 'S256') {
    const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
    return safeEqual(computed, challenge);
  }
  return safeEqual(verifier, challenge);
}

function cleanup() {
  const now = Date.now();
  for (const [key, value] of codes) if (value.expiresAt <= now) codes.delete(key);
  for (const [key, value] of accessTokens) if (value.expiresAt <= now) accessTokens.delete(key);
}
setInterval(cleanup, 60_000).unref();

/* -------------------------------------------------------------------------- */
/* OIDC endpoints                                                            */
/* -------------------------------------------------------------------------- */

function discovery() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    jwks_uri: `${ISSUER}/jwks`,
    end_session_endpoint: `${ISSUER}/logout`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: ['openid', 'profile', 'email'],
    claims_supported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      'auth_time',
      'nonce',
      'preferred_username',
      'email',
      'email_verified',
      'given_name',
      'family_name',
      'name',
      'locale',
    ],
    code_challenge_methods_supported: ['S256'],
  };
}

function authorize(req, res, url) {
  const q = url.searchParams;
  const clientId = q.get('client_id');
  const redirectUri = q.get('redirect_uri');
  const responseType = q.get('response_type');
  const state = q.get('state') || '';
  const nonce = q.get('nonce') || undefined;
  const codeChallenge = q.get('code_challenge') || undefined;
  const codeChallengeMethod = q.get('code_challenge_method') || undefined;

  if (responseType !== 'code') return text(res, 400, 'unsupported_response_type');
  if (clientId !== CLIENT_ID) return text(res, 400, 'unknown client_id');
  if (!redirectUri || !isAllowedRedirect(redirectUri)) {
    return text(res, 400, 'redirect_uri not allowed');
  }

  // Simulate an existing, silent Verimi SSO session: no login form.
  const code = crypto.randomBytes(24).toString('base64url');
  codes.set(code, {
    clientId,
    redirectUri,
    nonce,
    codeChallenge,
    codeChallengeMethod,
    expiresAt: Date.now() + CODE_TTL_MS,
    used: false,
  });

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (state) target.searchParams.set('state', state);
  res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
  res.end();
  console.log('[mock-verimi] authorize -> code issued (silent SSO)');
}

async function token(req, res) {
  const raw = await readBody(req);
  const form = new URLSearchParams(raw);

  // Support client_secret_post and client_secret_basic.
  let clientId = form.get('client_id') || '';
  let clientSecret = form.get('client_secret') || '';
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) {
      clientId = decodeURIComponent(decoded.slice(0, idx));
      clientSecret = decodeURIComponent(decoded.slice(idx + 1));
    }
  }

  if (form.get('grant_type') !== 'authorization_code') {
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  if (clientId !== CLIENT_ID || !safeEqual(clientSecret, CLIENT_SECRET)) {
    return json(res, 401, { error: 'invalid_client' });
  }

  const code = form.get('code') || '';
  const record = codes.get(code);
  if (!record || record.used || record.expiresAt <= Date.now()) {
    return json(res, 400, { error: 'invalid_grant' });
  }
  if (record.clientId !== clientId) return json(res, 400, { error: 'invalid_grant' });

  const redirectUri = form.get('redirect_uri');
  if (redirectUri && redirectUri !== record.redirectUri) {
    return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }

  if (!verifyPkce(form.get('code_verifier'), record.codeChallenge, record.codeChallengeMethod)) {
    return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
  }

  record.used = true;
  codes.delete(code);

  const now = Math.floor(Date.now() / 1000);
  const idToken = signJwt({
    iss: ISSUER,
    sub: DEMO_USER.sub,
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    exp: now + 300,
    iat: now,
    auth_time: now,
    nonce: record.nonce,
    sid: crypto.randomBytes(16).toString('base64url'),
    ...DEMO_USER,
  });

  const accessToken = crypto.randomBytes(32).toString('base64url');
  accessTokens.set(accessToken, {
    sub: DEMO_USER.sub,
    expiresAt: Date.now() + 300_000,
  });

  json(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 300,
    scope: 'openid profile email',
    id_token: idToken,
  });
  console.log('[mock-verimi] token -> id_token issued');
}

function userinfo(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const record = accessTokens.get(token);
  if (!record || record.expiresAt <= Date.now()) {
    res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' });
    return res.end();
  }
  json(res, 200, {
    sub: DEMO_USER.sub,
    preferred_username: DEMO_USER.preferred_username,
    email: DEMO_USER.email,
    email_verified: DEMO_USER.email_verified,
    given_name: DEMO_USER.given_name,
    family_name: DEMO_USER.family_name,
    name: DEMO_USER.name,
    locale: DEMO_USER.locale,
  });
}

function logout(req, res, url) {
  const target = url.searchParams.get('post_logout_redirect_uri');
  if (target && isAllowedRedirect(target)) {
    res.writeHead(302, { location: target });
    return res.end();
  }
  text(res, 200, 'mock-verimi: logged out (demo)');
}

/* -------------------------------------------------------------------------- */
/* Request handler                                                           */
/* -------------------------------------------------------------------------- */

async function handle(req, res) {
  const url = new URL(req.url, ISSUER);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      return json(res, 200, discovery());
    }
    if (req.method === 'GET' && path === '/jwks') {
      return json(res, 200, { keys: [publicJwk] });
    }
    if (req.method === 'GET' && path === '/authorize') {
      return authorize(req, res, url);
    }
    if (req.method === 'POST' && path === '/token') {
      return await token(req, res);
    }
    if (req.method === 'GET' && path === '/userinfo') {
      return userinfo(req, res);
    }
    if (req.method === 'GET' && path === '/logout') {
      return logout(req, res, url);
    }
    if (req.method === 'GET' && path === '/healthz') {
      return json(res, 200, { status: 'ok', issuer: ISSUER });
    }
    return text(res, 404, 'not found');
  } catch (err) {
    console.error('[mock-verimi] error:', err.message);
    return text(res, 500, 'internal error');
  }
}

/* -------------------------------------------------------------------------- */
/* Server                                                                    */
/* -------------------------------------------------------------------------- */

let server;
if (TLS_CERT && TLS_KEY) {
  server = https.createServer(
    { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
    handle
  );
  console.log(`[mock-verimi] HTTPS listening on :${PORT} (issuer ${ISSUER})`);
} else {
  // Deliberately fatal: Keycloak 26 refuses to import an IdP with a plain-HTTP
  // token endpoint ("The url [token_url] requires secure connections"), so an
  // HTTP mock would only produce confusing errors. Run scripts/gen-certs.sh.
  console.error('[mock-verimi] TLS_CERT/TLS_KEY not set - refusing to start. Run scripts/gen-certs.sh first.');
  process.exit(1);
}
server.listen(PORT, '0.0.0.0');

/* Graceful shutdown for docker stop */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[mock-verimi] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
