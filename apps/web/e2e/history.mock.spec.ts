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

      test(`alertas: a leitura escolhe 12 meses (${label})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => {
          window.localStorage.setItem('verax.mock.role', 'leitura');
          window.localStorage.setItem('verax.theme', value);
        }, theme);
        await page.goto('/?visao=alertas');
        await ready(page, 'Detecções');
        // No celular, os filtros ficam na folha "Filtros" (E-02).
        if (device === 'celular') await page.getByRole('button', { name: /^Filtros/ }).click();
        const period = page.getByRole('combobox', { name: 'Período' });
        await expect(period.getByRole('option', { name: 'Últimos 12 meses' })).toBeAttached();
        // A lista fica esmaecida enquanto busca o período novo. O endereço muda antes de a tela marcar a busca
        // (`aria-busy`), então a espera de `ready` sozinha pode passar cedo demais, e a conferência de acessibilidade
        // pegaria a tabela esmaecida: espera-se a resposta do período novo antes.
        const loaded = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === '/v1/findings' && url.searchParams.get('period') === '12m';
        });
        await period.selectOption('12m');
        await expect(page).toHaveURL(/\/\?visao=alertas&periodo=12m$/);
        await loaded;
        if (device === 'celular') await page.keyboard.press('Escape');
        await expect(page.getByRole('table', { name: 'Alertas do cliente' })).toBeVisible();
        await ready(page, 'Detecções');
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
      });

      test(`análise de 12 meses: o MITRE ATT&CK do período (${label})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => {
          window.localStorage.setItem('verax.mock.role', 'analista_cliente');
          window.localStorage.setItem('verax.theme', value);
        }, theme);
        await page.goto('/?analise=mitre&periodo=12m');
        await ready(page, 'Detecções');
        if (device === 'celular') {
          // No celular, o período fica na folha "Filtros" (E-02), e a etiqueta dele à vista.
          await expect(page.getByRole('button', { name: /^Últimos 12 meses/ })).toBeVisible();
          await page.getByRole('button', { name: /^Filtros/ }).click();
        }
        await expect(page.getByRole('combobox', { name: 'Período' })).toHaveValue('12m');
        if (device === 'celular') await page.keyboard.press('Escape');
        await expect(page.getByRole('group', { name: /^Gráfico de radar das táticas/ })).toBeVisible();
        // As 14 táticas, mais o cabeçalho, atrás de "Ver tabela completa" (R-11).
        await page.getByText(/^Ver tabela completa \(14 táticas/).click();
        await expect(
          page.getByRole('table', { name: 'Táticas e técnicas do MITRE ATT&CK' }).getByRole('row'),
        ).toHaveCount(15);
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

    test(`detalhe do alerta: o evento bruto disponível por 30 dias (${theme === 'light' ? 'claro' : 'escuro'})`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('verax.mock.role', 'analista_cliente');
        window.localStorage.setItem('verax.theme', value);
      }, theme);
      // Na tela larga (1280 px), o detalhe fica ao lado da lista.
      await page.goto(`/?alerta=${FINDING}`);
      const panel = page.getByRole('complementary', {
        name: 'Tentativa de desligar a trilha do CloudTrail',
      });
      await expect(panel).toBeVisible();
      await panel.getByText('Evento bruto', { exact: true }).click();
      await expect(
        panel.getByText(
          'Evento bruto do log disponível por 30 dias. Os dados do alerta acima ficam pelo histórico do plano, de 365 dias.',
        ),
      ).toBeVisible();
      await expect(panel.getByText(/"eventName": "StopLogging"/)).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  }
});
