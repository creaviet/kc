/**
 * LOCAL MOCK of the IONOS VPS (nginx + Keycloak + Verimi).
 *
 * NO Docker, NO Java, NO real Keycloak. Runs on 127.0.0.1 only.
 * It implements just enough OIDC for the BFF to complete both flows:
 *
 *   /realms/vw-beav/protocol/openid-connect/auth   -> mock login / AIA page
 *   /mock-verimi/*                                  -> mock Verimi login
 *   /realms/vw-beav/broker/verimi/endpoint          -> broker callback
 *   /realms/vw-beav/protocol/openid-connect/token  -> signs real RS256 JWTs (jose)
 *   /realms/vw-beav/protocol/openid-connect/certs  -> JWKS
 *   /realms/vw-beav/account/credentials             -> proves passkey enrolment
 *   /realms/vw-beav/protocol/openid-connect/logout -> post-logout redirect
 *
 * SECURITY: this server deliberately accepts ANY "password" and fakes WebAuthn.
 * It must never be exposed beyond localhost. It is a teaching/test tool.
 */

import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const PORT = Number(process.env.MOCK_PORT || 9443);
const REALM = 'vw-beav';
const BASE = `http://localhost:${PORT}`;
const ISSUER = `${BASE}/realms/${REALM}`;
const CLIENT_ID = 'portal-spa';
const CLIENT_SECRET = 'dev-secret'; // must match PORTALS_JSON in backend/.env

// Real RSA key pair generated at startup -> the BFF verifies real signatures.
const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'mock-kc-1', use: 'sig', alg: 'RS256' };

