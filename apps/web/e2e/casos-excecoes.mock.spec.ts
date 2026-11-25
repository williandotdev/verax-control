import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Exceções a partir de um caso (casos, PR-9), sobre a demonstração (`dev:mock`): o diálogo "Criar exceção" no detalhe do
 * caso (as de usuário, IP ou recurso em lote e a ampla, com a prévia antes de salvar) e a seção das amplas na tela
 * Exceções, sem violação de acessibilidade (WCAG 2.2 AA) nos dois temas e em 360, 768 e 1280 px. Com os casos desligados,
 * a tela Exceções é a de sempre, sem pedido a mais.
 */

async function prepare(page: Page, role: string, theme?: 'light' | 'dark', cases?: 'off' | 'on') {
  await skipDemoTour(page);
  await page.addInitScript(
    (entries) => {
      for (const [key, value] of entries) if (value) window.localStorage.setItem(key, value);
    },
    [
      ['verax.mock.role', role],
      ['verax.theme', theme ?? ''],
      ['verax.mock.cases', cases ?? ''],
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

/** Abre o caso das chamadas negadas (regra 80202, três usuários e três IPs) e o diálogo da exceção. */
async function openExceptionDialog(page: Page): Promise<Locator> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Detecções' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: /^Abrir o caso: Chamadas negadas/ }).click();
  await page.getByRole('button', { name: 'Criar exceção', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Criar exceção a partir do caso' });
  await expect(dialog.getByRole('group', { name: 'Tipo de exceção' })).toBeVisible();
  return dialog;
}

/** Navega dentro do painel (o estado da API simulada fica). */
async function goInside(page: Page, path: string) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test.describe('exceções a partir de um caso (modo mock): acessibilidade', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [360, 768, 1280] as const) {
      test(`o diálogo, a prévia e a seção das amplas (${theme === 'light' ? 'claro' : 'escuro'}, ${width} px)`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        await prepare(page, 'admin_cliente', theme);
        await page.setViewportSize({ width, height: 900 });
        const dialog = await openExceptionDialog(page);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'diálogo');
        await dialog.getByRole('radio', { name: /^Exceção ampla/ }).check();
        await dialog.getByRole('button', { name: 'Ver prévia' }).click();
        await expect(dialog.getByText(/^Teria coberto \d+ alertas? nos últimos 30 dias/)).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'prévia');
        await dialog
          .getByRole('textbox', { name: 'Motivo (obrigatório)' })
          .fill('Listagem do inventário noturno');
        await dialog.getByRole('button', { name: 'Salvar exceção ampla' }).click();
        await expect(dialog.getByRole('status')).toHaveText(/^Exceção ampla criada/);
        await dialog.getByRole('button', { name: 'Fechar', exact: true }).last().click();

        await goInside(page, '/cadastros/excecoes');
        const section = page.getByRole('region', { name: 'Exceções amplas' });
        await expect(section.getByRole('table', { name: 'Exceções amplas do cliente' })).toBeVisible();
        await expect(section.getByText('Listagem do inventário noturno')).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'tela Exceções');
      });
    }
  }
});

test.describe('exceções a partir de um caso (modo mock): os fluxos', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('o analista cria as de IP em lote, e não vê a ampla', async ({ page }) => {
    await prepare(page, 'analista_cliente');
    const dialog = await openExceptionDialog(page);
    await expect(dialog.getByRole('radio', { name: /^Exceção ampla/ })).toHaveCount(0);
    await dialog.getByRole('radio', { name: /^Por ip ou faixa \(3 valores\)/ }).check();
    await expect(dialog.getByText('198.51.100.200', { exact: true })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Motivo (obrigatório)' }).fill('Rede do escritório');
    await dialog.getByRole('button', { name: 'Criar 3 exceções' }).click();
    await expect(dialog.getByRole('status')).toHaveText('3 exceções criadas.');
  });

  test('a ampla só salva depois da prévia dos valores de agora; revogar na tela Exceções', async ({
    page,
  }) => {
    await prepare(page, 'admin_cliente');
    const dialog = await openExceptionDialog(page);
    await dialog.getByRole('radio', { name: /^Exceção ampla/ }).check();
    const save = dialog.getByRole('button', { name: 'Salvar exceção ampla' });
    await expect(save).toBeDisabled();
    await dialog.getByRole('button', { name: 'Ver prévia' }).click();
    await expect(save).toBeEnabled();
    // Mudou o alvo: a prévia não vale mais.
    await dialog.getByRole('combobox', { name: 'Severidade' }).selectOption('high');
    await expect(save).toBeDisabled();
    await dialog.getByRole('button', { name: 'Ver prévia' }).click();
    await expect(save).toBeEnabled();
    // Sem motivo, não salva.
    await save.click();
    await expect(dialog.getByText(/caracteres|obrigatório|Too small|pelo menos/i).first()).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Motivo (obrigatório)' }).fill('Robô de inventário');
    await save.click();
    await expect(dialog.getByRole('status')).toHaveText(/^Exceção ampla criada/);
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).last().click();

    await goInside(page, '/cadastros/excecoes');
    const section = page.getByRole('region', { name: 'Exceções amplas' });
    const row = section.getByRole('row', { name: /Robô de inventário/ });
    await expect(row).toContainText('Até alta');
    await row.getByRole('button', { name: 'Revogar a exceção ampla da regra 80202' }).click();
    await row.getByRole('button', { name: 'Confirmar' }).click();
    await expect(row).toContainText(/Revogada em/);
  });

  test('somente leitura não vê o botão no caso', async ({ page }) => {
    await prepare(page, 'leitura');
    await page.goto('/');
    await page.getByRole('button', { name: /^Abrir o caso: Chamadas negadas/ }).click();
    await expect(page.getByRole('heading', { name: 'O que os alertas têm em comum' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Criar exceção', exact: true })).toHaveCount(0);
  });

  test('casos desligados: a tela Exceções é a de sempre, sem pedir as amplas', async ({ page }) => {
    await prepare(page, 'admin_cliente', undefined, 'off');
    const asked: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/v1/scoped-exceptions')) asked.push(request.url());
    });
    await page.goto('/cadastros/excecoes');
    await expect(page.getByRole('heading', { level: 1, name: 'Exceções' })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Exceções amplas' })).toHaveCount(0);
    expect(asked).toEqual([]);
  });
});
