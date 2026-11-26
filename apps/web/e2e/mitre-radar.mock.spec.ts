import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Gráfico de radar do MITRE ATT&CK (aba MITRE ATT&CK da tela Detecções) no navegador, sobre a demonstração
 * (`dev:mock`): nos dois temas, a 360, 768 e 1280 px, sem violação de acessibilidade (WCAG 2.2 AA) com a dica aberta
 * pelo teclado, com o contraste da linha, dos pontos e dos nomes medido (o axe não mede texto de SVG), sem nome cortado
 * nem encostado em outro e sem rolagem horizontal da página; o clique, o Enter e o toque que levam à lista filtrada.
 */

const open = async (page: Page, period = '30d') => {
  await page.goto(`/?analise=mitre&periodo=${period}`);
  const chart = page.getByRole('group', { name: /^Gráfico de radar das táticas do MITRE ATT&CK/ });
  await expect(chart).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  return chart;
};

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

/**
 * Quanto o bloco do gráfico (com a lista) passa da tela, e quanto a página rola para o lado. A 768 px, com as letras
 * largas do Linux, o cabeçalho do painel pode alargar a página sozinho: ali vale só o bloco.
 */
async function noHorizontalScroll(page: Page, width: number) {
  const { block, content, document } = await page.evaluate(() => {
    const section = globalThis.document.querySelector('section:has(> div [data-axis])');
    if (!section) throw new Error('sem o gráfico na tela');
    return {
      block: section.getBoundingClientRect().right - window.innerWidth,
      content: section.scrollWidth - section.clientWidth,
      document: globalThis.document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(block, `bloco a ${width} px`).toBeLessThanOrEqual(0);
  expect(content, `conteúdo do bloco a ${width} px`).toBeLessThanOrEqual(1);
  if (width !== 768) expect(document, `página a ${width} px`).toBeLessThanOrEqual(1);
}

/** O contraste de cada marca e texto do gráfico contra o fundo do quadro dele, pelas cores que o navegador usou. */
const contrasts = (page: Page) =>
  page.evaluate(() => {
    const svg = document.querySelector('svg:has([data-axis])');
    const panel = svg?.closest('.bg-surface');
    if (!svg || !panel) throw new Error('sem o gráfico na tela');
    const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!canvas) throw new Error('sem canvas');
    const luminance = (color: string) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = [...canvas.getImageData(0, 0, 1, 1).data].map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const surface = luminance(getComputedStyle(panel).backgroundColor);
    const ratio = (color: string) => {
      const ink = luminance(color);
      return (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05);
    };
    const series = svg.querySelector('[data-series]');
    const dot = svg.querySelector('[data-dot]');
    if (!series || !dot) throw new Error('sem a série ou os pontos');
    return {
      line: ratio(getComputedStyle(series).stroke),
      dot: ratio(getComputedStyle(dot).fill),
      text: Math.min(...[...svg.querySelectorAll('text')].map((text) => ratio(getComputedStyle(text).fill))),
    };
  });

/** Os textos que saem do quadro do gráfico e os pares que se encostam, pelo tamanho real das letras. */
const collisions = (page: Page) =>
  page.evaluate(() => {
    const svg = document.querySelector('svg:has([data-axis])');
    if (!svg) throw new Error('sem o gráfico na tela');
    const frame = svg.getBoundingClientRect();
    const texts = [...svg.querySelectorAll('text')].map((text) => ({
      name: text.textContent,
      box: text.getBoundingClientRect(),
    }));
    const outside = texts
      .filter(({ box }) => box.left < frame.left - 1 || box.right > frame.right + 1)
      .map(({ name }) => `${name} fora do quadro`);
    const touching = texts.flatMap((one, index) =>
      texts
        .slice(index + 1)
        .filter(
          ({ box }) =>
            one.box.left < box.right &&
            box.left < one.box.right &&
            one.box.top < box.bottom &&
            box.top < one.box.bottom,
        )
        .map(({ name }) => `${one.name} encosta em ${name}`),
    );
    return [...outside, ...touching];
  });

test.describe('gráfico do MITRE ATT&CK (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    // Com os casos desligados, o gráfico conta alertas; com eles, está em `casos-torre.mock.spec.ts`.
    await page.addInitScript(() => {
      window.localStorage.setItem('verax.mock.role', 'analista_cliente');
      window.localStorage.setItem('verax.mock.cases', 'off');
    });
    await skipDemoTour(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [360, 768, 1280]) {
      test(`${theme === 'light' ? 'claro' : 'escuro'}, ${width} px: acessível com a dica aberta, legível e sem rolagem horizontal`, async ({
        page,
      }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        const chart = await open(page);
        await expect(chart.locator('[data-axis]')).toHaveCount(14);
        expect(await violations(page)).toEqual([]);

        await chart.getByRole('link', { name: /^Evasão de defesas \(TA0005\): \d+ alertas/ }).focus();
        const tip = page.locator('[data-spider-tip]');
        await expect(tip).toContainText(/\d+% · \d+ alertas/);
        await page.keyboard.press('ArrowRight');
        await expect(tip).toContainText('Acesso a credenciais');
        expect(await violations(page)).toEqual([]);
        // A dica fica dentro do quadro do gráfico.
        const [tipBox, chartBox] = [await tip.boundingBox(), await chart.boundingBox()];
        if (!tipBox || !chartBox) throw new Error('sem a dica ou o gráfico na tela');
        expect(tipBox.x).toBeGreaterThanOrEqual(chartBox.x - 1);
        expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(chartBox.x + chartBox.width + 1);

        await page.keyboard.press('Escape');
        await expect(tip).toHaveCount(0);

        const contrast = await contrasts(page);
        expect(contrast.line).toBeGreaterThanOrEqual(3);
        expect(contrast.dot).toBeGreaterThanOrEqual(3);
        expect(contrast.text).toBeGreaterThanOrEqual(4.5);
        expect(await collisions(page)).toEqual([]);
        await noHorizontalScroll(page, width);
      });
    }
  }

  test('de 320 a 1920 px: os nomes cabem sem se encostar, e a lista fica ao lado do gráfico na tela larga', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const beside = new Map<number, boolean>();
    for (const width of [320, 360, 390, 768, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const chart = await open(page);
      expect(await collisions(page), `${width} px`).toEqual([]);
      await noHorizontalScroll(page, width);
      const list = page.getByRole('list', { name: 'Táticas com alertas' });
      const [chartBox, listBox] = [await chart.boundingBox(), await list.boundingBox()];
      if (!chartBox || !listBox) throw new Error('sem o gráfico ou a lista na tela');
      beside.set(width, listBox.x >= chartBox.x + chartBox.width);
    }
    expect(Object.fromEntries(beside)).toEqual({
      320: false,
      360: false,
      390: false,
      768: false,
      // Desde a E-07, a análise fica na coluna ao lado do radar: em 1280 px, a lista vai para baixo do gráfico.
      1280: false,
      1920: true,
    });
  });

  test('o clique na tática e o Enter levam à lista filtrada, do gráfico e da lista ao lado', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const chart = await open(page);
    // O nome da tática é o alvo (o meio da caixa do link, entre o nome e o ponto, não é nada).
    await chart
      .getByRole('link', { name: /^Evasão de defesas/ })
      .locator('rect')
      .first()
      .click();
    await expect(page).toHaveURL(/tatica=Defense\+Evasion/);
    // Desde a E-07, a tática volta para a aba "Lista", já filtrada. O ponto leva ao mesmo lugar que o nome.
    await expect(page).not.toHaveURL(/analise=/);
    await expect(page.getByRole('table', { name: 'Alertas do cliente' })).toBeVisible();
    await page.goBack();
    await expect(chart).toBeVisible();
    await chart
      .getByRole('link', { name: /^Descoberta/ })
      .locator('circle')
      .first()
      .click();
    await expect(page).toHaveURL(/tatica=Discovery/);
    await page.goBack();

    await chart.getByRole('link', { name: /^Acesso inicial/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/tatica=Initial\+Access/);
    await page.goBack();

    await page
      .getByRole('list', { name: 'Táticas com alertas' })
      .getByRole('link', { name: /^Persistência/ })
      .click();
    await expect(page).toHaveURL(/tatica=Persistence/);
  });

  test('tática sem alerta não é link, mas tem dica com o mouse', async ({ page }) => {
    const chart = await open(page);
    const silent = chart.getByRole('img', { name: /: 0 alertas/ }).first();
    await expect(silent).toBeVisible();
    await silent.locator('rect').first().hover();
    await expect(page.locator('[data-spider-tip]')).toContainText('0% · 0 alertas');
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-spider-tip]')).toHaveCount(0);
  });

  test.describe('no toque', () => {
    test.use({ hasTouch: true, viewport: { width: 360, height: 800 } });

    test('o primeiro toque mostra a dica, o toque fora fecha e o segundo na mesma tática abre', async ({
      page,
    }) => {
      const chart = await open(page);
      const axis = chart
        .getByRole('link', { name: /^Evasão de defesas/ })
        .locator('rect')
        .first();
      const tip = page.locator('[data-spider-tip]');
      await axis.tap();
      await expect(tip).toContainText('Toque de novo para ver os alertas.');
      await expect(page).toHaveURL(/analise=mitre/);
      await page.getByRole('heading', { name: 'Alertas por tática' }).tap();
      await expect(tip).toHaveCount(0);

      await axis.tap();
      await expect(tip).toContainText('Evasão de defesas');
      await axis.tap();
      await expect(page).toHaveURL(/tatica=Defense\+Evasion/);
      await expect(page.getByRole('table', { name: 'Alertas do cliente' })).toBeVisible();
    });
  });
});
