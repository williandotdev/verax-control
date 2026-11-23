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
  awsAccountFixture,
  checksFixture,
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

/** O arquivo que o comando da CLI lê (`--template-file`). */
const templateFileOf = (command: HTMLElement): string | undefined =>
  / --template-file (\S+) /.exec(command.textContent)?.[1];

/** As linhas do arquivo que não estão no template do repositório. */
function changedLines(filled: string): string[] {
  const original = new Set(READER_TEMPLATE_TEXT.split('\n'));
  return filled.split('\n').filter((line) => !original.has(line));
}

describe('Conectar com AWS', () => {
  it('um clique baixa o arquivo preenchido, abre o CloudFormation e avisa a API; a tela só avança com a resposta', async () => {
    const user = userEvent.setup();
    const browser = watchBrowser();
    const { account, fake } = open(state('not_started'));
    fake.on('connect', () => {
      browser.events.push('connect');
      return onboardingFixture(account.id, 'awaiting_authorization', {
        connect: {
          requestedAt: new Date().toISOString(),
          waitingUntil: new Date(Date.now() + 45 * 60_000).toISOString(),
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
    expect(choices).toHaveTextContent('Nada é criado nem alterado na sua conta AWS');
    // O cliente desliga os achados: o arquivo sai com essa escolha.
    await user.click(within(choices).getByRole('checkbox', { name: 'Achados de segurança' }));

    const button = await within(panel).findByRole('button', { name: 'Conectar com AWS' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    // Na ordem: o arquivo, o console em outra aba (sem acesso a esta) e o aviso à API.
    await waitFor(() => expect(browser.events).toEqual(['download', 'open', 'connect']));
    expect(browser.opened).toHaveBeenCalledExactlyOnceWith(
      'https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks/create',
      '_blank',
      'noopener,noreferrer',
    );
    expect(fake.calls).toEqual([{ route: 'connect', sourceId: null, body: undefined }]);
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

  it('a recusa da API aparece, e a tela continua no mesmo passo (nada é adiantado)', async () => {
    const user = userEvent.setup();
    watchBrowser();
    const { fake } = open(state('not_started'));
    fake.on('connect', () => refusal(400, undefined, 'Reative o monitoramento antes de conectar a conta.'));
    const panel = await screen.findByRole('region', { name: 'Conectar a conta 111111111111' });
    const button = await within(panel).findByRole('button', { name: 'Conectar com AWS' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Reative o monitoramento antes de conectar a conta.',
    );
    expect(screen.queryByRole('region', { name: 'Crie a pilha na AWS' })).not.toBeInTheDocument();
    expect(await banner()).toHaveTextContent('Não conectada');
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
    // Criada a pilha pela CLI, o botão só avisa a API: não baixa nem abre nada.
    await user.click(within(panel).getByRole('button', { name: 'Já criei a pilha: conectar' }));
    await waitFor(() => expect(fake.calls.map((call) => call.route)).toEqual(['connect']));
    expect(browser.events).toEqual([]);
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
    await waitFor(() => expect(fake.calls.map((call) => call.route)).toEqual(['connect']));
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
    expect(stack).toHaveTextContent('versão 1 (anterior: a atual é a 2)');
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
    await user.click(within(stack).getByRole('button', { name: 'Verificar de novo' }));
    await waitFor(() => expect(fake.calls.map((call) => call.route)).toEqual(['verify']));
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
