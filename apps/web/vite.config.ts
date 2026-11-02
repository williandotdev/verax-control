import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { assertOnlyAllowedPublicEnv, securityHeaders } from './src/build-guards';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  assertOnlyAllowedPublicEnv({ ...env, ...process.env });
  const apiUrl = env['VITE_API_URL'] ?? 'http://localhost:3000';

  return {
    // O Mock Service Worker só existe no modo `dev:mock`; nos outros modos o plugin nem é carregado.
    plugins: [react(), tailwindcss(), ...(mode === 'mock' ? [msw()] : [])],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@verax/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
    },
    build: {
      // Sem sourcemap público: o código-fonte não fica exposto no CDN.
      sourcemap: false,
    },
    preview: {
      headers: securityHeaders(apiUrl),
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
