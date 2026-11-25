import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Radar de detecções no resumo da tela Detecções, no navegador, sobre a demonstração (`dev:mock`): sem violação de acessibilidade (WCAG 2.2
 * AA, inclusive contraste) com a dica aberta pelo teclado e a tabela aberta, nos dois temas, no computador e no celular
 * (sem rolagem horizontal da página); a varredura girando só pelo CSS; e, com menos movimento pedido, parado e completo.
 * Com os casos desligados: o radar de alertas, o de sempre. O de casos está em `casos-torre.mock.spec.ts`.
 */

async function openTower(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Detecções' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // No celular, o resumo começa recolhido.
  const show = page.getByRole('region', { name: 'Situação agora' }).getByRole('button', { name: /^Mostrar/ });
  if (await show.isVisible()) await show.click();
  return page.getByRole('region', { name: 'Radar das últimas 24 horas' });
}

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test.describe('radar de detecções da tela Detecções (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('verax.mock.role', 'analista_cliente');
      window.localStorage.setItem('verax.mock.cases', 'off');
    });
    await skipDemoTour(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width] of [
      ['computador', 1280],
      ['celular', 390],
    ] as const) {
      test(`dica pelo teclado e tabela (${theme === 'light' ? 'claro' : 'escuro'}, ${device}): sem violação de acessibilidade`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        const card = await openTower(page);
        const radar = card.getByRole('group', { name: /^Radar de detecções das últimas 24 horas/ });
        await expect(radar).toBeVisible();
        const first = radar.getByRole('link', {
          name: /^Crítico: Tentativa de desligar a trilha do CloudTrail/,
        });
        await first.focus();
        await expect(card.locator('[data-radar-tip]')).toContainText(
          'Tentativa de desligar a trilha do CloudTrail',
        );
        await page.keyboard.press('ArrowRight');
        await expect(card.locator('[data-radar-tip]')).toBeVisible();
        expect(await violations(page)).toEqual([]);

        await card.getByText(/^Ver em tabela/).click();
        await expect(card.getByRole('table', { name: 'Detecções do radar' })).toBeVisible();
        expect(await violations(page)).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  test('a varredura gira pelo CSS, e o Enter num ponto abre o alerta', async ({ page }) => {
    const card = await openTower(page);
    const sweep = card.locator('[data-radar-sweep]');
    await expect(sweep).toBeVisible();
    // A matriz da rotação muda com o tempo, sem o React redesenhar nada.
    const angle = () => sweep.evaluate((element) => getComputedStyle(element).transform);
    const before = await angle();
    await expect.poll(angle).not.toBe(before);
    const first = card.getByRole('link', { name: /^Crítico: Tentativa de desligar a trilha do CloudTrail/ });
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/\?alerta=018f2c1e-0000-7000-8000-000000001001$/);
    // Na tela larga, o detalhe abre ao lado da lista.
    await expect(
      page.getByRole('complementary', { name: 'Tentativa de desligar a trilha do CloudTrail' }),
    ).toBeVisible();
  });

  test('com menos movimento pedido: sem varredura nem pulso, com todos os pontos', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const card = await openTower(page);
    const radar = card.getByRole('group', { name: /^Radar de detecções das últimas 24 horas/ });
    await expect(radar.getByRole('link').first()).toBeVisible();
    await expect(card.locator('[data-radar-sweep]')).toHaveCount(0);
    await expect(card.locator('.radar-echo, [data-pulse]')).toHaveCount(0);
    expect(await radar.getByRole('link').count()).toBeGreaterThan(20);
    expect(await violations(page)).toEqual([]);
  });
});
