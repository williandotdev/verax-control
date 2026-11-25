import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Casos e triagem em massa na tela Detecções, no navegador, sobre a demonstração (`dev:mock`): a tela de sempre com eles
 * desligados; a lista, as vulnerabilidades, o detalhe e os diálogos sem violação de acessibilidade (WCAG 2.2 AA) nos dois
 * temas e em 360, 768 e 1280 px, sem rolagem horizontal de 320 a 1920; o teclado, o celular e cada fluxo em massa, com o
 * que dá errado (`verax.mock.triage`).
 */

interface Setup {
  role?: string;
  theme?: 'light' | 'dark';
  cases?: 'off' | 'shadow' | 'on';
  triage?: string;
  volume?: number;
}

async function prepare(page: Page, { role = 'analista_cliente', theme, cases, triage, volume }: Setup = {}) {
  await skipDemoTour(page);
  await page.addInitScript(
    (entries) => {
      for (const [key, value] of entries) if (value) window.localStorage.setItem(key, value);
    },
    [
      ['verax.mock.role', role],
      ['verax.theme', theme ?? ''],
      ['verax.mock.cases', cases ?? ''],
      ['verax.mock.triage', triage ?? ''],
      ['verax.mock.cases.volume', volume === undefined ? '' : String(volume)],
    ] as [string, string][],
  );
}

async function open(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Detecções' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function violations(page: Page): Promise<string[]> {
  // As transições de cor do botão pela metade dariam um contraste que não existe parado (a varredura do radar não acaba).
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

const noHorizontalScroll = async (page: Page, label = '') =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    label,
  ).toBeLessThanOrEqual(1);

const casesTable = (page: Page) => page.getByRole('table', { name: 'Casos do cliente' });
const bar = (page: Page) => page.getByRole('region', { name: 'Ações em lote' });
const dialog = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name });
const closeDialog = (opened: Locator) =>
  opened.getByRole('button', { name: 'Fechar', exact: true }).last().click();

/** Abre o diálogo do grupo do openssl (mais de 200 alertas: vai para a fila) e pede "em análise". */
async function queueGroup(page: Page) {
  await open(page, '/?visao=vulnerabilidades');
  await page.getByRole('button', { name: 'Tratar o grupo openssl' }).click();
  const opened = dialog(page, 'Tratar: pacote openssl');
  await opened.getByRole('radio', { name: /^Em análise/ }).check();
  // Os críticos ficam de fora, e quem já está em análise também: a prévia diz quantos são os novos de cada severidade.
  await opened.getByRole('button', { name: /^Colocar \d+ alertas em análise$/ }).click();
  const outcome = dialog(page, 'Em análise: pacote openssl');
  await expect(outcome).toBeVisible();
  return outcome;
}

test.describe('casos desligados (modo mock)', () => {
  test('a tela é a de sempre: as duas visões, os mesmos filtros, sem caixas nem histórico, e um pedido só a mais', async ({
    page,
  }) => {
    await prepare(page, { cases: 'off' });
    const requests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/v1/')) requests.push(url.pathname);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/?visao=casos');
    await expect(page.getByRole('table', { name: 'Alertas do cliente' })).toBeVisible();
    const list = page.getByRole('group', { name: 'Visão da lista' }).locator('xpath=..');
    await expect(list.locator('> *').nth(0)).toMatchAriaSnapshot(`
      - group "Visão da lista":
        - button "Alertas" [pressed]
        - button "Incidentes"
    `);
    await expect(list.locator('> *').nth(1)).toMatchAriaSnapshot(`
      - search:
        - text: Buscar
        - searchbox "Buscar"
        - button "Buscar"
      - text: Período
      - combobox "Período"
      - text: Severidade
      - combobox "Severidade"
      - text: Status
      - combobox "Status"
      - button "Mais filtros"
    `);
    await expect(list.locator('> *')).toHaveCount(3);
    await expect(page.getByRole('table', { name: 'Alertas do cliente' }).getByRole('row').first())
      .toMatchAriaSnapshot(`
      - row "Severidade Alerta Status Incidente":
        - columnheader "Severidade"
        - columnheader "Alerta"
        - columnheader "Status"
        - columnheader "Incidente"
    `);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    expect(requests.filter((path) => path.startsWith('/v1/cases') || path.startsWith('/v1/triage'))).toEqual([
      '/v1/cases/status',
    ]);
  });
});

