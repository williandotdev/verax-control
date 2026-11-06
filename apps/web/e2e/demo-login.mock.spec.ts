import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Login da demonstração (`dev:mock`): abre fora da sessão, os botões preenchem o acesso e o código de exemplo (sem
 * enviar), quem entra vê o painel do admin da Verax com o primeiro cliente, e sair e entrar de novo funciona sem
 * recarregar. Estes testes começam sem nada guardado, como a primeira visita (o projeto `mock` abre a sessão para os
 * outros, no `playwright.config.ts`).
 */
test.use({ storageState: { cookies: [], origins: [] } });

const ALFA = '018f2c1e-0000-7000-8000-00000000a1fa';

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

/** Erros de página e do console (fora as respostas de erro da API simulada, como o 401 de quem ainda não entrou). */
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

/** Entra como quem visita: os dois botões de preencher e o teclado no botão que recebeu o foco. */
async function signInWithDemoAccess(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Preencher acesso de demonstração' }).click();
  await expect(page.getByLabel('E-mail')).toHaveValue('analista@demo.verax.local');
  await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('senha-de-demonstracao');
  // Preenche, mas não envia: o foco vai para o "Entrar".
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/login\/codigo$/);
  await page.getByRole('button', { name: 'Preencher código de demonstração' }).click();
  await expect(page.getByLabel('Código do aplicativo')).toHaveValue('123456');
  await expect(page).toHaveURL(/\/login\/codigo$/);
  await expect(page.getByRole('button', { name: 'Verificar' })).toBeFocused();
  await page.keyboard.press('Enter');
}

/** O painel aberto na Torre, como o admin da Verax, com o primeiro cliente selecionado. */
async function expectAdminPanel(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Torre' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByRole('banner').getByText('Administrador Verax')).toBeVisible();
  await expect(page.getByLabel('Cliente')).toHaveValue(ALFA);
}

/** "Fazer o tour" na faixa da demonstração abre o tour; Esc fecha. */
async function expectTourLauncherWorks(page: Page): Promise<void> {
  await page.getByRole('note').getByRole('button', { name: 'Fazer o tour' }).click();
  await expect(page.locator('[data-tour-card]').getByText(/^Passo \d+ de 19$/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.describe('login da demonstração (modo mock)', () => {
  test('abre fora da sessão: o painel leva ao login, com o formulário vazio e o acesso de exemplo', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
    await expect(page.getByLabel('E-mail')).toHaveValue('');
    await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('');
    const hint = page.getByRole('note').filter({ hasText: 'Acesso de demonstração' });
    await expect(hint).toContainText('senha-temporaria-demonstracao');
    await expect(hint.getByRole('button', { name: 'Preencher acesso de demonstração' })).toBeVisible();
  });

  test('preencher e entrar abre o painel do admin da Verax; recarregar mantém; sair e entrar de novo sem recarregar', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const errors = collectErrors(page);
    await skipDemoTour(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);

    // No código de recuperação o botão sai (ele preenche o código do aplicativo).
    await page.getByRole('button', { name: 'Preencher acesso de demonstração' }).click();
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByRole('button', { name: /usar código de recuperação/ }).click();
    await expect(page.getByRole('button', { name: 'Preencher código de demonstração' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Voltar ao login' }).click();

    await signInWithDemoAccess(page);
    await expectAdminPanel(page);
    await expectTourLauncherWorks(page);

    // Recarregar a página não tira ninguém do painel (como o cookie de sessão do painel real).
    await page.reload();
    await expectAdminPanel(page);

    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('E-mail')).toHaveValue('');
    // Entra de novo sem recarregar, e o tour continua ao alcance.
    await signInWithDemoAccess(page);
    await expectAdminPanel(page);
    await expectTourLauncherWorks(page);

    // Depois de sair, recarregar continua fora.
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    expect(errors).toEqual([]);
  });

  test('primeira visita: depois do login, o tour do admin da Verax abre sozinho na Torre', async ({
    page,
  }) => {
    await page.goto('/login');
    await signInWithDemoAccess(page);
    const dialog = page.getByRole('dialog', { name: 'Torre: está tudo bem?' });
    await expect(dialog.getByText('Passo 1 de 19')).toBeVisible();
    await dialog.getByRole('button', { name: 'Pular' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectAdminPanel(page);
  });

  test('primeiro acesso com a senha temporária: troca da senha, cadastro do MFA e o painel', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await skipDemoTour(page);
    await page.goto('/login');
    await page.getByLabel('E-mail').fill('analista@demo.verax.local');
    await page.getByLabel('Senha', { exact: true }).fill('senha-temporaria-demonstracao');
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page).toHaveURL(/\/trocar-senha$/);
    const password = `nova-${randomUUID()}`;
    await page.getByLabel('Senha temporária', { exact: true }).fill('senha-temporaria-demonstracao');
    await page.getByLabel('Nova senha', { exact: true }).fill(password);
    await page.getByLabel('Confirme a nova senha', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Salvar e continuar' }).click();

    await expect(page).toHaveURL(/\/mfa\/cadastro$/);
    await page.getByLabel('Senha', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('img', { name: 'QR code para o aplicativo autenticador' })).toBeVisible();
    await page.getByLabel('Código do aplicativo').fill('123456');
    await page.getByLabel('Guardei os códigos em local seguro').check();
    await page.getByRole('button', { name: 'Ativar e entrar' }).click();
    await expectAdminPanel(page);
  });

  // Nos dois temas, com o aviso do preenchimento na página (a região de status ganha texto).
  for (const theme of ['light', 'dark'] as const) {
    test(`login e código com o acesso de demonstração (${theme === 'light' ? 'claro' : 'escuro'}): sem violação de acessibilidade`, async ({
      page,
    }) => {
      await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
      await page.goto('/login');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const fill = page.getByRole('button', { name: 'Preencher acesso de demonstração' });
      await expect(fill).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await fill.click();
      await expect(page.getByRole('status')).toHaveText(/E-mail e senha de demonstração preenchidos/);
      expect(await violations(page)).toEqual([]);

      await page.getByRole('button', { name: 'Entrar' }).click();
      const fillCode = page.getByRole('button', { name: 'Preencher código de demonstração' });
      await expect(fillCode).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await fillCode.click();
      await expect(page.getByRole('status')).toHaveText(/Código de demonstração preenchido/);
      expect(await violations(page)).toEqual([]);
    });
  }

  test('celular: o login e o código com o acesso de demonstração cabem na largura', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.goto('/login');
    const fill = page.getByRole('button', { name: 'Preencher acesso de demonstração' });
    await expect(fill).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);
    await fill.click();
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('button', { name: 'Preencher código de demonstração' })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(1);
  });
});
