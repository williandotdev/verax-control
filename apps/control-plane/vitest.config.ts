import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC é necessário porque o NestJS depende de emitDecoratorMetadata, que o transformador padrão do Vite não gera.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  // O contrato do canal da célula (CE-06) direto do código-fonte, como na API: os testes não dependem do build.
  resolve: {
    alias: {
      '@verax/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Os testes contra o emulador do Firestore abrem conexões gRPC; 5 s não bastam na primeira chamada.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
