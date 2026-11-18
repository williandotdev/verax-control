import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { createFakeState, type FakeAdminState } from '../src/mocks/fake-admin-api';
import { FICTITIOUS_LOGIN_PHRASE, FICTITIOUS_TOTP_CODE } from '../src/mocks/fake-auth';
import { FICTITIOUS_OWNER } from '../src/mocks/fixtures';
import { mockAdminApi } from './mock-api';

/**
 * O Turnstile na entrada do console, no navegador, com a CSP do cp-admin (`vite preview`): o script e o frame vêm de
 * `https://challenges.cloudflare.com`, mas atendidos pelo `page.route` com um widget falso (nada sai para a rede). O
 * widget falso desenha um iframe da origem da Cloudflare, entrega um token novo a cada `render`/`reset` e, com a chave
 * que "bloqueia", chama o `error-callback`. A API do console é a simulada (`mock-api.ts`), que exige o header com a
 * chave do site ligada, como o cp-admin.
 */
const ALLOW_KEY = '1x00000000000000000000AA';
const BLOCK_KEY = '2x00000000000000000000AB';

const FAKE_WIDGET_SCRIPT = `
(() => {
  let serial = 0;
  const widgets = new Map();
  function issue(id) {
    const widget = widgets.get(id);
    if (!widget) return;
    if (widget.options.sitekey === '${BLOCK_KEY}') {
      setTimeout(() => widget.options['error-callback'] && widget.options['error-callback']('300030'), 50);
      return;
    }
    serial += 1;
    const token = 'token-e2e-' + serial;
    setTimeout(() => widget.options.callback && widget.options.callback(token), 50);
  }
  window.turnstile = {
    render(container, options) {
      const id = 'widget-' + (widgets.size + 1);
      const frame = document.createElement('iframe');
      frame.src = 'https://challenges.cloudflare.com/e2e-widget';
      frame.title = 'Widget do Cloudflare Turnstile';
      frame.style.width = '300px';
      frame.style.height = '65px';
      frame.style.border = '0';
      container.append(frame);
      widgets.set(id, { options });
      issue(id);
      return id;
    },
    reset(id) { issue(id); },
    remove(id) { widgets.delete(id); },
  };
  const onload = new URL(document.currentScript.src).searchParams.get('onload');
  if (onload && typeof window[onload] === 'function') window[onload]();
})();
`;

interface Watch {
  violations: string[];
  tokens: (string | undefined)[];
}

async function prepare(page: Page, state: FakeAdminState): Promise<Watch> {
  const watch: Watch = { violations: [], tokens: [] };
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) watch.violations.push(message.text());
  });
  page.on('pageerror', (error) => watch.violations.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/admin/login') {
      watch.tokens.push(request.headers()['x-turnstile-token']);
    }
  });
  await page.route('https://challenges.cloudflare.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/turnstile/v0/api.js') {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_WIDGET_SCRIPT });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html lang="pt-BR"><title>Verificação</title><body>ok</body></html>',
    });
  });
  await mockAdminApi(page, state);
  return watch;
}

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`);
}

async function fillCredentials(page: Page): Promise<void> {
  await page.getByLabel('Senha').fill(FICTITIOUS_LOGIN_PHRASE);
  await page.getByLabel('Código do aplicativo').fill(FICTITIOUS_TOTP_CODE);
}

test.describe('Turnstile na entrada do console (widget falso, CSP do cp-admin)', () => {
  test('ligado: o widget carrega sob a CSP, o "Entrar" espera o token, e cada envio leva um token novo no header', async ({
    page,
  }) => {
    const state = createFakeState({ loggedIn: false });
    state.auth.turnstileSiteKey = ALLOW_KEY;
    state.auth.turnstileRejects = true;
    const watch = await prepare(page, state);
    await page.goto('/entrar');
    await expect(page.getByRole('group', { name: 'Verificação de segurança' })).toBeVisible();
    await expect(page.locator('[data-turnstile] iframe')).toBeVisible();
    await page.getByLabel('E-mail').fill(FICTITIOUS_OWNER);
    await fillCredentials(page);
    const entrar = page.getByRole('button', { name: 'Entrar' });
    await expect(entrar).toBeEnabled();
    expect(await axe(page)).toEqual([]);

    // Recusado pelo "cp-admin": a mensagem genérica, e o widget pede outro token.
    await entrar.click();
    await expect(page.getByRole('alert')).toContainText('A verificação de segurança não foi aceita');
    state.auth.turnstileRejects = false;
    await fillCredentials(page);
    await expect(entrar).toBeEnabled();
    await entrar.click();
    await expect(page.getByTestId('usuario')).toHaveText(FICTITIOUS_OWNER);
    expect(watch.tokens).toEqual(['token-e2e-1', 'token-e2e-2']);
    expect(watch.violations).toEqual([]);
  });

  test('a Cloudflare bloqueia: o aviso aparece e o "Entrar" fica desligado', async ({ page }) => {
    const state = createFakeState({ loggedIn: false });
    state.auth.turnstileSiteKey = BLOCK_KEY;
    const watch = await prepare(page, state);
    await page.goto('/entrar');
    await expect(page.getByRole('alert')).toContainText('A verificação de segurança não pôde ser concluída');
    await page.getByLabel('E-mail').fill(FICTITIOUS_OWNER);
    await fillCredentials(page);
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeDisabled();
    expect(await axe(page)).toEqual([]);
    expect(watch.tokens).toEqual([]);
    expect(watch.violations).toEqual([]);
  });

  test('desligado: nada da Cloudflare é pedido, e a entrada segue como sempre', async ({ page }) => {
    const state = createFakeState({ loggedIn: false });
    const watch = await prepare(page, state);
    const cloudflare: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://challenges.cloudflare.com')) cloudflare.push(request.url());
    });
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(FICTITIOUS_OWNER);
    await fillCredentials(page);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByTestId('usuario')).toHaveText(FICTITIOUS_OWNER);
    expect(cloudflare).toEqual([]);
    expect(watch.tokens).toEqual([undefined]);
    expect(watch.violations).toEqual([]);
  });
});
