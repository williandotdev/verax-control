import { defineConfig, devices } from '@playwright/test';

/**
 * Testes de navegador do painel. O catálogo só existe no modo de desenvolvimento, então este projeto sobe o
 * servidor do Vite; os fluxos de ponta a ponta com a API (T6.5 em diante) entram em outro projeto.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
