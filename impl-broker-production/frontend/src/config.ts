/**
 * Frontend safety rail: the SPA may only navigate to the production Keycloak
 * origin. The value is compile-time fixed; it is not user- or server-controlled.
 */

export const KEYCLOAK_ORIGIN = new URL('https://kc.gateway-vw.de:8443').origin;

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
