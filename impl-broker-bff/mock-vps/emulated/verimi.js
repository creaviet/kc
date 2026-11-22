/**
 * External Verimi mock for the emulated VPS topology.
 *
 * It listens on its OWN origin (:3443), like the real Verimi IdP. The Keycloak
 * mock redirects the browser here; after "login" this service redirects back
 * to Keycloak's broker endpoint through the PUBLIC nginx origin (:8443).
 */

import http from 'node:http';

const PORT = Number(process.env.VERIMI_PORT || 3443);
const PUBLIC_BASE = (process.env.PUBLIC_BASE || 'http://localhost:8443').replace(/\/$/, '');
const REALM = process.env.REALM || 'vw-beav';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

function sendHtml(res, body, status = 200) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8">
    <title>Verimi Mock</title>
    <style>
      body{font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;background:#fff8e6}
      .box{border:1px solid #e6c980;border-radius:10px;padding:1.5rem;background:#fff}
      button{padding:.6rem 1rem;background:#d97900;color:#fff;border:0;border-radius:6px;margin:.5rem 0}
      label{display:block;margin:.8rem 0;font-weight:600}input{padding:.5rem;width:100%;box-sizing:border-box}
      .tag{background:#ffe6bd;color:#8a4b00;padding:.3rem .6rem;border-radius:4px;font-size:.8rem}
      code{background:#f4eee0;padding:.1rem .3rem;border-radius:3px}
    </style></head><body>${body}</body></html>`);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
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

http
  .createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const path = url.pathname;
    console.log(`[mock-verimi] ${req.method} ${path}`);

    if (path === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        service: 'mock-verimi',
        origin: `http://localhost:${PORT}`,
        backTo: `${PUBLIC_BASE}/realms/${REALM}/broker/verimi/endpoint`,
      });
    }

    if (path === '/mock-verimi/authorize' && req.method === 'GET') {
      const state = url.searchParams.get('state');
      if (!state) {
        return sendHtml(res, '<div class="box">Missing <code>state</code>.</div>', 400);
      }

      return sendHtml(res, `<div class="box">
        <span class="tag">MOCK VERIMI · EXTERNAL IDP</span>
        <h1>Verimi-Anmeldung</h1>
        <p>Dies ist der externe IdP. Keycloak hat hierher weitergeleitet.</p>
        <form method="post" action="/mock-verimi/login">
          <input type="hidden" name="state" value="${esc(state)}">
          <label>E-Mail <input name="email" type="email" value="test@example.de" required></label>
          <label>Passwort <input name="password" type="password" value="demo" required></label>
          <button type="submit">Bei Verimi anmelden</button>
        </form>
        <p class="tag" style="display:inline-block">Beliebige Daten werden akzeptiert.</p>
      </div>`);
    }

    if (path === '/mock-verimi/login' && req.method === 'POST') {
      const body = await readBody(req);
      const state = body.get('state');
      const email = body.get('email');

      if (!state || !email) {
        return sendHtml(res, '<div class="box">State und E-Mail sind erforderlich.</div>', 400);
      }

      console.log(`[mock-verimi] authenticated ${email}`);
      const target = `${PUBLIC_BASE}/realms/${REALM}/broker/verimi/endpoint?state=${encodeURIComponent(state)}`;
      console.log(`[mock-verimi] -> Keycloak broker endpoint ${target}`);
      return redirect(res, target);
    }

    return sendHtml(res, `<div class="box"><h1>Verimi Mock</h1>
      <p>Origin: <code>http://localhost:${PORT}</code></p>
      <p>Start: <a href="/mock-verimi/authorize?state=demo-state">/mock-verimi/authorize</a></p></div>`);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[mock-verimi] listening on http://127.0.0.1:${PORT}`);
    console.log(`[mock-verimi] returns to ${PUBLIC_BASE}/realms/${REALM}/broker/verimi/endpoint`);
  });
