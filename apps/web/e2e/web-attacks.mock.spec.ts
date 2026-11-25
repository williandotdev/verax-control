import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Os ataques web pelos logs do ALB no navegador, sobre a demonstração (`dev:mock`): a estimativa antes da autorização, os passos do
 * cliente, "Ataques web" (o modo, as rotas, as fontes confiáveis) e a evidência de um alerta. Sem violação de acessibilidade (WCAG
 * 2.2 AA, inclusive contraste) nos dois temas a 360, 768 e 1280 px, sem rolagem de lado de 320 a 1920 px, e com o teclado.
 */

/** A conta AWS de produção da demonstração, com um balanceador em cada situação (`mocks/web-logs.ts`). */
const AWS_ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0001';
const AWS_DIALOG = 'Conta AWS 111122223333';
/** Os alertas do ALB na demonstração, pela posição deles em `mocks/findings-fixtures.ts`. */
const FINDINGS = {
  bruteForce: '018f2c1e-0000-7000-8000-00000000101b',
  probes: '018f2c1e-0000-7000-8000-00000000101c',
  digest: '018f2c1e-0000-7000-8000-00000000101d',
  distributed: '018f2c1e-0000-7000-8000-00000000101e',
} as const;
const THEMES = ['light', 'dark'] as const;
const WIDTHS = [360, 768, 1280] as const;

type Theme = (typeof THEMES)[number];

async function enter(page: Page, role: string, theme: Theme = 'light', webLogs: 'on' | 'off' = 'on') {
  await page.addInitScript(
    ([mockRole, value, enabled]) => {
      window.localStorage.setItem('verax.mock.role', mockRole);
      window.localStorage.setItem('verax.theme', value);
      window.localStorage.setItem('verax.mock.web-logs', enabled);
    },
    [role, theme, webLogs] as const,
  );
  await skipDemoTour(page);
}

