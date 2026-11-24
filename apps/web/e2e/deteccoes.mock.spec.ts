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
    await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'analista_cliente'));
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
        await page.getByRole('button', { name: 'Promover a incidente' }).click();
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
        await page.getByRole('button', { name: 'Mais filtros' }).click();
        await expect(page.getByLabel('Tática do MITRE')).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);

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

  test('no computador, a lista fica ao lado do radar e as análises embaixo, a começar pelo Resumo', async ({
    page,
  }) => {
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const radar = await page.getByRole('region', { name: 'Radar das últimas 24 horas' }).boundingBox();
      const list = await page.getByRole('region', { name: 'Lista de alertas' }).boundingBox();
      const summary = page.getByRole('tab', { name: 'Resumo' });
      await expect(summary).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: 'Lista' })).toHaveCount(0);
      const tab = await summary.boundingBox();
      if (!radar || !list || !tab) throw new Error('sem o radar, a lista ou as análises na tela');
      expect(list.x).toBeGreaterThanOrEqual(radar.x + radar.width);
      expect(list.y).toBeLessThan(radar.y + radar.height);
      expect(tab.y).toBeGreaterThanOrEqual(list.y + list.height);
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
    await expect(page).toHaveURL(new RegExp(`/\\?alerta=${FINDING}$`));
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
