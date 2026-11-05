import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * Revisão de UX (T7.12) no navegador, sobre a demonstração (`dev:mock`): toda tela sem violação de acessibilidade
 * (WCAG 2.2 AA, inclusive contraste), sem rolagem horizontal da página no celular (as tabelas rolam por dentro) e
 * com o fluxo de teclado do painel de detalhe.
 */

const INCIDENT = '018f2c1e-0000-7000-8000-0000000a0001';
const FINDING = '018f2c1e-0000-7000-8000-000000001001';
const AUDIT_ENTRY = '018f2c1e-0000-7000-8000-0000000d0002';
/** O projeto da GCP da demonstração (`account(4, ...)` em mocks/admin.ts). */
const GCP_ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0004';
/** A conta do Cloudflare da demonstração (`account(5, ...)`), com o token guardado perto de vencer. */
const CLOUDFLARE_ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0005';
const CLOUDFLARE_DIALOG = 'Conta do Cloudflare d0e0000000000000000000000000a1fa';
/** A conta AWS conectada da demonstração (`account(1, ...)`) e a recusada (`account(2, ...)`, `trust_denied`). */
const AWS_ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0001';
const AWS_DIALOG = 'Conta AWS 111122223333';
const AWS_REFUSED_ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0002';
const AWS_REFUSED_DIALOG = 'Conta AWS 444455556666';
/** O template revisado, no repositório: o painel tem de servir exatamente este arquivo. */
const READER_TEMPLATE = fileURLToPath(
  new URL('../../../infra/cloudformation/verax-control-reader.yaml', import.meta.url),
);

const PAGES: [string, string | RegExp][] = [
  ['/', 'Torre'],
  ['/incidentes', 'Incidentes'],
  [`/incidentes/${INCIDENT}`, /Atividade suspeita com a chave de acesso/],
  ['/achados', 'Achados'],
  ['/postura', 'Postura cloud'],
  ['/ativos', 'Ativos e identidades'],
  ['/ativos?aba=security-groups', 'Ativos e identidades'],
  ['/relatorios', 'Relatórios'],
  ['/relatorios?aba=mitre', 'Relatórios'],
  ['/relatorios?aba=incidentes&periodo=90d', 'Relatórios'],
  ['/cadastros/clientes', 'Clientes'],
  ['/cadastros/usuarios', 'Usuários'],
  ['/cadastros/contas', 'Contas cloud'],
  ['/cadastros/agentes', 'Agentes'],
  ['/cadastros/agentes?sistema=windows', 'Agentes'],
  ['/cadastros/protecao', 'Lista de proteção'],
  ['/cadastros/excecoes', 'Exceções'],
  ['/cadastros/plano', 'Plano e uso'],
  ['/auditoria', 'Auditoria'],
  ['/alertas-sem-dono', 'Alertas sem dono'],
  ['/minha-conta', 'Minha conta'],
];

async function open(page: Page, path: string, heading: string | RegExp) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  // Nada carregando: a análise vê a tela pronta.
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

