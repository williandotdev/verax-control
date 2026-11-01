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
  },
});
