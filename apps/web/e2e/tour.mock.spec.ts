import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { setTourProgress, skipDemoTour, TOUR_STORAGE_KEY } from './demo-tour';

/**
 * Tour guiado da demonstração (`dev:mock`): abre sozinho na primeira entrada no painel, percorre as telas com o alvo
 * de cada passo em destaque, é acessível nos dois temas, cabe no celular e reabre pelo botão da faixa.
 */

const card = (page: Page) => page.locator('[data-tour-card]');
const backdrop = (page: Page) => page.locator('[data-tour-backdrop]');

/** O cartão do passo já posicionado, visível e com o foco. Devolve o número do passo e o total. */
async function currentStep(page: Page): Promise<[number, number]> {
  await expect(card(page)).not.toHaveAttribute('data-placement', 'pendente');
  await expect(card(page)).toHaveCSS('opacity', '1');
  await expect(card(page)).toBeFocused();
  const text =
    (await card(page)
      .getByText(/^Passo \d+ de \d+$/)
      .textContent()) ?? '';
  const [, step = '0', total = '0'] = /Passo (\d+) de (\d+)/.exec(text) ?? [];
  return [Number(step), Number(total)];
}

/** Percorre o tour do passo atual até "Concluir", chamando `check` em cada passo. Devolve os passos vistos. */
async function walkTour(
  page: Page,
  check: (step: number, total: number) => Promise<void> = async () => {},
): Promise<number[]> {
  const seen: number[] = [];
  for (;;) {
    const [step, total] = await currentStep(page);
    seen.push(step);
    await check(step, total);
    if (step === total) {
      await card(page).getByRole('button', { name: 'Concluir' }).click();
      break;
    }
    await card(page).getByRole('button', { name: 'Próximo' }).click();
    await expect(card(page).getByText(`Passo ${step + 1} de ${total}`)).toBeVisible();
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(backdrop(page)).toHaveCount(0);
  return seen;
}

/** Erros de página e do console (fora as respostas de erro da API simulada, que fazem parte dos fluxos). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      errors.push(message.text());
    }
  });
  return errors;
}

async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .include('[data-tour-card]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test.describe('tour guiado (modo mock)', () => {
  test('login na demonstração: o tour abre sozinho na Torre e vai até "Concluir" sem erro', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.goto('/login');
    await page.getByLabel('E-mail').fill('analista@demo.verax.local');
    await page.getByLabel('Senha', { exact: true }).fill('senha-de-demonstracao');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByLabel('Código do aplicativo').fill('123456');
    await page.getByRole('button', { name: 'Verificar' }).click();

    await expect(page).toHaveURL(/\/$/);
    const dialog = page.getByRole('dialog', { name: 'Torre: está tudo bem?' });
    await expect(dialog).toBeVisible();
    // A analista do cliente não vê as telas da Verax nem as de administração: o tour dela é mais curto.
    await expect(dialog.getByText('Passo 1 de 14')).toBeVisible();

    const seen = await walkTour(page);
    expect(seen).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
    expect(await page.evaluate((key) => window.localStorage.getItem(key), TOUR_STORAGE_KEY)).toBe(
      JSON.stringify({ seen: true, open: false, step: null }),
    );
    expect(errors).toEqual([]);
  });

  test('admin da Verax: cada um dos 18 passos destaca o alvo na tela dele, sem <style> injetado', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await page.goto('/');
    const seen = await walkTour(page, async (step, total) => {
      if (step < total) {
        await expect(backdrop(page), `passo ${step}`).toHaveAttribute('data-spotlight', 'sim');
        await expect(card(page), `passo ${step}`).not.toHaveAttribute('data-placement', 'center');
      } else {
        // O convite final fica no centro, sem destaque, com o link do site.
        await expect(card(page)).toHaveAttribute('data-placement', 'center');
        await expect(card(page).getByRole('link', { name: /veraxsistemas\.com\.br/ })).toHaveAttribute(
          'href',
          'https://veraxsistemas.com.br',
        );
      }
      // CSP de produção (style-src 'self'): nada de <style> na página além do CSS do próprio Vite em desenvolvimento.
      await expect(page.locator('style:not([data-vite-dev-id])')).toHaveCount(0);
    });
    expect(seen).toHaveLength(18);
    expect(errors).toEqual([]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`acessibilidade do cartão no tema ${theme === 'light' ? 'claro' : 'escuro'}`, async ({ page }) => {
      await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
      await page.goto('/');
      await currentStep(page);
      expect(await axeViolations(page)).toEqual([]);

      // O último passo (com o link do site).
      await setTourProgress(page, { seen: false, open: true, step: 'fim' });
      await page.reload();
      const [step, total] = await currentStep(page);
      expect(step).toBe(total);
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test('celular: nenhum passo faz a página rolar para o lado, e o cartão cabe na largura', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/');
    await walkTour(page, async (step) => {
      const layout = await page.evaluate(() => {
        const box = document.querySelector('[data-tour-card]')?.getBoundingClientRect();
        return {
          extra: document.documentElement.scrollWidth - window.innerWidth,
          left: box?.left ?? -1,
          right: box?.right ?? Number.POSITIVE_INFINITY,
          width: window.innerWidth,
        };
      });
      expect(layout.extra, `passo ${step}`).toBeLessThanOrEqual(1);
      expect(layout.left, `passo ${step}`).toBeGreaterThanOrEqual(0);
      expect(layout.right, `passo ${step}`).toBeLessThanOrEqual(layout.width);
    });
  });

  test('"Fazer o tour" na faixa reabre o tour; Esc encerra e o foco volta ao botão', async ({ page }) => {
    await skipDemoTour(page);
    await page.goto('/');
    const launcher = page.getByRole('note').getByRole('button', { name: 'Fazer o tour' });
    await expect(launcher).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await launcher.click();
    expect(await currentStep(page)).toEqual([1, 18]);
    await card(page).getByRole('button', { name: 'Próximo' }).click();
    expect(await currentStep(page)).toEqual([2, 18]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(launcher).toBeFocused();

    // Retoma de onde parou.
    await launcher.click();
    expect(await currentStep(page)).toEqual([2, 18]);
    await card(page).getByRole('button', { name: 'Pular' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
