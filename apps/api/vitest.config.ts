import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC é necessário porque o NestJS depende de emitDecoratorMetadata, que o transformador padrão do Vite não gera.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@verax/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Login faz hash de senha (scrypt) de propósito lento; com a suíte em paralelo, 5 s não bastam.
    testTimeout: 30_000,
    // Cada arquivo sobe a API inteira com pool de conexões: poucos processos em paralelo evitam estourar
    // conexões do Postgres e memória (falha intermitente de worker observada com o padrão de 11).
    maxWorkers: 4,
    hookTimeout: 30_000,
    // Aplica as migrations no banco de teste (TEST_DATABASE_URL) antes de qualquer teste.
    globalSetup: ['test/support/global-setup.ts'],
  },
});
