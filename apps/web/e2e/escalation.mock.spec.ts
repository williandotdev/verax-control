import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Contato de escalonamento (D8) na demonstração (`dev:mock`): a situação do contato e o "Reenviar confirmação" no
 * cadastro de clientes da Verax e na tela do administrador do cliente, e as páginas públicas dos links do e-mail
 * (confirmar e descadastrar). Sem violação de acessibilidade (WCAG 2.2 AA), nos dois temas e no celular.
 */

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const THEMES = ['light', 'dark'] as const;
const DEVICES = [
  ['computador', 1280],
  ['celular', 360],
] as const;
const themeName = (theme: (typeof THEMES)[number]) => (theme === 'light' ? 'claro' : 'escuro');
/** Um token no formato da API (43 caracteres em base64url); o vencido da demonstração é `A` repetido. */
const VALID_TOKEN = 'b'.repeat(43);
const EXPIRED_TOKEN = 'A'.repeat(43);

test.describe('contato de escalonamento (modo mock, D8)', () => {
  test.beforeEach(async ({ page }) => {
    await skipDemoTour(page);
  });

  for (const theme of THEMES) {
    for (const [device, width] of DEVICES) {
      test(`administrador do cliente troca o e-mail e pede a confirmação de novo (${themeName(theme)}, ${device})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => {
          window.localStorage.setItem('verax.mock.role', 'admin_cliente');
          window.localStorage.setItem('verax.theme', value);
        }, theme);
        await page.goto('/cadastros/escalonamento');
        await expect(page.getByRole('heading', { level: 1, name: 'Contato de escalonamento' })).toBeVisible();
        await expect(page.getByText('Confirmado', { exact: true })).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await violations(page)).toEqual([]);
        expect(await overflow(page)).toBeLessThanOrEqual(1);

        const email = page.getByLabel('E-mail do contato');
        await email.fill('plantao@exemplo.com.br');
        await page.getByRole('button', { name: 'Salvar contato' }).click();
        await expect(page.getByText('Aguardando confirmação', { exact: true })).toBeVisible();
        await expect(page.getByRole('status').filter({ hasText: 'Contato salvo.' })).toBeVisible();
        await page.getByRole('button', { name: 'Reenviar confirmação' }).click();
        await expect(
          page.getByRole('status').filter({ hasText: 'Pedido de confirmação na fila.' }),
        ).toBeVisible();
        expect(await violations(page)).toEqual([]);
        expect(await overflow(page)).toBeLessThanOrEqual(1);
      });
    }
  }

  for (const theme of THEMES) {
    test(`cadastro de clientes: a situação do contato e o reenvio (${themeName(theme)})`, async ({
      page,
    }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('verax.mock.role', 'admin_verax');
        window.localStorage.setItem('verax.theme', value);
      }, theme);
      await page.goto('/cadastros/clientes');
      await page.getByRole('button', { name: 'Cliente Demo Beta' }).click();
      const sheet = page.getByRole('dialog', { name: 'Cliente' });
      await expect(sheet.getByText('Aguardando confirmação', { exact: true })).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await sheet.getByRole('button', { name: 'Reenviar confirmação' }).click();
      await expect(
        sheet.getByRole('status').filter({ hasText: 'Pedido de confirmação na fila.' }),
      ).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    for (const [device, width] of DEVICES) {
      test(`links públicos: confirmar e descadastrar sem login (${themeName(theme)}, ${device})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        await page.goto(`/escalonamento/confirmar#token=${VALID_TOKEN}`);
        await expect(
          page.getByRole('heading', { level: 1, name: 'Confirmar o contato de escalonamento' }),
        ).toBeVisible();
        // O token sai da barra de endereço assim que a página o lê.
        await expect(page).toHaveURL(/\/escalonamento\/confirmar$/);
        expect(await violations(page)).toEqual([]);
        expect(await overflow(page)).toBeLessThanOrEqual(1);
        await page.getByRole('button', { name: 'Confirmar o endereço' }).click();
        await expect(page.getByRole('status')).toHaveText(
          'Endereço confirmado. A partir de agora, ele recebe os avisos críticos.',
        );
        expect(await violations(page)).toEqual([]);

        await page.goto(`/escalonamento/descadastrar#token=${EXPIRED_TOKEN}`);
        await page.getByRole('button', { name: 'Deixar de receber' }).click();
        await expect(page.getByRole('alert')).toContainText('Este link é inválido ou venceu.');
        expect(await violations(page)).toEqual([]);
        expect(await overflow(page)).toBeLessThanOrEqual(1);
      });
    }
  }
});
