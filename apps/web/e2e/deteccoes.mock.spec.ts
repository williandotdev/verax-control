import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Tela Detecções (16/11/2026, no lugar da Torre, de Incidentes, de Achados e de Relatórios) no navegador, sobre a
 * demonstração (`dev:mock`): sem violação de acessibilidade (WCAG 2.2 AA, inclusive contraste) nos dois temas, no
 * computador e a 390 px, com o que só aparece na interação (a gaveta da coleta com o pulso, a lista de alertas e a de
 * incidentes, os alertas de um incidente, o detalhe ao lado ou na gaveta, o diálogo de promover a incidente, os filtros
 * a mais e as análises); sem rolagem horizontal da página; o resumo recolhido lembrado; os endereços de antes; e a
 * exportação em CSV.
 */

const INCIDENT = '018f2c1e-0000-7000-8000-0000000a0001';
const FINDING = '018f2c1e-0000-7000-8000-000000001001';
const INCIDENT_TITLE = /^Atividade suspeita com a chave de acesso/;
/** "Política de bucket alterada para permitir leitura pública": alerta a validar, com um relacionado. */
const BUCKET_ALERT = '018f2c1e-0000-7000-8000-00000000100e';

async function open(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Detecções' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

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

test.describe('tela Detecções (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('verax.mock.role', 'analista_cliente');
      // Com os casos desligados (o padrão de um nó), a tela de sempre. Com eles, `casos.mock.spec.ts`.
      window.localStorage.setItem('verax.mock.cases', 'off');
    });
    await skipDemoTour(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width] of [
      ['computador', 1440],
      ['celular', 390],
    ] as const) {
      const label = `${theme === 'light' ? 'claro' : 'escuro'}, ${device}`;

      test(`o resumo, a coleta, a lista e o detalhe (${label}): sem violação de acessibilidade`, async ({
        page,
      }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        await open(page);
        const strip = page.getByRole('region', { name: 'Situação agora' });
        // No celular, o resumo começa recolhido: as contagens numa linha.
        if (device === 'celular') {
          await expect(
            strip.getByRole('status', { name: /^Situação: 1 incidente crítico aberto/ }),
          ).toBeVisible();
          expect(await violations(page)).toEqual([]);
          await strip.getByRole('button', { name: /^Mostrar/ }).click();
        }
        // Os motivos e, depois deles, quantos alertas altos ou críticos esperam validação.
        await expect(
          strip.getByRole('status', {
            name: /coleta parada \(GCP\)\. \d+ alertas altos ou críticos para validar\.$/,
          }),
        ).toBeVisible();
        await expect(strip.getByRole('region', { name: 'Decisões pendentes' })).toBeVisible();
        await expect(strip.getByRole('region', { name: 'Radar das últimas 24 horas' })).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);

        // A saúde da coleta numa gaveta, com o pulso (o minigráfico com a dica pelo teclado).
        await strip.getByRole('button', { name: /^Coleta parada: GCP/ }).click();
        const health = page.getByRole('dialog', { name: 'Saúde da coleta' });
        await expect(health.getByText('Parada', { exact: true })).toBeVisible();
        await expect(health.getByRole('region', { name: 'Agentes online' })).toContainText('3 de 5');
        await health.getByRole('img', { name: /^Alertas por hora nas últimas 24 horas/ }).focus();
        await page.keyboard.press('ArrowLeft');
        await expect(page.getByText(/^\d{2}:\d{2}: \d+ alertas?\.$/)).toBeAttached();
        expect(await violations(page)).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(health).toHaveCount(0);

        // A lista de alertas (o padrão), com a marca dos que estão em incidente.
        const alerts = page.getByRole('table', { name: 'Alertas do cliente' });
        // No celular, a marca vai em texto embaixo do título; no computador, é o botão que abre o incidente.
        await expect(
          device === 'celular'
            ? alerts.getByText('em incidente', { exact: true }).first()
            : alerts.getByRole('button', { name: /^Em incidente/ }).first(),
        ).toBeVisible();
        expect(await violations(page)).toEqual([]);

        // O alerta a validar: o diálogo de promover a incidente, com os relacionados.
        // No celular, o detalhe abre numa gaveta modal, que tira o resto da tela da árvore de acessibilidade.
        await page.goto(`/?alerta=${BUCKET_ALERT}`);
        await page.getByRole('button', { name: 'É uma ameaça real' }).click();
        const promote = page.getByRole('dialog', { name: 'Promover a incidente' });
        await expect(promote.getByRole('checkbox', { name: /Bloqueio de acesso público/ })).toBeChecked();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
        await promote.getByRole('button', { name: 'Cancelar' }).click();
        await expect(promote).toHaveCount(0);
        if (device === 'celular') {
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toHaveCount(0);
        } else {
          await page.getByRole('button', { name: 'Fechar o detalhe' }).click();
        }

        // A lista de incidentes, com os alertas de um incidente abertos e os filtros a mais.
        await page.getByRole('button', { name: 'Incidentes', exact: true }).click();
        const list = page.getByRole('table', { name: /^Incidentes do cliente/ });
        await list
          .getByRole('button', { name: /^Abrir os alertas do incidente: Atividade suspeita com a chave/ })
          .click();
        await expect(
          list.getByRole('button', { name: /^Abrir o alerta: Tentativa de desligar/ }),
        ).toBeVisible();
        // No celular, os filtros ficam na folha "Filtros" (E-02).
        if (device === 'celular') await page.getByRole('button', { name: /^Filtros/ }).click();
        await page.getByRole('button', { name: 'Mais filtros' }).click();
        await expect(page.getByLabel('Tática do MITRE')).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
        if (device === 'celular') await page.keyboard.press('Escape');

        // O detalhe: ao lado da lista no computador, numa gaveta no celular.
        await list
          .getByRole('button', { name: /^Abrir o incidente: Atividade suspeita com a chave/ })
          .click();
        const detail =
          device === 'computador'
            ? page.getByRole('complementary', { name: INCIDENT_TITLE })
            : page.getByRole('dialog', { name: INCIDENT_TITLE });
        await expect(detail.getByRole('heading', { name: 'Resumo' })).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
      });

      test(`as análises: MITRE ATT&CK e cobertura das fontes (${label})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        await open(page, '/?analise=mitre&periodo=7d');
        await expect(page.getByRole('tab', { name: 'MITRE ATT&CK' })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await expect(page.getByRole('group', { name: /^Gráfico de radar das táticas/ })).toBeVisible();
        // R-11: a tabela completa fica atrás de "Ver tabela completa"; aberta, também sem violação.
        await expect(page.getByRole('table', { name: 'Táticas e técnicas do MITRE ATT&CK' })).toBeHidden();
        await page.getByText(/^Ver tabela completa \(14 táticas/).click();
        await expect(page.getByRole('table', { name: 'Táticas e técnicas do MITRE ATT&CK' })).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
        await page.getByRole('tab', { name: 'Cobertura das fontes' }).click();
        await expect(
          page.getByRole('table', { name: 'Contas monitoradas e o que chegou de cada uma' }),
        ).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);
      });
    }

    test(`"Tudo calmo" da Beta (${theme === 'light' ? 'claro' : 'escuro'}): sem violação de acessibilidade`, async ({
      page,
    }) => {
      await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'admin_verax'));
      await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
      await open(page);
      await page.getByLabel('Cliente').selectOption({ label: 'Cliente Demo Beta' });
      const strip = page.getByRole('region', { name: 'Situação agora' });
      await expect(strip.getByRole('status', { name: /^Situação: Tudo calmo\./ })).toContainText(
        'Coleta ativa em 2 de 2 fontes',
      );
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });
  }

  test('no computador, a lista fica ao lado do radar, e as análises são abas no mesmo nível de "Lista" (E-07)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const radar = await page.getByRole('region', { name: 'Radar das últimas 24 horas' }).boundingBox();
      const list = await page.getByRole('region', { name: 'Lista de alertas' }).boundingBox();
      await expect(page.getByRole('tab', { name: 'Lista' })).toHaveAttribute('aria-selected', 'true');
      const tab = await page.getByRole('tab', { name: 'Resumo' }).boundingBox();
      if (!radar || !list || !tab) throw new Error('sem o radar, a lista ou as análises na tela');
      expect(list.x).toBeGreaterThanOrEqual(radar.x + radar.width);
      expect(list.y).toBeLessThan(radar.y + radar.height);
      // As abas ficam acima da lista, na mesma coluna.
      expect(tab.y).toBeLessThan(list.y);
      expect(tab.x).toBeGreaterThanOrEqual(radar.x + radar.width);
      await noHorizontalScroll(page);
      // Os alertas cabem na coluna ao lado do radar, sem rolar por dentro, nas duas visões.
      for (const [view, name] of [
        ['Alertas', 'Lista de alertas'],
        ['Incidentes', 'Lista de incidentes'],
      ] as const) {
        await page.getByRole('button', { name: view, exact: true }).click();
        const region = page.getByRole('region', { name });
        await expect(region).toBeVisible();
        expect(
          await region.evaluate((element) => element.scrollWidth - element.clientWidth),
          `${view} em ${width} px`,
        ).toBeLessThanOrEqual(1);
      }
    }
    // Na tela estreita, como antes: a lista é a primeira aba.
    await page.setViewportSize({ width: 1100, height: 900 });
    await open(page);
    await expect(page.getByRole('tab', { name: 'Lista' })).toHaveAttribute('aria-selected', 'true');
    await noHorizontalScroll(page);
  });

  for (const [width, height] of [
    [1280, 900],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    test(`em ${width} px, a coluna da lista termina na altura do quadro do radar, e só a tabela rola`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await open(page);
      const strip = page.getByRole('region', { name: 'Situação agora' });
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      for (const [view, name] of [
        ['Alertas', 'Lista de alertas'],
        ['Incidentes', 'Lista de incidentes'],
      ] as const) {
        await page.getByRole('button', { name: view, exact: true }).click();
        const region = page.getByRole('region', { name });
        await expect(region).toBeVisible();
        const bottoms = async () => {
          const [left, right] = await Promise.all([
            strip.boundingBox(),
            page.locator('[data-list-frame]').boundingBox(),
          ]);
          return Math.abs((left?.y ?? 0) + (left?.height ?? 0) - (right?.y ?? 0) - (right?.height ?? 0));
        };
        await expect.poll(bottoms, `${view} em ${width} px`).toBeLessThanOrEqual(1);
        // O cabeçalho fica à vista quando a tabela rola.
        const shift = await region.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          const head = element.querySelector('thead');
          return (head?.getBoundingClientRect().top ?? -1) - element.getBoundingClientRect().top;
        });
        expect(Math.abs(shift)).toBeLessThanOrEqual(1);
      }
      await page.getByRole('button', { name: 'Alertas', exact: true }).click();
      await noHorizontalScroll(page);
    });
  }

  test('recolher o resumo alarga a lista e fica lembrado depois de recarregar', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const list = page.getByRole('region', { name: 'Lista de alertas' });
    const before = (await list.boundingBox())?.width ?? 0;
    // O botão do próprio resumo: o menu lateral tem o seu ("Recolher menu").
    const situation = page.getByRole('region', { name: 'Situação agora' });
    await situation.getByRole('button', { name: /^Recolher/ }).click();
    await expect.poll(async () => (await list.boundingBox())?.width ?? 0).toBeGreaterThan(before + 200);
    await page.reload();
    await expect(situation.getByRole('button', { name: /^Mostrar/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('teclado: o detalhe ao lado abre com Enter, fecha com Esc e o foco volta para o item', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/?severidade=critical');
    const finding = page.getByRole('button', {
      name: 'Abrir o alerta: Tentativa de desligar a trilha do CloudTrail',
    });
    await finding.focus();
    await page.keyboard.press('Enter');
    const aside = page.getByRole('complementary', { name: 'Tentativa de desligar a trilha do CloudTrail' });
    await expect(aside.getByRole('heading', { level: 2 })).toBeFocused();
    // Não é modal: a lista continua na árvore de acessibilidade.
    await expect(page.getByRole('table', { name: 'Alertas do cliente' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(aside).toHaveCount(0);
    await expect(finding).toBeFocused();
  });

  test('os endereços de antes levam à visão equivalente', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/incidentes/${INCIDENT}`);
    await expect(page).toHaveURL(new RegExp(`/\\?incidente=${INCIDENT}$`));
    await expect(page.getByRole('complementary', { name: INCIDENT_TITLE })).toBeVisible();

    await page.goto(`/achados?achado=${FINDING}`);
    await expect(page).toHaveURL(`/?visao=alertas&alerta=${FINDING}`);
    await expect(
      page.getByRole('complementary', { name: 'Tentativa de desligar a trilha do CloudTrail' }),
    ).toBeVisible();

    await page.goto('/relatorios?aba=mitre');
    await expect(page).toHaveURL(/\/\?analise=mitre$/);
    await expect(page.getByRole('tab', { name: 'MITRE ATT&CK' })).toHaveAttribute('aria-selected', 'true');
  });

  test('exporta em CSV a lista filtrada', async ({ page }) => {
    await open(page, '/?severidade=critical');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^verax-alertas-\d{4}-\d{2}-\d{2}\.csv$/);
    await expect(page.getByText(/^\d+ linhas? exportadas?\.$/)).toBeVisible();
  });
});

