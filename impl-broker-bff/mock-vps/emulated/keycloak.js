/**
 * Keycloak mock — INTERNAL container in the emulated VPS topology.
 *
 * It listens only on 127.0.0.1:8080. The browser must reach it through the
 * nginx mock on :8443, exactly like the real deployment. It uses the public
 * base URL for issuer generation and redirects, and persists user state through
 * the Postgres mock.
 */

import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const PORT = Number(process.env.KEYCLOAK_PORT || 8080);
const REALM = 'vw-beav';
const PUBLIC_BASE = (process.env.PUBLIC_BASE || 'http://localhost:8443').replace(/\/+$/, '');
const VERIMI_BASE = (process.env.VERIMI_BASE || 'http://localhost:3443').replace(/\/+$/, '');
const PG_URL = (process.env.PG_URL || 'http://127.0.0.1:55432').replace(/\/+$/, '');

const ISSUER = `${PUBLIC_BASE}/realms/${REALM}`;
const CLIENT_ID = 'portal-spa';
const CLIENT_SECRET = 'dev-secret';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'mock-kc-1', use: 'sig', alg: 'RS256' };

const transactions = new Map();
const codes = new Map();

let user = {
  sub: 'mock-user-1',
  verimiSub: 'verimi-123',
  passkeyEnrolled: false,
};

async function pgGet() {
  const response = await fetch(`${PG_URL}/state`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`pg_get_${response.status}`);
  return response.json();
}

async function pgSet() {
  const response = await fetch(`${PG_URL}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`pg_set_${response.status}`);
}

try {
  const state = await pgGet();
  if (state?.user) user = state.user;
  console.log('[mock-kc] loaded user state from mock postgres');
} catch (err) {
  console.warn(`[mock-kc] could not load postgres state: ${err.message}`);
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendHtml(res, body, status = 200) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8">
    <title>Mock Keycloak</title>
    <style>
      body{font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;background:#f5f6f8}
      .box{border:1px solid #dcdfe5;border-radius:10px;padding:1.5rem;background:#fff}
      button{padding:.6rem 1rem;background:#0b5fff;color:#fff;border:0;border-radius:6px;margin:.3rem 0}
      label{display:block;margin:.8rem 0}input{padding:.5rem;width:100%;box-sizing:border-box}
      .tag{background:#e8eefc;color:#0b3f9e;padding:.3rem .6rem;border-radius:4px;font-size:.8rem}
    </style></head><body>${body}</body></html>`);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return new URLSearchParams(raw);
}

function makeCode(state) {
  const code = `mockcode-${Math.random().toString(36).slice(2)}`;
  codes.set(code, { state });
  return code;
}

