/**
 * Frontend safety rail: the SPA may only navigate to our own Keycloak origin.
 * In production this is https://kc.gateway-vw.de:8443.
 * For the local IONOS mock it is http://localhost:9443 (see frontend/.env.local).
 */

const env = import.meta.env as Record<string, string | undefined>;

const scheme = env.VITE_KC_SCHEME || 'https';
const host = env.VITE_KC_HOST || 'kc.gateway-vw.de:8443';

export const KEYCLOAK_ORIGIN = new URL(`${scheme}://${host}`).origin;

export function toKeycloakAuthorizationUrl(rawUrl: string): URL {
  const target = new URL(rawUrl);

  if (target.origin !== KEYCLOAK_ORIGIN) {
    throw new Error(`unexpected_keycloak_origin:${target.origin}`);
  }
  if (!target.pathname.includes('/protocol/openid-connect/auth')) {
    throw new Error(`unexpected_keycloak_path:${target.pathname}`);
  }

  return target;
}
