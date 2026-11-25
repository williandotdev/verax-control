import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * "Conectar com Cloudflare" (OAuth) no navegador, sobre a demonstração (`dev:mock`, `src/mocks/cloudflare-oauth.ts`). O
 * Cloudflare é de mentira: a navegação para a autorização é interceptada aqui e devolvida ao painel como o repasse da
 * Verax faz, com `code`, `state` e `iss` no fragmento de `/conexao-cloudflare`. Cobre o retorno com sucesso, recusa,
 * prazo vencido, `state` errado e repetição; a escolha de contas pelo teclado; a migração do token colado; o nó anterior
 * (a tela de antes); e a acessibilidade (WCAG 2.2 AA) nos dois temas, em 360, 768 e 1280 px.
 */

/** A conta do Cloudflare da Alfa na demonstração (`account(5, ...)` em mocks/admin.ts), com token colado. */
const ALFA_CLOUDFLARE = '018f2c1e-0000-7000-8000-0000000c0005';
const ALFA_CLOUDFLARE_ID = 'd0e0000000000000000000000000a1fa';
const ISSUER = 'https://dash.cloudflare.com';
/** Código de autorização fictício: o "Cloudflare" daqui não confere nada. */
const DEMO_CODE = 'codigo-de-demonstracao-0001';
const ANOTHER_STATE = `alfa.${'A'.repeat(43)}`;

type Scenario = 'one' | 'multi' | 'manual' | 'legacy' | 'off';

async function setup(
  page: Page,
  options: { scenario: Scenario; expire?: 'return' | 'choosing'; theme?: 'light' | 'dark' },
) {
  await page.addInitScript(
    ([scenario, expire, theme]) => {
      window.localStorage.setItem('verax.mock.role', 'admin_cliente');
      window.localStorage.setItem('verax.theme', theme);
      window.localStorage.setItem('verax.mock.cloudflare-oauth', scenario);
      if (expire) window.localStorage.setItem('verax.mock.cloudflare-oauth.expire', expire);
      else window.localStorage.removeItem('verax.mock.cloudflare-oauth.expire');
    },
    [options.scenario, options.expire ?? '', options.theme ?? 'light'] as const,
  );
  await skipDemoTour(page);
}

/**
 * O Cloudflare de mentira: a autorização devolve o navegador ao painel com o retorno no fragmento. Guarda o último
 * fragmento entregue, para o teste de repetição.
 */
async function fakeCloudflare(
  page: Page,
  answer: { deny?: boolean; state?: string; iss?: string } = {},
): Promise<{ last: () => string }> {
  let last = '';
  await page.route('https://dash.cloudflare.com/**', async (route) => {
    const request = new URL(route.request().url());
    const origin = new URL(page.url()).origin;
    const state = answer.state ?? request.searchParams.get('state') ?? '';
    const fragment = new URLSearchParams(
      answer.deny ? { error: 'access_denied', state } : { code: DEMO_CODE, state, iss: answer.iss ?? ISSUER },
    ).toString();
    last = fragment;
    await route.fulfill({ status: 302, headers: { location: `${origin}/conexao-cloudflare#${fragment}` } });
  });
  return { last: () => last };
}

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

/** O retorno foi tratado: nem código, nem `state` na barra de endereço. */
async function expectCleanUrl(page: Page) {
  await expect(page).toHaveURL((url) => url.pathname === '/conexao-cloudflare' && url.hash === '');
  expect(page.url()).not.toContain(DEMO_CODE);
  expect(page.url()).not.toContain('state');
}

async function connectFromAccounts(page: Page) {
  await page.goto('/cadastros/contas');
  await page.getByRole('button', { name: 'Conectar com Cloudflare' }).click();
}