function backToPortal(res, state, enroll = false) {
  const tx = transactions.get(state);
  if (!tx) return sendHtml(res, '<div class="box">Unknown transaction (state lost).</div>', 400);

  const params = new URLSearchParams({ code: makeCode(state), state });
  if (enroll) params.set('kc_action_status', 'success');
  const sep = tx.redirectUri.includes('?') ? '&' : '?';
  console.log(`[mock-kc] -> portal callback ${tx.redirectUri}${sep}${params}`);
  return redirect(res, `${tx.redirectUri}${sep}${params}`);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const path = url.pathname;
    const q = url.searchParams;

    console.log(`[mock-kc] ${req.method} ${path}`);

    if (path === '/healthz') {
      return sendJson(res, 200, { ok: true, service: 'mock-keycloak', port: PORT });
    }

    if (path === `/realms/${REALM}`) {
      return sendJson(res, 200, { realm: REALM, enabled: true, issuer: ISSUER });
    }

    if (path === `/realms/${REALM}/.well-known/openid-configuration`) {
      return sendJson(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${PUBLIC_BASE}/realms/${REALM}/protocol/openid-connect/auth`,
        token_endpoint: `${PUBLIC_BASE}/realms/${REALM}/protocol/openid-connect/token`,
        userinfo_endpoint: `${PUBLIC_BASE}/realms/${REALM}/protocol/openid-connect/userinfo`,
        jwks_uri: `${PUBLIC_BASE}/realms/${REALM}/protocol/openid-connect/certs`,
        end_session_endpoint: `${PUBLIC_BASE}/realms/${REALM}/protocol/openid-connect/logout`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile', 'email', 'roles'],
        claims_supported: ['sub', 'iss', 'aud', 'azp', 'exp', 'iat', 'nonce', 'email', 'verimi_sub'],
      });
    }

    if (path === `/realms/${REALM}/protocol/openid-connect/certs`) {
      return sendJson(res, 200, { keys: [publicJwk] }, { 'cache-control': 'public, max-age=300' });
    }

    if (path === '/admin' || path.startsWith('/admin/')) {
      return sendHtml(res, `<div class="box"><span class="tag">MOCK KEYCLOAK ADMIN</span>
        <h1>Admin Console</h1>
        <p>Nur über Port 8444 erreichbar. Dieser Mock prüft die IP-Regel im nginx-Mock.</p></div>`);
    }

    // ---------------------------------------------------------------- AUTH
    if (path === `/realms/${REALM}/protocol/openid-connect/auth`) {
      const state = q.get('state');
      if (!state || !q.get('redirect_uri')) {
        return sendHtml(res, '<div class="box">Missing state/redirect_uri</div>', 400);
      }

      transactions.set(state, {
        redirectUri: q.get('redirect_uri'),
        nonce: q.get('nonce'),
        challenge: q.get('code_challenge'),
        flow: q.get('kc_action') ? 'enroll' : 'login',
      });

      const hidden = `<input type="hidden" name="state" value="${esc(state)}">`;

      if (q.get('kc_idp_hint') === 'verimi') {
        console.log('[mock-kc] kc_idp_hint=verimi -> redirecting to EXTERNAL verimi origin');
        return redirect(
          res,
          `${VERIMI_BASE}/mock-verimi/authorize?state=${encodeURIComponent(state)}`,
        );
      }

      if (q.get('kc_action') === 'webauthn-register-passwordless:skip_if_exists') {
        return sendHtml(res, `<div class="box"><span class="tag">MOCK KEYCLOAK · AIA</span>
          <h1>Passkey erstellen</h1>
          <p>Simuliert: QR-Code, USB-Stick oder Biometrie.</p>
          <form method="post" action="/mock-aia/enroll">${hidden}
            <button type="submit">Passkey jetzt simulieren</button></form>
          <form method="post" action="/mock-aia/cancel">${hidden}
            <button type="submit" style="background:#666">Abbrechen</button></form>
        </div>`);
      }

      return sendHtml(res, `<div class="box"><span class="tag">MOCK KEYCLOAK · PASSKEY</span>
        <h1>Anmelden mit Passkey</h1>
        <p>Dies läuft auf der Keycloak-Origin ${esc(PUBLIC_BASE)}. Verimi wird nicht kontaktiert.</p>
        <form method="post" action="/mock-passkey/login">${hidden}
          <button type="submit">Mit Passkey anmelden</button></form>
        <p style="font-size:.9rem"><a href="${esc(VERIMI_BASE)}/mock-verimi/authorize?state=${encodeURIComponent(state)}">
          Stattdessen mit Verimi anmelden</a></p>
      </div>`);
    }

    // ---------------------------------------------------------------- BROKER CALLBACK
    if (path === `/realms/${REALM}/broker/verimi/endpoint`) {
      console.log('[mock-kc] broker endpoint: JIT-provision + SSO session + code to portal');
      return backToPortal(res, q.get('state'));
    }

    if (path === '/mock-aia/enroll' && req.method === 'POST') {
      const body = await readBody(req);
      user.passkeyEnrolled = true;
      await pgSet();
      console.log('[mock-kc] credential stored in mock postgres');
      return backToPortal(res, body.get('state'), true);
    }

    if (path === '/mock-aia/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      return backToPortal(res, body.get('state'));
    }

    if (path === '/mock-passkey/login' && req.method === 'POST') {
      const body = await readBody(req);
      console.log('[mock-kc] WebAuthn assertion verified');
      return backToPortal(res, body.get('state'));
    }

    // ---------------------------------------------------------------- TOKEN
    if (path === `/realms/${REALM}/protocol/openid-connect/token` && req.method === 'POST') {
      const body = await readBody(req);
      const entry = codes.get(body.get('code'));
      if (!entry) return sendJson(res, 400, { error: 'invalid_grant' });

      codes.delete(body.get('code'));

      const tx = transactions.get(entry.state);
      const { createHash } = await import('node:crypto');
      const actual = createHash('sha256')
        .update(body.get('code_verifier') || '', 'ascii')
        .digest('base64url');

      if (!tx || actual !== tx.challenge) {
        return sendJson(res, 400, { error: 'invalid_grant', detail: 'pkce_failed' });
      }

      // openid-client uses client_secret_basic by default for confidential
      // clients. Accept both Basic and form-based auth in the emulator.
      let clientId = body.get('client_id');
      let clientSecret = body.get('client_secret');
      const authorization = req.headers.authorization;
      if (typeof authorization === 'string' && authorization.startsWith('Basic ')) {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator >= 0) {
          clientId = decodeURIComponent(decoded.slice(0, separator));
          clientSecret = decodeURIComponent(decoded.slice(separator + 1));
        }
      }

      if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
        return sendJson(res, 401, { error: 'unauthorized_client' });
      }

      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        verimi_sub: user.verimiSub,
        email: 'test@example.de',
        azp: CLIENT_ID,
        nonce: tx.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'mock-kc-1' })
        .setSubject(user.sub)
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);

      const accessToken = await new SignJWT({ scope: 'openid profile email roles' })
        .setProtectedHeader({ alg: 'RS256', kid: 'mock-kc-1' })
        .setSubject(user.sub)
        .setIssuer(ISSUER)
        .setAudience('account')
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);

      console.log('[mock-kc] PKCE OK -> signed tokens');
      return sendJson(res, 200, {
        id_token: idToken,
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
      });
    }

    // ---------------------------------------------------------------- ACCOUNT API
    if (path === `/realms/${REALM}/account/credentials`) {
      if (!req.headers.authorization?.startsWith('Bearer ')) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      const credentials = user.passkeyEnrolled
        ? [{
            type: 'webauthn-passwordless',
            category: 'passwordless',
            userCredentialMetadatas: [{ id: 'mock-credential-1' }],
          }]
        : [];
      console.log(`[mock-kc] Account API -> passkeyEnrolled=${user.passkeyEnrolled}`);
      return sendJson(res, 200, credentials);
    }

    if (path === `/realms/${REALM}/protocol/openid-connect/logout`) {
      return redirect(res, q.get('post_logout_redirect_uri') || 'http://localhost:5173/');
    }

    if (path === '/mock/reset' && req.method === 'GET') {
      user.passkeyEnrolled = false;
      transactions.clear();
      codes.clear();
      await pgSet();
      return sendHtml(res, '<div class="box">Mock zurückgesetzt.</div>');
    }

    return sendHtml(res, `<div class="box"><h1>Mock Keycloak (internal)</h1>
      <p>Dieser Service läuft auf Port ${PORT} und ist nur über nginx erreichbar.</p>
      <p>Public base: <code>${esc(PUBLIC_BASE)}</code></p>
      <p>Verimi base: <code>${esc(VERIMI_BASE)}</code></p></div>`);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[mock-kc] listening internally on http://127.0.0.1:${PORT}`);
    console.log(`[mock-kc] public base: ${PUBLIC_BASE}`);
    console.log(`[mock-kc] verimi base: ${VERIMI_BASE}`);
  });
