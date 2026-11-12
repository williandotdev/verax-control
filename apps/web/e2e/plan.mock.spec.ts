import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * "Plano e uso" (fase 2, PR-18) na demonstração (`dev:mock`): o plano do nó, os contadores e a faixa a partir de 80% do
 * volume, só leitura e sem violação de acessibilidade (WCAG 2.2 AA), nos dois temas e no celular.
 */
test.describe('Plano e uso (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    await skipDemoTour(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width] of [
      ['computador', 1280],
      ['celular', 360],
    ] as const) {
      test(`administrador do cliente: contadores e a faixa de 80% (${theme === 'light' ? 'claro' : 'escuro'}, ${device})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => {
          window.localStorage.setItem('verax.mock.role', 'admin_cliente');
          window.localStorage.setItem('verax.theme', value);
        }, theme);
        await page.goto('/cadastros/plano');
        await expect(page.getByRole('heading', { level: 1, name: 'Plano e uso' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Plano Profissional' })).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

        // A Alfa da demonstração já passou de 80% do volume do mês: a faixa aparece, e a coleta não para.
        await expect(
          page.getByRole('status').filter({ hasText: 'O volume do mês já chegou a 86%' }),
        ).toBeVisible();
        await expect(page.getByRole('meter', { name: 'Volume do mês' })).toHaveAttribute(
          'aria-valuenow',
          '86',
        );
        await expect(page.getByRole('meter', { name: 'Contas cloud' })).toHaveAttribute(
          'aria-valuetext',
          /^\d+ de 15$/,
        );
        await expect(page.getByRole('meter', { name: 'Usuários' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Histórico' })).toContainText('365 dias');
        // Só leitura: nada para editar.
        await expect(page.getByRole('main').getByRole('textbox')).toHaveCount(0);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual(
          [],
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  // A Plataforma (CE-10): o contador da franquia em GB/dia, o volume por dia e "Ampliar franquia" desligado.
  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width] of [
      ['computador', 1280],
      ['celular', 360],
    ] as const) {
      test(`Plataforma: o contador da franquia (${theme === 'light' ? 'claro' : 'escuro'}, ${device})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => {
          window.localStorage.setItem('verax.mock.role', 'admin_cliente');
          window.localStorage.setItem('verax.mock.plan', 'plataforma');
          window.localStorage.setItem('verax.theme', value);
        }, theme);
        await page.goto('/cadastros/plano');
        await expect(page.getByRole('heading', { name: 'Plano Plataforma' })).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        const card = page.getByRole('region', { name: 'Franquia de 3 GB/dia' });
        await expect(card).toBeVisible();
        await expect(card.getByRole('meter', { name: 'Volume do ciclo' })).toBeVisible();
        await expect(card.getByRole('button', { name: 'Ampliar franquia' })).toBeDisabled();
        await expect(page.getByRole('region', { name: 'Volume por dia' }).getByRole('img')).toBeVisible();
        await expect(page.getByRole('region', { name: 'Volume do mês' })).toHaveCount(0);
        // A tabela do gráfico aberta também passa pelo axe.
        await page.getByText('Ver tabela').click();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual(
          [],
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  test('analista: sem o item no menu, e a página vira "sem permissão"', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'analista_cliente'));
    await page.goto('/');
    const menu = page.getByRole('navigation', { name: 'Menu principal' });
    await expect(menu.getByRole('link', { name: 'Torre' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Plano e uso' })).toHaveCount(0);
    await page.goto('/cadastros/plano');
    await expect(page.getByRole('heading', { name: 'Sem permissão' })).toBeVisible();
  });
});
