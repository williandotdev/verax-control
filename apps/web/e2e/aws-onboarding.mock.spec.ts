import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { skipDemoTour } from './demo-tour';

/**
 * O onboarding self-service da AWS no navegador, sobre a demonstração (`dev:mock`): do cadastro da conta (só o ID e a
 * região) ao "Conectar com AWS" (o arquivo preenchido baixado e o CloudFormation aberto em outra aba), a espera pela
 * pilha, a descoberta, a autorização das fontes (com a confirmação dos grupos de logs) e a coleta. A tela só anda
 * quando a API simulada anda: o teste não clica em nada para "avançar". Sem violação de acessibilidade (WCAG 2.2 AA,
 * inclusive contraste) em cada passo, nos dois temas, e sem rolagem horizontal da página no celular.
 */

/** O template revisado, no repositório: o arquivo baixado só pode diferir dele nas linhas `Default:`. */
const READER_TEMPLATE = fileURLToPath(
  new URL('../../../infra/cloudformation/verax-control-reader.yaml', import.meta.url),
);
/**
 * A conta AWS conectada da demonstração (`account(1, ...)` em mocks/admin.ts): com erro de permissão numa fonte de
 * achados, e as outras fontes de achados cada uma numa situação.
 */
const AWS_ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0001';
const AWS_DIALOG = 'Conta AWS 111122223333';
const CONSOLE_URL = 'https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks/create';
/** O "worker" da demonstração leva alguns segundos em cada passo, e a tela relê a cada 5 s. */
const STEP_TIMEOUT = 45_000;

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

/** A folga, em px, que o axe dá antes de tratar um quadro como rolável (`scrollable-region-focusable`). */
const AXE_SCROLL_TOLERANCE_PX = 13;
/** Os quadros de tabela da conta conectada da demonstração, pelo nome de cada um, na ordem da tela. */
const TABLE_FRAMES = [
  'Tabela: O que a descoberta não conseguiu ler',
  'Tabela: Saúde da coleta de cada fonte autorizada',
] as const;

/**
 * A conta conectada da demonstração numa tela de celular, carregada: nem a página nem o painel rolam de lado (só as
 * tabelas, cada uma dentro do quadro dela).
 */