test.describe('Conectar com Cloudflare (modo mock)', () => {
  test('retorno com sucesso: a conta nova é ligada, a URL fica limpa e a repetição é recusada', async ({
    page,
  }) => {
    await setup(page, { scenario: 'one' });
    const cloudflare = await fakeCloudflare(page);
    await connectFromAccounts(page);

    const done = page.getByRole('status').filter({ hasText: 'Conta conectada.' });
    await expect(done).toBeVisible();
    await expect(done).toBeFocused();
    await expectCleanUrl(page);
    await expect(page).toHaveURL(/\?tentativa=[0-9a-f-]{36}$/);

    // Recarregar acompanha a mesma tentativa, sem mandar nada de novo.
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'Conta conectada.' })).toBeVisible();

    // O mesmo retorno de novo (histórico, link copiado): a mesma recusa de sempre, e a URL limpa outra vez.
    await page.goto(`/conexao-cloudflare#${cloudflare.last()}`);
    await expect(page.getByRole('alert')).toContainText('já foi usado');
    await expectCleanUrl(page);
  });

  test('recusa no Cloudflare: a explicação e o começar de novo', async ({ page }) => {
    await setup(page, { scenario: 'one' });
    await fakeCloudflare(page, { deny: true });
    await connectFromAccounts(page);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('A autorização não foi dada no Cloudflare');
    await expect(alert).toBeFocused();
    await expect(page.getByRole('button', { name: 'Começar de novo' })).toBeVisible();
    await expectCleanUrl(page);
  });

  test('prazo vencido no retorno e na escolha', async ({ page }) => {
    await setup(page, { scenario: 'multi', expire: 'return' });
    await fakeCloudflare(page);
    await connectFromAccounts(page);
    await expect(page.getByRole('alert')).toContainText('venceu');
    await expectCleanUrl(page);

    await page.addInitScript(() =>
      window.localStorage.setItem('verax.mock.cloudflare-oauth.expire', 'choosing'),
    );
    await connectFromAccounts(page);
    await expect(page.getByRole('alert')).toContainText('O prazo para concluir a conexão terminou');
  });

  test('state de outra tentativa e emissor errado: a mesma recusa', async ({ page }) => {
    await setup(page, { scenario: 'one' });
    await fakeCloudflare(page, { state: ANOTHER_STATE });
    await connectFromAccounts(page);
    await expect(page.getByRole('alert')).toContainText('não é desta sessão');
    await expectCleanUrl(page);

    await page.unrouteAll();
    await fakeCloudflare(page, { iss: 'https://outro-emissor.example' });
    await connectFromAccounts(page);
    await expect(page.getByRole('alert')).toContainText('não é desta sessão');
  });

  test('retorno alterado (campo a mais) é descartado sem chamar a API', async ({ page }) => {
    await setup(page, { scenario: 'one' });
    const calls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/v1/cloudflare-oauth/complete')) calls.push(request.url());
    });
    await page.goto(`/conexao-cloudflare#code=${DEMO_CODE}&state=${ANOTHER_STATE}&iss=x&extra=1`);
    await expect(page.getByRole('alert')).toContainText('incompleto ou alterado');
    await expectCleanUrl(page);
    expect(calls).toEqual([]);
  });

  test('escolha das contas pelo teclado, com o nome do Cloudflare como texto', async ({ page }) => {
    await setup(page, { scenario: 'multi' });
    await fakeCloudflare(page);
    await connectFromAccounts(page);
    const heading = page.getByRole('heading', { name: 'Escolha as contas a monitorar' });
    await expect(heading).toBeFocused();
    // A marcação no nome vem do Cloudflare e aparece como texto, nunca como HTML.
    await expect(page.getByText('<b>Cliente Demo B</b> & Cia')).toBeVisible();
    await expect(page.locator('form b')).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /Conta sem nome/ })).toBeDisabled();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('checkbox', { name: /Cliente Demo A/ })).toBeFocused();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Monitorar as contas escolhidas' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Conta conectada.' })).toBeFocused();
    await page.getByRole('link', { name: 'Ver a conta conectada' }).click();
    await expect(page.getByRole('dialog', { name: /c0ffee00000000000000000000000b01/ })).toBeVisible();
  });

  test('ID digitado quando o Cloudflare não lista as contas', async ({ page }) => {
    await setup(page, { scenario: 'manual' });
    await fakeCloudflare(page);
    await connectFromAccounts(page);
    const field = page.getByLabel('ID da conta do Cloudflare');
    await page.getByRole('button', { name: 'Monitorar as contas escolhidas' }).click();
    await expect(page.getByText('Informe o ID da conta')).toBeVisible();
    await field.fill('c0ffee00000000000000000000000c01');
    await page.getByRole('button', { name: 'Monitorar as contas escolhidas' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Conta conectada.' })).toBeVisible();
  });

  test('migração da conta com token colado: a coleta passa à autorização e o token sai', async ({ page }) => {
    await setup(page, { scenario: 'one' });
    await fakeCloudflare(page);
    await page.goto(`/cadastros/contas?conta=${ALFA_CLOUDFLARE}`);
    const sheet = page.getByRole('dialog', { name: `Conta do Cloudflare ${ALFA_CLOUDFLARE_ID}` });
    await expect(sheet).toContainText('Esta conta é lida com um token colado');
    await expect(sheet.getByRole('heading', { name: 'Zonas e auditoria' })).toBeVisible();
    await expect(sheet.getByText('antigo-alfa.example')).toBeVisible();
    await sheet.getByRole('button', { name: 'Migrar para Conectar com Cloudflare' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'apague-o também no Cloudflare' })).toBeVisible();
    await page.getByRole('link', { name: 'Ver a conta conectada' }).click();
    const after = page.getByRole('dialog', { name: `Conta do Cloudflare ${ALFA_CLOUDFLARE_ID}` });
    await expect(after.getByText('Autorizada', { exact: true })).toBeVisible();
    await expect(after).not.toContainText('lida com um token colado');
    // "Monitorar todas": a conta com lista ganha todas as zonas.
    await after.getByRole('button', { name: 'Monitorar todas as zonas' }).click();
    await expect(after.getByText('Monitorando todas as zonas da conta')).toBeVisible();
  });

  test('nó anterior ao OAuth: a tela de antes, sem o botão nem as zonas', async ({ page }) => {
    await setup(page, { scenario: 'legacy' });
    await page.goto(`/cadastros/contas?conta=${ALFA_CLOUDFLARE}`);
    const sheet = page.getByRole('dialog', { name: `Conta do Cloudflare ${ALFA_CLOUDFLARE_ID}` });
    await expect(sheet.getByRole('link', { name: /criar o token no Cloudflare/ })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Conectar com Cloudflare' })).toHaveCount(0);
    await expect(sheet.getByRole('heading', { name: 'Zonas e auditoria' })).toHaveCount(0);
    await expect(sheet).not.toContainText('Migrar');
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`acessibilidade (${theme === 'light' ? 'claro' : 'escuro'}) em 360, 768 e 1280 px`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await setup(page, { scenario: 'multi', theme });
      await fakeCloudflare(page);
      for (const width of [360, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/cadastros/contas?conta=${ALFA_CLOUDFLARE}`);
        const sheet = page.getByRole('dialog', { name: `Conta do Cloudflare ${ALFA_CLOUDFLARE_ID}` });
        await expect(sheet.getByRole('list', { name: 'Zonas da conta' })).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await violations(page), `detalhe da conta em ${width}px`).toEqual([]);

        await page.goto('/cadastros/contas');
        await page.getByRole('button', { name: 'Conectar com Cloudflare' }).click();
        await expect(page.getByRole('heading', { name: 'Escolha as contas a monitorar' })).toBeVisible();
        expect(await violations(page), `escolha das contas em ${width}px`).toEqual([]);
      }
    });
  }
});
