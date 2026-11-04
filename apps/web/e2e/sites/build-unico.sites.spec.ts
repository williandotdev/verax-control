import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { LOOKALIKE_HOST, PORT } from './sites';

/**
 * Build único: o mesmo `dist` servido em dois sites de cliente (setup global). Cada site deriva a API do próprio
 * endereço e recebe a CSP que libera só ela; fora de um endereço de cliente, o painel não chama nada.
 */

const site = (tenant: string) => ({
  url: `http://${tenant}.control.veraxsistemas.com.br:${PORT}/`,
  api: `https://api-${tenant}.veraxsistemas.com.br`,
});
const A = site('cliente-demo-a');
const B = site('cliente-demo-b');

/** API de qualquer cliente, interceptada antes da rede. */
const ANY_TENANT_API = /^https:\/\/api-[a-z0-9-]+\.veraxsistemas\.com\.br\//;

/**
 * Registra o tráfego da página para fora da origem do painel (e qualquer `/v1/` na própria origem, que seria a API com
 * endereço vazio) e responde pela API de qualquer cliente como a API real sem sessão: 401, com o CORS que ela manda
 * para a origem do painel.
 */
async function watch(page: Page, panelOrigin: string): Promise<{ external: string[]; api: string[] }> {
  const external: string[] = [];
  const api: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.protocol.startsWith('http')) return;
    if (url.origin !== panelOrigin || url.pathname.startsWith('/v1/')) external.push(request.url());
  });
  await page.route(ANY_TENANT_API, async (route) => {
    api.push(route.request().url());
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': (await route.request().headerValue('origin')) ?? '',
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
      },
      body: JSON.stringify({ message: 'Sessão ausente ou expirada', code: 'UNAUTHENTICATED' }),
    });
  });
  return { external, api };
}

/** Fontes de uma diretiva da CSP. */
function directive(csp: string, name: string): string[] {
  const found = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([first]) => first === name);
  return found?.slice(1) ?? [];
}

async function openSite(browser: Browser, target: typeof A) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const traffic = await watch(page, new URL(target.url).origin);
  const response = await page.goto(target.url);
  if (!response) throw new Error('sem resposta do painel');
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  const html = await response.text();
  const entry = /<script[^>]* src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? '';
  const script = await page.evaluate(async (path) => (await fetch(path)).text(), entry);
  return { context, traffic, html, script, csp: response.headers()['content-security-policy'] ?? '' };
}

test('o mesmo dist serve os dois sites: cada um chama só a própria API e recebe a CSP com ela', async ({
  browser,
}) => {
  const a = await openSite(browser, A);
  const b = await openSite(browser, B);

  for (const [opened, target] of [
    [a, A],
    [b, B],
  ] as const) {
    expect(directive(opened.csp, 'connect-src')).toEqual(["'self'", target.api]);
    expect(opened.traffic.api).toContain(`${target.api}/v1/me`);
    expect(opened.traffic.external.filter((url) => !url.startsWith(`${target.api}/`))).toEqual([]);
  }

  // Mesmos bytes (o HTML e o JavaScript de entrada), CSPs diferentes. O bundle traz o modelo, e não a API de um cliente.
  expect(a.html).toBe(b.html);
  expect(a.script).toBe(b.script);
  expect(a.script).toContain('https://api-{tenant}.veraxsistemas.com.br');
  expect(a.script).not.toContain(A.api);
  expect(a.csp).not.toBe(b.csp);

  await Promise.all([a.context.close(), b.context.close()]);
});

test('a CSP do site de um cliente barra a API de outro cliente', async ({ page }) => {
  const traffic = await watch(page, new URL(A.url).origin);
  await page.goto(A.url);
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();

  const violated = await page.evaluate(async (url) => {
    const violation = new Promise<string>((done) => {
      document.addEventListener('securitypolicyviolation', (event) => done(event.effectiveDirective), {
        once: true,
      });
    });
    const none = new Promise<string>((done) => setTimeout(() => done('nenhuma'), 5_000));
    await fetch(url, { credentials: 'include' }).catch(() => undefined);
    return Promise.race([violation, none]);
  }, `${B.api}/v1/me`);

  expect(violated).toBe('connect-src');
  expect(traffic.api.filter((url) => url.startsWith(`${B.api}/`))).toEqual([]);
});

for (const [name, url] of [
  ['localhost', `http://localhost:${PORT}/`],
  ['domínio parecido com o de um cliente', `http://${LOOKALIKE_HOST}:${PORT}/`],
] as const) {
  test(`fora do endereço de um cliente (${name}): só o aviso, nenhuma chamada`, async ({ page }) => {
    const traffic = await watch(page, new URL(url).origin);
    const response = await page.goto(url);
    // Servido sem os cabeçalhos da Verax, como o bundle copiado para outro lugar: não há CSP para barrar chamadas, e
    // mesmo assim o painel não chama API nenhuma.
    expect(response?.headers()['content-security-policy']).toBeUndefined();
    await expect(page.getByRole('heading', { name: 'Endereço não reconhecido' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(traffic.external).toEqual([]);
    expect(traffic.api).toEqual([]);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`)).toEqual([]);
  });
}
