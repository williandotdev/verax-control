import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Tela Detecções (16/11/2026, no lugar da Torre, de Incidentes, de Achados e de Relatórios) no navegador, sobre a
 * demonstração (`dev:mock`): sem violação de acessibilidade (WCAG 2.2 AA, inclusive contraste) nos dois temas, no
 * computador e a 390 px, com o que só aparece na interação (a gaveta da coleta com o pulso, os achados de um incidente,
 * o detalhe ao lado ou na gaveta, os filtros a mais e as análises); sem rolagem horizontal da página; o resumo
 * recolhido lembrado; os endereços de antes; e a exportação em CSV.
 */

const INCIDENT = '018f2c1e-0000-7000-8000-0000000a0001';
const FINDING = '018f2c1e-0000-7000-8000-000000001001';
const INCIDENT_TITLE = /^Atividade suspeita com a chave de acesso/;

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
        // No celular, o resumo começa recolhido: o semáforo e as contagens numa linha.
        if (device === 'celular') {
          await expect(strip.getByRole('status', { name: /^Situação: Crítico/ })).toBeVisible();
          expect(await violations(page)).toEqual([]);
          await strip.getByRole('button', { name: /^Mostrar/ }).click();
        }
        await expect(strip.getByRole('status', { name: /coleta parada \(GCP\)\.$/ })).toBeVisible();
        await expect(strip.getByRole('region', { name: 'Decisões pendentes' })).toBeVisible();
        await expect(strip.getByRole('region', { name: 'Radar das últimas 24 horas' })).toBeVisible();
        expect(await violations(page)).toEqual([]);
        await noHorizontalScroll(page);

        // A saúde da coleta numa gaveta, com o pulso (o minigráfico com a dica pelo teclado).
        await strip.getByRole('button', { name: /^Coleta parada: GCP/ }).click();
        const health = page.getByRole('dialog', { name: 'Saúde da coleta' });
        await expect(health.getByText('Parada', { exact: true })).toBeVisible();
        await expect(health.getByRole('region', { name: 'Agentes online' })).toContainText('3 de 5');
        await health.getByRole('img', { name: /^Achados por hora nas últimas 24 horas/ }).focus();
        await page.keyboard.press('ArrowLeft');
        await expect(page.getByText(/^\d{2}:\d{2}: \d+ achados?\.$/)).toBeAttached();
        expect(await violations(page)).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(health).toHaveCount(0);

        // A lista agrupada, com os achados de um incidente abertos e os filtros a mais.
        const list = page.getByRole('table', { name: /^Detecções do cliente/ });
        await list
          .getByRole('button', { name: /^Abrir os achados do incidente: Atividade suspeita com a chave/ })
          .click();
        await expect(
          list.getByRole('button', { name: /^Abrir o achado: Tentativa de desligar/ }),
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
      await expect(strip.getByRole('status', { name: /^Situação: Normal\. Tudo calmo\./ })).toContainText(
        'Coleta ativa em 2 de 2 fontes',
      );
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });
  }

  test('recolher o resumo sobe a lista e fica lembrado depois de recarregar', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const list = page.getByRole('table', { name: /^Detecções do cliente/ });
    const before = (await list.boundingBox())?.y ?? 0;
    await page.getByRole('button', { name: /^Recolher/ }).click();
    await expect.poll(async () => (await list.boundingBox())?.y ?? 0).toBeLessThan(before - 200);
    await page.reload();
    await expect(page.getByRole('button', { name: /^Mostrar/ })).toHaveAttribute('aria-expanded', 'false');
  });

  test('teclado: o detalhe ao lado abre com Enter, fecha com Esc e o foco volta para o item', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/?visao=achados&severidade=critical');
    const finding = page.getByRole('button', {
      name: 'Abrir o achado: Tentativa de desligar a trilha do CloudTrail',
    });
    await finding.focus();
    await page.keyboard.press('Enter');
    const aside = page.getByRole('complementary', { name: 'Tentativa de desligar a trilha do CloudTrail' });
    await expect(aside.getByRole('heading', { level: 2 })).toBeFocused();
    // Não é modal: a lista continua na árvore de acessibilidade.
    await expect(page.getByRole('table', { name: 'Achados do cliente' })).toBeVisible();
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
    await expect(page).toHaveURL(new RegExp(`/\\?visao=achados&achado=${FINDING}$`));
    await expect(
      page.getByRole('complementary', { name: 'Tentativa de desligar a trilha do CloudTrail' }),
    ).toBeVisible();

    await page.goto('/relatorios?aba=mitre');
    await expect(page).toHaveURL(/\/\?analise=mitre$/);
    await expect(page.getByRole('tab', { name: 'MITRE ATT&CK' })).toHaveAttribute('aria-selected', 'true');
  });

  test('exporta em CSV a lista filtrada', async ({ page }) => {
    await open(page, '/?visao=achados&severidade=critical');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^verax-achados-\d{4}-\d{2}-\d{2}\.csv$/);
    await expect(page.getByText(/^\d+ linhas? exportadas?\.$/)).toBeVisible();
  });
});
