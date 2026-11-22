/** All browser-to-backend calls go through here. Cookies are included, tokens never are. */

import { API_BASE, assertSafeAuthorizationUrl } from './config';
import type { EnrollResponse, LoginMethod, MeResponse, AuthorizationUrlResponse } from './types';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new ApiError(0, 'Der Server ist nicht erreichbar. Bitte versuchen Sie es erneut.');
  }
  if (!response.ok) throw new ApiError(response.status, `Anfrage fehlgeschlagen (${response.status}).`);
  return (await response.json()) as T;
}

/** Navigate the browser to a validated Keycloak authorization URL. */
function navigateToAuthorizationUrl(rawUrl: string): void {
  window.location.assign(assertSafeAuthorizationUrl(rawUrl));
}

export async function fetchMe(): Promise<MeResponse> {
  return getJson<MeResponse>('/me');
}

export async function startLogin(method: LoginMethod): Promise<void> {
  const data = await getJson<AuthorizationUrlResponse>(`/auth/login?method=${encodeURIComponent(method)}`);
  navigateToAuthorizationUrl(data.authorizationUrl);
}

export async function startEnrollment(): Promise<boolean> {
  const data = await getJson<EnrollResponse>('/auth/enroll');
  if (data.alreadyEnrolled) return false;
  navigateToAuthorizationUrl(data.authorizationUrl);
  return true;
}

export function logout(): void {
  window.location.assign(`${API_BASE}/auth/logout`);
}
