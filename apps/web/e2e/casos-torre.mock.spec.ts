import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Os casos no resumo da situação, no radar e nas análises, no navegador, sobre a demonstração (`dev:mock`, com os casos
 * ligados): sem violação de acessibilidade (WCAG 2.2 AA) nos dois temas e em 360, 768 e 1280 px, sem rolagem horizontal de
 * 320 a 1920, o teclado, o toque, a animação e cada atalho. O radar e o MITRE com os casos desligados estão em
 * `radar.mock.spec.ts` e `mitre-radar.mock.spec.ts`.
 */

async function prepare(page: Page, entries: Record<string, string> = {}) {
  await skipDemoTour(page);
  await page.addInitScript(
    (values) => {
      for (const [key, value] of Object.entries(values)) window.localStorage.setItem(key, value);
    },
    { 'verax.mock.role': 'analista_cliente', ...entries },
  );
}

/** Abre a tela e o resumo da situação (no celular, ele começa recolhido). */
async function open(page: Page, path = '/'): Promise<Locator> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Detecções' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const strip = page.getByRole('region', { name: 'Situação agora' });
  const show = strip.getByRole('button', { name: /^Mostrar/ });
  if (await show.isVisible()) await show.click();
  return strip;
}

const radarOf = (strip: Locator) =>
  strip.getByRole('group', { name: /^Radar de casos das últimas 24 horas/ });

