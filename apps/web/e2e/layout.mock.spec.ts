import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/** Estrutura do painel no navegador, sobre a API simulada pelo Mock Service Worker (`dev:mock`). */
test.describe('estrutura e navegação (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    await skipDemoTour(page);
  });

  test('admin_verax: menu completo, troca de cliente e sem violações de acessibilidade', async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'admin_verax'));
    await page.goto('/');

    const menu = page.getByRole('navigation', { name: 'Menu principal' });
    await expect(menu.getByRole('link')).toHaveText([
      'Detecções',
      'Postura cloud',
      'Ativos e identidades',
      // R-09: Fontes, Regras e Conta no lugar de "Administração"; Clientes no grupo da Verax.
      'Contas cloud',
      'Agentes',
      'Lista de proteção',
      'Exceções',
      'Usuários',
      'Plano e uso',
      'Escalonamento',
      'Auditoria',
      'Clientes',
      'Alertas sem dono',
    ]);

    const tenant = page.getByLabel('Cliente');
    await expect(tenant).toBeEnabled();
    await tenant.selectOption({ label: 'Cliente Demo Beta' });
    await expect(tenant).toHaveValue('018f2c1e-0000-7000-8000-00000000be7a');

    await menu.getByRole('link', { name: 'Postura cloud' }).click();
    await expect(page).toHaveURL(/\/postura$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Postura cloud' })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('layout-admin.png'), fullPage: true });
  });

  test('leitura: sem clientes nem usuários nem seletor de cliente; a tela de clientes vira "sem permissão"', async ({
    page,
  }) => {
    await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'leitura'));
    await page.goto('/');
    const menu = page.getByRole('navigation', { name: 'Menu principal' });
    await expect(menu.getByRole('link', { name: 'Detecções' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Clientes' })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: 'Usuários' })).toHaveCount(0);
    await expect(page.getByLabel('Cliente')).toHaveCount(0);

    await page.goto('/cadastros/clientes');
    await expect(page.getByRole('heading', { name: 'Sem permissão' })).toBeVisible();
  });
});
