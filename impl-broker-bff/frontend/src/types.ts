export type Phase = 'B' | 'C';
export type LoginMethod = 'auto' | 'passkey' | 'verimi';

export interface MeResponse {
  authenticated: boolean;
  phase: Phase;
  sub?: string;
  passkeyEnrolled?: boolean;
  displayName?: string | null;
}

export interface AuthorizationUrlResponse {
  authorizationUrl: string;
}
