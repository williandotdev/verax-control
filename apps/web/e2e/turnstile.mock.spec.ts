import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Cloudflare Turnstile no login e no "esqueci minha senha", sobre a API simulada (`dev:mock`) e com o widget de
 * verdade, carregado de challenges.cloudflare.com com as chaves de site de teste da Cloudflare: uma que sempre passa
 * (o token vai no header `X-Turnstile-Token`) e uma que sempre bloqueia (o estado de erro aparece e nada é enviado).
 * O mock devolve a chave em `GET /v1/auth/client-config` e, com ela, exige o header, como a API.
 */

const PASS_KEY = '1x00000000000000000000AA';
const BLOCK_KEY = '2x00000000000000000000AB';

async function withSiteKey(page: Page, siteKey: string): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('verax.mock.turnstile', value), siteKey);
}

/**
 * O widget que a Cloudflare desenha dentro do contêiner do painel. O iframe fica numa shadow root fechada, fora do
 * alcance dos localizadores: o que dá para ver é o elemento que a hospeda, com o tamanho do widget.
 */
const widget = (page: Page) => page.locator('[data-turnstile] > *').first();

/** O elemento com o foco está dentro do contêiner do widget (a shadow root fechada esconde o iframe em si). */
const focusInsideWidget = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest('[data-turnstile]') !== null);

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test.describe('Turnstile (modo mock, chaves de teste da Cloudflare)', () => {
  test.beforeEach(async ({ page }) => {
    await skipDemoTour(page);
  });

  test('chave que sempre passa: widget no login e no "esqueci a senha", e o token no header dos dois', async ({
    page,
  }) => {
    await withSiteKey(page, PASS_KEY);
    await page.goto('/login');
    await expect(widget(page)).toBeVisible();
    await expect(page.getByText('Carregando verificação…')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    await page.getByLabel('E-mail').fill('analista@demo.verax.local');
    await page.getByLabel('Senha', { exact: true }).fill('senha-de-demonstracao');
    const entrar = page.getByRole('button', { name: 'Entrar' });
    // O botão só liga quando o token chega.
    await expect(entrar).toBeEnabled();
    const signIn = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/v1/auth/sign-in/email'),
    );
    await entrar.click();
    expect((await signIn).headers()['x-turnstile-token']).toBeTruthy();
    // O mock, como a API, recusa o login sem o header: chegar ao código prova que ele foi.
    await expect(page).toHaveURL(/\/login\/codigo$/);

    await page.goto('/esqueci-senha');
    await expect(widget(page)).toBeVisible();
    await page.getByLabel('E-mail').fill('analista@demo.verax.local');
    const enviar = page.getByRole('button', { name: 'Enviar link' });
    await expect(enviar).toBeEnabled();
    const reset = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/v1/auth/request-password-reset'),
    );
    await enviar.click();
    expect((await reset).headers()['x-turnstile-token']).toBeTruthy();
    await expect(page.getByRole('status')).toContainText('você vai receber um link');
  });

  test('chave que sempre bloqueia: o estado de erro aparece e o envio fica desligado', async ({ page }) => {
    await withSiteKey(page, BLOCK_KEY);
    await page.goto('/login');
    await expect(page.getByRole('alert')).toContainText('A verificação de segurança não pôde ser concluída');
    await page.getByLabel('E-mail').fill('analista@demo.verax.local');
    await page.getByLabel('Senha', { exact: true }).fill('senha-de-demonstracao');
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeDisabled();
    expect(await violations(page)).toEqual([]);
  });

  test('tema escuro: o widget acompanha, sem violação de acessibilidade', async ({ page }) => {
    await withSiteKey(page, PASS_KEY);
    await page.addInitScript(() => window.localStorage.setItem('verax.theme', 'dark'));
    await page.goto('/login');
    await expect(widget(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await violations(page)).toEqual([]);
    // O teclado passa pelo formulário e chega ao widget (a Cloudflare recebe o foco), sem pular nem prender.
    await page.getByLabel('Senha', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect.poll(() => focusInsideWidget(page)).toBe(true);
  });
});
