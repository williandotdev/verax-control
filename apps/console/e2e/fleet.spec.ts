import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { createFakeState, type FakeAdminState } from '../src/mocks/fake-admin-api';
import { mockAdminApi } from './mock-api';

/**
 * As telas de Versões (a frota) no navegador, nos dois temas: sem violação do axe (WCAG 2.2 AA), sem violação da CSP
 * do cp-admin e operáveis pelo teclado, sobre a frota simulada (`src/mocks/fake-fleet.ts`, dados FICTÍCIOS).
 */
const THEMES = ['light', 'dark'] as const;

async function prepare(page: Page, theme: (typeof THEMES)[number], state: FakeAdminState): Promise<string[]> {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) violations.push(message.text());
  });
  page.on('pageerror', (error) => violations.push(error.message));
  await page.addInitScript((value) => window.localStorage.setItem('verax.console.theme', value), theme);
  await mockAdminApi(page, state);
  return violations;
}

async function audit(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);
  const directory = process.env['CONSOLE_SCREENSHOTS'];
  if (directory !== undefined) mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: directory === undefined ? testInfo.outputPath(`${name}.png`) : join(directory, `${name}.png`),
    fullPage: true,
  });
}

for (const theme of THEMES) {
  test.describe(`versões, tema ${theme === 'light' ? 'claro' : 'escuro'}`, () => {
    test('a frota, a rodada parada na falha e a revisão de uma rodada nova', async ({ page }, testInfo) => {
      const state = createFakeState();
      const violations = await prepare(page, theme, state);
      await page.goto('/versoes');
      await expect(page.getByRole('table', { name: /Nós da frota/ })).toBeVisible();
      await expect(page.getByRole('row', { name: /sp1/ }).first()).toContainText('node-v1.2.3');
      await audit(page, testInfo, `versoes-${theme}`);

      await page.getByRole('link', { name: 'Acompanhar a rodada' }).click();
      await expect(page.getByRole('alert')).toContainText('node_rolled_back:health_failed');
      await audit(page, testInfo, `rodada-falha-${theme}`);

      // Pelo teclado: abortar a rodada parada, e a revisão de uma versão nova fica livre.
      await page.getByRole('button', { name: 'Abortar' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Abortar' })).toHaveCount(0);
      await page.goto('/versoes/promover/node-v1.3.0');
      await expect(page.getByRole('heading', { name: /Onda 0: célula da Verax/ })).toBeVisible();
      await page.getByLabel(/Digite a versão/).fill('node-v1.3.0');
      await expect(page.getByRole('button', { name: 'Promover para a frota' })).toBeEnabled();
      await audit(page, testInfo, `promover-${theme}`);
      expect(violations).toEqual([]);
    });
  });
}
