import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Mapa de origens no catálogo, no navegador: sem violação de acessibilidade (WCAG 2.2 AA) nos dois temas e em três
 * larguras, com a dica e a tabela abertas; o contraste calculado das cores de verdade; sem rolagem horizontal de 320 a
 * 1920 px em todos os estados; e a animação, o botão de pausa, o teclado, o mouse e o toque.
 */

const THEMES = ['light', 'dark'] as const;
const STATES = [
  'comum',
  'ataque',
  'todos',
  'um',
  'cdn',
  'sem-pais',
  'vazio',
  'enorme',
  'parada',
  'falhou',
  'carregando',
] as const;

async function openCatalog(page: Page, theme: (typeof THEMES)[number] = 'dark'): Promise<Locator> {
  await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
  await page.goto('/catalogo');
  const card = page.getByTestId('mapa-de-origens');
  await expect(card.locator('[data-land]')).toBeAttached();
  return card;
}

async function choose(page: Page, card: Locator, state: (typeof STATES)[number]): Promise<void> {
  await page.getByLabel('Estado do mapa').selectOption(state);
  if (state === 'carregando') await expect(card.getByText('Carregando o mapa de origens…')).toBeVisible();
  else await expect(card.locator('[data-land]')).toBeAttached();
}

const map = (card: Locator) => card.getByRole('group', { name: /^Mapa de origens/ });

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .include('[data-testid="mapa-de-origens"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

type Color = readonly [number, number, number];

function contrast(a: Color, b: Color): number {
  const luminance = (color: Color) => {
    const [red = 0, green = 0, blue = 0] = color.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [light = 0, dark = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** A cor calculada pelo navegador, que precisa ser opaca. */
async function colorOf(
  locator: Locator,
  property: 'fill' | 'stroke' | 'color' | 'backgroundColor',
): Promise<Color> {
  const text = await locator
    .first()
    .evaluate((element, name) => getComputedStyle(element)[name as 'fill'], property);
  const [, red, green, blue] = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(text) ?? [];
  expect(blue, `${property}: ${text}`).toBeDefined();
  return [Number(red), Number(green), Number(blue)];
}

for (const theme of THEMES) {
  for (const width of [360, 768, 1280]) {
    test(`${theme}, ${width} px: sem violação de acessibilidade, com a dica e a tabela abertas`, async ({
      page,
    }) => {
      // Três passadas do axe num servidor de desenvolvimento.
      test.slow();
      await page.setViewportSize({ width, height: 900 });
      const card = await openCatalog(page, theme);
      expect(await violations(page)).toEqual([]);

      await map(card)
        .getByRole('img', { name: /^Brasil:/ })
        .focus();
      await page.keyboard.press('ArrowRight');
      const facts = card.locator(width < 600 ? '[data-map-readout]' : '[data-map-tip]');
      await expect(facts).toContainText('Estados Unidos');
      expect(await violations(page)).toEqual([]);

      await card.getByText(/^Ver em tabela/).click();
      await expect(card.getByRole('table', { name: /^Origem das requisições/ })).toBeVisible();
      expect(await violations(page)).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test(`${theme}: cada estado sem violação de acessibilidade, no celular e no computador`, async ({
    page,
  }) => {
    // Catorze passadas do axe, duas delas com 250 países.
    test.setTimeout(180_000);
    const card = await openCatalog(page, theme);
    for (const [width, states] of [
      [1280, STATES],
      [360, ['todos', 'sem-pais', 'parada']],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      for (const state of states) {
        await choose(page, card, state);
        expect(await violations(page), `${state} em ${width} px`).toEqual([]);
      }
    }
  });

  test(`${theme}: o contraste das cores de verdade`, async ({ page }) => {
    // Parado: os anéis de quem pulsaria também entram na conta.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const card = await openCatalog(page, theme);
    const ocean = await colorOf(card.locator('.bg-map-ocean'), 'backgroundColor');
    const land = await colorOf(card.locator('[data-land]'), 'fill');
    const coast = await colorOf(card.locator('[data-land]'), 'stroke');
    expect(contrast(land, ocean)).toBeGreaterThanOrEqual(1.3);
    expect(contrast(coast, ocean)).toBeGreaterThan(contrast(land, ocean));

    await map(card)
      .getByRole('img', { name: /^Brasil:/ })
      .focus();
    const marks = {
      comum: await colorOf(card.locator('circle[data-dot]'), 'fill'),
      suspeito: await colorOf(card.locator('polygon[data-dot]'), 'fill'),
      'anel do suspeito': await colorOf(card.locator('[data-flagged-ring]'), 'stroke'),
      'anel parado': await colorOf(card.locator('[data-still-ring]'), 'stroke'),
      foco: await colorOf(card.locator('[data-ring]'), 'stroke'),
    };
    for (const [name, color] of Object.entries(marks)) {
      expect(contrast(color, ocean), `${name} sobre o mar`).toBeGreaterThanOrEqual(3);
      expect(contrast(color, land), `${name} sobre a terra`).toBeGreaterThanOrEqual(3);
    }
    const legend = await colorOf(card.getByRole('list', { name: 'Legenda do mapa' }), 'color');
    expect(contrast(legend, ocean)).toBeGreaterThanOrEqual(4.5);
  });
}

test('de 320 a 1920 px, nenhum estado passa da largura da tela, e o mapa usa a largura dele', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const card = await openCatalog(page);
  for (const width of [320, 360, 640, 768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const state of STATES) {
      await choose(page, card, state);
      expect(await overflow(page), `${state} em ${width} px`).toBeLessThanOrEqual(0);
      if (state === 'carregando') continue;
      const panel = await card.locator('.bg-map-ocean').first().boundingBox();
      const box = await card.boundingBox();
      // No celular, a largura toda do cartão; no computador, a maior parte (a lista fica ao lado).
      expect((panel?.width ?? 0) / (box?.width ?? 1), `${state} em ${width} px`).toBeGreaterThan(0.65);
      expect(panel?.height ?? 0).toBeLessThan(620);
    }
  }
});

test('a onda só anda em transform e opacity, no período certo, e o botão pausa, retoma e lembra', async ({
  page,
}) => {
  const card = await openCatalog(page);
  const pulses = card.locator('[data-pulse]');
  expect(await pulses.count()).toBeGreaterThan(10);
  const animation = await pulses.first().evaluate((element) => {
    const [running] = element.getAnimations();
    const frames = (running?.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
    return {
      state: running?.playState,
      duration: getComputedStyle(element).animationDuration,
      properties: [
        ...new Set(
          frames
            .flatMap((frame) => Object.keys(frame))
            .filter((name) => !['offset', 'computedOffset', 'easing', 'composite'].includes(name)),
        ),
      ].sort(),
    };
  });
  expect(animation).toEqual({ state: 'running', duration: '2.4s', properties: ['opacity', 'transform'] });
  // Em fases diferentes, mas poucas: cada uma acorda a página uma vez por volta.
  const delays = await pulses.evaluateAll((items) =>
    items.map((item) => getComputedStyle(item).animationDelay),
  );
  expect(new Set(delays).size).toBeGreaterThan(6);
  expect(new Set(delays).size).toBeLessThanOrEqual(12);

  await card.getByRole('button', { name: 'Pausar a animação do mapa' }).click();
  await expect(pulses).toHaveCount(0);
  expect(await card.locator('[data-still-ring]').count()).toBeGreaterThan(10);
  expect(
    await card.evaluate(
      (element) =>
        element.getAnimations({ subtree: true }).filter((item) => item instanceof CSSAnimation).length,
    ),
  ).toBe(0);

  await page.reload();
  const resume = card.getByRole('button', { name: 'Retomar a animação do mapa' });
  await expect(resume).toBeVisible();
  await expect(pulses).toHaveCount(0);
  await resume.click();
  expect(await pulses.count()).toBeGreaterThan(10);
});

test('com menos movimento pedido: começa parado e completo; ligar no botão usa o período normal', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const card = await openCatalog(page);
  await expect(card.locator('[data-pulse]')).toHaveCount(0);
  expect(await card.locator('[data-still-ring]').count()).toBeGreaterThan(10);
  expect(await map(card).getByRole('img').count()).toBe(48);

  await card.getByRole('button', { name: /^Retomar/ }).click();
  // A regra global de menos movimento encurta as animações para 0,01 ms: aqui isso viraria um pisca-pisca.
  await expect(card.locator('[data-pulse]').first()).toHaveCSS('animation-duration', '2.4s');
  // A escolha vale só daquela vez.
  await page.reload();
  await expect(card.getByRole('button', { name: /^Retomar/ })).toBeVisible();
});

test('com 250 países, pulsam no máximo 60, e o texto diz quantos eram', async ({ page }) => {
  const card = await openCatalog(page);
  await choose(page, card, 'todos');
  await expect(map(card).getByRole('img')).toHaveCount(246);
  await expect(card.locator('[data-pulse]')).toHaveCount(60);
  await expect(card.getByText(/^A marca de atividade fica só nos 60 países/)).toBeVisible();
});

test('teclado: uma parada, as setas, Home, End e Esc; a dica fica sempre inteira dentro do mapa', async ({
  page,
}) => {
  // Um quadro de animação para cada um dos 246 países.
  test.slow();
  await page.setViewportSize({ width: 1280, height: 900 });
  const card = await openCatalog(page);
  await choose(page, card, 'todos');
  await card.getByRole('button', { name: /^Pausar/ }).focus();
  await page.keyboard.press('Tab');
  await expect(map(card).getByRole('img', { name: /^Brasil:/ })).toBeFocused();
  await page.keyboard.press('End');
  const last = map(card).getByRole('img').last();
  await expect(last).toBeFocused();
  await page.keyboard.press('Home');

  const tip = card.locator('[data-map-tip]');
  // Cada país, um por vez: a dica é a dele, fica ao lado do ponto e não sai do mapa.
  const misplaced = await map(card).evaluate(async (svg) => {
    const wrong: string[] = [];
    for (const dot of svg.querySelectorAll<SVGGElement>('[data-country]')) {
      dot.focus();
      await new Promise(requestAnimationFrame);
      const tip = svg.parentElement?.querySelector('[data-map-tip]');
      const name = dot.getAttribute('aria-label')?.split(':')[0] ?? '';
      const mark = dot.querySelector('[data-dot]')?.getBoundingClientRect();
      const inner = tip?.getBoundingClientRect();
      const outer = svg.getBoundingClientRect();
      if (!tip || !inner || !mark || tip.querySelector('p')?.textContent !== name) {
        wrong.push(`${name}: sem a dica dele`);
        continue;
      }
      const [x, y] = [mark.left + mark.width / 2, mark.top + mark.height / 2];
      const gap = Math.min(Math.abs(inner.left - x), Math.abs(inner.right - x));
      if (gap > 30 || y < inner.top - 10 || y > inner.bottom + 10) wrong.push(`${name}: longe do ponto`);
      if (
        inner.left < outer.left ||
        inner.right > outer.right ||
        inner.top < outer.top ||
        inner.bottom > outer.bottom
      )
        wrong.push(`${name}: fora do mapa`);
    }
    return wrong;
  });
  expect(misplaced).toEqual([]);
  await expect(last).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  await expect(last).toBeFocused();
  // O anel do foco continua.
  await expect(card.locator('[data-ring]')).toHaveCount(1);
  // Do mapa, o Tab sai para o próximo controle, e não para o próximo país.
  await page.keyboard.press('Tab');
  await expect(card.locator('summary')).toBeFocused();
});

test('mouse: a dica aparece no ponto, e o alvo tem 24 px mesmo quando o ponto é pequeno', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const card = await openCatalog(page);
  const tip = card.locator('[data-map-tip]');
  // A África do Sul está sozinha no canto dela.
  const dot = map(card)
    .getByRole('img', { name: /^África do Sul:/ })
    .locator('[data-dot]');
  await dot.scrollIntoViewIfNeeded();
  const box = await dot.boundingBox();
  if (!box) throw new Error('sem ponto');
  expect(box.width).toBeLessThan(24);
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  for (const [dx, dy] of [
    [0, 0],
    [11, 0],
    [-11, 0],
    [0, 11],
    [0, -11],
  ] as const) {
    await page.mouse.move(x + dx, y + dy);
    await expect(tip).toContainText('África do Sul');
  }
  await page.mouse.move(x + 16, y);
  await expect(tip).toHaveCount(0);
  // Esc fecha a dica do mouse.
  await page.mouse.move(x, y);
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
});

test.describe('toque', () => {
  test.use({ hasTouch: true, viewport: { width: 360, height: 800 } });

  test('o primeiro toque já mostra os números, embaixo do mapa, sem a página pular', async ({ page }) => {
    const card = await openCatalog(page);
    const readout = card.locator('[data-map-readout]');
    await expect(readout).toContainText('Toque num ponto');
    const before = await card.boundingBox();
    const dot = map(card)
      .getByRole('img', { name: /^Austrália:/ })
      .locator('[data-dot]');
    await dot.scrollIntoViewIfNeeded();
    const box = await dot.boundingBox();
    if (!box) throw new Error('sem ponto');
    await page.touchscreen.tap(box.x + box.width / 2 + 6, box.y + box.height / 2);
    await expect(readout).toContainText('Austrália');
    await expect(card.locator('[data-map-tip]')).toHaveCount(0);
    expect((await card.boundingBox())?.height).toBe(before?.height);
    // Tocar fora fecha.
    await card.getByRole('heading', { name: 'Principais origens' }).tap();
    await expect(readout).toContainText('Toque num ponto');
  });
});