test.describe('casos (modo mock): acessibilidade', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [360, 768, 1280] as const) {
      test(`a lista, as vulnerabilidades, o detalhe e os diálogos (${theme === 'light' ? 'claro' : 'escuro'}, ${width} px)`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        await prepare(page, { theme });
        await page.setViewportSize({ width, height: 900 });
        await open(page);
        await expect(casesTable(page)).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'lista');

        // O histórico aberto.
        const panel = page.getByRole('region', { name: 'Operações recentes' });
        await panel.getByRole('button', { name: /Mostrar/ }).click();
        await expect(panel.getByText('Pacote atualizado na imagem base.')).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await panel.getByRole('button', { name: /Recolher/ }).click();

        // A seleção e a barra; no celular, pelo modo de seleção.
        if (width < 768) await page.getByRole('button', { name: 'Selecionar', exact: true }).click();
        await page.getByRole('checkbox', { name: /^Selecionar: Senha de console/ }).check();
        await page.getByRole('checkbox', { name: /^Selecionar: Login do usuário root/ }).check();
        await expect(bar(page).getByRole('status')).toHaveText('2 casos · 2 alertas');
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'barra');

        // O diálogo, com o item protegido e o motivo.
        await bar(page)
          .getByRole('button', { name: width < 768 ? 'Tratar a seleção' : 'Legítimo' })
          .click();
        const bulk = dialog(page, 'Tratar: 2 casos');
        await bulk.getByRole('radio', { name: /^Legítimo/ }).check();
        await expect(bulk.getByText('1 caso toca a lista de proteção')).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'diálogo');
        await page.keyboard.press('Escape');
        await expect(bulk).toHaveCount(0);

        // O detalhe, e um alerta dentro dele.
        await page.getByRole('button', { name: /^Abrir o caso: Chamadas negadas/ }).click();
        const detail =
          width === 1280
            ? page.getByRole('complementary', { name: /^Chamadas negadas/ })
            : dialog(page, /^Chamadas negadas/);
        await expect(detail.getByRole('img', { name: /^Alertas do caso por hora/ })).toBeVisible();
        await expect(detail.getByRole('link', { name: /^Chamadas negadas/ }).first()).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'detalhe');
        await detail
          .getByRole('link', { name: /^Chamadas negadas/ })
          .first()
          .click();
        await expect(page.getByRole('button', { name: 'Voltar ao caso' })).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await violations(page)).toEqual([]);

        // As vulnerabilidades, com um grupo aberto, e o diálogo do grupo com os críticos.
        await open(page, '/?visao=vulnerabilidades');
        await page.getByRole('button', { name: 'Abrir os casos do grupo: openssl' }).click();
        await expect(
          page.getByRole('button', { name: /^Abrir o caso: Vulnerabilidade em pacote, openssl/ }),
        ).toHaveCount(4);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page, 'vulnerabilidades');
        await page.getByRole('button', { name: 'Tratar o grupo openssl' }).click();
        await expect(
          page.getByRole('checkbox', { name: /^Incluir também os 3 alertas críticos/ }),
        ).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });
    }
  }

  test('nenhuma largura de 320 a 1920 px rola para o lado, e as tabelas cabem ao lado do radar', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await prepare(page);
    for (const path of ['/', '/?visao=vulnerabilidades', '/?visao=alertas', '/?fila=postura']) {
      for (const width of [320, 390, 640, 768, 1024, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await open(page, path);
        await noHorizontalScroll(page, `${path} em ${width} px`);
        if (path === '/?visao=alertas' && width < 1440) continue;
        const region = page.locator('[data-tour="deteccoes-lista"]');
        expect(
          await region.evaluate((element) => element.scrollWidth - element.clientWidth),
          `a tabela de ${path} em ${width} px`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  test('a visão das quatro listas é um grupo de botões, e o teclado chega a todas', async ({ page }) => {
    await prepare(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const views = page.getByRole('group', { name: 'Visão da lista' });
    await expect(views.getByRole('button')).toHaveText([
      'Casos',
      'Alertas',
      'Incidentes',
      'Vulnerabilidades',
    ]);
    await views.getByRole('button', { name: 'Casos' }).focus();
    for (const [name, url] of [
      ['Alertas', /visao=alertas/],
      ['Incidentes', /visao=incidentes/],
      ['Vulnerabilidades', /visao=vulnerabilidades/],
    ] as const) {
      await page.keyboard.press('Tab');
      await expect(views.getByRole('button', { name })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(url);
      await expect(views.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('no celular, o toque tem 44 px: as visões, as caixas, a barra e as ações', async ({ page }) => {
    await prepare(page);
    await page.setViewportSize({ width: 360, height: 760 });
    await open(page);
    const tall = async (locator: Locator, label: string) => {
      const box = await locator.boundingBox();
      expect(box?.height ?? 0, label).toBeGreaterThanOrEqual(43.5);
    };
    await tall(
      page.getByRole('group', { name: 'Visão da lista' }).getByRole('button', { name: 'Casos' }),
      'visão',
    );
    const selecting = page.getByRole('button', { name: 'Selecionar', exact: true });
    await tall(selecting, 'selecionar');
    // Sem o modo de seleção, as caixas não estão na tela.
    await expect(page.getByRole('checkbox', { name: /^Selecionar: / })).toHaveCount(0);
    await selecting.click();
    const box = page.getByRole('checkbox', { name: /^Selecionar: Senha de console/ });
    await tall(box.locator('xpath=..'), 'caixa');
    await box.locator('xpath=..').click({ position: { x: 4, y: 4 } });
    await expect(box).toBeChecked();
    await tall(bar(page).getByRole('button', { name: 'Tratar a seleção' }), 'tratar');
    await tall(bar(page).getByRole('button', { name: 'Limpar a seleção' }), 'limpar');
    // A barra fica presa ao pé da tela.
    const place = await bar(page).boundingBox();
    expect(Math.round((place?.y ?? 0) + (place?.height ?? 0))).toBe(760);
    // A paginação sobe acima da barra ao rolar até o fim.
    await page.getByRole('navigation', { name: 'Paginação' }).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const pagination = await page.getByRole('navigation', { name: 'Paginação' }).boundingBox();
    expect((pagination?.y ?? 0) + (pagination?.height ?? 0)).toBeLessThanOrEqual(place?.y ?? 0);
    await bar(page).getByRole('button', { name: 'Tratar a seleção' }).click();
    const bulk = dialog(page, /^Tratar:/);
    await tall(bulk.getByRole('button', { name: 'Escolha o que fazer' }), 'confirmar');
    await tall(bulk.getByRole('radio', { name: /^Legítimo/ }).locator('xpath=..'), 'opção');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Cancelar a seleção' }).click();
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /^Selecionar: / })).toHaveCount(0);
  });
});

test.describe('casos (modo mock): os fluxos', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('a lista, os filtros na URL, o detalhe e a volta do alerta com o foco', async ({ page }) => {
    await prepare(page);
    await open(page);
    await expect(
      casesTable(page)
        .getByRole('button', { name: /^Abrir o caso/ })
        .first(),
    ).toHaveAccessibleName(/^Abrir o caso: Senha de console/);
    await page.getByRole('combobox', { name: 'Situação' }).selectOption('treated');
    await expect(page).toHaveURL(/estado=tratados/);
    await expect(page.getByRole('combobox', { name: 'Severidade' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Limpar filtros' }).click();
    await page.getByRole('combobox', { name: 'Severidade' }).selectOption('low');
    await expect(page).toHaveURL(/\/\?severidade=low$/);
    await page.getByRole('button', { name: /^Abrir o caso: Chamadas negadas/ }).click();
    const aside = page.getByRole('complementary', { name: /^Chamadas negadas/ });
    await expect(aside.getByRole('heading', { level: 2 })).toBeFocused();
    const rare = aside.getByRole('region', { name: 'O que foge do padrão' });
    await expect(rare.getByRole('listitem').first()).toContainText('198.51.100.200');
    const alert = aside.getByRole('link', { name: /^Chamadas negadas/ }).nth(2);
    await alert.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/caso=.*alerta=/);
    await page.getByRole('button', { name: 'Voltar ao caso' }).click();
    await expect(page).not.toHaveURL(/alerta=/);
    await expect(aside.getByRole('link', { name: /^Chamadas negadas/ }).nth(2)).toBeFocused();
    // O voltar do navegador também funciona, e Esc fecha com o foco na linha.
    await page.goBack();
    await expect(page.getByRole('button', { name: 'Voltar ao caso' })).toBeVisible();
    await page.goForward();
    await page.keyboard.press('Escape');
    await expect(aside).toHaveCount(0);
  });

  test('teclado: Espaço marca, Shift marca o trecho, o diálogo prende o foco e o devolve', async ({
    page,
  }) => {
    await prepare(page);
    await open(page);
    const boxes = page.getByRole('checkbox', { name: /^Selecionar: / });
    await boxes.nth(0).focus();
    await page.keyboard.press('Space');
    await expect(bar(page).getByRole('status')).toHaveText('1 caso · 1 alerta');
    await boxes.nth(3).click({ modifiers: ['Shift'] });
    await expect(bar(page).getByRole('status')).toHaveText('4 casos · 4 alertas');
    // Pelo rótulo em volta da caixa (a área de toque), também.
    await boxes
      .nth(5)
      .locator('xpath=..')
      .click({ modifiers: ['Shift'], position: { x: 4, y: 4 } });
    await expect(bar(page).getByRole('status')).toHaveText('6 casos · 6 alertas');
    await page.getByRole('checkbox', { name: 'Selecionar os casos desta página' }).check();
    const promote = bar(page).getByRole('button', { name: 'Promover a incidente' });
    await promote.focus();
    await page.keyboard.press('Enter');
    const bulk = dialog(page, /^Tratar:/);
    await expect(bulk).toBeVisible();
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      expect(await bulk.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    // Um Enter numa opção não confirma nada.
    await bulk.getByRole('radio', { name: /^Em análise/ }).focus();
    await page.keyboard.press('Enter');
    await expect(bulk.getByRole('radio', { name: /^Em análise/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(bulk).toHaveCount(0);
    await expect(promote).toBeFocused();
  });

  test('tratar casos e desfazer: o motivo, o resumo, as contagens e o histórico', async ({ page }) => {
    await prepare(page);
    await open(page);
    await page.getByRole('checkbox', { name: /^Selecionar: Login do usuário root/ }).check();
    await page.getByRole('checkbox', { name: /^Selecionar: Tentativa de desativar/ }).check();
    await bar(page).getByRole('button', { name: 'Legítimo' }).click();
    const bulk = dialog(page, 'Tratar: 2 casos');
    const confirm = bulk.getByRole('button', { name: 'Marcar 2 alertas como legítimos' });
    await expect(confirm).toBeDisabled();
    await bulk.getByLabel('Motivo (obrigatório)').fill('Janela de manutenção.');
    await confirm.click();
    const outcome = dialog(page, 'Legítimo: 2 casos');
    await expect(outcome.getByText('2 alertas mudaram.')).toBeVisible();
    await closeDialog(outcome);
    await expect(page.getByRole('region', { name: 'Lista de casos' })).toBeFocused();
    await expect(page.getByRole('button', { name: /^Abrir o caso: Login do usuário root/ })).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);

    // O histórico fica na tela: dá para desfazer depois de recarregar a lista, até o prazo.
    const panel = page.getByRole('region', { name: 'Operações recentes' });
    await panel.getByRole('button', { name: /Mostrar/ }).click();
    await expect(panel.getByText('Janela de manutenção.')).toBeVisible();
    await expect(panel.getByText(/^Dá para desfazer até /)).toBeVisible();
    await panel.getByRole('button', { name: /^Desfazer ?: Marcar como legítimo$/ }).click();
    const undo = dialog(page, 'Desfazer: Marcar como legítimo');
    await undo.getByRole('button', { name: 'Desfazer', exact: true }).click();
    await expect(undo.getByText('2 alertas voltaram ao que eram.')).toBeVisible();
    await closeDialog(undo);
    await expect(page.getByRole('button', { name: /^Abrir o caso: Login do usuário root/ })).toBeVisible();
    await expect(panel.getByText('Desfeita', { exact: true })).toBeVisible();
  });

  test('o grupo inteiro: os críticos só com a inclusão, a fila com o andamento e o resumo', async ({
    page,
  }) => {
    await prepare(page);
    await open(page, '/?visao=vulnerabilidades');
    await page.getByRole('button', { name: 'Tratar o grupo openssl' }).click();
    const bulk = dialog(page, 'Tratar: pacote openssl');
    await bulk.getByRole('radio', { name: /^Resolvido/ }).check();
    await bulk.getByLabel('Motivo (obrigatório)').fill('Imagem base atualizada.');
    await expect(bulk.getByRole('button', { name: 'Marcar 212 alertas como resolvidos' })).toBeEnabled();
    await bulk.getByRole('checkbox', { name: /^Incluir também os 3 alertas críticos/ }).check();
    await expect(bulk.getByRole('button', { name: 'Marcar 215 alertas como resolvidos' })).toBeEnabled();
    await bulk.getByRole('checkbox', { name: /^Incluir também/ }).uncheck();
    await bulk.getByRole('button', { name: 'Marcar 212 alertas como resolvidos' }).click();
    const outcome = dialog(page, 'Resolvido: pacote openssl');
    await expect(outcome.getByRole('progressbar')).toBeVisible();
    await expect(outcome.getByText('3 alertas críticos ficaram de fora.')).toBeVisible();
    await expect(outcome.getByText('212 alertas mudaram.')).toBeVisible();
    await closeDialog(outcome);
    await expect(page.getByRole('row', { name: /^Abrir os casos do grupo: openssl/ })).toContainText('3');
  });

  test('o conjunto mudou: confirma de novo com o número novo', async ({ page }) => {
    await prepare(page, { triage: 'mudou' });
    await open(page);
    await page.getByRole('checkbox', { name: /^Selecionar: Login do usuário root/ }).check();
    await bar(page).getByRole('button', { name: 'Em análise' }).click();
    const bulk = dialog(page, /^Tratar:/);
    await bulk.getByRole('button', { name: 'Colocar 1 alerta em análise' }).click();
    await expect(bulk.getByRole('alert')).toContainText('agora são 61 alertas');
    await bulk.getByRole('button', { name: 'Colocar 61 alertas em análise' }).click();
    await expect(page.getByText('61 alertas mudaram.')).toBeVisible();
  });

  test('a cota do analista: acima de 2.000 nem pede; quem administra digita a quantidade', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await prepare(page, { volume: 2_700 });
    await open(page, '/?visao=vulnerabilidades');
    await page.getByRole('button', { name: 'Tratar o grupo openssl' }).click();
    const bulk = dialog(page, 'Tratar: pacote openssl');
    await bulk.getByRole('radio', { name: /^Em análise/ }).check();
    await expect(bulk.getByRole('alert')).toContainText('só um administrador');
    await expect(bulk.getByRole('button', { name: /^Colocar/ })).toBeDisabled();

    const context = await browser.newContext({
      storageState: await page.context().storageState(),
      viewport: { width: 1440, height: 900 },
      baseURL: new URL(page.url()).origin,
    });
    const admin = await context.newPage();
    await prepare(admin, { role: 'admin_cliente', volume: 2_700 });
    await open(admin, '/?visao=vulnerabilidades');
    await admin.getByRole('button', { name: 'Tratar o grupo openssl' }).click();
    const allowed = dialog(admin, 'Tratar: pacote openssl');
    await allowed.getByRole('radio', { name: /^Em análise/ }).check();
    const confirm = allowed.getByRole('button', { name: /^Colocar/ });
    await expect(confirm).toBeDisabled();
    const label = (await allowed.getByText(/Digite [\d.]+ para confirmar/).textContent()) ?? '';
    const words = label.split(' ');
    const count = words[words.indexOf('Digite') + 1] ?? '';
    await allowed.getByLabel(/Digite [\d.]+ para confirmar/).fill(count);
    await expect(confirm).toBeEnabled();
    expect(await violations(admin)).toEqual([]);
    await context.close();
  });

  test('a fila: fechar não para nada, o painel mostra o andamento e cancela', async ({ page }) => {
    await prepare(page, { triage: 'lenta' });
    const outcome = await queueGroup(page);
    await closeDialog(outcome);
    const panel = page.getByRole('region', { name: 'Operações recentes' });
    await expect(panel).toContainText(/Colocar em análise: \d+ de 20\d alertas/);
    await panel.getByRole('button', { name: /Mostrar/ }).click();
    await expect(panel.getByRole('progressbar')).toBeVisible();
    await expect
      .poll(async () => Number(await panel.getByRole('progressbar').getAttribute('aria-valuenow')))
      .toBeGreaterThan(0);
    expect(await violations(page)).toEqual([]);
    await panel.getByRole('button', { name: /^Cancelar ?: Colocar em análise$/ }).click();
    await expect(panel.getByText('Cancelada', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Desfazer ?: Colocar em análise$/ })).toBeVisible();
  });

  test('parou no meio: o motivo, e continuar termina', async ({ page }) => {
    await prepare(page, { triage: 'parcial' });
    const outcome = await queueGroup(page);
    await expect(outcome.getByText('Parou antes do fim.')).toBeVisible();
    await expect(outcome).toContainText('3 não puderam ser gravados');
    expect(await violations(page)).toEqual([]);
    await outcome.getByRole('button', { name: /^Continuar/ }).click();
    await expect(outcome.getByText('Pronto.')).toBeVisible();
  });

  test('banco ocupado: nada mudou, e tentar de novo conclui', async ({ page }) => {
    await prepare(page, { triage: 'ocupada' });
    await open(page);
    await page.getByRole('checkbox', { name: /^Selecionar: Login do usuário root/ }).check();
    await bar(page).getByRole('button', { name: 'Em análise' }).click();
    const bulk = dialog(page, /^Tratar:/);
    await bulk.getByRole('button', { name: 'Colocar 1 alerta em análise' }).click();
    await expect(bulk.getByRole('alert')).toContainText('ocupado');
    await bulk.getByRole('button', { name: 'Colocar 1 alerta em análise' }).click();
    await expect(page.getByText('1 alerta mudou.')).toBeVisible();
  });

  test('desfazer tudo de uma pessoa: só quem administra, com o nome e o motivo', async ({ page }) => {
    await prepare(page, { role: 'admin_cliente' });
    await open(page);
    const panel = page.getByRole('region', { name: 'Operações recentes' });
    await panel.getByRole('button', { name: /Mostrar/ }).click();
    await panel.getByRole('combobox', { name: 'De quem' }).selectOption({ label: 'João Lima' });
    await panel.getByRole('button', { name: 'Desfazer tudo de João Lima' }).click();
    const all = dialog(page, 'Desfazer tudo de João Lima');
    const confirm = all.getByRole('button', { name: 'Desfazer tudo', exact: true });
    await expect(confirm).toBeDisabled();
    await all.getByLabel('Motivo (obrigatório)').fill('Conta usada por outra pessoa.');
    await all.getByLabel('Digite João Lima para confirmar').fill('João Lima');
    expect(await violations(page)).toEqual([]);
    await confirm.click();
    await expect(all.getByText('1 operação vai ser desfeita.')).toBeVisible();
    await closeDialog(all);
    await panel.getByRole('combobox', { name: 'De quem' }).selectOption({ label: 'Todas as pessoas' });
    await expect(panel.getByText('Desfeita', { exact: true })).toBeVisible();
  });

  test('o subgrupo: tratar e separar em outro caso', async ({ page }) => {
    await prepare(page);
    await open(page, '/?fila=postura');
    await page
      .getByRole('button', {
        name: /^Abrir o caso: Controle de segurança reprovado, arn:aws:s3:::loja-exemplo-backups/,
      })
      .first()
      .click();
    const aside = page.getByRole('complementary', { name: 'Controle de segurança reprovado' });
    await aside
      .getByRole('button', { name: /^Tratar este grupo ?: arn:aws:s3:::loja-exemplo-relatorios$/ })
      .click();
    const bulk = dialog(page, 'Tratar: grupo arn:aws:s3:::loja-exemplo-relatorios');
    await bulk.getByRole('radio', { name: /^Resolvido/ }).check();
    await bulk.getByRole('button', { name: 'Marcar 1 alerta como resolvido' }).click();
    await closeDialog(dialog(page, /^Resolvido: grupo/));
    await expect(aside.getByRole('region', { name: 'Operações em massa' })).toContainText(
      'Marcar como resolvido',
    );
    await aside
      .getByRole('button', { name: 'Separar em outro caso: arn:aws:s3:::loja-exemplo-imagens' })
      .click();
    const split = dialog(page, 'Separar em outro caso');
    expect(await violations(page)).toEqual([]);
    await split.getByRole('button', { name: 'Separar 1 alerta' }).click();
    await split.getByRole('link', { name: 'Abrir o caso novo' }).click();
    await expect(page.getByText(/Nasceu de um caso dividido/)).toBeVisible();
  });

  test('os alertas da lista em massa: os de incidente não se marcam', async ({ page }) => {
    await prepare(page);
    await open(page, '/?visao=alertas');
    await expect(
      page.getByRole('checkbox', { name: /Tentativa de desligar.*já está num incidente/ }),
    ).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Selecionar os alertas desta página' }).check();
    await expect(bar(page).getByRole('status')).toContainText(/^\d+ alertas/);
    await bar(page).getByRole('button', { name: 'Em análise' }).click();
    const bulk = dialog(page, /^Tratar:/);
    await bulk.getByRole('button', { name: /^Colocar \d+ alertas em análise$/ }).click();
    await expect(page.getByText(/^\d+ alertas mudaram\.$/)).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('a medição: a equipe da Verax lê, e ninguém trata', async ({ page }) => {
    await prepare(page, { role: 'admin_verax', cases: 'shadow' });
    await open(page, '/?visao=casos');
    await expect(page.getByText(/^Medição: só a equipe da Verax/)).toBeVisible();
    await expect(casesTable(page)).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });

  test('exporta os casos em CSV', async ({ page }) => {
    await prepare(page);
    await open(page);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar CSV' }).click();
    expect((await download).suggestedFilename()).toMatch(/^verax-casos-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test('nenhum <style> injetado: a CSP de produção recusaria', async ({ page }) => {
    await prepare(page);
    await open(page);
    await page.getByRole('checkbox', { name: /^Selecionar: Login do usuário root/ }).check();
    await bar(page).getByRole('button', { name: 'Em análise' }).click();
    await expect(dialog(page, /^Tratar:/)).toBeVisible();
    await expect(page.locator('style:not([data-vite-dev-id])')).toHaveCount(0);
  });
});
