import { defineConfig, devices } from '@playwright/test';
import { HOST_RESOLVER_RULES } from './e2e/sites/sites';

/**
 * Build único do painel: um `dist` compilado com `VITE_API_URL=https://api-{tenant}.veraxsistemas.com.br`, servido
 * como no Firebase Hosting para dois sites de cliente, cada um com a configuração gerada para ele (setup global). O
 * Chromium resolve os domínios de produção do teste para a própria máquina (`--host-resolver-rules`); a API de cada
 * cliente é interceptada pelo teste, sem rede.
 */
export default defineConfig({
  testDir: './e2e/sites',
  testMatch: /\.sites\.spec\.ts/,
  globalSetup: './e2e/sites/global-setup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'build-unico',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: [`--host-resolver-rules=${HOST_RESOLVER_RULES}`] },
      },
    },
  ],
});
