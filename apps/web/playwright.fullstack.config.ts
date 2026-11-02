import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Testes de ponta a ponta: o painel compilado (servido pelo `vite preview`, com a mesma CSP de produção)
 * contra a API compilada e o PostgreSQL de teste. Pré-requisitos: `pnpm build` e o banco `_test` no ar.
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const rootEnv = join(root, '.env');
// eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho fixo da raiz do repositório
if (!process.env['CI'] && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const API_PORT = 3100;
const WEB_PORT = 4174;
const apiUrl = `http://localhost:${API_PORT}`;
const webUrl = `http://localhost:${WEB_PORT}`;

// Gerados a cada execução: nada aqui é um segredo real.
process.env['E2E_PASSWORD'] ??= `e2e-${randomBytes(12).toString('base64url')}`;
process.env['E2E_MAILBOX_DIR'] ??= mkdtempSync(join(tmpdir(), 'verax-e2e-mailbox-'));
process.env['E2E_API_URL'] = apiUrl;

const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
if (!testDatabaseUrl) throw new Error('Defina TEST_DATABASE_URL (pnpm setup:env e docker compose up).');

const apiEnv: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: String(API_PORT),
  LOG_LEVEL: 'warn',
  WEB_ORIGIN: webUrl,
  API_ORIGIN: apiUrl,
  DATABASE_URL: testDatabaseUrl,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  CSRF_SECRET: randomBytes(32).toString('base64url'),
  // Sem limite por IP (todos os testes saem do mesmo IP) e sem acesso à internet (Have I Been Pwned).
  AUTH_RATE_LIMIT_ENABLED: 'false',
  PASSWORD_BREACH_CHECK_ENABLED: 'false',
  MAIL_TRANSPORT: 'dev-mailbox',
  MAIL_FROM: 'nao-responda@e2e.verax.local',
  DEV_MAILBOX_DIR: process.env['E2E_MAILBOX_DIR'],
  CHECKPOINT_DISABLE: '1',
};
process.env['E2E_API_ENV'] = JSON.stringify(apiEnv);

export default defineConfig({
  testDir: './e2e/fullstack',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  expect: { timeout: 15_000 },
  reporter: process.env['CI']
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-fullstack' }]]
    : 'list',
  use: { baseURL: webUrl, trace: 'retain-on-failure' },
  projects: [
    { name: 'dados', testMatch: /fixtures\.setup\.ts/ },
    {
      name: 'fullstack',
      testMatch: /\.fullstack\.spec\.ts/,
      dependencies: ['dados'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @verax/api db:deploy && node ../api/dist/main.js',
      url: `${apiUrl}/health`,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm exec vite build --mode production && pnpm exec vite preview --port ${WEB_PORT} --strictPort`,
      url: webUrl,
      env: { VITE_API_URL: apiUrl },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
