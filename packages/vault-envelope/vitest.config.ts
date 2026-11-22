import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Os schemas compartilhados direto do código-fonte, como na API: os testes não dependem do build.
  resolve: {
    alias: {
      '@verax/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Os testes geram pares RSA de 3072 e 4096 bits, que levam alguns segundos.
    testTimeout: 30_000,
  },
});