test.describe('revisão de UX (modo mock)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('verax.mock.role', 'admin_verax'));
    await skipDemoTour(page);
  });

  // Nos dois temas: o contraste do escuro não é o do claro invertido (tokens escolhidos à mão em cada modo).
  for (const theme of ['light', 'dark'] as const) {
    for (const [path, heading] of PAGES) {
      test(`${path} (${theme === 'light' ? 'claro' : 'escuro'}): sem violação de acessibilidade`, async ({
        page,
      }) => {
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        await open(page, path, heading);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await violations(page)).toEqual([]);
      });
    }
  }

  // Os gráficos do resumo dos Relatórios com o que só aparece na interação: a tabela de "Ver tabela" aberta e a dica
  // de cada gráfico pelo teclado. Nos dois temas, no computador e no celular (sem nada passar da tela).
  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width] of [
      ['computador', 1280],
      ['celular', 360],
    ] as const) {
      test(`/relatorios, gráficos com a tabela e a dica (${theme === 'light' ? 'claro' : 'escuro'}, ${device}): sem violação de acessibilidade`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        await open(page, '/relatorios', 'Relatórios');
        await page.getByText('Ver tabela').click();
        await expect(page.getByRole('table', { name: 'Achados por dia' })).toBeVisible();
        await page.getByRole('img', { name: /^Achados por dia/ }).focus();
        await page.keyboard.press('ArrowLeft');
        await expect(page.getByText(/^\d{2}\/\d{2}\/\d{4}: Crítico \d+/)).toBeAttached();
        expect(await violations(page)).toEqual([]);
        await page.getByRole('img', { name: /^Achados por status/ }).focus();
        await expect(page.getByText(/^Novo: \d+ achados?, .*% do total\.$/)).toBeAttached();
        expect(await violations(page)).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  // A Torre com o pulso e a saúde da coleta (OP-02), com o que só aparece na interação: a tabela do minigráfico aberta
  // e a dica pelo teclado. A Alfa da demonstração tem a coleta da GCP parada (amarelo pela coleta, além do crítico).
  // Nos dois temas, no computador e no celular (sem nada passar da tela).
  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width] of [
      ['computador', 1280],
      ['celular', 360],
    ] as const) {
      test(`Torre com o pulso e a coleta parada (${theme === 'light' ? 'claro' : 'escuro'}, ${device}): sem violação de acessibilidade`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        await open(page, '/', 'Torre');
        await expect(page.getByRole('status', { name: /coleta parada \(GCP\)\.$/ })).toBeVisible();
        const health = page.getByRole('region', { name: 'Saúde da coleta' });
        await expect(health.getByText('Parada', { exact: true })).toBeVisible();
        await expect(health.getByText('Aguardando o primeiro dado')).toBeVisible();
        const pulse = page.getByRole('region', { name: 'Pulso da operação' });
        await expect(pulse.getByRole('region', { name: 'Agentes online' })).toContainText('3 de 5');
        await pulse.getByText('Ver tabela').click();
        await expect(
          page.getByRole('table', { name: 'Achados por hora nas últimas 24 horas' }),
        ).toBeVisible();
        await pulse.getByRole('img', { name: /^Achados por hora nas últimas 24 horas/ }).focus();
        await page.keyboard.press('ArrowLeft');
        await expect(page.getByText(/^\d{2}:\d{2}: \d+ achados?\.$/)).toBeAttached();
        expect(await violations(page)).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  // O cliente tranquilo da demonstração: "Tudo calmo", com a prova da coleta, e as fontes que ele não tem por último.
  for (const theme of ['light', 'dark'] as const) {
    test(`Torre "Tudo calmo" da Beta (${theme === 'light' ? 'claro' : 'escuro'}): sem violação de acessibilidade`, async ({
      page,
    }) => {
      await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
      await open(page, '/', 'Torre');
      await page.getByLabel('Cliente').selectOption({ label: 'Cliente Demo Beta' });
      await expect(page.getByRole('status', { name: /^Situação: Normal\. Tudo calmo\./ })).toContainText(
        'Coleta ativa em 2 de 2 fontes',
      );
      const health = page.getByRole('region', { name: 'Saúde da coleta' });
      await expect(health.getByText('Não configurada')).toHaveCount(3);
      await expect(page.getByRole('region', { name: 'Pulso da operação' })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });
  }

  // Um teste por painel: cada análise de acessibilidade leva alguns segundos, e juntos passavam do tempo de um teste.
  // Abertos pela URL: com o painel modal, o resto da página fica fora da árvore de acessibilidade.
  for (const [path, dialog] of [
    [`/achados?achado=${FINDING}`, 'Tentativa de desligar a trilha do CloudTrail'],
    [`/auditoria?registro=${AUDIT_ENTRY}`, 'Comentou achado'],
    // Projeto GCP de cliente: o comando do sink e o campo da identidade.
    [`/cadastros/contas?conta=${GCP_ACCOUNT}`, 'Projeto da GCP loja-alfa-demo'],
    // Conta do Cloudflare: o link do token, o IP de saída e o cartão do token com o aviso de vencimento.
    [`/cadastros/contas?conta=${CLOUDFLARE_ACCOUNT}`, CLOUDFLARE_DIALOG],
    // Conta AWS: o papel de leitura sem chave, com o template, os três valores do nó e o resultado da verificação.
    [`/cadastros/contas?conta=${AWS_ACCOUNT}`, AWS_DIALOG],
  ] as const) {
    test(`painel de detalhe ${path}: sem violação de acessibilidade`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('dialog', { name: dialog })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });
  }

  test('token do Cloudflare: o campo de senha com erro, a troca e a remoção sem violação de acessibilidade', async ({
    page,
  }) => {
    await page.goto(`/cadastros/contas?conta=${CLOUDFLARE_ACCOUNT}`);
    const sheet = page.getByRole('dialog', { name: CLOUDFLARE_DIALOG });
    const card = sheet.getByRole('group', { name: 'Token de API guardado' });
    await card.getByRole('button', { name: 'Trocar token' }).click();
    const field = card.getByLabel('Token de API do Cloudflare');
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveAttribute('autocomplete', 'off');
    // Curto demais: o erro fica ligado ao campo, e o campo zera.
    await field.fill('curto');
    await card.getByRole('button', { name: 'Trocar token' }).click();
    await expect(field).toHaveValue('');
    await expect(field).toHaveAccessibleDescription(/Token do Cloudflare inválido/);
    expect(await violations(page)).toEqual([]);
    // Um token no formato, só de teste: o mock aceita e o cartão volta, com o foco no título.
    await field.fill(`cfat_${'0123456789abcdef'.repeat(3)}`);
    await card.getByRole('button', { name: 'Trocar token' }).click();
    await expect(card.getByText(/guardado no cofre do nó/)).toBeVisible();
    await expect(card.getByText('Token de API guardado')).toBeFocused();
    expect(await violations(page)).toEqual([]);
    await card.getByRole('button', { name: 'Remover token' }).click();
    await expect(card.getByRole('group', { name: 'Confirmação' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await card.getByRole('button', { name: 'Confirmar remoção' }).click();
    await expect(sheet.getByLabel('Token de API do Cloudflare')).toBeFocused();
    expect(await violations(page)).toEqual([]);
  });

  test('Conectar AWS: o template baixado é o do repositório, byte a byte, com o nome do arquivo', async ({
    page,
  }) => {
    await page.goto(`/cadastros/contas?conta=${AWS_ACCOUNT}`);
    const sheet = page.getByRole('dialog', { name: AWS_DIALOG });
    const link = sheet.getByRole('link', { name: /Baixar o template/ });
    await expect(link).toHaveAttribute('download', 'verax-control-reader.yaml');
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe('verax-control-reader.yaml');
    const saved = readFileSync(await download.path());
    expect(saved.equals(readFileSync(READER_TEMPLATE))).toBe(true);
  });

  test('Conectar AWS: o erro, a CLI, a verificação pendente e o resultado sem violação de acessibilidade', async ({
    page,
  }) => {
    await page.goto(`/cadastros/contas?conta=${AWS_REFUSED_ACCOUNT}`);
    const sheet = page.getByRole('dialog', { name: AWS_REFUSED_DIALOG });
    const status = sheet.getByRole('status');
    await expect(status).toContainText('A AWS recusou a entrada no papel');
    // O comando da CLI, aberto.
    await sheet.getByText('Prefere a CLI?').click();
    await expect(sheet.getByText(/^aws cloudformation deploy/)).toBeVisible();
    expect(await violations(page)).toEqual([]);
    // Verificar: pendente (o botão desliga e o estado vem pela região de status), depois o resultado.
    await sheet.getByRole('button', { name: 'Verificar conexão' }).click();
    await expect(status).toContainText('Verificação pedida');
    await expect(sheet.getByRole('button', { name: 'Verificando…' })).toBeDisabled();
    expect(await violations(page)).toEqual([]);
    await expect(status).toContainText('A AWS recusou a entrada no papel', { timeout: 15_000 });
    await expect(sheet.getByRole('button', { name: 'Verificar conexão' })).toBeEnabled();
    expect(await violations(page)).toEqual([]);
  });

  // A senha de registro à mostra (o botão alternado) e a aba do Windows, com o script na região rolável.
  test('agentes com a senha de registro à mostra: sem violação de acessibilidade', async ({ page }) => {
    await open(page, '/cadastros/agentes?sistema=windows', 'Agentes');
    await page.getByRole('button', { name: 'Mostrar senha' }).click();
    await expect(page.getByRole('button', { name: 'Esconder senha' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('region', { name: 'Script de instalação para Windows' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('painel de detalhe da postura: sem violação de acessibilidade', async ({ page }) => {
    await open(page, '/postura?severidade=critical', 'Postura cloud');
    await page.getByRole('button', { name: /Usuário root sem MFA/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  // A produção da demonstração tem o EC2 de us-east-1 negado por uma SCP: o retrato dela é parcial (PR-14').
  for (const theme of ['light', 'dark'] as const) {
    test(`Ativos com coleta parcial (${theme === 'light' ? 'claro' : 'escuro'}): a faixa diz o que ficou de fora, sem violação de acessibilidade`, async ({
      page,
    }) => {
      await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
      await open(page, '/ativos', 'Ativos e identidades');
      const band = page.getByRole('region', { name: 'Coleta parcial' });
      await expect(band).toContainText('Conta 111122223333');
      await expect(band.getByRole('listitem')).toContainText([
        'Instâncias EC2 em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).',
        'Security groups em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).',
      ]);
      // O que foi lido continua nas abas.
      await expect(page.getByRole('tab', { name: /Usuários IAM 9/ })).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  }

  // A postura nativa (PR-15'): a produção da demonstração tem o EC2 de us-east-1 negado pela SCP fictícia, então a
  // varredura é parcial e as checagens de EC2 de lá ficam "não lidas"; o catálogo mostra a situação de cada checagem.
  // Nos dois temas, no computador e no celular (a tabela do catálogo rola por dentro).
  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width] of [
      ['computador', 1280],
      ['celular', 360],
    ] as const) {
      test(`Postura com varredura parcial e o catálogo (${theme === 'light' ? 'claro' : 'escuro'}, ${device}): sem violação de acessibilidade`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.addInitScript((value) => window.localStorage.setItem('verax.theme', value), theme);
        await open(page, '/postura', 'Postura cloud');
        const band = page.getByRole('region', { name: 'Varredura parcial' });
        await expect(band).toContainText('Conta 111122223333');
        await expect(band.getByRole('listitem')).toContainText([
          'Instâncias EC2 em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).',
          'Security groups em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).',
          'Criptografia padrão do EBS em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).',
        ]);
        const catalog = page.getByRole('table', { name: 'Checagens do catálogo na última varredura' });
        await expect(catalog.getByRole('row')).toHaveCount(19);
        await expect(
          catalog.getByRole('row', {
            name: /Nenhum security group aberto para a internet em todas as portas/,
          }),
        ).toContainText('Não lida');
        await expect(page.locator('body')).not.toContainText('Prowler');
        expect(await violations(page)).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  // Um cliente novo, sem conta AWS: Postura e Ativos dizem "em breve" (PR-14'). A troca de cliente e a navegação são
  // pelo painel: recarregar a página recomeçaria a demonstração, sem o cliente novo.
  test('cliente sem conta AWS: Postura e Ativos "em breve", sem violação de acessibilidade', async ({
    page,
  }) => {
    await open(page, '/cadastros/clientes', 'Clientes');
    await page.getByRole('button', { name: 'Novo cliente' }).click();
    const sheet = page.getByRole('dialog', { name: 'Novo cliente' });
    await sheet.getByLabel('Nome', { exact: true }).fill('Cliente Novo Delta');
    await sheet.getByLabel(/^CNPJ/).fill('45.723.174/0001-10');
    await sheet.getByLabel('Plano').fill('Essencial');
    await sheet.getByLabel('Nome do contato').fill('Gabriel Lima');
    await sheet.getByLabel('E-mail do contato').fill('gabriel@exemplo.com.br');
    await sheet.getByLabel('Nome do administrador').fill('Helena Prado');
    await sheet.getByLabel('E-mail do administrador').fill('helena@exemplo.com.br');
    await sheet.getByRole('button', { name: 'Cadastrar cliente' }).click();
    await expect(sheet.getByRole('region', { name: 'Senha temporária de Helena Prado' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    await page.getByLabel('Cliente').selectOption({ label: 'Cliente Novo Delta' });
    const menu = page.getByRole('navigation', { name: 'Menu principal' });
    await menu.getByRole('link', { name: 'Postura cloud' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Postura cloud' })).toBeVisible();
    await expect(page.getByText('Postura de GCP e Cloudflare: em breve')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    await menu.getByRole('link', { name: 'Ativos e identidades' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Ativos e identidades' })).toBeVisible();
    await expect(page.getByText('Ativos de GCP e Cloudflare: em breve')).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });

  // A troca da senha temporária só abre para a sessão de primeiro acesso: entra pela senha temporária da demonstração.
  test('/trocar-senha (primeiro acesso): sem violação de acessibilidade', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-mail').fill('analista@demo.verax.local');
    await page.getByLabel('Senha', { exact: true }).fill('senha-temporaria-demonstracao');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page).toHaveURL(/\/trocar-senha$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Troque a senha temporária' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('senha temporária de uma conta nova: sem violação de acessibilidade', async ({ page }) => {
    await open(page, '/cadastros/usuarios', 'Usuários');
    await page.getByRole('button', { name: 'Criar usuário' }).click();
    const sheet = page.getByRole('dialog', { name: 'Criar usuário' });
    await sheet.getByLabel('Nome').fill('Bruna Melo');
    await sheet.getByLabel('E-mail').fill('bruna@exemplo.com.br');
    await sheet.getByRole('button', { name: 'Criar usuário' }).click();
    await expect(sheet.getByRole('region', { name: 'Senha temporária de Bruna Melo' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('cliente novo com o primeiro administrador: formulário e senha temporária sem violação de acessibilidade', async ({
    page,
  }) => {
    await open(page, '/cadastros/clientes', 'Clientes');
    await page.getByRole('button', { name: 'Novo cliente' }).click();
    const sheet = page.getByRole('dialog', { name: 'Novo cliente' });
    await expect(sheet.getByLabel('E-mail do administrador')).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await sheet.getByLabel('Nome', { exact: true }).fill('Cliente Novo Gama');
    await sheet.getByLabel(/^CNPJ/).fill('45.723.174/0001-10');
    await sheet.getByLabel('Plano').fill('Postura');
    await sheet.getByLabel('Nome do contato').fill('Gabriel Lima');
    await sheet.getByLabel('E-mail do contato').fill('gabriel@exemplo.com.br');
    await sheet.getByLabel('Nome do administrador').fill('Helena Prado');
    await sheet.getByLabel('E-mail do administrador').fill('helena@exemplo.com.br');
    await sheet.getByRole('button', { name: 'Cadastrar cliente' }).click();
    await expect(sheet.getByRole('region', { name: 'Senha temporária de Helena Prado' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('teclado: o detalhe abre com Enter, fecha com Esc e o foco volta para o achado', async ({ page }) => {
    await open(page, '/achados?severidade=critical', 'Achados');
    const finding = page.getByRole('button', { name: /Tentativa de desligar a trilha/ });
    await finding.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // O foco fica preso no painel.
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(finding).toBeFocused();
  });

  test('celular: nenhuma tela rola na horizontal', async ({ page }) => {
    // Percorre todas as telas num teste só: o tempo cresce com a lista (cerca de 2 s por tela).
    test.setTimeout(PAGES.length * 5_000);
    await page.setViewportSize({ width: 360, height: 800 });
    const overflowing: string[] = [];
    for (const [path, heading] of PAGES) {
      await open(page, path, heading);
      // A falha diz qual elemento passa da tela (fora dos quadros que rolam por dentro): as fontes do Linux do CI
      // são mais largas que as de outras máquinas, e só o nome do elemento permite corrigir sem adivinhar.
      const problem = await page.evaluate(() => {
        const extra = document.documentElement.scrollWidth - window.innerWidth;
        if (extra <= 1) return null;
        const scrollsInside = (element: Element) => {
          for (
            let parent = element.parentElement;
            parent && parent !== document.body;
            parent = parent.parentElement
          ) {
            if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX))
              return true;
          }
          return false;
        };
        const culprits = Array.from(document.body.querySelectorAll('*'))
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
          .filter((element) => !scrollsInside(element))
          .slice(-3)
          .map(
            (element) => `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}">`,
          );
        return `${extra}px (${culprits.join(', ')})`;
      });
      if (problem) overflowing.push(`${path}: ${problem}`);
    }
    expect(overflowing).toEqual([]);
  });
});
