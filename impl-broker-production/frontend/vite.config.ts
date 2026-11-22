import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

declare const process: { env: Record<string, string | undefined> };

const EXPECTED_SCHEME = 'https';
const EXPECTED_HOST = 'kc.gateway-vw.de:8443';

/**
 * Production-only frontend build.
 *
 * There is intentionally no /api dev proxy. In production the SPA is served
 * from each portal domain and API Gateway maps /api to the BFF Lambda.
 */
export default defineConfig(() => {
  const configuredScheme = process.env.VITE_KC_SCHEME;
  const configuredHost = process.env.VITE_KC_HOST;

  if (configuredScheme && configuredScheme !== EXPECTED_SCHEME) {
    throw new Error(`Refusing frontend build with VITE_KC_SCHEME=${configuredScheme}`);
  }
  if (configuredHost && configuredHost !== EXPECTED_HOST) {
    throw new Error(`Refusing frontend build with VITE_KC_HOST=${configuredHost}`);
  }

  return {
    plugins: [react()],
  };
});
