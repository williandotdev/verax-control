import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AWS_ONBOARDING_STATES,
  type AwsOnboarding,
  type AwsOnboardingState,
  type CloudAccount,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers } from '@/mocks/handlers';
import {
  authorizedSourceFixture,
  awsAccountFixture,
  checksFixture,
  FIXTURE_NOW,
  onboardingFixture,
  runFixture,
} from '@/test/aws-onboarding-fixtures';
import { type OnboardingApi, onboardingApi, refusal, renderAwsSection } from '@/test/aws-onboarding-harness';
import { READER_TEMPLATE_TEXT } from '@/test/aws-reader-template';
import { stubObjectUrls } from '@/test/object-url';
import { AWS_ONBOARDING_ERROR_TEXTS, AWS_ONBOARDING_STATE_TEXTS } from './aws-onboarding-labels';

/** A releitura a cada 5 s precisa de folga sobre os 15 s padrão quando a suíte inteira roda em paralelo. */
const POLL_TIMEOUT = 30_000;

const server = setupServer();
beforeAll(() => server.listen());
let objectUrls: ReturnType<typeof stubObjectUrls> | undefined;
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.restoreAllMocks();
  vi.useRealTimers();
  objectUrls?.restore();
  objectUrls = undefined;
});
afterAll(() => server.close());

/** A seção na tela, com a API do teste na frente das rotas do mock (que respondem a sessão e o CSRF). */
function open(
  onboarding: (account: CloudAccount) => AwsOnboarding,
  options: {
    account?: Partial<CloudAccount>;
    canWrite?: boolean;
    /** Respostas que valem antes das do teste (o MSW usa a primeira que casa). */
    handlers?: Parameters<typeof server.use>;
  } = {},
): { account: CloudAccount; fake: OnboardingApi } {
  const account = awsAccountFixture(options.account);
  const fake = onboardingApi(account, onboarding(account));
  server.use(
    ...(options.handlers ?? []),
    ...fake.handlers,
    ...createHandlers({ me: demoMe('admin_cliente') }),
  );
  renderAwsSection(account, options.canWrite ?? true);
  return { account, fake };
}

/** A mesma seção, para os testes que a abrem mais de uma vez: devolve como tirá-la da tela. */
function renderOnly(onboarding: (account: CloudAccount) => AwsOnboarding): { unmount: () => void } {
  const account = awsAccountFixture();
  const fake = onboardingApi(account, onboarding(account));
  server.resetHandlers();
  server.use(...fake.handlers, ...createHandlers({ me: demoMe('admin_cliente') }));
  return renderAwsSection(account, true);
}

/** O aviso do estado da conta, no alto da situação da conexão. */
const banner = async () =>
  within(await screen.findByRole('region', { name: 'Situação da conexão' })).getByRole('status');

const state =
  (name: AwsOnboardingState, overrides: Partial<AwsOnboarding> = {}) =>
  (account: CloudAccount) =>
    onboardingFixture(account.id, name, overrides);

/** O que o clique em "Conectar com AWS" faz no navegador, na ordem em que acontece. */
function watchBrowser() {
  const events: string[] = [];
  objectUrls = stubObjectUrls();
  const { create, revoke } = objectUrls;
  const downloads: { name: string; blob: Blob }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (!this.download) return;
    events.push('download');
    const blob = create.mock.calls.at(-1)?.[0];
    if (blob) downloads.push({ name: this.download, blob });
  });
  const opened = vi.spyOn(window, 'open').mockImplementation(() => {
    events.push('open');
    return null;
  });
  return { events, downloads, opened, revoke };
}

type Authorization = 'service-logs' | 'findings' | 'log-groups';

/** A conta esperando a pilha, com a escolha gravada informada: o que a API devolve depois de um "Conectar" com ela. */
const waitingFor = (capabilities: Authorization[]) =>
  state('awaiting_authorization', {
    connect: {
      requestedAt: '2026-11-23T12:00:00.000Z',
      waitingUntil: new Date(Date.now() + 50 * 60_000).toISOString(),
      capabilities,
    },
    checks: checksFixture({ assume_role: { status: 'pending', code: 'awaiting_stack' } }),
  });

/** O padrão gravado no arquivo para cada parâmetro de autorização: a linha `Default:` do bloco dele. */
function authorizationDefaults(template: string): Record<string, string | undefined> {
  const lines = template.split('\n').map((line) => line.trimEnd());
  const defaultOf = (parameter: string) => {
    const block = lines.slice(lines.indexOf(`  ${parameter}:`) + 1);
    const end = block.findIndex((line) => line.startsWith('  ') && !line.startsWith('   '));
    return block
      .slice(0, end === -1 ? block.length : end)
      .find((line) => line.startsWith('    Default: '))
      ?.slice('    Default: '.length);
  };
  return {
    ReadAwsServiceLogs: defaultOf('ReadAwsServiceLogs'),
    ReadSecurityFindings: defaultOf('ReadSecurityFindings'),
    ReadTaggedLogGroups: defaultOf('ReadTaggedLogGroups'),
  };
}

/** O arquivo que o comando da CLI lê (`--template-file`). */
const templateFileOf = (command: HTMLElement): string | undefined =>
  / --template-file (\S+) /.exec(command.textContent)?.[1];

/** As linhas do arquivo que não estão no template do repositório. */
function changedLines(filled: string): string[] {
  const original = new Set(READER_TEMPLATE_TEXT.split('\n'));
  return filled.split('\n').filter((line) => !original.has(line));
}

