import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * O "Admin master" no SIEM da Verax, sobre a API simulada (`dev:mock`): o mock devolve o endereço de um console fictício
 * na configuração pública quando `localStorage['verax.mock.admin-master']` o traz (a demonstração, sem ele, não mostra
 * nada). O botão do login, a recusa do retorno e o item do menu, sem violações de acessibilidade.
 */

const CONSOLE = 'https://admin.example.com/';

async function withConsole(page: Page): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('verax.mock.admin-master', value), CONSOLE);
}

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test.describe('Admin master (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    await skipDemoTour(page);
    await withConsole(page);
  });

  test('login com "Entrar com o Admin master" e a recusa genérica do retorno, sem violações', async ({
    browser,
  }) => {
    // Fora da sessão da demonstração: o login de verdade.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await skipDemoTour(page);
    await withConsole(page);
    await page.goto('/login');
    const sso = page.getByRole('link', { name: 'Entrar com o Admin master' });
    await expect(sso).toBeVisible();
    await expect(sso).toHaveAttribute('href', /\/v1\/auth\/sso\/start$/);
    expect(await violations(page)).toEqual([]);

    await page.goto('/login?sso=recusado');
    await expect(page.getByRole('alert')).toHaveText(
      'Não foi possível entrar pelo Admin master. Tente de novo ou entre com e-mail e senha.',
    );
    expect(await violations(page)).toEqual([]);
    await context.close();
  });

  test('menu do admin_verax com o item "Admin master" (mesma aba), sem violações', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'admin_verax'));
    await page.goto('/');
    const menu = page.getByRole('navigation', { name: 'Menu principal' });
    const item = menu.getByRole('link', { name: 'Admin master' });
    await expect(item).toHaveAttribute('href', CONSOLE);
    await expect(item).not.toHaveAttribute('target', /.+/);
    expect(await violations(page)).toEqual([]);
  });

  test('quem não é admin_verax não vê o item', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'admin_cliente'));
    await page.goto('/');
    const menu = page.getByRole('navigation', { name: 'Menu principal' });
    await expect(menu.getByRole('link', { name: 'Detecções' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Admin master' })).toHaveCount(0);
  });
});
