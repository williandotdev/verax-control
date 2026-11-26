import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * O mapa de origens no topo da tela Detecções, no navegador, sobre a demonstração (`dev:mock`): sem violação de
 * acessibilidade (WCAG 2.2 AA, inclusive contraste) nos dois temas, em 360, 768 e 1.280 px, em cada situação; sem rolagem
 * horizontal de 320 a 1.920 px; quem não tem o mapa vê a tela de sempre, sem nada pular; a lista não pula enquanto o mapa
 * carrega para quem o tem; e o desenho do mundo só é baixado com a faixa aberta.
 */

const FINDING = '018f2c1e-0000-7000-8000-000000001001';
const VIEWER_ID = 'demo-analista_cliente';
const CHOICE = `verax:deteccoes:origens:${VIEWER_ID}`;

async function prepare(page: Page, options: { traffic?: string; theme?: string; choice?: string } = {}) {
  await skipDemoTour(page);
  await page.addInitScript(
    ([choiceKey, { traffic, theme, choice }]) => {
      const { localStorage } = window;
      localStorage.setItem('verax.mock.role', 'analista_cliente');
      if (traffic && localStorage.getItem('verax.mock.traffic') === null)
        localStorage.setItem('verax.mock.traffic', traffic);
      if (theme) localStorage.setItem('verax.theme', theme);
      if (choice && localStorage.getItem(choiceKey) === null) localStorage.setItem(choiceKey, choice);
    },
    [CHOICE, options] as const,
  );
}

async function open(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Detecções' })).toBeVisible();
}

const band = (page: Page) => page.getByRole('region', { name: 'Origem das requisições' });
const map = (page: Page) => band(page).locator('[data-world-map]');
const strip = (page: Page) => page.getByRole('region', { name: 'Situação agora' });

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

const settled = async (page: Page) => expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

/** Do título da página ao resumo: só muda se a faixa muda de altura (o que a tela tem acima do título não conta). */
const stripOffset = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const top = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? NaN;
    return top('[data-tour="deteccoes-situacao"]') - top('main h1');
  });

/** Os arquivos do desenho do mundo que a página pediu. */
function worldRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/world-map-data')) urls.push(request.url());
  });
  return urls;
}

