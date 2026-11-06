import { defineConfig, devices } from '@playwright/test';

/** Servidor da demonstração (`dev:mock`) nos testes. */
const MOCK_PORT = 5175;
const MOCK_URL = `http://localhost:${MOCK_PORT}`;

/**
 * Testes de navegador do painel. O catálogo só existe no modo de desenvolvimento, então este projeto sobe o
 * servidor do Vite; os fluxos de ponta a ponta com a API (T6.5 em diante) entram em outro projeto.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // O servidor de desenvolvimento otimiza dependências na primeira carga (partida a frio, mais lenta).
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'catalogo', testMatch: /catalog.spec.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      // Painel sobre a API simulada (`dev:mock`), para a estrutura e a navegação sem backend. A demonstração abre fora
      // da sessão; as telas são testadas já dentro dela (`verax.mock.session`, em `src/mocks/demo-session.ts`). Os
      // testes do login começam sem nada guardado (`demo-login.mock.spec.ts`).
      name: 'mock',
      testMatch: /mock.spec.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: MOCK_URL,
        storageState: {
          cookies: [],
          origins: [{ origin: MOCK_URL, localStorage: [{ name: 'verax.mock.session', value: 'logged-in' }] }],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm exec vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite --mode mock --port ${MOCK_PORT} --strictPort`,
      url: MOCK_URL,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
  ],
});
