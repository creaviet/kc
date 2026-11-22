/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_ALLOWED_AUTH_ORIGINS?: string;
  readonly VITE_VERIMI_AVAILABLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
