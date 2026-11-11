import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { assertOnlyAllowedPublicEnv, assertValidApiUrl, securityHeaders } from './src/build-guards';
import { firebaseHostingConfig } from './src/hosting';

/**
 * Grava a configuração do Firebase Hosting do build (cabeçalhos e rotas) fora do `dist`, ao lado dele
 * (`dist-hosting.json`), para o script de publicação (`scripts/firebase-hosting-deploy.mjs`). Gerada da mesma função
 * dos testes: não há cópia à mão. No build único, sai o modelo com `{tenant}`, e cada site recebe a sua
 * (`siteHostingConfig`).
 */
function hostingConfig(apiUrl: string): Plugin {
  let file = '';
  return {
    name: 'verax-hosting-config',
    apply: 'build',
    configResolved(config) {
      file = `${resolve(config.root, config.build.outDir)}-hosting.json`;
    },
    closeBundle() {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- ao lado da pasta do build
      writeFileSync(file, `${JSON.stringify(firebaseHostingConfig(apiUrl), null, 2)}\n`);
    },
  };
}

/**
 * Fora do modo `mock`, `virtual:msw` não existe, mas o `src/mocks/enable.ts` o importa (só carregado no modo `mock`).
 * Sem resolver o nome, a varredura de dependências do servidor de desenvolvimento falha, o Vite pula a otimização e
 * recarrega a página quando descobre as dependências no meio do uso (o que derrubava os testes de navegador). O módulo
 * vazio só existe no servidor de desenvolvimento: no build, o ramo do modo `mock` é removido antes de chegar aqui.
 */
function mswOutsideMockMode(): Plugin {
  const id = '\0verax-msw-desligado';
  return {
    name: 'verax-msw-desligado',
    apply: 'serve',
    resolveId: (source) => (source === 'virtual:msw' ? id : null),
    load: (loaded) => (loaded === id ? 'export {};' : null),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  assertOnlyAllowedPublicEnv({ ...env, ...process.env });
  const apiUrl = env['VITE_API_URL'] ?? 'http://localhost:3000';
  assertValidApiUrl(apiUrl);

  return {
    // Cache de dependências por modo. O e2e sobe o servidor normal e o de demonstração ao mesmo tempo, e o modo mock
    // tem dependências a mais (o MSW): com uma pasta só, um servidor invalidava o cache do outro, o otimizador rodava
    // de novo e a página recarregava no meio do teste (visto no trace: dois hashes de dependência na mesma carga).
    cacheDir: mode === 'mock' ? 'node_modules/.vite-mock' : 'node_modules/.vite',
    // O Mock Service Worker só existe no modo `dev:mock`; nos outros modos o plugin nem é carregado.
    plugins: [
      react(),
      tailwindcss(),
      hostingConfig(apiUrl),
      ...(mode === 'mock' ? [msw()] : [mswOutsideMockMode()]),
    ],
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
    // `msw/browser` só é importado de dentro do módulo virtual do plugin do MSW, que a varredura de dependências não
    // enxerga: sem esta linha, o Vite o descobria na primeira página aberta, otimizava de novo e recarregava a página.
    ...(mode === 'mock' && { optimizeDeps: { include: ['msw/browser'] } }),
    server: {
      // Transforma o app (a entrada e tudo o que ela importa) assim que o servidor de desenvolvimento sobe, em vez de
      // esperar o primeiro navegador pedir: os testes de navegador abrem 6 páginas ao mesmo tempo logo no início.
      warmup: { clientFiles: ['./src/main.tsx'] },
    },
    // No build único, o preview manda a política-modelo, com `{tenant}`: a de cada site sai na publicação, e o e2e
    // `test:e2e:sites` serve o mesmo `dist` como o Firebase Hosting, um site por cliente.
    preview: {
      headers: securityHeaders(apiUrl),
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      // As telas inteiras (Postura, Achados) passam dos 5 s padrão num executor lento do CI, sem nada de errado:
      // o teto maior tira a falha intermitente sem esconder um teste travado.
      testTimeout: 15_000,
    },
  };
});
