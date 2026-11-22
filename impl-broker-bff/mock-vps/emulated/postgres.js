/**
 * Postgres mock for the emulated VPS topology.
 *
 * This is NOT a Postgres wire-protocol server. It is a tiny HTTP JSON state
 * store bound to localhost so the Keycloak mock can persist user/credential
 * state across restarts, like a real Postgres-backed Keycloak would.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PG_PORT || 55432);
const FILE = process.env.PG_FILE || path.join(process.cwd(), 'state.json');

const initialState = () => ({
  user: {
    sub: 'mock-user-1',
    verimiSub: 'verimi-123',
    passkeyEnrolled: false,
  },
  updatedAt: new Date().toISOString(),
});

let state = initialState();

try {
  state = JSON.parse(await fs.readFile(FILE, 'utf8'));
  console.log(`[mock-pg] loaded state from ${FILE}`);
} catch {
  console.log('[mock-pg] no existing state file — using defaults');
}

async function persist() {
  await fs.writeFile(FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    console.log(`[mock-pg] ${req.method} ${url.pathname}`);

    if (url.pathname === '/healthz') {
      return send(res, 200, { ok: true, service: 'mock-postgres', port: PORT });
    }

    if (url.pathname === '/state' && req.method === 'GET') {
      return send(res, 200, state);
    }

    if (url.pathname === '/state' && req.method === 'POST') {
      try {
        const next = await readJson(req);
        state = { ...next, updatedAt: new Date().toISOString() };
        await persist();
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, 400, { error: 'invalid_json', detail: err.message });
      }
    }

    if (url.pathname === '/reset' && req.method === 'POST') {
      state = initialState();
      await persist();
      return send(res, 200, { ok: true, state });
    }

    return send(res, 404, { error: 'not_found' });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[mock-pg] listening on http://127.0.0.1:${PORT}`);
    console.log(`[mock-pg] state file: ${FILE}`);
  });