/** As propostas da auditoria de UX (25/11/2026) que só o navegador mede: posição, largura e área de toque. */
test.describe('Detecções: arrumação por largura (auditoria de UX)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('verax.mock.role', 'analista_cliente');
      window.localStorage.setItem('verax.mock.cases', 'off');
    });
    await skipDemoTour(page);
  });

  test('E-02 e E-11: no celular, a primeira tela responde, mostra a lista e todo alvo de toque tem 44 px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await open(page);
    const strip = page.getByRole('region', { name: 'Situação agora' });
    const rows = strip.getByRole('list', { name: 'Resumo da situação' });
    await expect(rows.getByText('Coleta parada: GCP')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Filtros/ })).toBeVisible();
    await expect(page.getByLabel('Severidade')).toBeHidden();
    // Uma barra só no topo; o tema e "Sair" no menu.
    await expect(page.getByRole('button', { name: 'Sair' })).toBeHidden();
    const targets = [
      page.getByRole('button', { name: 'Menu' }),
      page.getByRole('link', { name: 'Minha conta' }),
      strip.getByRole('button', { name: /^Mostrar/ }),
      ...(await rows.getByRole('link').all()),
      ...(await rows.getByRole('button').all()),
      page.getByRole('tab', { name: 'Lista' }),
      page.getByRole('button', { name: 'Alertas', exact: true }),
      page.getByRole('button', { name: /^Filtros/ }),
    ];
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box?.height ?? 0, (await target.textContent()) ?? '').toBeGreaterThanOrEqual(43.5);
    }
    // A linha inteira do alerta é o alvo do toque.
    const row = page.getByRole('region', { name: 'Lista de alertas' }).getByRole('row').nth(1);
    await row.scrollIntoViewIfNeeded();
    const rowBox = await row.boundingBox();
    expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.mouse.click(
      (rowBox?.x ?? 0) + (rowBox?.width ?? 0) - 8,
      (rowBox?.y ?? 0) + (rowBox?.height ?? 0) - 6,
    );
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    // As abas numa fileira só, que desliza de lado, sem rolar a página.
    const tabs = page.getByRole('tablist', { name: 'Como ver as detecções' });
    expect(await tabs.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await noHorizontalScroll(page);
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: /^Filtros/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Filtros' });
    await expect(sheet.getByRole('button', { name: /Exportar CSV/ })).toBeVisible();
    const select = sheet.getByLabel('Severidade');
    expect((await select.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    await select.selectOption('high');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Severidade: Alto/ })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  for (const [width, height] of [
    [1024, 768],
    [768, 1024],
  ] as const) {
    test(`R-07 e R-08: em ${width} px, o mapa e a situação começam recolhidos e a lista não rola de lado`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await open(page);
      const strip = page.getByRole('region', { name: 'Situação agora' });
      await expect(strip.getByRole('button', { name: /^Mostrar/ })).toHaveAttribute('aria-expanded', 'false');
      // Recolhida, a situação diz a coleta parada (R-13).
      await expect(strip.getByRole('status', { name: /^Situação: / })).toContainText('Coleta parada: GCP');
      const region = page.getByRole('region', { name: 'Lista de alertas' });
      await expect(region.getByRole('columnheader', { name: 'Status' })).toBeVisible();
      await expect(region.getByRole('columnheader', { name: 'Incidente' })).toBeVisible();
      expect(
        await region.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      const first = await region.getByRole('row').nth(1).boundingBox();
      expect(first?.y ?? Infinity).toBeLessThan(height);
      await noHorizontalScroll(page);
      if (width === 768) {
        // De 768 a 1023 px, o menu começa nos ícones.
        await expect(page.getByRole('button', { name: 'Expandir menu' })).toBeVisible();
      }
    });
  }

  test('R-12: "Pular para o conteúdo" é o primeiro item do teclado e só aparece com o foco', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const skip = page.getByRole('link', { name: 'Pular para o conteúdo' });
    await page.locator('body').focus();
    // Na demonstração, o botão do tour vem antes (a faixa da demonstração fica fora do painel).
    for (
      let i = 0;
      i < 3 && !(await skip.evaluate((element) => element === document.activeElement));
      i += 1
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(skip).toBeFocused();
    expect((await skip.boundingBox())?.width ?? 0).toBeGreaterThan(40);
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });

  test('R-01: a manchete vem antes das decisões, e as decisões antes do radar', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const strip = page.getByRole('region', { name: 'Situação agora' });
    const headline = await strip.getByRole('status', { name: /^Situação: / }).boundingBox();
    const decisions = await strip.getByRole('region', { name: 'Decisões pendentes' }).boundingBox();
    const radar = await strip.getByRole('region', { name: 'Radar das últimas 24 horas' }).boundingBox();
    expect(headline?.y ?? 0).toBeLessThan(decisions?.y ?? 0);
    expect(decisions?.y ?? 0).toBeLessThan(radar?.y ?? 0);
    await expect(strip.getByRole('status', { name: /^Situação: / })).toHaveText(
      '1 incidente crítico aberto e 2 incidentes altos abertos',
    );
  });
});
