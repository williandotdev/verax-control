import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Minha conta e a coluna "Recebe alertas" (fase 2, PR-17') na demonstração (`dev:mock`): a pessoa desliga e religa os
 * próprios avisos de incidente por e-mail; quem administra só vê, na lista de usuários. Sem violação de acessibilidade
 * (WCAG 2.2 AA), nos dois temas e no celular.
 */

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`);
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("Minha conta: avisos por e-mail (modo mock, PR-17')", () => {
  test.beforeEach(async ({ page }) => {
    await skipDemoTour(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width] of [
      ['computador', 1280],
      ['celular', 360],
    ] as const) {
      test(`analista desliga e religa os avisos (${theme === 'light' ? 'claro' : 'escuro'}, ${device})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => {
          window.localStorage.setItem('verax.mock.role', 'analista_cliente');
          window.localStorage.setItem('verax.theme', value);
        }, theme);
        await page.goto('/');
        await page.getByRole('link', { name: 'Minha conta' }).click();
        await expect(page.getByRole('heading', { level: 1, name: 'Minha conta' })).toBeVisible();
        const box = page.getByRole('checkbox', { name: 'Receber os avisos de incidente por e-mail' });
        await expect(box).toBeChecked();
        expect(await violations(page)).toEqual([]);

        await box.uncheck();
        await expect(page.getByRole('status').filter({ hasText: 'deixa de receber' })).toBeVisible();
        await expect(box).not.toBeChecked();
        expect(await violations(page)).toEqual([]);
        expect(await overflow(page)).toBeLessThanOrEqual(1);

        await box.check();
        await expect(page.getByRole('status').filter({ hasText: 'volta a receber' })).toBeVisible();
      });
    }
  }

  test('leitura: a tela diz que o papel não recebe, sem a opção', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'leitura'));
    await page.goto('/minha-conta');
    await expect(page.getByText(/O papel Somente leitura não recebe avisos por e-mail/)).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`Usuários: a coluna "Recebe alertas" é só leitura (${theme === 'light' ? 'claro' : 'escuro'})`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('verax.mock.role', 'admin_cliente');
        window.localStorage.setItem('verax.theme', value);
      }, theme);
      await page.goto('/cadastros/usuarios');
      const table = page.getByRole('table', { name: 'Usuários do cliente' });
      await expect(table.getByRole('columnheader', { name: 'Recebe alertas' })).toBeVisible();
      await expect(table.getByRole('row').filter({ hasText: 'João Lima' })).toContainText('Não (desligou)');
      await expect(table.getByRole('row').filter({ hasText: 'Diretoria' })).toContainText('Não (papel)');
      await expect(table.getByRole('checkbox')).toHaveCount(0);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });
  }
});