const transactions = new Map(); // state -> { redirectUri, nonce, challenge, flow }
const codes = new Map();        // code   -> { state, enroll }
const user = { sub: 'mock-user-1', verimiSub: 'verimi-123', passkeyEnrolled: false };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sendHtml(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Mock ${esc(REALM)}</title>
    <style>body{font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem}
    .box{border:1px solid #ccc;border-radius:8px;padding:1.5rem}button{padding:.6rem 1rem;background:#0b5fff;color:#fff;border:0;border-radius:6px}
    label{display:block;margin:.8rem 0}input{padding:.5rem;width:100%;box-sizing:border-box}
    .tag{background:#fff3cd;padding:.3rem .6rem;border-radius:4px;font-size:.85rem}</style></head>
    <body>${body}</body></html>`);
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

function makeCode(state, enroll = false) {
  const code = `mockcode-${Math.random().toString(36).slice(2)}`;
  codes.set(code, { state, enroll });
  return code;
}

function backToPortal(res, state, enroll = false) {
  const tx = transactions.get(state);
  if (!tx) return sendHtml(res, '<div class="box">Unknown transaction (state lost).</div>', 400);

  const params = new URLSearchParams({ code: makeCode(state, enroll), state });
  if (enroll) params.set('kc_action_status', 'success');
  const sep = tx.redirectUri.includes('?') ? '&' : '?';
  console.log(`[mock-kc] -> portal callback ${tx.redirectUri}${sep}${params}`);
  redirect(res, `${tx.redirectUri}${sep}${params}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const path = url.pathname;
  const q = url.searchParams;

  console.log(`[mock-vps] ${req.method} ${path}`);

  // ---------------------------------------------------------------- DISCOVERY
  if (path === `/realms/${REALM}/.well-known/openid-configuration`) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${BASE}/realms/${REALM}/protocol/openid-connect/auth`,
      token_endpoint: `${BASE}/realms/${REALM}/protocol/openid-connect/token`,
      userinfo_endpoint: `${BASE}/realms/${REALM}/protocol/openid-connect/userinfo`,
      jwks_uri: `${BASE}/realms/${REALM}/protocol/openid-connect/certs`,
      end_session_endpoint: `${BASE}/realms/${REALM}/protocol/openid-connect/logout`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'profile', 'email', 'roles'],
      claims_supported: ['sub', 'iss', 'aud', 'azp', 'exp', 'iat', 'nonce', 'email', 'verimi_sub'],
    }));
  }

  // ---------------------------------------------------------------- JWKS
  if (path === `/realms/${REALM}/protocol/openid-connect/certs`) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
    return res.end(JSON.stringify({ keys: [publicJwk] }));
  }

  // ---------------------------------------------------------------- AUTHORIZE
  if (path === `/realms/${REALM}/protocol/openid-connect/auth`) {
    const state = q.get('state');
    if (!state || !q.get('redirect_uri')) return sendHtml(res, '<div class="box">Missing state/redirect_uri</div>', 400);

    transactions.set(state, {
      redirectUri: q.get('redirect_uri'),
      nonce: q.get('nonce'),
      challenge: q.get('code_challenge'),
      flow: q.get('kc_action') ? 'enroll' : 'login',
    });
    const hidden = `<input type="hidden" name="state" value="${esc(state)}">`;

    // kc_idp_hint=verimi => Keycloak would immediately 302 to Verimi.
    if (q.get('kc_idp_hint') === 'verimi') {
      console.log('[mock-kc] kc_idp_hint=verimi -> redirecting straight to mock Verimi');
      return redirect(res, `/mock-verimi/authorize?state=${encodeURIComponent(state)}`);
    }

    // AIA enrolment (step 10 of your flow)
    if (q.get('kc_action') === 'webauthn-register-passwordless:skip_if_exists') {
      return sendHtml(res, `<div class="box"><span class="tag">MOCK KEYCLOAK · AIA</span>
        <h1>Passkey erstellen</h1>
        <p>Simuliert: QR-Code, USB-Stick oder Biometrie. Es wird nur ein öffentlicher Schlüssel gespeichert.</p>
        <form method="post" action="/mock-aia/enroll">${hidden}
          <button type="submit">Passkey jetzt simulieren</button></form>
        <form method="post" action="/mock-aia/cancel">${hidden}
          <button type="submit" style="background:#666">Abbrechen</button></form>
      </div>`);
    }

    // Explicit passkey login: no kc_idp_hint -> Keycloak's passkey UI.
    return sendHtml(res, `<div class="box"><span class="tag">MOCK KEYCLOAK · PASSKEY</span>
      <h1>Anmelden mit Passkey</h1>
      <p>Verimi wird hier NICHT kontaktiert.</p>
      <form method="post" action="/mock-passkey/login">${hidden}
        <button type="submit">Mit Passkey anmelden</button></form>
      <p style="font-size:.9rem"><a href="/mock-verimi/authorize?state=${encodeURIComponent(state)}">
        Stattdessen mit Verimi anmelden</a></p>
    </div>`);
  }

  // ---------------------------------------------------------------- MOCK VERIMI
  if (path === '/mock-verimi/authorize') {
    const state = q.get('state');
    return sendHtml(res, `<div class="box"><span class="tag">MOCK VERIMI · external IdP</span>
      <h1>Verimi-Anmeldung</h1><p>Beliebige E-Mail und Passwort eingeben – der Mock akzeptiert alles.</p>
      <form method="post" action="/mock-verimi/login">
        <input type="hidden" name="state" value="${esc(state)}">
        <label>E-Mail <input name="email" value="test@example.de" required></label>
        <label>Passwort <input name="password" type="password" value="demo" required></label>
        <button type="submit">Anmelden</button>
      </form></div>`);
  }

  if (path === '/mock-verimi/login' && req.method === 'POST') {
    const body = await readBody(req);
    const state = body.get('state');
    console.log(`[mock-verimi] authenticated ${body.get('email')}`);
    // In reality Verimi -> Keycloak /broker/verimi/endpoint?code=...
    return redirect(res, `/realms/${REALM}/broker/verimi/endpoint?code=verimi-code&state=${encodeURIComponent(state)}`);
  }

  if (path === `/realms/${REALM}/broker/verimi/endpoint`) {
    console.log('[mock-kc] broker endpoint: JIT-provision + SSO session + code to portal');
    return backToPortal(res, q.get('state'));
  }

  if (path === '/mock-aia/enroll' && req.method === 'POST') {
    const body = await readBody(req);
    user.passkeyEnrolled = true;
    console.log('[mock-kc] CREDENTIAL_REGISTER webauthn-passwordless -> stored public key');
    return backToPortal(res, body.get('state'), true);
  }

  if (path === '/mock-aia/cancel' && req.method === 'POST') {
    const body = await readBody(req);
    return backToPortal(res, body.get('state')); // no kc_action_status=success
  }

  if (path === '/mock-passkey/login' && req.method === 'POST') {
    const body = await readBody(req);
    console.log('[mock-kc] WebAuthn assertion verified against stored public key');
    return backToPortal(res, body.get('state'));
  }

  // ---------------------------------------------------------------- TOKEN
  if (path === `/realms/${REALM}/protocol/openid-connect/token` && req.method === 'POST') {
    const body = await readBody(req);
    const entry = codes.get(body.get('code'));
    if (!entry) {
      console.warn('[mock-kc] unknown/reused code');
      return sendHtml(res, 'invalid_grant', 400);
    }
    codes.delete(body.get('code')); // single use, like real Keycloak

    const tx = transactions.get(entry.state);
    const { createHash } = await import('node:crypto');
    const actual = createHash('sha256').update(body.get('code_verifier') || '', 'ascii').digest('base64url');
    if (!tx || actual !== tx.challenge) {
      console.warn('[mock-kc] PKCE verification FAILED');
      return sendHtml(res, 'invalid_grant (PKCE)', 400);
    }
    // openid-client uses client_secret_basic; accept both auth styles here.
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
      return sendHtml(res, 'unauthorized_client', 401);
    }
    console.log('[mock-kc] PKCE OK -> signing id_token + access_token');

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

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ id_token: idToken, access_token: accessToken, token_type: 'Bearer', expires_in: 300 }));
  }

  // ---------------------------------------------------------------- ACCOUNT API
  if (path === `/realms/${REALM}/account/credentials`) {
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      return sendHtml(res, 'unauthorized', 401);
    }
    const credentials = user.passkeyEnrolled
      ? [{ type: 'webauthn-passwordless', category: 'passwordless', userCredentialMetadatas: [{ id: 'mock-credential-1' }] }]
      : [];
    console.log(`[mock-kc] Account API -> passkeyEnrolled=${user.passkeyEnrolled}`);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(credentials));
  }

  // ---------------------------------------------------------------- LOGOUT
  if (path === `/realms/${REALM}/protocol/openid-connect/logout`) {
    return redirect(res, q.get('post_logout_redirect_uri') || 'http://localhost:5173/');
  }

  // ---------------------------------------------------------------- RESET (test helper)
  if (path === '/mock/reset') {
    user.passkeyEnrolled = false;
    transactions.clear();
    codes.clear();
    return sendHtml(res, '<div class="box">Mock zurückgesetzt. <a href="/">Weiter</a></div>');
  }

  return sendHtml(res, `<div class="box"><h1>Mock IONOS VPS</h1>
    <p>Endpoints: <code>/realms/${REALM}/...</code>, <code>/mock-verimi/...</code></p>
    <p><a href="/mock/reset">Mock zurücksetzen</a></p></div>`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock IONOS VPS listening on http://127.0.0.1:${PORT}`);
  console.log(`Issuer: ${ISSUER}`);
});
