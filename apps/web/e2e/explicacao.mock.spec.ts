import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * "O que aconteceu" no detalhe do alerta, sobre a demonstração (`dev:mock`): o alerta da trilha explicado em português, com o
 * que mudou, por que importa e o que conferir; sem violação de acessibilidade (WCAG 2.2 AA, inclusive contraste) nos dois
 * temas a 360, 768 e 1280 px; e sem rolagem de lado da página.
 */

/** "Grupo de segurança liberou a porta 22 para a internet". */
const SECURITY_GROUP_ALERT = '018f2c1e-0000-7000-8000-000000001010';
/** "Tentativa de desligar a trilha do CloudTrail". */
const TRAIL_ALERT = '018f2c1e-0000-7000-8000-000000001001';
const WIDTHS = [360, 768, 1280] as const;

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const noHorizontalScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);

test.describe('O que aconteceu (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('verax.mock.role', 'analista_cliente');
      window.localStorage.setItem('verax.mock.cases', 'off');
    });
    await skipDemoTour(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const width of WIDTHS) {
      test(`grupo de segurança aberto (${theme === 'light' ? 'claro' : 'escuro'}, ${width} px)`, async ({
        page,
      }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        await page.goto(`/?alerta=${SECURITY_GROUP_ALERT}`);
        const section = page.getByRole('region', { name: 'O que aconteceu' });
        await expect(section).toBeVisible();
        await expect(section).toContainText('liberou entradas no grupo de segurança sg-0a1b2c3d4e5f60789');
        await expect(section.getByRole('list', { name: 'Incluídos (2)' })).toContainText(
          'TCP porta 22 (SSH, acesso remoto) de qualquer endereço IPv4',
        );
        await expect(section).toContainText('Por que importa:');
        await expect(section).toContainText('O que conferir:');
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
      });
    }
  }

  test('a trilha do CloudTrail parada: o nome da trilha e o motivo', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/?alerta=${TRAIL_ALERT}`);
    const section = page.getByRole('region', { name: 'O que aconteceu' });
    await expect(section).toContainText('parou o registro da trilha do CloudTrail "trilha-principal"');
    await expect(section).toContainText('sem deixar rastro');
  });
});
