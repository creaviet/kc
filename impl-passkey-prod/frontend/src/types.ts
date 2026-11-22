export type LoginMethod = 'verimi' | 'passkey' | 'auto';

export interface MeResponse {
  authenticated: boolean;
  passkeyEnrolled: boolean;
  email: string | null;
  portal: string | null;
}

export interface AuthorizationUrlResponse {
  authorizationUrl: string;
}

export interface EnrollResponse extends AuthorizationUrlResponse {
  alreadyEnrolled?: boolean;
}