describe('Conectar com AWS', () => {
  it('um clique abre o CloudFormation, avisa a API e, com a escolha confirmada, baixa o arquivo preenchido; a tela só avança com a resposta', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    const { account, fake } = open(state('not_started'));
    fake.on('connect', () => {
      browser.events.push('connect');
      return onboardingFixture(account.id, 'awaiting_authorization', {
        connect: {
          requestedAt: new Date().toISOString(),
          waitingUntil: new Date(Date.now() + 45 * 60_000).toISOString(),
          // A API devolve a escolha que o clique mandou.
          capabilities: ['service-logs', 'log-groups'],
        },
        checks: checksFixture({ assume_role: { status: 'pending', code: 'awaiting_stack' } }),
      });
    });
    const panel = await screen.findByRole('region', { name: 'Conectar a conta 111111111111' });
    // O que a integração faz e o que o cliente autoriza, antes do botão.
    expect(panel).toHaveTextContent('Nada é coletado até você escolher e autorizar cada fonte');
    const choices = within(panel).getByRole('group', { name: 'O que você autoriza' });
    for (const label of [
      'Logs de serviços da AWS no S3',
      'Achados de segurança',
      'Grupos do CloudWatch Logs marcados',
    ]) {
      expect(within(choices).getByRole('checkbox', { name: label })).toBeChecked();
    }
    expect(
      within(choices).getByRole('checkbox', { name: 'Logs de serviços da AWS no S3' }),
    ).toHaveAccessibleDescription(
      /lista os nomes do primeiro nível dos buckets: só os nomes, nunca o conteúdo/,
    );
    expect(choices).toHaveTextContent('Descoberta e postura (sempre ligada)');
    // E-10: cada autorização em linhas com rótulo; a descrição da caixa lê as linhas inteiras, com os rótulos.
    const findings = within(choices).getByRole('checkbox', { name: 'Achados de segurança' });
    expect(findings).toHaveAccessibleDescription(
      'Lê: os achados do GuardDuty, do Security Hub, do Inspector e do IAM Access Analyzer. Não faz: Não liga nenhum desses serviços (ligar tem custo na AWS, e a decisão é sua) e não altera, arquiva nem apaga achado nenhum.',
    );
    const logs = within(choices).getByRole('checkbox', { name: 'Logs de serviços da AWS no S3' });
    const lines = document.getElementById(logs.getAttribute('aria-describedby') ?? '') as HTMLElement;
    expect([...lines.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      'Lê:',
      'Onde:',
      'Não lê:',
      'Dado pessoal:',
    ]);
    expect(choices).toHaveTextContent('Nada é criado nem alterado na sua conta AWS');
    // O cliente desliga os achados: o arquivo sai com essa escolha.
    await user.click(within(choices).getByRole('checkbox', { name: 'Achados de segurança' }));

    const button = await within(panel).findByRole('button', { name: 'Conectar com AWS' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    // Na ordem: o console em outra aba (sem acesso a esta), o aviso à API e, com a resposta dela, o arquivo.
    await waitFor(() => expect(browser.events).toEqual(['open', 'connect', 'download']));
    expect(browser.opened).toHaveBeenCalledExactlyOnceWith(
      'https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks/create',
      '_blank',
      'noopener,noreferrer',
    );
    // O pedido leva a escolha das caixas (sem a descoberta, que vale sempre); o arquivo sai com a que a API confirmou.
    expect(fake.calls).toEqual([
      { route: 'connect', sourceId: null, body: { capabilities: ['service-logs', 'log-groups'] } },
    ]);
    const [download] = browser.downloads;
    expect(download?.name).toBe('verax-control-reader-111111111111.yaml');
    const text = (await download?.blob.text()) ?? '';
    const changed = changedLines(text);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((line) => line.startsWith('    Default: '))).toBe(true);
    expect(changed).toEqual(
      expect.arrayContaining(["    Default: '123456789012345678901'", "    Default: '203.0.113.10/32'"]),
    );
    // Só os achados saem desligados: um 'false' a mais do que o template já tinha.
    const falses = (value: string) => value.split("    Default: 'false'").length - 1;
    expect(falses(text)).toBe(falses(READER_TEMPLATE_TEXT) + 1);
    await waitFor(() => expect(browser.revoke).toHaveBeenCalledWith('blob:verax-teste'), { timeout: 3_000 });

    // A resposta da API leva a tela para a espera, com os três passos e o prazo que a API mandou.
    const waiting = await screen.findByRole('region', { name: 'Crie a pilha na AWS' });
    expect(screen.queryByRole('region', { name: 'Conectar a conta 111111111111' })).not.toBeInTheDocument();
    expect(waiting).toHaveTextContent('Carregar um arquivo de modelo');
    expect(waiting).toHaveTextContent('avance sem mudar os valores');
    expect(waiting).toHaveTextContent('marque a confirmação de IAM');
    expect(waiting).toHaveTextContent('O Verax não enxerga a pilha enquanto ela é criada.');
    expect(waiting).toHaveTextContent(/Tempo restante para criar a pilha: 4[45] min/);
    expect(within(waiting).getByRole('link', { name: /Abrir o CloudFormation/ })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(await banner()).toHaveTextContent('Aguardando autorização na AWS');

    // "Baixar o arquivo de novo" repete o mesmo arquivo, com a mesma escolha, sem abrir nada nem avisar a API.
    await user.click(within(waiting).getByRole('button', { name: 'Baixar o arquivo de novo' }));
    expect(browser.downloads).toHaveLength(2);
    expect(await browser.downloads[1]?.blob.text()).toBe(text);
    expect(browser.opened).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(1);

    // A CLI da espera lê o arquivo que este painel baixa, pelo nome, e leva a escolha (os achados desligados).
    const cli = within(waiting).getByText(/^aws cloudformation deploy/);
    expect(browser.downloads[1]?.name).toBe('verax-control-reader-111111111111.yaml');
    expect(templateFileOf(cli)).toBe(browser.downloads[1]?.name);
    expect(waiting).toHaveTextContent(
      'na pasta do arquivo baixado aqui (verax-control-reader-111111111111.yaml)',
    );
    expect(cli).toHaveTextContent('NodeServiceAccountId=123456789012345678901');
    expect(cli).toHaveTextContent('ReadSecurityFindings=false');
    expect(cli).toHaveTextContent('ReadTaggedLogGroups=true');
  });

  it('valor do nó faltando: nenhum arquivo quebrado, só o que pedir à Verax; a alternativa manual leva os marcadores', async () => {
    const browser = watchBrowser();
    const { fake } = open(state('not_started'), { account: { nodeServiceAccountId: null, egressIps: [] } });
    const panel = await screen.findByRole('region', { name: 'Conectar a conta 111111111111' });
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Este ambiente ainda não informa o ID da conta de serviço dele, que vai na pilha. Peça à Verax antes de criar a pilha.',
    );
    expect(within(panel).queryByRole('button', { name: 'Conectar com AWS' })).not.toBeInTheDocument();
    expect(
      within(panel).getByText('Este nó ainda não informa o ID. Peça à Verax antes de criar a pilha.'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText('Este nó ainda não informa o IP. Peça à Verax antes de criar a pilha.'),
    ).toBeInTheDocument();
    const command = within(panel).getByText(/^aws cloudformation deploy/);
    expect(command).toHaveTextContent('NodeServiceAccountId=ID_DA_CONTA_DE_SERVICO_DO_NO');
    expect(command).toHaveTextContent('NodeEgressIps=IP_DE_SAIDA_DO_NO/32');
    expect(browser.events).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('o modelo que não carrega pede para tentar de novo, e o botão só aparece com o arquivo pronto', async () => {
    const user = userEvent.setup();
    let fail = true;
    const { account } = open(state('not_started'), {
      handlers: [
        http.get('*/verax-control-reader.yaml', () =>
          fail ? new HttpResponse(null, { status: 500 }) : HttpResponse.text(READER_TEMPLATE_TEXT),
        ),
      ],
    });
    const panel = await screen.findByRole('region', { name: `Conectar a conta ${account.accountId}` });
    expect(await within(panel).findByRole('alert', undefined, { timeout: 10_000 })).toHaveTextContent(
      'O modelo da pilha não carregou.',
    );
    expect(within(panel).queryByRole('button', { name: 'Conectar com AWS' })).not.toBeInTheDocument();
    fail = false;
    await user.click(within(panel).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Conectar com AWS' })).toBeEnabled(),
    );
  });

  it('a recusa da API aparece, e a tela continua no mesmo passo (nada é adiantado): nenhum arquivo sai com a escolha que não foi gravada', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    const { account, fake } = open(state('not_started'));
    let refuse = true;
    fake.on('connect', (call) =>
      refuse
        ? refusal(400, undefined, 'Reative o monitoramento antes de conectar a conta.')
        : onboardingFixture(account.id, 'awaiting_authorization', {
            connect: {
              requestedAt: new Date().toISOString(),
              waitingUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
              capabilities: (call.body as { capabilities: ('service-logs' | 'findings' | 'log-groups')[] })
                .capabilities,
            },
          }),
    );
    const panel = await screen.findByRole('region', { name: 'Conectar a conta 111111111111' });
    const groups = within(panel).getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' });
    await user.click(groups);
    const button = await within(panel).findByRole('button', { name: 'Conectar com AWS' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('Reative o monitoramento antes de conectar a conta.');
    expect(alert).toHaveTextContent('nenhum arquivo foi baixado');
    expect(screen.queryByRole('region', { name: 'Crie a pilha na AWS' })).not.toBeInTheDocument();
    expect(await banner()).toHaveTextContent('Não conectada');
    // O console abriu no clique; o arquivo, que levaria uma escolha não gravada, não saiu.
    expect(browser.events).toEqual(['open']);
    // As caixas ficam como o cliente as deixou: nenhuma autorização volta a ficar ligada sozinha.
    expect(groups).not.toBeChecked();
    expect(groups).toBeEnabled();

    // De novo, com a API respondendo: o mesmo pedido, e agora o arquivo, com a escolha confirmada.
    refuse = false;
    await user.click(button);
    await waitFor(() => expect(browser.downloads).toHaveLength(1));
    expect(fake.calls.map((call) => call.body)).toEqual([
      { capabilities: ['service-logs', 'findings'] },
      { capabilities: ['service-logs', 'findings'] },
    ]);
    const text = (await browser.downloads[0]?.blob.text()) ?? '';
    expect(authorizationDefaults(text)).toEqual({
      ReadAwsServiceLogs: "'true'",
      ReadSecurityFindings: "'true'",
      ReadTaggedLogGroups: "'false'",
    });
  });

  it('alternativa manual: o template sem preencher, os valores com cópia, a CLI com a escolha e o aviso à API', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    const { fake } = open(state('not_started'), {
      account: { buckets: { cloudtrail: 'exemplo-trilha', guardduty: null, waf: null } },
    });
    const panel = await screen.findByRole('region', { name: 'Conectar a conta 111111111111' });
    expect(within(panel).getByText('Alternativa manual (sem o arquivo preenchido)')).toBeInTheDocument();
    const link = within(panel).getByRole('link', {
      name: /Baixar o template \(verax-control-reader\.yaml\)/,
    });
    expect(link).toHaveAttribute('download', 'verax-control-reader.yaml');
    expect(link.getAttribute('href')).toMatch(/verax-control-reader\.yaml$/);
    expect(within(panel).getByRole('link', { name: /passo a passo/ })).toHaveAttribute(
      'href',
      expect.stringContaining('infra/cloudformation/README.md'),
    );
    await user.click(within(panel).getByRole('button', { name: 'Copiar: ID da conta de serviço do nó' }));
    expect(await navigator.clipboard.readText()).toBe('123456789012345678901');
    expect(within(panel).getByText('arn:aws:s3:::exemplo-trilha')).toBeInTheDocument();
    // A CLI acompanha as caixas: desligar os grupos de logs muda o comando.
    const command = within(panel).getByText(/^aws cloudformation deploy/);
    expect(command).toHaveTextContent('ReadTaggedLogGroups=true');
    // E lê o arquivo que o link deste bloco baixa: o template do repositório, sem nada preenchido.
    expect(templateFileOf(command)).toBe(link.getAttribute('download'));
    expect(templateFileOf(command)).toBe('verax-control-reader.yaml');
    await user.click(within(panel).getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' }));
    expect(within(panel).getByText(/^aws cloudformation deploy/)).toHaveTextContent(
      'ReadTaggedLogGroups=false',
    );
    expect(within(panel).getByText(/^aws cloudformation deploy/)).toHaveTextContent(
      'LogBucketArns=arn:aws:s3:::exemplo-trilha',
    );
    // Criada a pilha pela CLI, o botão só avisa a API: não baixa nem abre nada. O aviso leva a escolha do comando.
    await user.click(within(panel).getByRole('button', { name: 'Já criei a pilha: conectar' }));
    await waitFor(() =>
      expect(fake.calls).toEqual([
        { route: 'connect', sourceId: null, body: { capabilities: ['service-logs', 'findings'] } },
      ]),
    );
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Já criei a pilha: conectar' })).toBeEnabled(),
    );
    expect(browser.events).toEqual([]);
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a tela recarregada devolve a escolha gravada: as caixas, o arquivo baixado de novo e a CLI, nunca as três de volta', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    // Como a API responde depois de um "Conectar" só com os logs do S3: a tela acabou de abrir, sem estado nenhum.
    const { fake } = open(
      state('awaiting_authorization', {
        connect: {
          requestedAt: new Date().toISOString(),
          waitingUntil: new Date(Date.now() + 50 * 60_000).toISOString(),
          capabilities: ['service-logs'],
        },
        checks: checksFixture({ assume_role: { status: 'pending', code: 'awaiting_stack' } }),
      }),
    );
    const waiting = await screen.findByRole('region', { name: 'Crie a pilha na AWS' });
    const choices = within(waiting).getByRole('group', {
      name: 'O arquivo baixado de novo sai com estas autorizações',
      hidden: true,
    });
    const box = (name: string) => within(choices).getByRole('checkbox', { name, hidden: true });
    expect(box('Logs de serviços da AWS no S3')).toBeChecked();
    expect(box('Achados de segurança')).not.toBeChecked();
    expect(box('Grupos do CloudWatch Logs marcados')).not.toBeChecked();

    const again = within(waiting).getByRole('button', { name: 'Baixar o arquivo de novo' });
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    const text = (await browser.downloads[0]?.blob.text()) ?? '';
    // Os achados e os grupos de logs saem desligados: dois 'false' a mais do que o template já tinha.
    const falses = (value: string) => value.split("    Default: 'false'").length - 1;
    expect(falses(text)).toBe(falses(READER_TEMPLATE_TEXT) + 2);
    const cli = within(waiting).getByText(/^aws cloudformation deploy/);
    expect(cli).toHaveTextContent('ReadAwsServiceLogs=true');
    expect(cli).toHaveTextContent('ReadSecurityFindings=false');
    expect(cli).toHaveTextContent('ReadTaggedLogGroups=false');
    // Baixar de novo não muda a escolha gravada: nada vai para a API.
    expect(fake.calls).toEqual([]);
  });

  it('mudar uma caixa enquanto espera a pilha grava a escolha nova na hora, e o arquivo sai com ela', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    const waitingState = (capabilities: ('service-logs' | 'findings' | 'log-groups')[]) =>
      state('awaiting_authorization', {
        connect: {
          requestedAt: '2026-11-23T12:00:00.000Z',
          waitingUntil: new Date(Date.now() + 50 * 60_000).toISOString(),
          capabilities,
        },
        checks: checksFixture({ assume_role: { status: 'pending', code: 'awaiting_stack' } }),
      });
    const { account, fake } = open(waitingState(['service-logs']));
    fake.on('connect', () => waitingState(['service-logs', 'findings'])(account));
    const waiting = await screen.findByRole('region', { name: 'Crie a pilha na AWS' });
    await user.click(within(waiting).getByText('O que o arquivo autoriza'));
    await user.click(within(waiting).getByRole('checkbox', { name: 'Achados de segurança' }));
    await waitFor(() =>
      expect(fake.calls).toEqual([
        { route: 'connect', sourceId: null, body: { capabilities: ['service-logs', 'findings'] } },
      ]),
    );
    expect(waiting).toHaveTextContent('A escolha fica gravada');
    const again = within(waiting).getByRole('button', { name: 'Baixar o arquivo de novo' });
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    const falses = (value: string) => value.split("    Default: 'false'").length - 1;
    expect(falses((await browser.downloads[0]?.blob.text()) ?? '')).toBe(falses(READER_TEMPLATE_TEXT) + 1);
    // O prazo é o do "Conectar" de antes: gravar a escolha não o renova (a API responde com o mesmo pedido).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('marcar e desmarcar em seguida, com a primeira gravação parada na API: um pedido de cada vez, vale a última escolha, e nada sai da tela antes de ela ser a gravada', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    const { account, fake } = open(waitingFor(['service-logs', 'findings']));
    // A primeira gravação fica parada na API até o teste soltar; as seguintes respondem na hora.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let together = 0;
    fake.on('connect', async (call) => {
      inFlight += 1;
      together = Math.max(together, inFlight);
      if (fake.calls.length === 1) await held;
      inFlight -= 1;
      return waitingFor((call.body as { capabilities: Authorization[] }).capabilities)(account);
    });
    const waiting = await screen.findByRole('region', { name: 'Crie a pilha na AWS' });
    await user.click(within(waiting).getByText('O que o arquivo autoriza'));
    const findings = within(waiting).getByRole('checkbox', { name: 'Achados de segurança' });
    const groups = within(waiting).getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' });
    const again = within(waiting).getByRole('button', { name: 'Baixar o arquivo de novo' });
    await waitFor(() => expect(again).toBeEnabled());
    expect(within(waiting).getByText(/^aws cloudformation deploy/)).toBeInTheDocument();

    // Desliga os achados (o primeiro pedido sai e fica parado), liga os grupos, liga os achados e desliga de novo.
    await user.click(findings);
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    await user.click(groups);
    await user.click(findings);
    await user.click(findings);

    // Só um pedido saiu. As caixas mostram a última escolha; o arquivo e o comando esperam ela ser gravada.
    expect(fake.calls).toHaveLength(1);
    expect(findings).not.toBeChecked();
    expect(groups).toBeChecked();
    expect(again).toBeDisabled();
    expect(within(waiting).getByText(/Salvando a escolha/)).toBeInTheDocument();
    expect(within(waiting).queryByText(/^aws cloudformation deploy/)).not.toBeInTheDocument();
    await user.click(again);
    expect(browser.downloads).toEqual([]);

    // A primeira termina: a seguinte leva a escolha de agora, e nenhuma das que ficaram pelo caminho.
    release();
    await waitFor(() => expect(again).toBeEnabled());
    expect(fake.calls.map((call) => call.body)).toEqual([
      { capabilities: ['service-logs'] },
      { capabilities: ['service-logs', 'log-groups'] },
    ]);
    expect(together).toBe(1);
    expect(within(waiting).queryByText(/Salvando a escolha/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // O arquivo e o comando saem com a escolha que a API confirmou por último.
    await user.click(again);
    expect(authorizationDefaults((await browser.downloads[0]?.blob.text()) ?? '')).toEqual({
      ReadAwsServiceLogs: "'true'",
      ReadSecurityFindings: "'false'",
      ReadTaggedLogGroups: "'true'",
    });
    const cli = within(waiting).getByText(/^aws cloudformation deploy/);
    expect(cli).toHaveTextContent('ReadSecurityFindings=false');
    expect(cli).toHaveTextContent('ReadTaggedLogGroups=true');
  });

  it('desligar e ligar de volta com a gravação no caminho: o segundo pedido só sai depois do primeiro, e fica gravada a escolha de volta', async () => {
    const user = userEvent.setup();
    const { account, fake } = open(waitingFor(['service-logs', 'findings']));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.on('connect', async (call) => {
      if (fake.calls.length === 1) await held;
      return waitingFor((call.body as { capabilities: Authorization[] }).capabilities)(account);
    });
    const waiting = await screen.findByRole('region', { name: 'Crie a pilha na AWS' });
    await user.click(within(waiting).getByText('O que o arquivo autoriza'));
    const findings = within(waiting).getByRole('checkbox', { name: 'Achados de segurança' });
    await user.click(findings);
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    await user.click(findings);
    expect(fake.calls).toHaveLength(1);
    release();
    await waitFor(() =>
      expect(fake.calls.map((call) => call.body)).toEqual([
        { capabilities: ['service-logs'] },
        { capabilities: ['service-logs', 'findings'] },
      ]),
    );
    const again = within(waiting).getByRole('button', { name: 'Baixar o arquivo de novo' });
    await waitFor(() => expect(again).toBeEnabled());
    expect(findings).toBeChecked();
  });

  it('a gravação que falha fica à vista: as caixas como o cliente deixou, o arquivo e o comando indisponíveis, e "Tentar de novo" grava', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    const { account, fake } = open(waitingFor(['service-logs']));
    let fail = true;
    fake.on('connect', (call) =>
      fail
        ? refusal(500)
        : waitingFor((call.body as { capabilities: Authorization[] }).capabilities)(account),
    );
    const waiting = await screen.findByRole('region', { name: 'Crie a pilha na AWS' });
    await user.click(within(waiting).getByText('O que o arquivo autoriza'));
    const findings = within(waiting).getByRole('checkbox', { name: 'Achados de segurança' });
    const again = within(waiting).getByRole('button', { name: 'Baixar o arquivo de novo' });
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(findings);

    const alert = await within(waiting).findByRole('alert');
    expect(alert).toHaveTextContent('A escolha marcada não foi salva');
    // A caixa fica como o cliente a deixou, e nada sai da tela com a escolha que não foi gravada.
    expect(findings).toBeChecked();
    expect(again).toBeDisabled();
    expect(within(waiting).queryByText(/^aws cloudformation deploy/)).not.toBeInTheDocument();
    await user.click(again);
    expect(browser.downloads).toEqual([]);

    // "Tentar de novo" manda a mesma escolha; gravada, o arquivo sai com ela.
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(again).toBeEnabled());
    expect(fake.calls.map((call) => call.body)).toEqual([
      { capabilities: ['service-logs', 'findings'] },
      { capabilities: ['service-logs', 'findings'] },
    ]);
    expect(within(waiting).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(again);
    expect(authorizationDefaults((await browser.downloads[0]?.blob.text()) ?? '')).toEqual({
      ReadAwsServiceLogs: "'true'",
      ReadSecurityFindings: "'true'",
      ReadTaggedLogGroups: "'false'",
    });
  });

  it('depois da falha, voltar a caixa para a escolha gravada libera o arquivo, que sai com a gravada', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    const { account, fake } = open(waitingFor(['service-logs']));
    let fail = true;
    fake.on('connect', (call) =>
      fail
        ? refusal(500)
        : waitingFor((call.body as { capabilities: Authorization[] }).capabilities)(account),
    );
    const waiting = await screen.findByRole('region', { name: 'Crie a pilha na AWS' });
    await user.click(within(waiting).getByText('O que o arquivo autoriza'));
    const findings = within(waiting).getByRole('checkbox', { name: 'Achados de segurança' });
    const again = within(waiting).getByRole('button', { name: 'Baixar o arquivo de novo' });
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(findings);
    await within(waiting).findByRole('alert');
    expect(again).toBeDisabled();

    fail = false;
    await user.click(findings);
    await waitFor(() => expect(again).toBeEnabled());
    expect(within(waiting).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(again);
    expect(authorizationDefaults((await browser.downloads[0]?.blob.text()) ?? '')).toEqual({
      ReadAwsServiceLogs: "'true'",
      ReadSecurityFindings: "'false'",
      ReadTaggedLogGroups: "'false'",
    });
  });

  it('esperando a pilha sem escolha gravada: o primeiro "Baixar o arquivo de novo" grava a escolha da tela, e o arquivo sai com a confirmada', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    // Um "Conectar de novo" das conferências, numa conta que nunca gravou a escolha: a tela parte das três do modelo.
    const { account, fake } = open(
      state('awaiting_authorization', {
        connect: {
          requestedAt: new Date().toISOString(),
          waitingUntil: new Date(Date.now() + 50 * 60_000).toISOString(),
          capabilities: null,
        },
        checks: checksFixture({ assume_role: { status: 'pending', code: 'awaiting_stack' } }),
      }),
    );
    let fail = true;
    fake.on('connect', (call) =>
      fail
        ? refusal(500)
        : waitingFor((call.body as { capabilities: Authorization[] }).capabilities)(account),
    );
    const waiting = await screen.findByRole('region', { name: 'Crie a pilha na AWS' });
    const again = within(waiting).getByRole('button', { name: 'Baixar o arquivo de novo' });
    await waitFor(() => expect(again).toBeEnabled());
    // A gravação falha: nenhum arquivo sai, e a tela diz por quê.
    await user.click(again);
    expect(await within(waiting).findByRole('alert')).toHaveTextContent('nenhum arquivo foi baixado');
    expect(browser.downloads).toEqual([]);

    fail = false;
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    await waitFor(() => expect(browser.downloads).toHaveLength(1));
    expect(within(waiting).queryByRole('alert')).not.toBeInTheDocument();
    expect(fake.calls.map((call) => call.body)).toEqual([
      { capabilities: ['service-logs', 'findings', 'log-groups'] },
      { capabilities: ['service-logs', 'findings', 'log-groups'] },
    ]);
    expect(authorizationDefaults((await browser.downloads[0]?.blob.text()) ?? '')).toEqual({
      ReadAwsServiceLogs: "'true'",
      ReadSecurityFindings: "'true'",
      ReadTaggedLogGroups: "'true'",
    });
    // Com a escolha gravada, baixar de novo não manda mais nada.
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    expect(browser.downloads).toHaveLength(2);
    expect(fake.calls).toHaveLength(2);
  });

  it('criar a pilha de novo (desconectada): o painel parte da escolha gravada; sem ela, do que a pilha tinha', async () => {
    const stored = open(
      state('disconnected', {
        connect: { requestedAt: '2026-11-20T12:00:00.000Z', waitingUntil: null, capabilities: ['findings'] },
        checks: checksFixture({ assume_role: { status: 'failed', code: 'trust_denied' } }),
        template: {
          version: 2,
          capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
          outdated: false,
          checkedAt: '2026-11-21T12:00:00.000Z',
        },
      }),
    );
    const panel = await screen.findByRole('region', {
      name: `Conectar de novo a conta ${stored.account.accountId}`,
      hidden: true,
    });
    const box = (name: string) => within(panel).getByRole('checkbox', { name, hidden: true });
    expect(box('Achados de segurança')).toBeChecked();
    expect(box('Logs de serviços da AWS no S3')).not.toBeChecked();
    expect(box('Grupos do CloudWatch Logs marcados')).not.toBeChecked();
  });

  it('sem escolha gravada, o painel de criar de novo parte do que o papel tinha (as etiquetas), e não das três', async () => {
    const { account } = open(
      state('disconnected', {
        checks: checksFixture({ assume_role: { status: 'failed', code: 'trust_denied' } }),
        template: {
          version: 2,
          capabilities: ['discovery', 'service-logs'],
          outdated: false,
          checkedAt: '2026-11-21T12:00:00.000Z',
        },
      }),
    );
    const panel = await screen.findByRole('region', {
      name: `Conectar de novo a conta ${account.accountId}`,
      hidden: true,
    });
    const box = (name: string) => within(panel).getByRole('checkbox', { name, hidden: true });
    expect(box('Logs de serviços da AWS no S3')).toBeChecked();
    expect(box('Achados de segurança')).not.toBeChecked();
    expect(box('Grupos do CloudWatch Logs marcados')).not.toBeChecked();
  });

  it('quem só lê vê o que seria autorizado, sem o botão; a conta desativada pede a reativação', async () => {
    open(state('not_started'), { canWrite: false });
    const panel = await screen.findByRole('region', { name: 'Conectar a conta 111111111111' });
    expect(within(panel).getByText('Quem administra as contas conecta a conta.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Conectar/ })).not.toBeInTheDocument();
    expect(within(panel).getByRole('checkbox', { name: 'Achados de segurança' })).toBeDisabled();
  });

  it('a conta desativada não conecta: a tela pede a reativação', async () => {
    open(state('not_started'), { account: { status: 'inactive' } });
    const panel = await screen.findByRole('region', { name: 'Conectar a conta 111111111111' });
    expect(within(panel).getByText('Reative o monitoramento para conectar a conta.')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Conectar com AWS' })).not.toBeInTheDocument();
    expect(await banner()).toHaveTextContent('Monitoramento desativado');
  });
});

describe('na VM própria do cliente (chave de leitura): a escolha das autorizações', () => {
  it('o "Verificar" da chave leva as autorizações marcadas, as mesmas das políticas mostradas', async () => {
    const user = userEvent.setup();
    const { account, fake } = open(state('not_started', { credentialMode: 'access_key' }));
    const steps = await screen.findByRole('region', { name: `Conectar a conta ${account.accountId}` });
    await user.click(within(steps).getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' }));
    // A política de leitura mostrada já não tem a leitura dos grupos de logs.
    expect(steps).not.toHaveTextContent('logs:GetLogEvents');
    await user.click(within(steps).getByRole('button', { name: 'Verificar conexão' }));
    await waitFor(() =>
      expect(fake.calls).toEqual([
        { route: 'verify', sourceId: null, body: { capabilities: ['service-logs', 'findings'] } },
      ]),
    );
  });

  it('a tela reaberta mostra as políticas com a escolha gravada, e não com as três', async () => {
    const { account } = open(
      state('not_started', {
        credentialMode: 'access_key',
        connect: { requestedAt: null, waitingUntil: null, capabilities: ['findings'] },
      }),
    );
    const steps = await screen.findByRole('region', { name: `Conectar a conta ${account.accountId}` });
    expect(within(steps).getByRole('checkbox', { name: 'Achados de segurança' })).toBeChecked();
    expect(within(steps).getByRole('checkbox', { name: 'Logs de serviços da AWS no S3' })).not.toBeChecked();
    expect(
      within(steps).getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' }),
    ).not.toBeChecked();
    expect(steps).toHaveTextContent('guardduty:ListFindings');
    expect(steps).not.toHaveTextContent('logs:GetLogEvents');
  });

  it('o usuário de leitura com mais do que a escolha: o mesmo aviso, com os termos da chave', async () => {
    open(
      state('awaiting_sources', {
        credentialMode: 'access_key',
        connect: { requestedAt: null, waitingUntil: null, capabilities: ['service-logs'] },
        template: {
          version: 2,
          capabilities: ['discovery', 'service-logs', 'findings'],
          outdated: false,
          checkedAt: '2026-11-23T10:05:00.000Z',
        },
      }),
      { account: { connection: 'connected', ingestFrom: '2026-11-20' } },
    );
    const section = await screen.findByRole('region', { name: 'Usuário de leitura na AWS' });
    const notice = within(section).getByRole('status');
    expect(notice).toHaveTextContent('O usuário de leitura na AWS não está como você escolheu aqui');
    expect(notice).toHaveTextContent(
      'Concede mais do que a sua escolha: “Achados de segurança” está ligada nas políticas do usuário de leitura, e você não a marcou aqui.',
    );
    expect(notice).toHaveTextContent('o Verax só lê o que as políticas permitem');
    expect(notice).not.toHaveTextContent('CloudFormation');
  });
});

describe('acompanhamento: só o estado da API decide o passo', () => {
  /** O passo atual do acompanhamento, pelo `aria-current`. */
  const currentStep = () =>
    within(screen.getByRole('list', { name: 'Passos da conexão' }))
      .getAllByRole('listitem')
      .find((item) => item.getAttribute('aria-current') === 'step');

  it.each(AWS_ONBOARDING_STATES.filter((name) => name !== 'not_started'))(
    'estado %s: o aviso e o passo atual levam o nome do estado',
    async (name) => {
      open(state(name));
      const status = await banner();
      const label = AWS_ONBOARDING_STATE_TEXTS[name].label;
      expect(status).toHaveTextContent(label);
      expect(currentStep()).toHaveTextContent(label);
      // Os passos anteriores estão concluídos; os seguintes, ainda não começaram.
      const steps = within(screen.getByRole('list', { name: 'Passos da conexão' })).getAllByRole('listitem');
      const position = steps.findIndex((item) => item.getAttribute('aria-current') === 'step');
      for (const step of steps.slice(0, position)) expect(step).toHaveTextContent('(concluído)');
      for (const step of steps.slice(position + 1)) expect(step).toHaveTextContent('(ainda não começou)');
    },
  );

  it('antes de conectar não há passos; os passos têm os nomes do caminho inteiro', async () => {
    open(state('not_started'));
    expect(await banner()).toHaveTextContent('Não conectada');
    expect(screen.queryByRole('list', { name: 'Passos da conexão' })).not.toBeInTheDocument();
  });

  it('o tempo esgotado marca o primeiro passo com problema, e os seguintes ainda não começaram', async () => {
    open(state('authorization_timeout'));
    await banner();
    expect(currentStep()).toHaveTextContent('Tempo esgotado (com problema)');
    expect(
      within(screen.getByRole('list', { name: 'Passos da conexão' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Tempo esgotado (com problema)',
      'Autenticação (ainda não começou)',
      'Descoberta das fontes (ainda não começou)',
      'Autorização de fontes (ainda não começou)',
      'Configuração dos coletores (ainda não começou)',
      'Coleta de eventos (ainda não começou)',
    ]);
  });

  it(
    'enquanto espera o papel, a tela relê o estado sozinha e avança quando a API avança',
    async () => {
      const { account, fake } = open(
        state('awaiting_authorization', {
          connect: {
            requestedAt: new Date().toISOString(),
            waitingUntil: new Date(Date.now() + 59 * 60_000).toISOString(),
            capabilities: null,
          },
        }),
      );
      expect(await banner()).toHaveTextContent('Aguardando autorização na AWS');
      expect(fake.reads()).toBe(1);
      fake.set(onboardingFixture(account.id, 'awaiting_sources'));
      // Sem clique nenhum: a releitura de 5 s traz o estado novo.
      expect(
        await screen.findByText('Aguardando autorização de fontes', { selector: 'p' }, { timeout: 12_000 }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Crie a pilha na AWS' })).not.toBeInTheDocument();
      expect(fake.reads()).toBeGreaterThanOrEqual(2);
      // Esperando a escolha das fontes, a releitura para.
      const reads = fake.reads();
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(fake.reads()).toBe(reads);
    },
    POLL_TIMEOUT,
  );

  it('coletando com uma conferência pendente ou falhando não é "tudo certo": o aviso diz o que falta', async () => {
    open(
      state('collecting', {
        checks: checksFixture({
          assume_role: { status: 'ok', checkedAt: '2026-11-23T11:50:00.000Z' },
          identity: { status: 'ok' },
          template: { status: 'failed', code: 'template_outdated' },
          discovery: { status: 'ok' },
          permission: { status: 'ok' },
          collector_config: { status: 'ok' },
          events: { status: 'ok' },
          last_sync: { status: 'ok' },
          lag: { status: 'pending', code: 'no_data' },
        }),
      }),
    );
    const status = await banner();
    expect(status).toHaveTextContent('Coletando eventos, com pendências');
    expect(status).toHaveTextContent('Pendências: Modelo da pilha e autorizações; Atraso da coleta.');
    expect(screen.getByText(/^Última verificação da conexão: /)).toBeInTheDocument();
  });

  it('coletando com tudo conferido: aí sim, coletando eventos', async () => {
    open(
      state('collecting', {
        checks: checksFixture(
          Object.fromEntries(
            [
              'assume_role',
              'identity',
              'template',
              'discovery',
              'permission',
              'collector_config',
              'events',
              'last_sync',
              'lag',
            ].map((id) => [id, { status: 'ok' }]),
          ),
        ),
      }),
    );
    const status = await banner();
    expect(status).toHaveTextContent('Coletando eventos');
    expect(status).not.toHaveTextContent('pendências');
    expect(status).not.toHaveTextContent('Pendências');
    expect(screen.getByText('Conexão ainda não verificada.')).toBeInTheDocument();
  });
});

describe('conferências e o "tentar de novo" de cada uma', () => {
  const checks = () => within(screen.getByRole('list', { name: 'Conferências da conexão' }));
  const checkItem = (label: string) => {
    const item = checks()
      .getAllByRole('listitem')
      .find((candidate) => candidate.textContent?.startsWith(label));
    if (!item) throw new Error(`conferência não encontrada: ${label}`);
    return item;
  };

  it('as nove conferências aparecem, cada uma com a situação e o texto do código', async () => {
    open(
      state('partial', {
        checks: checksFixture({
          assume_role: { status: 'ok', code: 'excess_permissions', checkedAt: '2026-11-23T11:50:00.000Z' },
          identity: { status: 'ok' },
          template: { status: 'failed', code: 'template_outdated' },
          discovery: { status: 'ok', code: 'partial' },
          permission: { status: 'failed', code: 'tag_missing' },
          collector_config: { status: 'failed', code: 'wazuh_apply_failed' },
          events: { status: 'failed', code: 'stalled' },
          last_sync: { status: 'pending', code: 'no_data' },
          lag: { status: 'failed', code: 'stalled' },
        }),
      }),
    );
    await banner();
    expect(checks().getAllByRole('listitem')).toHaveLength(9);
    expect(checkItem('Entrada no papel de leitura')).toHaveTextContent(
      /Certo.*Aviso: O papel verax-control-reader tem permissão além da leitura.*Conferido/,
    );
    expect(checkItem('Conta e papel conferidos')).toHaveTextContent('Certo');
    expect(checkItem('Modelo da pilha e autorizações')).toHaveTextContent(
      /Com problema.*A pilha desta conta é de um modelo anterior/,
    );
    expect(checkItem('Descoberta das fontes')).toHaveTextContent(/terminou sem conseguir ler tudo/);
    expect(checkItem('Permissão das fontes autorizadas')).toHaveTextContent(
      'Uma fonte autorizada não pode ser lida: o grupo não tem a etiqueta verax-control = leitura.',
    );
    expect(checkItem('Configuração dos coletores')).toHaveTextContent(
      /O nó não conseguiu aplicar a configuração nova da coleta.*fale com a Verax/,
    );
    expect(checkItem('Chegada de eventos')).toHaveTextContent(/parou de entregar/);
    expect(checkItem('Última leitura das fontes')).toHaveTextContent(
      /Pendente.*Ainda não há leitura registrada/,
    );
    expect(checkItem('Atraso da coleta')).toHaveTextContent(/mais de 2 horas de atraso/);
  });

  it('as conferências das fontes citam as fontes que as seguram, com um link para a linha de cada uma em "Fontes autorizadas"', async () => {
    const denied = authorizedSourceFixture('guardduty', 'permission_error', {
      name: 'GuardDuty',
      permission: 'missing',
      permissionDetail: 'guardduty:ListFindings',
    });
    const stalled = authorizedSourceFixture('cloudtrail', 'stalled', {
      name: 'management-events',
      stateCode: 'no_progress',
    });
    const healthy = authorizedSourceFixture('security_hub', 'collecting', { name: 'Security Hub' });
    open(
      state('permission_error', {
        sources: [denied, stalled, healthy],
        checks: checksFixture({
          assume_role: { status: 'ok' },
          identity: { status: 'ok' },
          template: { status: 'ok' },
          discovery: { status: 'ok' },
          permission: { status: 'failed', code: 'guardduty:ListFindings', sourceIds: [denied.id] },
          collector_config: { status: 'ok' },
          // Um ID que a tela não conhece (a fonte saiu entre duas leituras) fica de fora, sem quebrar a lista.
          events: { status: 'failed', code: 'no_progress', sourceIds: [stalled.id, crypto.randomUUID()] },
          last_sync: { status: 'ok' },
          lag: { status: 'failed', code: 'stalled', sourceIds: [stalled.id] },
        }),
      }),
    );
    await banner();
    const permission = checkItem('Permissão das fontes autorizadas');
    expect(permission).toHaveTextContent('Fonte: GuardDuty (API) GuardDuty.');
    expect(within(permission).getByRole('link', { name: 'GuardDuty (API) GuardDuty' })).toHaveAttribute(
      'href',
      `#aws-autorizada-${denied.id}`,
    );
    for (const label of ['Chegada de eventos', 'Atraso da coleta']) {
      expect(
        within(checkItem(label)).getByRole('link', { name: 'CloudTrail (trilha) management-events' }),
      ).toHaveAttribute('href', `#aws-autorizada-${stalled.id}`);
    }
    // As que passaram, e as que não são de fontes, não citam nenhuma.
    for (const label of [
      'Configuração dos coletores',
      'Última leitura das fontes',
      'Descoberta das fontes',
    ]) {
      expect(within(checkItem(label)).queryByRole('link')).not.toBeInTheDocument();
    }
    // O alvo de cada link existe, e é a linha daquela fonte na tabela das autorizadas.
    const monitor = screen.getByRole('region', { name: 'Fontes autorizadas' });
    for (const [source, name] of [
      [denied, /GuardDuty \(API\)/],
      [stalled, /management-events/],
      [healthy, /Security Hub/],
    ] as const) {
      const row = within(monitor).getByRole('rowheader', { name }).closest('tr');
      expect(row).toHaveAttribute('id', `aws-autorizada-${source.id}`);
      expect(document.querySelectorAll(`#aws-autorizada-${source.id}`)).toHaveLength(1);
    }
  });

  it('muitas fontes na mesma conferência: as cinco primeiras pelo nome, e as outras pelo número', async () => {
    const sources = Array.from({ length: 7 }, (_, index) =>
      authorizedSourceFixture('cloudwatch_log_group', 'authorized', { name: `/app/grupo-${index + 1}` }),
    );
    open(
      state('configuring', {
        sources,
        checks: checksFixture({
          assume_role: { status: 'ok' },
          identity: { status: 'ok' },
          template: { status: 'ok' },
          discovery: { status: 'ok' },
          permission: { status: 'ok' },
          collector_config: {
            status: 'pending',
            code: 'awaiting_collector',
            sourceIds: sources.map((source) => source.id),
          },
        }),
      }),
    );
    await banner();
    const item = checkItem('Configuração dos coletores');
    expect(item).toHaveTextContent('7 fontes: ');
    expect(within(item).getAllByRole('link')).toHaveLength(6);
    expect(item).toHaveTextContent('e 2 outras, em Fontes autorizadas.');
    expect(within(item).getByRole('link', { name: 'Fontes autorizadas' })).toHaveAttribute(
      'href',
      '#aws-autorizadas',
    );
  });

  it('onde o servidor não descobre as fontes sozinho: nada de "Rodar a descoberta", "Descobrir de novo" nem "Tentar de novo" para recusar depois', async () => {
    const denied = authorizedSourceFixture('guardduty', 'permission_error', {
      name: 'GuardDuty',
      permission: 'missing',
      permissionDetail: 'guardduty:ListFindings',
    });
    const { fake } = open(
      state('authenticated', {
        discoveryAvailable: false,
        sources: [denied],
        checks: checksFixture({
          assume_role: { status: 'ok' },
          identity: { status: 'ok' },
          template: { status: 'ok' },
          discovery: { status: 'pending', code: 'not_requested' },
          permission: { status: 'failed', code: 'guardduty:ListFindings', sourceIds: [denied.id] },
        }),
      }),
      { account: { connection: 'connected', ingestFrom: '2026-11-20' } },
    );
    await banner();
    const found = screen.getByRole('region', { name: 'O que encontramos' });
    expect(found).toHaveTextContent('Neste ambiente, o Verax ainda não descobre as fontes de log sozinho');
    expect(
      screen.queryByRole('button', {
        name: /Descobrir|Rodar a descoberta|Tentar de novo|Verificar de novo:/,
      }),
    ).not.toBeInTheDocument();
    // O resto da tela continua: a conferência diz o que falta, e a fonte segue na tabela, com o "Revogar".
    expect(checkItem('Descoberta das fontes')).toHaveTextContent('Pendente');
    expect(
      within(screen.getByRole('region', { name: 'Fontes autorizadas' })).getByRole('button', {
        name: /^Revogar: GuardDuty/,
      }),
    ).toBeInTheDocument();
    expect(fake.calls).toEqual([]);
  });

  it('tempo esgotado: "Conectar de novo" avisa a API; o painel de conectar volta, com o arquivo', async () => {
    const user = userEvent.setup();
    const { fake } = open(
      state('authorization_timeout', {
        checks: checksFixture({ assume_role: { status: 'failed', code: 'authorization_timeout' } }),
      }),
    );
    await banner();
    const item = checkItem('Entrada no papel de leitura');
    expect(item).toHaveTextContent('O papel de leitura não apareceu nesta conta em 60 minutos.');
    await user.click(within(item).getByRole('button', { name: 'Conectar de novo' }));
    // Sem corpo: este botão não escolhe nada, e a escolha gravada fica como está.
    await waitFor(() => expect(fake.calls).toEqual([{ route: 'connect', sourceId: null, body: undefined }]));
    expect(screen.getByRole('region', { name: 'Conectar de novo a conta 111111111111' })).toBeInTheDocument();
  });

  it('desconectada: o erro diz o que conferir, e "Verificar de novo" pede a verificação', async () => {
    const user = userEvent.setup();
    const { fake } = open(
      state('disconnected', {
        checks: checksFixture({ assume_role: { status: 'failed', code: 'trust_denied' } }),
      }),
    );
    await banner();
    const item = checkItem('Entrada no papel de leitura');
    expect(item).toHaveTextContent(
      /^Entrada no papel de leitura · Com problemaA AWS recusou a entrada no papel\./,
    );
    await user.click(within(item).getByRole('button', { name: 'Verificar de novo' }));
    await waitFor(() => expect(fake.calls.map((call) => call.route)).toEqual(['verify']));
    // Quem apagou a pilha tem o caminho para criar de novo, fechado por padrão.
    expect(screen.getByText('A pilha foi apagada da conta? Criar de novo')).toBeInTheDocument();
  });

  it('descoberta parcial: "Rodar a descoberta de novo" pede outra; a recusa de 5 minutos é explicada', async () => {
    const user = userEvent.setup();
    const { fake } = open(
      state('awaiting_sources', {
        checks: checksFixture({
          assume_role: { status: 'ok' },
          identity: { status: 'ok' },
          template: { status: 'ok' },
          discovery: { status: 'ok', code: 'partial' },
        }),
      }),
    );
    fake.on('discovery', () => refusal(429, 'DISCOVERY_RATE_LIMITED'));
    await banner();
    await user.click(
      within(checkItem('Descoberta das fontes')).getByRole('button', { name: 'Rodar a descoberta de novo' }),
    );
    expect(
      await within(screen.getByRole('region', { name: 'Conferências da conexão' })).findByRole('alert'),
    ).toHaveTextContent(
      'A descoberta acabou de rodar. Só é possível pedir outra a cada 5 minutos: tente de novo daqui a pouco.',
    );
    expect(fake.calls.map((call) => call.route)).toEqual(['discovery']);
  });

  it('verificação comum pendente: o aviso fala dos 10 minutos, e o botão fica desligado', async () => {
    open(
      state('awaiting_authorization', {
        checks: checksFixture({ assume_role: { status: 'pending', code: 'verifying' } }),
      }),
    );
    const status = await banner();
    expect(status).toHaveTextContent('ele tenta de novo por até 10 minutos');
    expect(screen.getByRole('button', { name: 'Verificando…' })).toBeDisabled();
    // Não é a espera pela pilha: os passos de criar a pilha não aparecem.
    expect(screen.queryByRole('region', { name: 'Crie a pilha na AWS' })).not.toBeInTheDocument();
    expect(checkItem('Entrada no papel de leitura')).toHaveTextContent('Verificação pedida');
  });

  it('quem só lê vê as conferências, sem botão nenhum', async () => {
    open(
      state('disconnected', {
        checks: checksFixture({ assume_role: { status: 'failed', code: 'trust_denied' } }),
      }),
      { canWrite: false },
    );
    await banner();
    const section = screen.getByRole('region', { name: 'Situação da conexão' });
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
    expect(within(section).getByText('Quem administra as contas pede a verificação.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Conferências da conexão' })).queryByRole('button'),
    ).not.toBeInTheDocument();
    expect(checkItem('Entrada no papel de leitura')).toHaveTextContent('A AWS recusou a entrada no papel.');
  });

  it('antes de conectar, as conferências ficam recolhidas, depois do "Conectar com AWS"', async () => {
    open(state('not_started'));
    await banner();
    const sections = screen.getAllByRole('region').map((region) => region.getAttribute('id'));
    expect(sections.indexOf('aws-conectar')).toBeLessThan(sections.indexOf('aws-conferencias'));
    const section = screen.getByRole('region', { name: 'Conferências da conexão' });
    expect(
      within(section)
        .getByText('O que o Verax confere depois de conectar (9 conferências)')
        .closest('details'),
    ).not.toHaveAttribute('open');
    expect(checks().getAllByRole('listitem')).toHaveLength(9);
  });
});

describe('pilha na AWS: a versão do modelo e as autorizações', () => {
  it('modelo anterior: "Atualize a pilha", com o arquivo do modelo atual (as três ligadas), os passos e a CLI', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    const { fake } = open(
      state('awaiting_sources', {
        template: {
          version: 1,
          capabilities: ['discovery'],
          outdated: true,
          checkedAt: '2026-11-23T11:00:00.000Z',
        },
      }),
    );
    const stack = await screen.findByRole('region', { name: 'Pilha na AWS' });
    expect(stack).toHaveTextContent('versão 1 (anterior: a atual é a 3)');
    expect(stack).toHaveTextContent('Logs de serviços da AWS no S3: desligada');
    expect(stack).toHaveTextContent('Atualize a pilha');
    expect(stack).toHaveTextContent('A pilha desta conta foi criada com o modelo anterior.');
    // Os passos para atualizar a pilha que já existe.
    expect(stack).toHaveTextContent('Atualizar pilha (Update stack)');
    expect(stack).toHaveTextContent('Substituir o modelo existente (Replace existing template)');
    expect(stack).toHaveTextContent('Carregar um arquivo de modelo (Upload a template file)');
    expect(within(stack).getByRole('link', { name: /CloudFormation/ })).toHaveAttribute(
      'href',
      'https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks',
    );
    const download = within(stack).getByRole('button', { name: 'Baixar o arquivo da pilha' });
    await waitFor(() => expect(download).toBeEnabled());
    await user.click(download);
    const text = (await browser.downloads[0]?.blob.text()) ?? '';
    const falses = (value: string) => value.split("    Default: 'false'").length - 1;
    expect(falses(text)).toBe(falses(READER_TEMPLATE_TEXT));
    expect(browser.opened).not.toHaveBeenCalled();
    // A CLI lê o arquivo que o botão acabou de baixar, pelo nome, e continua levando os valores e as autorizações:
    // numa atualização, a AWS manteria os valores anteriores da pilha.
    const command = within(stack).getByText(/^aws cloudformation deploy/);
    expect(browser.downloads[0]?.name).toBe('verax-control-reader-111111111111.yaml');
    expect(templateFileOf(command)).toBe(browser.downloads[0]?.name);
    expect(stack).toHaveTextContent(
      'na pasta do arquivo baixado aqui (verax-control-reader-111111111111.yaml)',
    );
    expect(stack).not.toHaveTextContent('alternativa manual');
    expect(command).toHaveTextContent('NodeServiceAccountId=123456789012345678901');
    expect(command).toHaveTextContent('NodeEgressIps=203.0.113.10/32');
    expect(command).toHaveTextContent('ReadAwsServiceLogs=true');
    expect(command).toHaveTextContent('ReadSecurityFindings=true');
    expect(command).toHaveTextContent('ReadTaggedLogGroups=true');
    expect(command).toHaveTextContent('LogBucketArns=""');
    // O "Verificar de novo" depois de atualizar leva as autorizações marcadas no bloco: a escolha gravada passa a ser
    // essa.
    await user.click(within(stack).getByRole('button', { name: 'Verificar de novo' }));
    await waitFor(() =>
      expect(fake.calls).toEqual([
        {
          route: 'verify',
          sourceId: null,
          body: { capabilities: ['service-logs', 'findings', 'log-groups'] },
        },
      ]),
    );
  });

  it('a pilha concede mais do que a escolha do cliente: o aviso diz o que está a mais, e o bloco abre com a escolha dele', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    // O cliente conectou só com os logs do S3, mas a pilha criada tem as três (o arquivo antigo, os parâmetros
    // digitados à mão): as etiquetas lidas depois do "Conectar" dizem isso.
    const { fake } = open(
      state('awaiting_sources', {
        connect: {
          requestedAt: '2026-11-23T10:00:00.000Z',
          waitingUntil: null,
          capabilities: ['service-logs'],
        },
        template: {
          version: 2,
          capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
          outdated: false,
          checkedAt: '2026-11-23T10:05:00.000Z',
        },
      }),
    );
    const stack = await screen.findByRole('region', { name: 'Pilha na AWS' });
    const notice = within(stack).getByRole('status');
    expect(notice).toHaveTextContent('A pilha na AWS não está como você escolheu aqui');
    expect(notice).toHaveTextContent(
      'Concede mais do que a sua escolha: “Achados de segurança” e “Grupos do CloudWatch Logs marcados” estão ligadas na pilha, e você não as marcou aqui.',
    );
    expect(notice).toHaveTextContent('Vale o que está na AWS: o Verax só lê o que a pilha permite.');
    expect(notice).toHaveTextContent('o console mantém o valor anterior');
    // O que a pilha tem continua à vista, e o bloco de atualização abre já com a escolha do cliente.
    expect(stack).toHaveTextContent('Achados de segurança: ligada');
    expect(
      within(stack).getByText('Atualizar a pilha ou mudar o que está autorizado').closest('details'),
    ).toHaveAttribute('open');
    const choices = within(stack).getByRole('group', { name: 'Como a pilha deve ficar' });
    expect(within(choices).getByRole('checkbox', { name: 'Logs de serviços da AWS no S3' })).toBeChecked();
    expect(within(choices).getByRole('checkbox', { name: 'Achados de segurança' })).not.toBeChecked();
    expect(
      within(choices).getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' }),
    ).not.toBeChecked();
    const download = within(stack).getByRole('button', { name: 'Baixar o arquivo da pilha' });
    await waitFor(() => expect(download).toBeEnabled());
    await user.click(download);
    const falses = (value: string) => value.split("    Default: 'false'").length - 1;
    expect(falses((await browser.downloads[0]?.blob.text()) ?? '')).toBe(falses(READER_TEMPLATE_TEXT) + 2);
    // Se a pilha está como o cliente quer, ele marca as caixas como ela está e confirma: a escolha gravada muda.
    await user.click(within(choices).getByRole('checkbox', { name: 'Achados de segurança' }));
    await user.click(within(choices).getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' }));
    await user.click(within(stack).getByRole('button', { name: 'Verificar de novo' }));
    await waitFor(() =>
      expect(fake.calls).toEqual([
        {
          route: 'verify',
          sourceId: null,
          body: { capabilities: ['service-logs', 'findings', 'log-groups'] },
        },
      ]),
    );
  });

  it('a pilha com menos do que a escolha: o aviso diz o que está desligado; uma autorização só, no singular', async () => {
    open(
      state('awaiting_sources', {
        connect: {
          requestedAt: '2026-11-23T10:00:00.000Z',
          waitingUntil: null,
          capabilities: ['service-logs', 'findings'],
        },
        template: {
          version: 2,
          capabilities: ['discovery', 'service-logs'],
          outdated: false,
          checkedAt: '2026-11-23T10:05:00.000Z',
        },
      }),
    );
    const stack = await screen.findByRole('region', { name: 'Pilha na AWS' });
    const notice = within(stack).getByRole('status');
    expect(notice).toHaveTextContent(
      'Você marcou “Achados de segurança” aqui, e na pilha ela está desligada: as fontes desse tipo ficam em “Precisam de permissão adicional”.',
    );
    expect(notice).not.toHaveTextContent('Concede mais');
    // O bloco "Atualize a pilha" (a autorização desligada) parte da escolha do cliente, com os achados ligados.
    const choices = within(stack).getByRole('group', { name: 'Como a pilha deve ficar' });
    expect(within(choices).getByRole('checkbox', { name: 'Achados de segurança' })).toBeChecked();
    expect(
      within(choices).getByRole('checkbox', { name: 'Grupos do CloudWatch Logs marcados' }),
    ).not.toBeChecked();
  });

  it('sem diferença, sem escolha gravada, com as etiquetas de antes do "Conectar" ou do modelo anterior: nenhum aviso de escolha', async () => {
    const all = ['discovery', 'service-logs', 'findings', 'log-groups'] as const;
    const cases: Partial<AwsOnboarding>[] = [
      // A pilha está como o cliente escolheu.
      {
        connect: { requestedAt: '2026-11-23T10:00:00.000Z', waitingUntil: null, capabilities: ['findings'] },
        template: {
          version: 2,
          capabilities: ['discovery', 'findings'],
          outdated: false,
          checkedAt: '2026-11-23T10:05:00.000Z',
        },
      },
      // Nenhuma escolha gravada (a conta de antes, ou conectada sem o painel).
      {
        connect: { requestedAt: '2026-11-23T10:00:00.000Z', waitingUntil: null, capabilities: null },
        template: {
          version: 2,
          capabilities: [...all],
          outdated: false,
          checkedAt: '2026-11-23T10:05:00.000Z',
        },
      },
      // As etiquetas foram lidas antes deste "Conectar": são da pilha anterior, e não respondem a esta escolha.
      {
        connect: { requestedAt: '2026-11-23T10:00:00.000Z', waitingUntil: null, capabilities: ['findings'] },
        template: {
          version: 2,
          capabilities: [...all],
          outdated: false,
          checkedAt: '2026-11-22T09:00:00.000Z',
        },
      },
      // O modelo anterior não tinha autorizações: vale o aviso dele ("Atualize a pilha"), e não o da escolha.
      {
        connect: { requestedAt: '2026-11-23T10:00:00.000Z', waitingUntil: null, capabilities: ['findings'] },
        template: {
          version: 1,
          capabilities: ['discovery'],
          outdated: true,
          checkedAt: '2026-11-23T10:05:00.000Z',
        },
      },
    ];
    for (const overrides of cases) {
      const { unmount } = renderOnly(state('awaiting_sources', overrides));
      const stack = await screen.findByRole('region', { name: 'Pilha na AWS' });
      expect(within(stack).queryByRole('status')).not.toBeInTheDocument();
      expect(stack).not.toHaveTextContent('não está como você escolheu aqui');
      unmount();
    }
  });

  it('autorização desligada: o bloco parte do que a pilha tem; ligar outra muda o arquivo, os parâmetros e a CLI', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    open(
      state('awaiting_sources', {
        template: {
          version: 2,
          capabilities: ['discovery', 'service-logs'],
          outdated: false,
          checkedAt: '2026-11-23T11:00:00.000Z',
        },
      }),
      { account: { buckets: { cloudtrail: 'exemplo-trilha', guardduty: null, waf: null } } },
    );
    const stack = await screen.findByRole('region', { name: 'Pilha na AWS' });
    expect(stack).toHaveTextContent('versão 2 (atual)');
    expect(stack).toHaveTextContent('Achados de segurança: desligada');
    expect(stack).toHaveTextContent('Há autorização desligada na pilha.');
    const choices = within(stack).getByRole('group', { name: 'Como a pilha deve ficar' });
    expect(within(choices).getByRole('checkbox', { name: 'Logs de serviços da AWS no S3' })).toBeChecked();
    expect(within(choices).getByRole('checkbox', { name: 'Achados de segurança' })).not.toBeChecked();
    // O console mantém os valores da pilha na atualização: a tela diz como cada parâmetro deve ficar.
    expect(stack).toHaveTextContent('Achados de segurança (ReadSecurityFindings): false');
    expect(stack).toHaveTextContent('(LogBucketArns): arn:aws:s3:::exemplo-trilha');
    await user.click(within(choices).getByRole('checkbox', { name: 'Achados de segurança' }));
    expect(stack).toHaveTextContent('Achados de segurança (ReadSecurityFindings): true');
    expect(stack).toHaveTextContent('Grupos do CloudWatch Logs marcados (ReadTaggedLogGroups): false');
    expect(within(stack).getByText(/^aws cloudformation deploy/)).toHaveTextContent(
      'ReadSecurityFindings=true',
    );
    const download = within(stack).getByRole('button', { name: 'Baixar o arquivo da pilha' });
    await waitFor(() => expect(download).toBeEnabled());
    await user.click(download);
    const text = (await browser.downloads[0]?.blob.text()) ?? '';
    const falses = (value: string) => value.split("    Default: 'false'").length - 1;
    // Só os grupos de logs continuam desligados.
    expect(falses(text)).toBe(falses(READER_TEMPLATE_TEXT) + 1);
    expect(text).toContain("    Default: 'arn:aws:s3:::exemplo-trilha'");
    // O comando lê esse mesmo arquivo, com a escolha nova e o bucket da conta.
    const command = within(stack).getByText(/^aws cloudformation deploy/);
    expect(templateFileOf(command)).toBe(browser.downloads[0]?.name);
    expect(command).toHaveTextContent('ReadTaggedLogGroups=false');
    expect(command).toHaveTextContent('LogBucketArns=arn:aws:s3:::exemplo-trilha');
  });

  it('sem arquivo para baixar (falta um valor do ambiente), não há comando apontando para um arquivo que não existe', async () => {
    open(
      state('awaiting_sources', {
        template: {
          version: 1,
          capabilities: ['discovery'],
          outdated: true,
          checkedAt: '2026-11-23T11:00:00.000Z',
        },
      }),
      { account: { nodeServiceAccountId: null } },
    );
    const stack = await screen.findByRole('region', { name: 'Pilha na AWS' });
    expect(await within(stack).findByText('O arquivo da pilha não pode ser preparado agora.')).toBeVisible();
    expect(within(stack).getByRole('button', { name: 'Baixar o arquivo da pilha' })).toBeDisabled();
    expect(within(stack).queryByText(/^aws cloudformation deploy/)).not.toBeInTheDocument();
    expect(stack).not.toHaveTextContent('Prefere a CLI?');
  });

  it('etiqueta da versão ilegível: pede a pilha atualizada, com o arquivo desta tela', async () => {
    open(
      state('awaiting_sources', {
        template: {
          version: null,
          capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
          outdated: false,
          checkedAt: '2026-11-23T11:00:00.000Z',
        },
      }),
    );
    const stack = await screen.findByRole('region', { name: 'Pilha na AWS' });
    expect(stack).toHaveTextContent('versão não identificada');
    expect(stack).toHaveTextContent('O Verax não conseguiu identificar a versão do modelo desta pilha.');
    expect(within(stack).getByRole('button', { name: 'Baixar o arquivo da pilha' })).toBeInTheDocument();
  });

  it('modelo em dia com as três ligadas: sem aviso; o caminho para mudar fica fechado', async () => {
    open(state('awaiting_sources'));
    const stack = await screen.findByRole('region', { name: 'Pilha na AWS' });
    expect(stack).toHaveTextContent('versão 2 (atual)');
    expect(stack).toHaveTextContent('Grupos do CloudWatch Logs marcados: ligada');
    expect(
      within(stack).getByText('Atualizar a pilha ou mudar o que está autorizado').closest('details'),
    ).not.toHaveAttribute('open');
    expect(stack).not.toHaveTextContent('Há autorização desligada');
  });

  it('quem só lê vê o aviso, sem o arquivo nem os passos', async () => {
    open(
      state('awaiting_sources', {
        template: {
          version: 1,
          capabilities: ['discovery'],
          outdated: true,
          checkedAt: '2026-11-23T11:00:00.000Z',
        },
      }),
      { canWrite: false },
    );
    const stack = await screen.findByRole('region', { name: 'Pilha na AWS' });
    expect(stack).toHaveTextContent('Quem administra as contas atualiza a pilha.');
    expect(within(stack).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('o que encontramos', () => {
  it('o retrato da infraestrutura, as regiões e os serviços identificados', async () => {
    // O relógio fica no instante das fixtures: o "há 30 minutos" não depende de quanto a suíte já demorou.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(FIXTURE_NOW) });
    open(state('awaiting_sources'));
    const found = await screen.findByRole('region', { name: 'O que encontramos' });
    expect(found).toHaveTextContent(
      /Última descoberta: completa, há 30 minutos\. 2 regiões lidas na conta\./,
    );
    const row = (label: string) => within(found).getByText(label).nextElementSibling;
    expect(row('Regiões com recursos')).toHaveTextContent('sa-east-1, us-east-1');
    expect(row('Instâncias (EC2)')).toHaveTextContent('14 (3 com IP público)');
    expect(row('Grupos de segurança')).toHaveTextContent('31 (2 abertos para a internet)');
    expect(row('Buckets (S3)')).toHaveTextContent('18 (1 público)');
    expect(row('Bancos do RDS')).toHaveTextContent('3 (0 públicos, 1 sem cifragem)');
    expect(row('Balanceadores de carga')).toHaveTextContent('2 (1 voltado para a internet)');
    expect(row('MFA do usuário root')).toHaveTextContent('ligado');
  });

  it('descoberta parcial: o que ficou de fora, com o serviço, a região e o motivo; a leitura recusada não vira zero', async () => {
    open((account) =>
      onboardingFixture(account.id, 'awaiting_sources', {
        discovery: {
          run: runFixture({
            status: 'partial',
            errors: [
              { service: 'inspector', region: 'us-east-1', code: 'AccessDeniedException' },
              { service: 'cloudwatch_logs', region: 'sa-east-1', code: 'TimeoutError' },
              { service: 's3', region: 'global', code: 'ErroNovoDaAws' },
            ],
          }),
          lastCompletedAt: '2026-11-23T11:30:00.000Z',
          regions: ['sa-east-1'],
        },
        infrastructure: {
          instances: 2,
          publicInstances: 0,
          securityGroups: 4,
          openSecurityGroups: 0,
          buckets: null,
          publicBuckets: null,
          iamUsers: 1,
          rootMfaEnabled: false,
          rdsInstances: 0,
          rdsPublic: 0,
          rdsUnencrypted: 0,
          rdsClusters: 0,
          loadBalancers: 0,
          internetFacingLoadBalancers: 0,
          vpcs: 1,
          webAcls: 0,
          logGroups: 3,
          trails: 1,
        },
      }),
    );
    const found = await screen.findByRole('region', { name: 'O que encontramos' });
    expect(found).toHaveTextContent('Última descoberta: parcial');
    expect(found).toHaveTextContent('Descoberta parcial: 3 leituras ficaram de fora.');
    // A tabela rola dentro de um quadro com nome, que recebe o foco do teclado (ela não tem botão nem link).
    const frame = within(found).getByRole('region', { name: 'Tabela: O que a descoberta não conseguiu ler' });
    expect(frame).toHaveAttribute('tabindex', '0');
    expect(within(frame).queryByRole('button')).not.toBeInTheDocument();
    const rows = within(within(frame).getByRole('table', { name: 'O que a descoberta não conseguiu ler' }))
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      ['Inspector', 'us-east-1', expect.stringMatching(/^sem permissão para ler/)],
      ['CloudWatch Logs', 'sa-east-1', 'a AWS não respondeu a tempo'],
      ['Buckets (S3)', 'conta inteira', 'a AWS respondeu ErroNovoDaAws'],
    ]);
    expect(within(found).getByText('Buckets (S3)', { selector: 'dt' }).nextElementSibling).toHaveTextContent(
      'não lido',
    );
    expect(within(found).getByText('MFA do usuário root').nextElementSibling).toHaveTextContent('desligado');
  });

  it.each(['DISCOVERY_RATE_LIMITED', 'ACCOUNT_NOT_CONNECTED', 'DISCOVERY_UNAVAILABLE'] as const)(
    '"Descobrir de novo" recusado com %s: o texto do código, no lugar do genérico',
    async (code) => {
      const user = userEvent.setup();
      const { fake } = open(state('awaiting_sources'));
      fake.on('discovery', () => refusal(code === 'DISCOVERY_RATE_LIMITED' ? 429 : 409, code));
      const found = await screen.findByRole('region', { name: 'O que encontramos' });
      await user.click(within(found).getByRole('button', { name: 'Descobrir de novo' }));
      expect(await within(found).findByRole('alert')).toHaveTextContent(AWS_ONBOARDING_ERROR_TEXTS[code]);
      expect(fake.calls.map((call) => call.route)).toEqual(['discovery']);
    },
  );

  it('"Descobrir de novo" aceito: a tela mostra a descoberta na fila que a API respondeu, e o botão desliga', async () => {
    const user = userEvent.setup();
    const { account, fake } = open(state('awaiting_sources'));
    fake.on('discovery', () =>
      onboardingFixture(account.id, 'awaiting_sources', {
        discovery: {
          run: runFixture({ trigger: 'manual', status: 'pending', startedAt: null, finishedAt: null }),
          lastCompletedAt: new Date().toISOString(),
          regions: ['sa-east-1'],
        },
      }),
    );
    const found = await screen.findByRole('region', { name: 'O que encontramos' });
    await user.click(within(found).getByRole('button', { name: 'Descobrir de novo' }));
    expect(await within(found).findByText(/^Descoberta na fila: /)).toBeInTheDocument();
    expect(within(found).getByRole('button', { name: 'Descobrir de novo' })).toBeDisabled();
  });

  it(
    'descoberta em andamento e descoberta que falhou: o que está acontecendo e o que fazer',
    async () => {
      const { account, fake } = open(
        state('discovering', {
          discovery: {
            run: runFixture({ status: 'running', finishedAt: null }),
            lastCompletedAt: null,
            regions: [],
          },
        }),
      );
      const found = await screen.findByRole('region', { name: 'O que encontramos' });
      expect(found).toHaveTextContent('Descoberta em andamento: o Verax está lendo a configuração da conta');
      expect(within(found).getByRole('button', { name: 'Descobrir de novo' })).toBeDisabled();
      fake.set(
        onboardingFixture(account.id, 'authenticated', {
          discovery: {
            run: runFixture({
              status: 'failed',
              errors: [{ service: 'run', region: 'global', code: 'interrupted' }],
            }),
            lastCompletedAt: null,
            regions: [],
          },
          checks: checksFixture({
            assume_role: { status: 'ok' },
            discovery: { status: 'failed', code: 'interrupted' },
          }),
        }),
      );
      expect(
        await within(found).findByText('A última descoberta não conseguiu ler a conta.', undefined, {
          timeout: 12_000,
        }),
      ).toBeInTheDocument();
      expect(found).toHaveTextContent('Motivo: a descoberta foi interrompida no meio');
      expect(within(found).getByRole('button', { name: 'Descobrir de novo' })).toBeEnabled();
    },
    POLL_TIMEOUT,
  );
});
