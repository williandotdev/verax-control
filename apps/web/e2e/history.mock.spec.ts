import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * 365 dias nas telas (fase 2, PR-20) na demonstração (`dev:mock`, nó no Profissional): o período de 12 meses nos
 * filtros de achados, auditoria e relatórios, para quem não administra também, e a retenção do evento bruto no detalhe
 * do achado. Sem violação de acessibilidade (WCAG 2.2 AA), nos dois temas, no computador e no celular.
 */

const FINDING = '018f2c1e-0000-7000-8000-000000001001';

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

async function ready(page: Page, heading: string) {
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

const noHorizontalScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);

test.describe('histórico de 12 meses (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    await skipDemoTour(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width] of [
      ['computador', 1280],
      ['celular', 360],
    ] as const) {
      const label = `${theme === 'light' ? 'claro' : 'escuro'}, ${device}`;

      test(`achados: a leitura escolhe 12 meses (${label})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => {
          window.localStorage.setItem('verax.mock.role', 'leitura');
          window.localStorage.setItem('verax.theme', value);
        }, theme);
        await page.goto('/achados');
        await ready(page, 'Achados');
        const period = page.getByRole('combobox', { name: 'Período' });
        await expect(period.getByRole('option', { name: 'Últimos 12 meses' })).toBeAttached();
        await period.selectOption('12m');
        await expect(page).toHaveURL(/\?periodo=12m$/);
        await expect(page.getByRole('table', { name: 'Achados do cliente' })).toBeVisible();
        await ready(page, 'Achados');
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
      });

      test(`relatórios de 12 meses: o resumo com os 366 dias (${label})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => {
          window.localStorage.setItem('verax.mock.role', 'analista_cliente');
          window.localStorage.setItem('verax.theme', value);
        }, theme);
        await page.goto('/relatorios?periodo=12m');
        await ready(page, 'Relatórios');
        await expect(page.getByRole('combobox', { name: 'Período' })).toHaveValue('12m');
        await page.getByText('Ver tabela').click();
        // 365 dias tocam 366 datas; mais o cabeçalho.
        await expect(page.getByRole('table', { name: 'Achados por dia' }).getByRole('row')).toHaveCount(367);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
      });

      test(`auditoria de 12 meses e o histórico em Plano e uso (${label})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => {
          window.localStorage.setItem('verax.mock.role', 'admin_cliente');
          window.localStorage.setItem('verax.theme', value);
        }, theme);
        await page.goto('/auditoria?periodo=12m');
        await ready(page, 'Auditoria');
        await expect(page.getByRole('combobox', { name: 'Período' })).toHaveValue('12m');
        await expect(page.getByRole('table', { name: 'Trilha de auditoria' })).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);

        await page.goto('/cadastros/plano');
        await ready(page, 'Plano e uso');
        const history = page.getByRole('region', { name: 'Histórico' });
        await expect(history).toContainText('365 dias');
        await expect(history).toContainText('o evento bruto do log, 30 dias');
        expect(await violations(page)).toEqual([]);
      });
    }

    test(`detalhe do achado: o evento bruto disponível por 30 dias (${theme === 'light' ? 'claro' : 'escuro'})`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('verax.mock.role', 'analista_cliente');
        window.localStorage.setItem('verax.theme', value);
      }, theme);
      await page.goto(`/achados?achado=${FINDING}`);
      const panel = page.getByRole('dialog', { name: 'Tentativa de desligar a trilha do CloudTrail' });
      await expect(panel).toBeVisible();
      await panel.getByText('Evento bruto', { exact: true }).click();
      await expect(
        panel.getByText(
          'Evento bruto do log disponível por 30 dias. Os dados do achado acima ficam pelo histórico do plano, de 365 dias.',
        ),
      ).toBeVisible();
      await expect(panel.getByText(/"eventName": "StopLogging"/)).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  }
});
