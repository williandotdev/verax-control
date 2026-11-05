import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * A mesma CSP que o cp-admin manda com as telas (`apps/control-plane/src/admin/console-assets.ts`, `CONSOLE_CSP`;
 * o teste de lá confere que as duas são iguais). O `vite preview` dos testes de navegador a usa, para uma violação
 * (estilo ou script inline) aparecer antes de produção.
 */
const CONSOLE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // Sem sourcemap: o código já é público no repositório, e o mapa só aumentaria o que o cp-admin serve.
    sourcemap: false,
  },
  preview: {
    headers: { 'Content-Security-Policy': CONSOLE_CSP, 'X-Content-Type-Options': 'nosniff' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // As telas digitam campo a campo; com as suítes do monorepo rodando juntas (pre-push e CI), 5 s não bastam.
    testTimeout: 20_000,
  },
});
