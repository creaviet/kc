/**
 * BFF client. The browser never builds an OIDC URL and never sees a token.
 * It only asks the Lambda for an authorizationUrl and then navigates there.
 */

import type { AuthorizationUrlResponse, LoginMethod, MeResponse } from './types';

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'GET',
    credentials: 'include', // send the httpOnly __Host- cookies
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`request_failed_${response.status}`);
  }
  return (await response.json()) as T;
}

export const getMe = (): Promise<MeResponse> => get<MeResponse>('/me');

export const startLogin = (method: LoginMethod = 'auto'): Promise<AuthorizationUrlResponse> =>
  get<AuthorizationUrlResponse>(`/auth/login?method=${encodeURIComponent(method)}`);

export const startEnrolment = (): Promise<AuthorizationUrlResponse> =>
  get<AuthorizationUrlResponse>('/auth/enroll');

// Logout is a plain top-level navigation; the BFF answers with a 302 to
// Keycloak's logout endpoint. No JSON is involved.
