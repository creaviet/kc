import { readFile } from 'node:fs/promises';

const HOST_RE = /^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const REALM_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function validatePortalsFile(data) {
  const expected = Number(data?.expectedPortalCount || 9);
  const portals = data?.portals;

  if (!Number.isInteger(expected) || expected <= 0) throw new Error('invalid expectedPortalCount');
  if (!Array.isArray(portals)) throw new Error('portals must be an array');
  if (portals.length !== expected) {
    throw new Error(`expected ${expected} portals, got ${portals.length}`);
  }

  const hosts = new Set();
  const realms = new Set();

  for (const portal of portals) {
    const host = String(portal?.host || '').toLowerCase();
    const realm = String(portal?.realm || '');
    const displayName = String(portal?.displayName || '');

    if (!HOST_RE.test(host)) throw new Error(`invalid portal host: ${host}`);
    if (/\.example\.(com|org|net)$/i.test(host)) throw new Error(`placeholder portal host: ${host}`);
    if (/REPLACE_/i.test(host) || /REPLACE_/i.test(realm)) throw new Error(`placeholder in ${host}`);
    if (!REALM_RE.test(realm)) throw new Error(`invalid realm: ${realm}`);
    if (!displayName) throw new Error(`missing displayName for ${host}`);

    if (hosts.has(host)) throw new Error(`duplicate host: ${host}`);
    if (realms.has(realm)) throw new Error(`duplicate realm: ${realm}`);
    hosts.add(host);
    realms.add(realm);
  }

  return portals.map((p) => ({ ...p, host: p.host.toLowerCase() }));
}

export async function loadPortals(path) {
  const raw = await readFile(path, 'utf8');
  return validatePortalsFile(JSON.parse(raw));
}
