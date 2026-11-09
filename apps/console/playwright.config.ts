import { defineConfig, devices } from '@playwright/test';

/**
 * Testes de navegador do console do responsável: o build de produção servido pelo `vite preview` com a mesma CSP do
 * cp-admin (`vite.config.ts`), e a API do console simulada em memória pelo `page.route` (`e2e/mock-api.ts`, sobre
 * `src/mocks/fake-admin-api.ts`, com a tabela e o modelo FICTÍCIOS). Nada fala com o plano de controle.
 */
/** A porta do `vite preview`; `CONSOLE_E2E_PORT` troca (outra cópia do repositório rodando ao mesmo tempo). */
const PORT = Number(process.env['CONSOLE_E2E_PORT'] ?? 5291);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [{ name: 'console', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