async function openAccount(page: Page): Promise<Locator> {
  await page.goto(`/cadastros/contas?conta=${AWS_ACCOUNT}`);
  const sheet = page.getByRole('dialog', { name: AWS_DIALOG });
  await expect(sheet.getByRole('region', { name: 'Fontes de log' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  return sheet;
}

/** As violações dentro de um pedaço da tela (a conta inteira tem centenas de linhas, e cada cenário olha o seu). */
async function violations(page: Page, include?: string): Promise<string[]> {
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  const results = await (include === undefined ? builder : builder.include(include)).analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

/** Nem a página nem o painel lateral rolam de lado. */
async function expectNoSidewaysScroll(page: Page, sheet?: Locator) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
  if (sheet === undefined) return;
  const overflow = await sheet.evaluate((dialog) => {
    const scroller = dialog.querySelector('.overflow-y-auto');
    return scroller ? scroller.scrollWidth - scroller.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

const balancer = (section: Locator, name: string) =>
  section.getByRole('button', { name: `${name} sa-east-1`, exact: false }).first();
const balancerBox = (sources: Locator, name: string) =>
  sources.getByRole('checkbox', { name: `Balanceador (log de acesso) · ${name}`, exact: false });

test.describe('ataques web pelos logs do ALB (modo mock)', () => {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`fontes e ataques web sem violação de acessibilidade nem rolagem de lado (${theme}, ${width} px)`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width, height: 900 });
        await enter(page, 'admin_cliente', theme);
        const sheet = await openAccount(page);
        const section = sheet.getByRole('region', { name: 'Ataques web' });
        const sources = sheet.getByRole('region', { name: 'Fontes de log' });

        // Observando, com a contagem; alertando, com as rotas; e atrás de uma CDN, com a lacuna.
        for (const name of ['loja-alb', 'api-alb', 'checkout-alb']) {
          await balancer(section, name).click();
          await expect(section.getByRole('region', { name: `Modo do ${name}` })).toBeVisible();
        }
        await expect(section.getByText('Parte do log ficou sem leitura.')).toBeVisible();
        await expect(section.getByText('POST api.exemplo.com.br/v1/entrar')).toBeVisible();
        // Os dois formulários abertos, e os passos do cliente.
        await section.getByRole('button', { name: 'Declarar uma rota: api-alb' }).click();
        await section.getByRole('button', { name: 'Incluir fonte confiável' }).click();
        await section.getByText('O que esta detecção não vê').click();
        await sources.getByText('Como ligar o log de acesso do site-alb').click();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await expectNoSidewaysScroll(page, sheet);
        expect(await violations(page, '#aws-ataques-web')).toEqual([]);
        expect(await violations(page, '#aws-fontes')).toEqual([]);

        // A confirmação, com as duas ciências, e a janela de começar a alertar por cima do painel.
        await balancerBox(sources, 'catalogo-alb').check();
        await balancerBox(sources, 'blog-alb').check();
        await sources.getByRole('button', { name: 'Autorizar selecionadas (2)' }).click();
        await expect(sources.getByRole('checkbox', { name: /^Entendi:/ })).toHaveCount(2);
        await expectNoSidewaysScroll(page, sheet);
        expect(await violations(page, '#aws-fontes')).toEqual([]);
        await section.getByRole('button', { name: 'Começar a alertar: checkout-alb' }).click();
        const dialog = page.getByRole('dialog', { name: 'Começar a alertar: checkout-alb' });
        await expect(dialog).toContainText('pelo menos 6 alertas teriam sido abertos');
        expect(await violations(page)).toEqual([]);
        const box = await dialog.boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      });

      test(`a evidência de cada alerta sem violação de acessibilidade nem rolagem de lado (${theme}, ${width} px)`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width, height: 900 });
        await enter(page, 'leitura', theme);
        for (const id of Object.values(FINDINGS)) {
          await page.goto(`/?alerta=${id}`);
          const evidence = page.getByRole('region', { name: 'Evidência', exact: true });
          await expect(evidence.getByText('Contagens da janela')).toBeVisible();
          await expectNoSidewaysScroll(page);
          expect(
            await evidence.evaluate((element) => element.scrollWidth - element.clientWidth),
          ).toBeLessThanOrEqual(1);
          await evidence.evaluate((element) => element.setAttribute('data-evidencia', ''));
          expect(await violations(page, '[data-evidencia]'), id).toEqual([]);
        }
      });
    }
  }

  test('de 320 a 1920 px, nada rola de lado, nem com tudo aberto', async ({ page }) => {
    test.setTimeout(120_000);
    await enter(page, 'admin_cliente');
    await page.setViewportSize({ width: 1280, height: 900 });
    const sheet = await openAccount(page);
    const section = sheet.getByRole('region', { name: 'Ataques web' });
    const sources = sheet.getByRole('region', { name: 'Fontes de log' });
    for (const name of ['loja-alb', 'api-alb', 'checkout-alb']) await balancer(section, name).click();
    await section.getByRole('button', { name: 'Incluir fonte confiável' }).click();
    await sources.getByText('Como ligar o log de acesso do site-alb').click();
    for (const width of [320, 360, 414, 600, 768, 1024, 1280, 1600, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoSidewaysScroll(page, sheet);
    }
  });

  test('do balanceador sem estimativa à autorização: pedir, acompanhar, marcar, confirmar e observar', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await enter(page, 'admin_cliente');
    const sheet = await openAccount(page);
    const sources = sheet.getByRole('region', { name: 'Fontes de log' });
    const box = balancerBox(sources, 'relatorios-alb');
    await expect(box).toBeDisabled();
    await sources.getByRole('button', { name: 'Estimar o volume: relatorios-alb' }).click();
    const row = sources.getByRole('listitem').filter({ hasText: 'relatorios-alb' });
    await expect(row).toContainText('aguardando o servidor do Verax');
    // Sem clique nenhum: o servidor responde, e a tela mostra.
    await expect(row).toContainText('cerca de 0,12 GB por dia (5,6% do volume do mês do plano)', {
      timeout: 30_000,
    });
    await expect(box).toBeEnabled();
    // Outro pedido do mesmo balanceador espera 5 minutos.
    await expect(
      row.getByRole('button', { name: 'Estimar de novo em 5 min: relatorios-alb' }),
    ).toBeDisabled();

    await box.check();
    await balancerBox(sources, 'catalogo-alb').check();
    await sources.getByRole('button', { name: 'Autorizar selecionadas (2)' }).click();
    const confirmation = sources.getByRole('group', { name: 'Confirmar a autorização de 2 fontes' });
    await expect(confirmation).toContainText('não guarda nenhuma');
    const confirm = confirmation.getByRole('button', { name: 'Confirmar autorização' });
    await expect(confirm).toBeDisabled();
    // Só o de mais de 20% do plano pede a confirmação.
    const acknowledgement = confirmation.getByRole('checkbox');
    await expect(acknowledgement).toHaveCount(1);
    await expect(
      confirmation.getByRole('checkbox', { name: /^Entendi: o catalogo-alb deve consumir cerca de 1 GB/ }),
    ).not.toBeChecked();
    await acknowledgement.check();
    await confirm.click();

    const section = sheet.getByRole('region', { name: 'Ataques web' });
    await expect(balancer(section, 'relatorios-alb')).toContainText('Observando');
    await balancer(section, 'catalogo-alb').click();
    const mode = section.getByRole('region', { name: 'Modo do catalogo-alb' });
    await expect(mode.getByRole('status')).toContainText('Observando: faltam 72 h');
    await expect(mode.getByRole('button', { name: 'Começar a alertar: catalogo-alb' })).toBeDisabled();
    // Na tabela, a linha leva até aqui.
    await expect(sheet.getByRole('link', { name: 'Ver em Ataques web: catalogo-alb' })).toHaveAttribute(
      'href',
      /^#ataques-web-/,
    );
  });

  test('só com o teclado: abrir o quadro, começar a alertar e voltar, com o foco sempre no lugar', async ({
    page,
  }) => {
    await enter(page, 'admin_cliente');
    const sheet = await openAccount(page);
    const section = sheet.getByRole('region', { name: 'Ataques web' });
    const header = balancer(section, 'checkout-alb');
    await header.focus();
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    const start = section.getByRole('button', { name: 'Começar a alertar: checkout-alb' });
    await start.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Começar a alertar: checkout-alb' });
    await expect(dialog).toBeVisible();
    // Esc fecha só a janela de cima, e devolve o foco.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(start).toBeFocused();
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Começar a alertar' }).press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(
      section.getByRole('region', { name: 'Modo do checkout-alb' }).getByRole('status'),
    ).toContainText('Alertando.');
    await expect(section.getByRole('button', { name: 'Voltar a observar: checkout-alb' })).toBeFocused();
  });

  test('rotas e fontes confiáveis: incluir, ver o erro no campo, alterar e remover', async ({ page }) => {
    await enter(page, 'admin_cliente');
    const sheet = await openAccount(page);
    const section = sheet.getByRole('region', { name: 'Ataques web' });
    await balancer(section, 'loja-alb').click();
    await section.getByRole('button', { name: 'Declarar uma rota: loja-alb' }).click();
    const route = section.getByRole('form', { name: 'Declarar uma rota' });
    await route.getByLabel('Caminho').fill('entrar');
    await route.getByRole('button', { name: 'Declarar rota' }).click();
    await expect(route.getByLabel('Caminho')).toHaveAttribute('aria-invalid', 'true');
    await route.getByLabel('Caminho').fill('/conta/*/entrar');
    await route.getByRole('button', { name: 'Declarar rota' }).click();
    const list = section.getByRole('list', { name: 'Rotas declaradas do loja-alb' });
    await expect(list).toContainText('POST /conta/*/entrar');
    await expect(section.getByRole('button', { name: 'Declarar uma rota: loja-alb' })).toBeFocused();
    await list.getByRole('button', { name: 'Remover a rota POST /conta/*/entrar' }).click();
    await page
      .getByRole('dialog', { name: 'Remover a rota declarada' })
      .getByRole('button', { name: 'Remover rota' })
      .click();
    await expect(list).toHaveCount(0);

    await section.getByRole('button', { name: 'Incluir fonte confiável' }).click();
    const trusted = section.getByRole('form', { name: 'Incluir fonte confiável' });
    await expect(trusted).toContainText('Nunca cala:');
    await trusted.getByLabel('Faixa de endereços').fill('192.0.2.10/32');
    await trusted.getByLabel('Motivo').fill('Outro monitor');
    await trusted.getByRole('button', { name: 'Incluir fonte confiável' }).click();
    await expect(trusted.getByRole('alert')).toContainText('Esta faixa já é uma fonte confiável ali.');
    await trusted.getByLabel('Faixa de endereços').fill('192.0.2.11/32');
    await trusted.getByRole('button', { name: 'Incluir fonte confiável' }).click();
    const trustedList = section.getByRole('list', { name: 'Fontes confiáveis' });
    await expect(trustedList).toContainText('192.0.2.11/32');
    await expect(trustedList).toContainText('Vencida: não vale mais');
  });

  test('quem só lê vê tudo e não muda nada', async ({ page }) => {
    await enter(page, 'analista_cliente');
    const sheet = await openAccount(page);
    const section = sheet.getByRole('region', { name: 'Ataques web' });
    await balancer(section, 'api-alb').click();
    await expect(section.getByText('POST api.exemplo.com.br/v1/entrar')).toBeVisible();
    await expect(section).toContainText('Multiplicador dos limites: 1,5.');
    await expect(
      section.getByRole('button', {
        name: /Alterar|Remover|Renovar|Incluir|Declarar|Salvar|alertar|observar/,
      }),
    ).toHaveCount(0);
    const sources = sheet.getByRole('region', { name: 'Fontes de log' });
    await expect(sources.getByRole('button', { name: /Estimar/ })).toHaveCount(0);
    await expect(sources.getByText('aparecem para quem administra o cliente').first()).toBeVisible();
    await expect(sources.getByText(/% do volume do mês/)).toHaveCount(0);
  });

  test('num nó sem os ataques web, nada deles aparece, e nada quebra', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await enter(page, 'admin_cliente', 'light', 'off');
    const sheet = await openAccount(page);
    await expect(sheet.getByRole('region', { name: 'Ataques web' })).toHaveCount(0);
    const sources = sheet.getByRole('region', { name: 'Fontes de log' });
    await expect(sources.getByRole('button', { name: /Estimar/ })).toHaveCount(0);
    await expect(sources.getByText(/[Ee]stimativa de volume/)).toHaveCount(0);
    await expect(sources.getByRole('region', { name: /^Ainda não coletadas/ })).toContainText('catalogo-alb');
    await expect(sheet.getByRole('link', { name: /Ver em Ataques web/ })).toHaveCount(0);
    await expect(sheet.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('o alerta do ALB: a evidência no lugar do evento bruto, e as amostras que expiraram', async ({
    page,
  }) => {
    await enter(page, 'admin_cliente');
    await page.goto(`/?alerta=${FINDINGS.bruteForce}`);
    const evidence = page.getByRole('region', { name: 'Evidência', exact: true });
    await expect(evidence).toContainText('login, declarada por você');
    await expect(evidence).toContainText('Abra no seu S3');
    await expect(evidence.getByRole('button', { name: /^Copiar a chave do arquivo/ })).toHaveCount(2);
    await expect(evidence.getByRole('link')).toHaveCount(0);
    await expect(page.getByText('Evento bruto', { exact: true })).toHaveCount(0);
    await page.goto(`/?alerta=${FINDINGS.distributed}`);
    await expect(evidence.getByRole('note')).toContainText(
      'As amostras e as indicações dos arquivos expiraram em',
    );
    await expect(
      evidence.getByRole('list', { name: 'Endereços, do mais ativo ao menos ativo' }).getByRole('listitem'),
    ).toHaveCount(20);
  });
});