async function violations(page: Page): Promise<string[]> {
  // As transições de cor pela metade dariam um contraste que não existe parado (a varredura do radar não acaba).
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

/** O menor contraste das marcas do radar contra o fundo dele, pelas cores que o navegador usou. */
const markContrast = (radar: Locator) =>
  radar.evaluate((svg) => {
    const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const panel = svg.parentElement?.querySelector('.bg-surface');
    if (!canvas || !panel) throw new Error('sem o radar na tela');
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
    const ratios = [...svg.querySelectorAll('[data-blip]')].map((blip) => {
      // A marca é a última forma com traço de 2; a vazada (nada pendente) se vê pelo traço.
      const mark = [...blip.querySelectorAll('polygon, circle')].find(
        (shape) => shape.getAttribute('stroke-width') === '2' && !shape.classList.contains('stroke-ring'),
      );
      if (!mark) throw new Error('ponto sem marca');
      const style = getComputedStyle(mark);
      const ink = luminance(blip.getAttribute('data-severity') === 'none' ? style.stroke : style.fill);
      return (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05);
    });
    return Math.min(...ratios);
  });

test.describe('casos na situação (modo mock): acessibilidade', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [360, 768, 1280] as const) {
      test(`o resumo, o radar com a dica e a tabela, e as análises (${theme === 'light' ? 'claro' : 'escuro'}, ${width} px)`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        await prepare(page, { 'verax.theme': theme });
        await page.setViewportSize({ width, height: 900 });
        const strip = await open(page);
        const radar = radarOf(strip);
        await expect(radar).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'resumo');
        expect(await markContrast(radar)).toBeGreaterThanOrEqual(3);

        // A dica pelo teclado: do mais grave, e o seguinte.
        const first = radar.getByRole('link', { name: /^Crítico: Tentativa de desligar a trilha/ });
        await first.focus();
        const tip = strip.locator('[data-radar-tip]');
        await expect(tip).toContainText('Tentativa de desligar a trilha do CloudTrail');
        await expect(tip).toContainText('Em incidente aberto');
        await expect(tip).toContainText(/\d+ alertas?/);
        expect(await violations(page)).toEqual([]);
        await page.keyboard.press('ArrowRight');
        await expect(tip).toBeVisible();

        await strip.getByText(/^Ver em tabela/).click();
        await expect(strip.getByRole('table', { name: 'Casos do radar' })).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'tabela');

        await open(page, '/?analise=resumo');
        await expect(page.getByRole('heading', { name: 'Casos abertos no período' })).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'resumo do período');
        await open(page, '/?analise=mitre&periodo=30d');
        const chart = page.getByRole('group', { name: /^Gráfico de radar das táticas do MITRE ATT&CK/ });
        await expect(page.getByRole('heading', { name: 'Casos por tática' })).toBeVisible();
        await chart.getByRole('link', { name: /^Descoberta \(TA0007\): \d+ casos?/ }).focus();
        await expect(page.locator('[data-spider-tip]')).toContainText(/\d+% · \d+ casos? · \d+ alertas/);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'MITRE');
      });
    }
  }

  test('nenhuma largura de 320 a 1920 px rola para o lado, com o resumo aberto', async ({ page }) => {
    test.setTimeout(120_000);
    await prepare(page);
    for (const path of ['/', '/?analise=resumo', '/?analise=mitre']) {
      for (const width of [320, 360, 390, 640, 768, 1024, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        const strip = await open(page, path);
        await expect(radarOf(strip)).toBeVisible();
        await noHorizontalScroll(page, `${path} em ${width} px`);
        // Nada sai do cartão: as decisões, com dois botões, cabem nele.
        expect(
          await strip.evaluate((element) => element.scrollWidth - element.clientWidth),
          `o resumo em ${width} px`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });
});

test.describe('casos na situação (modo mock): uso', () => {
  test.beforeEach(async ({ page }) => {
    await prepare(page);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('a frase liga os alertas aos casos, e a tabela tem os mesmos números do radar', async ({ page }) => {
    const strip = await open(page);
    const radar = radarOf(strip);
    const points = await radar.getByRole('link').count();
    await expect(strip.getByText(/^\d+ alertas em \d+ casos$/)).toHaveText(
      `${await total(radar, 'com')} alertas em ${points} casos`,
    );
    await strip.getByText(`Ver em tabela (${points})`).click();
    const rows = strip.getByRole('table', { name: 'Casos do radar' }).getByRole('row');
    await expect(rows).toHaveCount(points + 1);
    const recent = await strip
      .getByRole('table', { name: 'Casos do radar' })
      .locator('tbody td:nth-child(5)')
      .allInnerTexts();
    expect(recent.reduce((sum, value) => sum + Number(value), 0)).toBe(await total(radar, 'com'));
  });

  test('o ponto abre o caso ao lado da lista; a volta devolve o radar, e o filtro fica', async ({ page }) => {
    const strip = await open(page, '/?severidade=high');
    await radarOf(strip)
      .getByRole('link', { name: /^Alto: Login do usuário root no console\./ })
      .focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/severidade=high&caso=/);
    const aside = page.getByRole('complementary', { name: 'Login do usuário root no console' });
    await expect(aside.getByText(/^Caso · Detecção/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(radarOf(page.getByRole('region', { name: 'Situação agora' }))).toBeVisible();
    await expect(page).toHaveURL(/\/\?severidade=high$/);
  });

  test('cada decisão leva à lista dela', async ({ page }) => {
    const strip = await open(page);
    const decisions = strip.getByRole('region', { name: 'Decisões pendentes' });
    await expect(decisions.getByText(/\d+ casos com alerta alto ou crítico para validar$/)).toBeVisible();
    await decisions.getByRole('link', { name: 'Ver a postura' }).click();
    await expect(page).toHaveURL(/\/\?fila=postura$/);
    await expect(
      page.getByRole('button', { name: /^Abrir o caso: Controle de segurança/ }).first(),
    ).toBeVisible();
    await decisions.getByRole('link', { name: 'Ver as vulnerabilidades' }).click();
    await expect(page).toHaveURL(/\/\?visao=vulnerabilidades$/);
    await decisions.getByRole('link', { name: 'Ver os casos' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('table', { name: 'Casos do cliente' })).toBeVisible();
  });

  test('tratar o caso muda a situação na hora: um caso a menos para validar, e o ponto sem nada pendente', async ({
    page,
  }) => {
    const strip = await open(page);
    const phrase = strip.getByText(/\d+ casos com alerta alto ou crítico para validar$/);
    const before = Number.parseInt(((await phrase.textContent()) ?? '').split(': ')[1] ?? '', 10);
    await page.getByRole('checkbox', { name: /^Selecionar: Login do usuário root/ }).check();
    await page
      .getByRole('region', { name: 'Ações em lote' })
      .getByRole('button', { name: 'Resolvido' })
      .click();
    const dialog = page.getByRole('dialog', { name: /^Tratar:/ });
    const critical = dialog.getByRole('checkbox', { name: /^Incluir também/ });
    if (await critical.isVisible()) await critical.check();
    await dialog.getByRole('button', { name: /^Marcar/ }).click();
    await expect(page.getByText('Pronto.')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Fechar', exact: true }).last().click();
    await expect(phrase).toHaveText(`Alto: ${before - 1} casos com alerta alto ou crítico para validar`);
    await expect(
      radarOf(strip).getByRole('link', { name: /^Nada pendente: Login do usuário root no console\./ }),
    ).toHaveCount(1);
  });

  test('a varredura gira pelo CSS, com um brilho por ponto, sem mexer no resto da tela', async ({ page }) => {
    const strip = await open(page);
    const radar = radarOf(strip);
    const sweep = strip.locator('[data-radar-sweep]');
    const angle = () => sweep.evaluate((element) => getComputedStyle(element).transform);
    const before = await angle();
    await expect.poll(angle).not.toBe(before);
    expect(await radar.locator('.radar-echo').count()).toBe(await radar.getByRole('link').count());
    // Uma volta inteira da varredura sem nenhuma mudança no DOM do radar.
    const changes = await radar.evaluate(
      (svg) =>
        new Promise<number>((resolve) => {
          let count = 0;
          const observer = new MutationObserver((records) => (count += records.length));
          observer.observe(svg, { subtree: true, childList: true, attributes: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(count);
          }, 2_000);
        }),
    );
    expect(changes).toBe(0);
    // Só `transform` e `opacity` são animados: nada é redesenhado.
    const animated = await strip.evaluate((element) => [
      ...new Set(
        element
          .getAnimations({ subtree: true })
          .flatMap((animation) =>
            ((animation.effect as KeyframeEffect | null)?.getKeyframes() ?? []).flatMap((frame) =>
              Object.keys(frame).filter(
                (key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key),
              ),
            ),
          ),
      ),
    ]);
    expect(animated.sort()).toEqual(['opacity', 'transform']);
  });

  test('com menos movimento pedido: sem varredura, brilho nem pulso, com todos os casos', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const strip = await open(page);
    await expect(radarOf(strip).getByRole('link').first()).toBeVisible();
    await expect(strip.locator('[data-radar-sweep], .radar-echo, [data-pulse]')).toHaveCount(0);
    expect(await radarOf(strip).getByRole('link').count()).toBeGreaterThan(10);
  });

  test.describe('no toque', () => {
    test.use({ hasTouch: true });

    test('o primeiro toque mostra a dica, e o segundo abre o caso', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      const strip = await open(page);
      const point = radarOf(strip).getByRole('link', { name: /^Alto: Login do usuário root/ });
      await point.scrollIntoViewIfNeeded();
      await point.locator('circle').first().tap({ force: true });
      const tip = strip.locator('[data-radar-tip]');
      await expect(tip).toBeVisible();
      const shown = await tip.locator('strong').innerText();
      await expect(page).not.toHaveURL(/caso=/);
      await radarOf(strip).locator('[data-active] circle').first().tap({ force: true });
      await expect(page).toHaveURL(/caso=/);
      await expect(page.getByRole('dialog', { name: shown })).toBeVisible();
    });
  });
});

/** O número de alertas que o nome acessível do radar diz. */
async function total(radar: Locator, word: string): Promise<number> {
  const name = (await radar.getAttribute('aria-label')) ?? '';
  const words = name.split(' ');
  return Number.parseInt(words[words.indexOf(word) + 1] ?? '', 10);
}
