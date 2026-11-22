/**
 * nginx mock for the emulated VPS topology.
 *
 * Two listeners, like your real IONOS host:
 *   :8443 public  -> reverse proxy to Keycloak internal :8080 (no restrictions)
 *   :8444 admin   -> reverse proxy to Keycloak internal :8080, but FAIL CLOSED
 *
 * The real admin rule is in ../nginx/conf.d/20-keycloak-admin.conf (`deny all`
 * plus explicit `allow` lines). Since everything runs on localhost here, we
 * simulate the client IP with the `X-Mock-Remote-IP` header.
 */

import http from 'node:http';

const PUBLIC_PORT = Number(process.env.NGINX_PUBLIC_PORT || 8443);
const ADMIN_PORT = Number(process.env.NGINX_ADMIN_PORT || 8444);
const UPSTREAM = new URL(process.env.KEYCLOAK_UPSTREAM || 'http://127.0.0.1:8080');

const normalizeIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
const TRUSTED = new Set(
  (process.env.ADMIN_TRUSTED_IPS || '127.0.0.1,::1')
    .split(',')
    .map((s) => normalizeIp(s.trim()))
    .filter(Boolean),
);

function requestIp(req) {
  // Real nginx uses the TCP peer. The header exists only so we can test the
  // allow/deny rule from one machine. Never trust this header in production.
  return normalizeIp(req.headers['x-mock-remote-ip'] || req.socket.remoteAddress);
}

function sendJson(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function sendHtml(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8">
    <title>mock nginx</title><style>
      body{font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem;background:#f6f7f9}
      .box{background:#fff;border:1px solid #dcdfe5;border-radius:10px;padding:1.5rem}
      code{background:#eef1f5;padding:.1rem .3rem;border-radius:3px}
    </style></head><body>${body}</body></html>`);
}

function proxyToKeycloak(req, res, label) {
  const target = new URL(req.url || '/', UPSTREAM);
  const headers = { ...req.headers, host: UPSTREAM.host };
  delete headers['x-mock-remote-ip']; // do not leak the simulated client IP upstream

  const upstreamReq = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upstreamRes) => {
      const forwarded = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (['connection', 'keep-alive', 'transfer-encoding'].includes(key.toLowerCase())) continue;
        forwarded[key] = value;
      }
      if (!forwarded['cache-control']) forwarded['cache-control'] = 'no-store';
      res.writeHead(upstreamRes.statusCode || 502, {
        ...forwarded,
        'x-mock-proxy': label,
      });
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on('error', (err) => {
    console.error(`[mock-nginx:${label}] upstream error: ${err.message}`);
    sendJson(res, 502, { error: 'bad_gateway', via: label, detail: err.message }, {
      'x-mock-proxy': label,
    });
  });

  req.pipe(upstreamReq);
}

// ------------------------------------------------------------------ PUBLIC :8443
http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PUBLIC_PORT}`);
    console.log(`[mock-nginx:public] ${req.method} ${url.pathname}`);

    if (url.pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        service: 'mock-nginx-public',
        listens: `http://localhost:${PUBLIC_PORT}`,
        upstream: UPSTREAM.href,
      }, { 'x-mock-proxy': 'public' });
    }

    return proxyToKeycloak(req, res, 'public-nginx');
  })
  .listen(PUBLIC_PORT, '127.0.0.1', () => {
    console.log(`[mock-nginx:public] listening on http://127.0.0.1:${PUBLIC_PORT}`);
    console.log(`[mock-nginx:public] proxy -> ${UPSTREAM.href}`);
  });

// ------------------------------------------------------------------- ADMIN :8444
http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${ADMIN_PORT}`);
    const ip = requestIp(req);
    const allowed = TRUSTED.has(ip);
    console.log(`[mock-nginx:admin] ${req.method} ${url.pathname} ip=${ip} allowed=${allowed}`);

    if (!allowed) {
      return sendHtml(res, 403, `<div class="box">
        <h1>403 Forbidden</h1>
        <p>Admin plane is restricted. Client <code>${ip}</code> is not allowlisted.</p>
        <p>Trusted in this emulator: <code>${[...TRUSTED].join(', ') || '(none)'}</code>.</p>
        <p>Test allow with: <code>curl -H 'X-Mock-Remote-IP: 127.0.0.1' ...</code></p>
      </div>`, { 'x-mock-proxy': 'admin-nginx-denied' });
    }

    if (url.pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        service: 'mock-nginx-admin',
        listens: `http://localhost:${ADMIN_PORT}`,
        upstream: UPSTREAM.href,
        trustedClient: ip,
      }, { 'x-mock-proxy': 'admin-nginx' });
    }

    return proxyToKeycloak(req, res, 'admin-nginx');
  })
  .listen(ADMIN_PORT, '127.0.0.1', () => {
    console.log(`[mock-nginx:admin] listening on http://127.0.0.1:${ADMIN_PORT}`);
    console.log(`[mock-nginx:admin] trusted IPs: ${[...TRUSTED].join(', ') || '(none — fail closed)'}`);
  });
