#!/usr/bin/env node
/** Build guard: never ship a frontend that would send users to an arbitrary host. */

const apiBase = process.env.VITE_API_BASE || '/api';
const origins = (process.env.VITE_ALLOWED_AUTH_ORIGINS || 'https://kc.gateway-vw.de:8443').split(',');

function fail(message) {
  console.error(`FRONTEND ENV FAILED: ${message}`);
  process.exit(1);
}

if (apiBase.startsWith('/')) {
  // same-origin /api is fine
} else {
  try {
    const url = new URL(apiBase);
    if (url.protocol !== 'https:') fail('VITE_API_BASE must be HTTPS or a same-origin /api path');
  } catch {
    fail('VITE_API_BASE is not a valid URL or path');
  }
}

if (!origins.some((origin) => origin.trim() === 'https://kc.gateway-vw.de:8443')) {
  fail('VITE_ALLOWED_AUTH_ORIGINS must include https://kc.gateway-vw.de:8443');
}
for (const origin of origins) {
  try {
    const url = new URL(origin.trim());
    if (url.protocol !== 'https:') fail(`non-HTTPS auth origin: ${origin}`);
  } catch {
    fail(`invalid auth origin: ${origin}`);
  }
}

console.log('FRONTEND ENV OK');
