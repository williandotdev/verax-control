import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Exceção nova resolve os alertas em aberto (decisão do dono de 26/11/2026), sobre a demonstração (`dev:mock`): a prévia
 * ("vai resolver N alertas em aberto") na nova exceção da tela Exceções e, criada, quantos resolveu; sem violação de
 * acessibilidade (WCAG 2.2 AA) nos dois temas e em 360, 768 e 1280 px, e sem rolagem lateral.
 */

async function prepare(page: Page, theme: 'light' | 'dark') {
  await skipDemoTour(page);
  await page.addInitScript(
    (entries) => {
      for (const [key, value] of entries) window.localStorage.setItem(key, value);
    },
    [
      ['verax.mock.role', 'admin_cliente'],
      ['verax.theme', theme],
    ] as [string, string][],
  );
}

async function violations(page: Page): Promise<string[]> {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return typeof end !== 'number' || !Number.isFinite(end) || animation.playState !== 'running';
    }),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const noHorizontalScroll = async (page: Page, label: string) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    label,
  ).toBeLessThanOrEqual(1);

test.describe('exceção nova resolve os alertas em aberto (modo mock)', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [360, 768, 1280] as const) {
      test(`a prévia e o resultado na tela Exceções (${theme === 'light' ? 'claro' : 'escuro'}, ${width} px)`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        await prepare(page, theme);
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/cadastros/excecoes');
        await page.getByRole('button', { name: 'Nova exceção' }).click();
        const sheet = page.getByRole('dialog', { name: 'Nova exceção' });
        // O alerta novo da demonstração da regra 80253, do usuário root (fora de incidente).
        await sheet.getByLabel(/^Regra/).fill('80253');
        await sheet.getByLabel(/^Valor/).fill('root');
        await expect(sheet.getByText(/^Vai resolver \d+ alertas? em aberto/)).toBeVisible();
        await sheet.getByLabel('Motivo (obrigatório)').fill('Acesso de manutenção conhecido.');
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'prévia');

        await sheet.getByRole('button', { name: 'Criar exceção' }).click();
        await expect(sheet.getByRole('status')).toContainText(/alertas? em aberto resolvidos?/);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'resultado');
        await sheet.getByRole('button', { name: 'Concluir' }).click();
        await expect(sheet).toBeHidden();
      });
    }
  }

  test('o alerta em incidente fica: a prévia diz quantos ficam', async ({ page }) => {
    await prepare(page, 'light');
    await page.goto('/cadastros/excecoes');
    await page.getByRole('button', { name: 'Nova exceção' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nova exceção' });
    // Os alertas do deploy-bot na regra 80256 estão no incidente da chave comprometida.
    await sheet.getByLabel(/^Regra/).fill('80256');
    await sheet.getByLabel(/^Valor/).fill('deploy-bot');
    await expect(sheet.getByText(/em incidente\)\.$/)).toBeVisible();
  });
});