test.describe('mapa de origens na tela Detecções (modo mock)', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [360, 768, 1280]) {
      test(`aberto e recolhido, em dia e parado (${theme}, ${width} px): sem violação de acessibilidade`, async ({
        page,
      }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width, height: 900 });
        await prepare(page, { theme });
        await open(page);
        await expect(band(page)).toBeVisible();
        // Abaixo de 1280 px (a tela empilhada), a faixa começa recolhida (R-07).
        if (width < 1280) {
          await settled(page);
          expect(await violations(page)).toEqual([]);
          await band(page)
            .getByRole('button', { name: /^Mostrar/ })
            .click();
        }
        await expect(map(page)).toBeVisible();
        await settled(page);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
        // A dica (ou os números embaixo do mapa, no estreito) e a tabela.
        await band(page).locator('[data-country="BR"]').focus();
        expect(await violations(page)).toEqual([]);
        await band(page)
          .getByText(/^Ver em tabela/)
          .click();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
        await band(page).getByRole('button', { name: 'Últimos 30 dias' }).click();
        await expect(
          band(page).getByRole('group', { name: /^Mapa de origens nos últimos 30 dias/ }),
        ).toBeVisible();
        expect(await violations(page)).toEqual([]);
        // Parado, na mesma visita: a atualização seguinte.
        await page.evaluate(() => window.localStorage.setItem('verax.mock.traffic', 'stale'));
        await page.reload();
        if (width < 768) await expect(band(page).getByRole('button', { name: /^Recolher/ })).toBeVisible();
        await expect(
          band(page)
            .getByText(/^Sem logs novos desde/)
            .first(),
        ).toBeVisible();
        await settled(page);
        await expect(band(page).locator('[data-pulse]')).toHaveCount(0);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
      });

      test(`aguardando os primeiros logs e carregando (${theme}, ${width} px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await prepare(page, { theme, traffic: 'waiting', choice: 'aberto' });
        await open(page);
        await expect(band(page).getByRole('status')).toContainText('Aguardando os primeiros logs');
        await settled(page);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
        // Na visita seguinte, o lugar já é da faixa enquanto a resposta não vem.
        await page.evaluate(() => window.localStorage.setItem('verax.mock.traffic', 'slow'));
        await page.reload();
        await expect(band(page).getByText('Carregando o mapa de origens…')).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
        await expect(map(page)).toBeVisible();
      });
    }
  }

  test('sem rolagem horizontal de 320 a 1.920 px, aberto e recolhido', async ({ page }) => {
    await prepare(page, { choice: 'aberto' });
    await open(page);
    await expect(map(page)).toBeVisible();
    for (const width of [320, 360, 414, 560, 768, 896, 1024, 1280, 1440, 1760, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await noHorizontalScroll(page);
    }
    await band(page)
      .getByRole('button', { name: /^Recolher/ })
      .click();
    for (const width of [320, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await noHorizontalScroll(page);
    }
  });

  for (const width of [390, 1440]) {
    test(`quem não tem o mapa vê a tela de sempre, e nada pula (${width} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const requested = worldRequests(page);
      await prepare(page, { traffic: 'off' });
      const tops: number[] = [];
      for (const traffic of ['off', 'no_source', 'error']) {
        await page.goto('/login');
        await page.evaluate((value) => window.localStorage.setItem('verax.mock.traffic', value), traffic);
        await open(page);
        await expect(strip(page)).toBeVisible();
        await settled(page);
        tops.push(await stripOffset(page));
        await expect(band(page)).toHaveCount(0);
        // O resumo continua no mesmo lugar depois de todas as respostas.
        await page.waitForTimeout(1_500);
        expect(await stripOffset(page)).toBe(tops.at(-1));
        expect(await page.locator('[data-tour="deteccoes-origens"]').count()).toBe(0);
      }
      expect(new Set(tops).size).toBe(1);
      expect(requested).toEqual([]);
    });
  }

  // Em 1.180 e 1.280 px (conforme a fonte), a explicação do cabeçalho passa a duas linhas quando a resposta chega.
  for (const width of [768, 1180, 1280, 1920]) {
    test(`na visita seguinte, a lista não pula enquanto o mapa carrega (${width} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await prepare(page);
      await open(page);
      // Abaixo de 1280 px a faixa começa recolhida (R-07): abrir guarda a escolha para a visita seguinte.
      if (width < 1280)
        await band(page)
          .getByRole('button', { name: /^Mostrar/ })
          .click();
      await expect(map(page)).toBeVisible();
      await settled(page);
      // A altura é medida depois do mapa pronto.
      await page.waitForTimeout(500);
      const ready = await stripOffset(page);
      await page.evaluate(() => window.localStorage.setItem('verax.mock.traffic', 'slow'));
      await page.reload();
      await expect(band(page).getByText('Carregando o mapa de origens…')).toBeVisible();
      await expect(strip(page)).toBeVisible();
      const loading = await stripOffset(page);
      await expect(map(page)).toBeVisible();
      const loaded = await stripOffset(page);
      expect(Math.abs(loading - ready), 'carregando').toBeLessThanOrEqual(2);
      expect(Math.abs(loaded - loading), 'carregado').toBeLessThanOrEqual(2);
    });
  }

  test('o desenho do mundo só é baixado com a faixa aberta; recolher e abrir de novo não pede outra vez', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const requested = worldRequests(page);
    await prepare(page, { choice: 'recolhido' });
    await open(page);
    await expect(band(page)).toContainText(/requisições em 24 h/);
    await settled(page);
    expect(requested).toEqual([]);
    await band(page)
      .getByRole('button', { name: /^Mostrar/ })
      .click();
    await expect(map(page)).toBeVisible();
    expect(requested).toHaveLength(1);
    await band(page)
      .getByRole('button', { name: /^Recolher/ })
      .click();
    await band(page)
      .getByRole('button', { name: /^Mostrar/ })
      .click();
    await expect(map(page)).toBeVisible();
    expect(requested).toHaveLength(1);
  });

  test('teclado: o título da faixa, o período, recolher, o mapa e só depois o resumo', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page);
    await open(page);
    await expect(map(page)).toBeVisible();
    await settled(page);
    const headings = await page
      .locator('main :is(h1, h2, h3)')
      .evaluateAll((elements) => elements.map((element) => `${element.tagName} ${element.textContent}`));
    expect(headings.slice(0, 4)).toEqual([
      'H1 Detecções',
      'H2 Origem das requisições',
      'H3 Principais origens',
      'H2 Situação agora',
    ]);
    await page.getByRole('button', { name: 'Exportar CSV' }).focus();
    const focused: string[] = [];
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press('Tab');
      focused.push(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute('aria-label') ??
            document.activeElement?.textContent?.trim() ??
            '',
        ),
      );
    }
    expect(focused[0]).toContain('24 horas');
    expect(focused[1]).toContain('7 dias');
    expect(focused[2]).toContain('30 dias');
    expect(focused[3]).toMatch(/^Recolher/);
    expect(focused[4]).toMatch(/^Pausar/);
    expect(focused[5]).toMatch(/^Brasil: /);
    expect(focused[6]).toMatch(/^Ver em tabela/);
    expect(focused[7]).toMatch(/^Recolher/);
    // O botão de recolher do resumo: a faixa inteira ficou para trás.
    expect(await strip(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  });

  test('a demonstração pisca, e anda com o relógio: noutro minuto, outros países', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install({ time: new Date('2026-11-24T17:33:10.000Z') });
    await prepare(page);
    await open(page);
    await expect(map(page)).toBeVisible();
    const pulsing = () =>
      band(page)
        .locator('[data-pulse]')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-pulse')).join(' '));
    const before = await pulsing();
    expect(before.split(' ').length).toBeGreaterThan(15);
    await page.clock.fastForward(61_000);
    await expect.poll(pulsing).not.toBe(before);
    expect((await pulsing()).split(' ').length).toBeGreaterThan(15);
  });

  test('a atualização que falha mantém o mapa, com o aviso; em segundo plano, a aba não pede nada', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install({ time: new Date('2026-11-24T17:33:10.000Z') });
    await prepare(page);
    await open(page);
    await expect(map(page)).toBeVisible();
    const updated = band(page).getByText(/^Atualizado às/);
    const first = await updated.textContent();

    // A aba vai para segundo plano: passam cinco minutos, e nada é pedido.
    const visibility = (state: 'hidden' | 'visible') =>
      page.evaluate((value) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      }, state);
    await visibility('hidden');
    for (let minute = 0; minute < 5; minute += 1) await page.clock.fastForward(60_000);
    expect(await updated.textContent()).toBe(first);
    await visibility('visible');
    await expect(updated).not.toHaveText(first ?? '');

    await page.evaluate(() => window.localStorage.setItem('verax.mock.traffic', 'error'));
    await page.clock.fastForward(61_000);
    // A segunda tentativa, um segundo depois.
    await page.clock.fastForward(3_000);
    await expect(band(page).getByText('Não foi possível atualizar agora.')).toBeVisible();
    await expect(band(page).locator('[data-country]').first()).toBeVisible();
    await expect(band(page).locator('[data-pulse]')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
    await page.evaluate(() => window.localStorage.setItem('verax.mock.traffic', 'ok'));
    await page.clock.fastForward(61_000);
    await expect(band(page).getByText('Não foi possível atualizar agora.')).toHaveCount(0);
  });

  test('com menos movimento pedido, começa parado, com tudo à vista', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page);
    await open(page);
    await expect(map(page)).toBeVisible();
    await expect(band(page).locator('[data-pulse]')).toHaveCount(0);
    expect(await band(page).locator('[data-still-ring]').count()).toBeGreaterThan(15);
    await expect(band(page).getByRole('button', { name: /^Retomar/ })).toBeVisible();
  });

  test('por um link direto a faixa começa recolhida, e o detalhe aparece sem rolar a tela', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page, { choice: 'aberto' });
    await open(page, `/?alerta=${FINDING}`);
    await expect(band(page).getByRole('button', { name: /^Mostrar/ })).toBeVisible();
    const detail = page.getByRole('complementary', { name: 'Tentativa de desligar a trilha do CloudTrail' });
    await expect(detail).toBeVisible();
    expect((await detail.boundingBox())?.y ?? 900).toBeLessThan(450);
    await open(page);
    await expect(band(page).getByRole('button', { name: /^Recolher/ })).toBeVisible();
  });
});