async function openOnPhone(page: Page, role: string, width: number): Promise<Locator> {
  await useRole(page, role);
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/cadastros/contas?conta=${AWS_ACCOUNT}`);
  const sheet = page.getByRole('dialog', { name: AWS_DIALOG });
  await expect(sheet.getByRole('region', { name: 'Fontes autorizadas' })).toBeVisible();
  await expect(sheet.getByRole('region', { name: 'Fontes de log' })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
  const overflow = await sheet.evaluate((dialog) => {
    const scroller = dialog.querySelector('.overflow-y-auto');
    return scroller ? scroller.scrollWidth - scroller.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  return sheet;
}

async function useRole(page: Page, role: string, theme: 'light' | 'dark' = 'light') {
  await page.addInitScript(
    ([mockRole, value]) => {
      window.localStorage.setItem('verax.mock.role', mockRole);
      window.localStorage.setItem('verax.theme', value);
    },
    [role, theme] as const,
  );
  await skipDemoTour(page);
}

/** O padrão gravado para um parâmetro no arquivo da pilha: a linha `Default:` do bloco dele. */
function parameterDefault(template: string, parameter: string): string | undefined {
  const lines = template.split('\n').map((line) => line.trimEnd());
  const block = lines.slice(lines.indexOf(`  ${parameter}:`) + 1);
  const end = block.findIndex((line) => line.startsWith('  ') && !line.startsWith('   '));
  return block
    .slice(0, end === -1 ? block.length : end)
    .find((line) => line.startsWith('    Default: '))
    ?.slice('    Default: '.length);
}

test.describe('onboarding self-service da AWS (modo mock)', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`do cadastro à coleta (${theme === 'light' ? 'claro' : 'escuro'}): conectar, descobrir, autorizar e acompanhar, sem violação de acessibilidade`, async ({
      page,
      context,
    }) => {
      test.setTimeout(180_000);
      // O console da AWS não é aberto de verdade: a aba nova recebe uma página em branco.
      await context.route('https://console.aws.amazon.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<title>CloudFormation</title>' }),
      );
      await useRole(page, 'admin_verax', theme);
      await page.goto('/cadastros/contas');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      // Cadastro: só o ID da conta e a região principal; os buckets ficam recolhidos em "Avançado".
      await page.getByRole('button', { name: 'Cadastrar conta' }).click();
      const create = page.getByRole('dialog', { name: 'Cadastrar conta' });
      await expect(create.getByLabel('Região principal')).toHaveValue('sa-east-1');
      await expect(create.getByLabel('Nome do bucket')).toHaveCount(0);
      await create.getByLabel('ID da conta AWS').fill('135792468024');
      expect(await violations(page)).toEqual([]);
      await create.getByRole('button', { name: 'Cadastrar conta' }).click();
      await expect(create.getByText(/Conta AWS 135792468024 cadastrada/)).toBeVisible();
      // O acompanhamento é no detalhe da conta, aberto pela tabela.
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /135792468024/ }).click();
      const sheet = page.getByRole('dialog', { name: 'Conta AWS 135792468024' });
      const situation = sheet.getByRole('region', { name: 'Situação da conexão' });
      const status = situation.getByRole('status');
      await expect(status).toContainText('Não conectada');

      // Antes de conectar: o que a integração faz e o que o cliente autoriza, com a nota honesta dos buckets.
      const connect = sheet.getByRole('region', { name: 'Conectar a conta 135792468024' });
      const choices = connect.getByRole('group', { name: 'O que você autoriza' });
      await expect(choices.getByRole('checkbox', { name: 'Logs de serviços da AWS no S3' })).toBeChecked();
      await expect(choices).toContainText('só os nomes, nunca o conteúdo');
      await expect(choices).toContainText('Nada é criado nem alterado na sua conta AWS');
      const button = connect.getByRole('button', { name: 'Conectar com AWS' });
      await expect(button).toBeEnabled();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);

      // Um clique: o arquivo preenchido baixado e o CloudFormation aberto em outra aba.
      const [download, popup] = await Promise.all([
        page.waitForEvent('download'),
        context.waitForEvent('page'),
        button.click(),
      ]);
      expect(download.suggestedFilename()).toBe('verax-control-reader-135792468024.yaml');
      const original = readFileSync(READER_TEMPLATE, 'utf8').split('\n');
      const kept = new Set(original);
      const changed = readFileSync(await download.path(), 'utf8')
        .split('\n')
        .filter((line) => !kept.has(line));
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.every((line) => line.startsWith('    Default: '))).toBe(true);
      await popup.waitForURL(CONSOLE_URL);
      // A aba aberta não tem acesso a esta.
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await popup.close();

      // A espera pela pilha, pelo estado da API: os passos, o aviso e o prazo.
      const waiting = sheet.getByRole('region', { name: 'Crie a pilha na AWS' });
      await expect(waiting).toContainText('Carregar um arquivo de modelo');
      await expect(waiting).toContainText('O Verax não enxerga a pilha enquanto ela é criada.');
      await expect(waiting).toContainText('Tempo restante para criar a pilha');
      await expect(status).toContainText('Aguardando autorização na AWS');
      await expect(waiting.getByRole('button', { name: 'Baixar o arquivo de novo' })).toBeEnabled();
      await expect(waiting.getByRole('link', { name: /Abrir o CloudFormation/ })).toHaveAttribute(
        'href',
        CONSOLE_URL,
      );
      // Quem prefere a CLI: o comando lê o arquivo que o botão baixou, pelo nome dele.
      await waiting.getByText('Prefere a CLI?').click();
      await expect(waiting.getByText(/^aws cloudformation deploy/)).toContainText(
        `--template-file ${download.suggestedFilename()} `,
      );
      expect(await violations(page)).toEqual([]);

      // Sem clique nenhum: a pilha "fica pronta", o Verax entra, descobre a conta e espera a escolha das fontes.
      await expect(status).toContainText('Aguardando autorização de fontes', { timeout: STEP_TIMEOUT });
      await expect(waiting).toHaveCount(0);
      await expect(sheet.getByRole('region', { name: 'Pilha na AWS' })).toContainText('versão 2 (atual)');
      const found = sheet.getByRole('region', { name: 'O que encontramos' });
      await expect(found).toContainText('Última descoberta: completa');
      await expect(found).toContainText('Instâncias (EC2)');
      await expect(found).toContainText('Serviços identificados');
      const sources = sheet.getByRole('region', { name: 'Fontes de log' });
      await expect(sources.getByRole('region', { name: /^Precisam de permissão adicional/ })).toBeVisible();
      await expect(sources.getByRole('region', { name: /^Não habilitadas na AWS/ })).toContainText(
        'o Verax nunca liga nada na sua conta',
      );
      await expect(sources.getByRole('region', { name: /^Ainda não coletadas/ })).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);

      // A escolha: a trilha, a API do GuardDuty (a recomendada) e um grupo de logs, achado pela busca e marcado um a um.
      await sources.getByRole('checkbox', { name: /CloudTrail \(trilha\) · management-events/ }).check();
      await sources.getByRole('checkbox', { name: /GuardDuty \(API\)/ }).check();
      const groups = sources.getByRole('region', { name: /^Grupos do CloudWatch Logs/ });
      await expect(groups).toContainText('Logs de aplicação podem conter dados pessoais.');
      await groups.getByLabel('Buscar grupo de logs').fill('auditoria');
      await expect(groups.getByRole('status')).toContainText('Mostrando 1 de 1 grupo.');
      await groups.getByRole('checkbox', { name: '/aplicacao/auditoria' }).check();
      await sources.getByRole('button', { name: 'Autorizar selecionadas (3)' }).click();
      const confirmation = sources.getByRole('group', { name: 'Confirmar a autorização de 3 fontes' });
      await expect(confirmation).toContainText(
        'A coleta começa hoje: o Verax não busca o histórico anterior.',
      );
      await expect(confirmation).toContainText('Pode aumentar o volume mensal do seu plano.');
      // O grupo de logs pede a confirmação explícita.
      const confirm = confirmation.getByRole('button', { name: 'Confirmar autorização' });
      await expect(confirm).toBeDisabled();
      expect(await violations(page)).toEqual([]);
      await confirmation.getByRole('checkbox', { name: /^Confirmo que o Verax pode ler/ }).check();
      await confirm.click();

      // Autorizadas: aguardando o coletor, e a conta configurando. Nada de "tudo certo" antes da hora.
      const monitor = sheet.getByRole('region', { name: 'Fontes autorizadas' });
      await expect(monitor.getByRole('rowheader', { name: /management-events/ })).toBeVisible();
      await expect(monitor.getByRole('rowheader', { name: /\/aplicacao\/auditoria/ })).toContainText(
        'Sensível',
      );
      await expect(status).toContainText('Configurando coletores');
      await expect(
        sources.getByRole('checkbox', { name: /CloudTrail \(trilha\) · management-events/ }),
      ).toHaveCount(0);
      expect(await violations(page)).toEqual([]);

      // Os coletores da demonstração começam a ler: todas coletando, e só então o estado é "Coletando eventos".
      await expect(status).toContainText('Coletando eventos', { timeout: STEP_TIMEOUT });
      await expect(status).not.toContainText('pendências');
      await expect(monitor.getByText('Coletando', { exact: true })).toHaveCount(3);
      await expect(
        situation.getByRole('list', { name: 'Passos da conexão' }).locator('[aria-current="step"]'),
      ).toContainText('Coletando eventos');
      expect(await violations(page)).toEqual([]);

      // Retirar a autorização pede a confirmação, e a fonte volta para as disponíveis.
      await monitor.getByRole('button', { name: /^Revogar: GuardDuty \(API\)/ }).click();
      expect(await violations(page)).toEqual([]);
      await monitor.getByRole('button', { name: 'Confirmar revogação' }).click();
      await expect(monitor.getByRole('rowheader', { name: /GuardDuty \(API\)/ })).toHaveCount(0);
      await expect(sources.getByRole('region', { name: /^Disponíveis para coletar/ })).toContainText(
        'Autorização retirada em',
      );
    });
  }

  test('a escolha do "Conectar com AWS" fica gravada: o arquivo sai com ela, a pilha lida bate e a tela reaberta a traz de volta', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await context.route('https://console.aws.amazon.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>CloudFormation</title>' }),
    );
    await useRole(page, 'admin_verax');
    await page.goto('/cadastros/contas');
    await page.getByRole('button', { name: 'Cadastrar conta' }).click();
    const create = page.getByRole('dialog', { name: 'Cadastrar conta' });
    await create.getByLabel('ID da conta AWS').fill('246813579135');
    await create.getByRole('button', { name: 'Cadastrar conta' }).click();
    await expect(create.getByText(/Conta AWS 246813579135 cadastrada/)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /246813579135/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Conta AWS 246813579135' });

    // O cliente desliga uma das três autorizações antes de conectar.
    const connect = sheet.getByRole('region', { name: 'Conectar a conta 246813579135' });
    await connect
      .getByRole('group', { name: 'O que você autoriza' })
      .getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' })
      .uncheck();
    const [download, popup] = await Promise.all([
      page.waitForEvent('download'),
      context.waitForEvent('page'),
      connect.getByRole('button', { name: 'Conectar com AWS' }).click(),
    ]);
    await popup.close();
    // O arquivo sai com a escolha: só a leitura dos grupos de logs desligada.
    const file = readFileSync(await download.path(), 'utf8');
    expect(parameterDefault(file, 'ReadTaggedLogGroups')).toBe("'false'");
    expect(parameterDefault(file, 'ReadAwsServiceLogs')).toBe("'true'");
    expect(parameterDefault(file, 'ReadSecurityFindings')).toBe("'true'");

    // A pilha "fica pronta" como o cliente escolheu: a tela mostra a autorização desligada, sem acusar diferença.
    const status = sheet.getByRole('region', { name: 'Situação da conexão' }).getByRole('status');
    await expect(status).toContainText('Aguardando autorização de fontes', { timeout: STEP_TIMEOUT });
    const stack = sheet.getByRole('region', { name: 'Pilha na AWS' });
    await expect(stack).toContainText('Grupos do CloudWatch Logs marcados: desligada');
    await expect(stack).toContainText('Achados de segurança: ligada');
    await expect(stack.getByText(/não está como você escolheu aqui/)).toHaveCount(0);

    // Fechada e aberta de novo, a tela volta com a escolha gravada, e não com as três ligadas.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await page.getByRole('button', { name: /246813579135/ }).click();
    await expect(
      stack.getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' }),
    ).not.toBeChecked();
    await expect(stack.getByRole('checkbox', { name: 'Achados de segurança' })).toBeChecked();
    await expect(stack.getByRole('checkbox', { name: 'Logs de serviços da AWS no S3' })).toBeChecked();
  });

  test('a conta conectada no celular: as tabelas rolam por dentro, sem rolagem horizontal da página', async ({
    page,
  }) => {
    await openOnPhone(page, 'admin_verax', 360);
    expect(await violations(page)).toEqual([]);
  });

  test('a conta conectada a 320 px: os quadros das tabelas rolam de lado, têm nome e recebem o foco do teclado', async ({
    page,
  }) => {
    // Quem administra o cliente não tem, no cabeçalho, o seletor de cliente da Verax (que a 320 px passa da tela).
    const sheet = await openOnPhone(page, 'admin_cliente', 320);
    // Nesta largura os dois quadros rolam de lado em qualquer sistema, bem além da folga que o axe dá antes de tratar
    // um quadro como rolável (a 360 px, o das leituras que ficaram de fora só passa dela com a fonte do Linux). É o
    // que faz a regra `scrollable-region-focusable` valer aqui, e não só na integração contínua.
    const frames = sheet.locator('.overflow-x-auto');
    await expect(frames).toHaveCount(TABLE_FRAMES.length);
    const overflows = await frames.evaluateAll((elements) =>
      elements.map((element) => element.scrollWidth - element.clientWidth),
    );
    expect(Math.min(...overflows)).toBeGreaterThan(2 * AXE_SCROLL_TOLERANCE_PX);
    expect(await violations(page)).toEqual([]);
    // Cada quadro é uma região com o nome da tabela dele, alcançável pelo teclado (sem mouse, é o foco no quadro que
    // deixa rolar até as colunas da direita).
    for (const name of TABLE_FRAMES) {
      const frame = sheet.getByRole('region', { name, exact: true });
      await expect(frame).toHaveAttribute('tabindex', '0');
      await frame.focus();
      await expect(frame).toBeFocused();
    }
    // Com o foco no quadro, as setas rolam a tabela.
    const monitor = sheet.getByRole('region', { name: TABLE_FRAMES[1], exact: true });
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => monitor.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  });

  test('as fontes de achados da conta conectada (escuro): cada situação com o texto dela, e o "Tentar de novo" espera os 30 s', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await useRole(page, 'admin_verax', 'dark');
    await page.goto(`/cadastros/contas?conta=${AWS_ACCOUNT}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const sheet = page.getByRole('dialog', { name: AWS_DIALOG });
    await expect(
      sheet.getByRole('region', { name: 'Situação da conexão' }).getByRole('status'),
    ).toContainText('Erro de permissão');
    const monitor = sheet.getByRole('region', { name: 'Fontes autorizadas' });
    // Sem achado nenhum, limitada pela AWS, sem a permissão de leitura e desligada na conta.
    await expect(monitor).toContainText('Sincronizada, sem achados novos');
    await expect(monitor).toContainText('A leitura deu certo, e o serviço ainda não trouxe nenhum achado.');
    await expect(monitor).toContainText('Falta permissão: a AWS negou a ação access-analyzer:ListFindings.');
    await expect(monitor).toContainText('O serviço foi desligado na conta depois da autorização.');
    const throttled = monitor.getByRole('row').filter({ hasText: 'A AWS está limitando as chamadas' });
    await expect(throttled).toHaveCount(1);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    // O clique pede a leitura da fonte agora; respondido, o botão espera o intervalo da mesma fonte.
    await throttled.getByRole('button', { name: /^Tentar de novo: Security Hub/ }).click();
    const waiting = throttled.getByRole('button', { name: /^Tentar de novo em \d+ s: Security Hub/ });
    await expect(waiting).toBeVisible({ timeout: 20_000 });
    await expect(waiting).toBeDisabled();
    // A espera é só daquela fonte.
    await expect(monitor.getByRole('button', { name: /^Tentar de novo: / }).first()).toBeEnabled();
    expect(await violations(page)).toEqual([]);
  });

  test('quem só lê acompanha a conta, sem conectar, autorizar nem revogar', async ({ page }) => {
    await useRole(page, 'leitura');
    await page.goto(`/cadastros/contas?conta=${AWS_ACCOUNT}`);
    const sheet = page.getByRole('dialog', { name: AWS_DIALOG });
    await expect(
      sheet.getByRole('region', { name: 'Situação da conexão' }).getByRole('status'),
    ).toContainText('Erro de permissão');
    await expect(sheet.getByRole('region', { name: 'Fontes autorizadas' })).toBeVisible();
    await expect(
      sheet.getByRole('button', { name: /Verificar|Conectar|Autorizar|Revogar|Descobrir|Tentar/ }),
    ).toHaveCount(0);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });
});
