import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

declare const process: { cwd(): string; env: Record<string, string | undefined> };

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const isProductionBuild = command === 'build' && mode === 'production';
  const scheme = env.VITE_KC_SCHEME || 'https';
  const host = env.VITE_KC_HOST || 'kc.gateway-vw.de:8443';

  if (isProductionBuild && (scheme !== 'https' || host !== 'kc.gateway-vw.de:8443')) {
    throw new Error(
      `Refusing production build with non-production Keycloak origin: ${scheme}://${host}`,
    );
  }

  return {
    plugins: [react()],
    server: {
      // In production /api is mapped to the Lambda by API Gateway.
      // Locally it is proxied to backend/src/local-server.js.
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
