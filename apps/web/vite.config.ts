import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { assertOnlyAllowedPublicEnv, securityHeaders } from './src/build-guards';
import { firebaseHostingConfig } from './src/hosting';

/**
 * Grava a configuração do Firebase Hosting do build (cabeçalhos e rotas) fora do `dist`, para o script de
 * publicação (`scripts/firebase-hosting-deploy.mjs`). Gerada da mesma função dos testes: não há cópia à mão.
 */
function hostingConfig(apiUrl: string): Plugin {
  return {
    name: 'verax-hosting-config',
    apply: 'build',
    closeBundle() {
      const file = fileURLToPath(new URL('./dist-hosting.json', import.meta.url));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho fixo, relativo a este arquivo
      writeFileSync(file, `${JSON.stringify(firebaseHostingConfig(apiUrl), null, 2)}\n`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  assertOnlyAllowedPublicEnv({ ...env, ...process.env });
  const apiUrl = env['VITE_API_URL'] ?? 'http://localhost:3000';

  return {
    // O Mock Service Worker só existe no modo `dev:mock`; nos outros modos o plugin nem é carregado.
    plugins: [react(), tailwindcss(), hostingConfig(apiUrl), ...(mode === 'mock' ? [msw()] : [])],
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
