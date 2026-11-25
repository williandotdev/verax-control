import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AWS_ONBOARDING_ERROR_CODES,
  type AwsOnboarding,
  type AwsSource,
  type CloudAccount,
  CONSOLE_MANAGED_CODE,
} from '@verax/shared';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers } from '@/mocks/handlers';
import {
  authorizedSourceFixture,
  awsAccountFixture,
  checksFixture,
  legacySourceFixture,
  onboardingFixture,
  sourceFixture,
} from '@/test/aws-onboarding-fixtures';
import { type OnboardingApi, onboardingApi, refusal, renderAwsSection } from '@/test/aws-onboarding-harness';
import {
  AWS_ONBOARDING_ERROR_TEXTS,
  AWS_SOURCE_COLLECTION_NOTES,
  AWS_SOURCE_NOTE_TEXTS,
  AWS_SOURCE_STATE_CODE_TEXTS,
  AWS_WAZUH_SOURCE_STATE_CODE_TEXTS,
} from './aws-onboarding-labels';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.useRealTimers();
});
afterAll(() => server.close());

/** A seção com as fontes dadas, numa conta que já terminou a descoberta. */
function open(
  sources: AwsSource[],
  options: {
    account?: Partial<CloudAccount>;
    canWrite?: boolean;
    onboarding?: Partial<AwsOnboarding>;
  } = {},
): { account: CloudAccount; fake: OnboardingApi; view: (next: AwsSource[]) => AwsOnboarding } {
  const account = awsAccountFixture({
    connection: 'connected',
    ingestFrom: '2026-11-01',
    ...options.account,
  });
  const view = (next: AwsSource[]) =>
    onboardingFixture(account.id, 'awaiting_sources', { sources: next, ...options.onboarding });
  const fake = onboardingApi(account, view(sources));
  server.use(...fake.handlers, ...createHandlers({ me: demoMe('admin_cliente') }));
  renderAwsSection(account, options.canWrite ?? true);
  return { account, fake, view };
}

const sourcesRegion = () => screen.findByRole('region', { name: 'Fontes de log' });
const group = (region: HTMLElement, title: RegExp) => within(region).getByRole('region', { name: title });
/** A fonte autorizada, como a API a devolveria depois do pedido. */
const authorized = (source: AwsSource): AwsSource => ({
  ...source,
  state: 'authorized',
  stateCode: 'awaiting_collector',
  authorization: {
    authorizedAt: new Date().toISOString(),
    authorizedBy: 'demo-admin_cliente',
    revokedAt: null,
  },
  collectFrom: new Date().toISOString().slice(0, 10),
});

describe('fontes de log: os grupos da tela', () => {
  it('o balanceador que o nó coleta aparece sem a caixa de autorizar, e o NLB diz por que não serve', async () => {
    const alb = (name: string, overrides: Partial<AwsSource> = {}) =>
      sourceFixture('elb_logs', { name, collectable: true, ...overrides });
    open([
      sourceFixture('cloudtrail', { name: 'trilha' }),
      alb('loja', { notes: ['high_volume'], details: { internetFacing: true } }),
      alb('semlog', { availability: 'no_destination', notes: ['aws_cost_alb_logs'] }),
      alb('rede', { availability: 'unsupported_format' }),
    ]);
    const region = await sourcesRegion();
    const available = group(region, /^Disponíveis para coletar \(2\)$/);
    expect(within(available).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(available).getByRole('checkbox', { name: /trilha/ })).not.toBeChecked();
    expect(available).toHaveTextContent('Balanceador (log de acesso) · loja');
    expect(available).toHaveTextContent(
      'A autorização deste tipo de fonte ainda não está disponível nesta tela.',
    );
    expect(group(region, /^Não habilitadas na AWS \(1\)$/)).toHaveTextContent(
      'Ligar o log de acesso do balanceador tem custo na AWS, pelo volume gravado no S3.',
    );
    const unsupported = group(region, /^Em destino ou formato que o Verax não lê \(1\)$/);
    expect(unsupported).toHaveTextContent('Não é um balanceador de aplicação (ALB)');
    expect(unsupported).not.toHaveTextContent('Parquet');
  });

  it('cada fonte aparece no grupo dela, com a contagem e a explicação', async () => {
    open([
      sourceFixture('cloudtrail', {
        name: 'management-events',
        loggingState: 'logging',
        details: { bucket: 'exemplo-trilha', prefix: 'AWSLogs/111111111111/CloudTrail/sa-east-1/' },
      }),
      sourceFixture('cloudtrail', { name: 'trilha-antiga', notes: ['covered_by_legacy'] }),
      sourceFixture('waf', { name: 'loja-acl', permission: 'missing', permissionDetail: 'kms_denied' }),
      sourceFixture('inspector', {
        name: 'inspector',
        region: 'global',
        availability: 'not_enabled',
        loggingState: 'disabled',
        notes: ['aws_cost_inspector'],
      }),
      sourceFixture('waf', {
        name: 'api-acl',
        availability: 'no_destination',
        notes: ['aws_cost_waf_logging'],
      }),
      sourceFixture('vpc_flow_logs', { name: 'fl-parquet', availability: 'unsupported_format' }),
      sourceFixture('waf', {
        name: 'cdn-acl',
        region: 'global',
        availability: 'unsupported_destination',
        details: { destination: 'arn:aws:firehose:us-east-1:111111111111:deliverystream/aws-waf-logs-cdn' },
      }),
      sourceFixture('config', { name: 'default', notes: ['not_collected_yet'] }),
      sourceFixture('elb_logs', { name: 'loja-alb', notes: ['not_collected_yet'] }),
    ]);
    const region = await sourcesRegion();
    const available = group(region, /^Disponíveis para coletar \(1\)$/);
    expect(
      within(available).getByRole('checkbox', { name: /CloudTrail \(trilha\) · management-events/ }),
    ).not.toBeChecked();
    expect(available).toHaveTextContent('sa-east-1, gravando');
    expect(available).toHaveTextContent(
      'Bucket exemplo-trilha, pasta AWSLogs/111111111111/CloudTrail/sa-east-1/',
    );

    const covered = group(region, /^Já lidas pelo cadastro manual \(1\)$/);
    expect(covered).toHaveTextContent('trilha-antiga');
    expect(within(covered).queryByRole('checkbox')).not.toBeInTheDocument();

    expect(group(region, /^Precisam de permissão adicional \(1\)$/)).toHaveTextContent('loja-acl');

    const notEnabled = group(region, /^Não habilitadas na AWS \(2\)$/);
    expect(notEnabled).toHaveTextContent(
      'Ligar um destes serviços tem custo na AWS, e a decisão é sua: o Verax nunca liga nada na sua conta.',
    );
    // A linha do serviço desligado mostra só o tipo; cada uma com o aviso de custo dela.
    expect(notEnabled).toHaveTextContent('Inspector · conta inteira, desligado');
    expect(notEnabled).toHaveTextContent('Ligar o Inspector tem custo na AWS.');
    expect(notEnabled).toHaveTextContent('Ligado, mas sem log configurado.');
    expect(notEnabled).toHaveTextContent('Ligar o log da Web ACL tem custo na AWS, pelo volume gravado.');

    const unsupported = group(region, /^Em destino ou formato que o Verax não lê \(2\)$/);
    expect(unsupported).toHaveTextContent('Grava num formato que o Verax não lê');
    expect(unsupported).toHaveTextContent(
      'Destino: arn:aws:firehose:us-east-1:111111111111:deliverystream/aws-waf-logs-cdn',
    );

    const notCollected = group(region, /^Ainda não coletadas \(2\)$/);
    expect(notCollected).toHaveTextContent('AWS Config · default');
    expect(notCollected).toHaveTextContent('Balanceador (log de acesso) · loja-alb');
    // Nenhuma dessas pode ser marcada.
    expect(within(region).getAllByRole('checkbox')).toHaveLength(1);
    // Nada vem marcado de antemão, e sem escolha não há o que autorizar.
    expect(within(region).getByRole('button', { name: 'Autorizar selecionadas' })).toBeDisabled();
  });

  it('GuardDuty: com a API e o export, a API é a recomendada e o export fica "coberto pela API"', async () => {
    open([
      sourceFixture('guardduty', { name: 'GuardDuty' }),
      sourceFixture('guardduty_export', { name: 'exemplo-export' }),
    ]);
    const available = group(await sourcesRegion(), /^Disponíveis para coletar \(2\)$/);
    const [api, exported] = within(available).getAllByRole('listitem');
    expect(api).toHaveTextContent('GuardDuty (API)');
    expect(api).toHaveTextContent('Recomendada');
    expect(api).not.toHaveTextContent('Coberto pela API');
    expect(exported).toHaveTextContent('GuardDuty (export para o S3)');
    expect(exported).toHaveTextContent('Coberto pela API');
    expect(exported).toHaveTextContent('os mesmos achados já chegam pela API do GuardDuty');
    expect(exported).not.toHaveTextContent('Recomendada');
  });

  it('cada motivo de permissão tem a correção exata', async () => {
    const user = userEvent.setup();
    open([
      sourceFixture('security_hub', {
        name: 'Security Hub',
        permission: 'missing',
        permissionDetail: 'capability_off',
      }),
      sourceFixture('waf', {
        name: 'loja-acl',
        permission: 'missing',
        permissionDetail: 'kms_denied',
        details: { bucket: 'aws-waf-logs-loja', kmsKeyArn: 'arn:aws:kms:sa-east-1:111111111111:key/exemplo' },
      }),
      sourceFixture('cloudtrail', {
        name: 'trilha-da-organizacao',
        permission: 'missing',
        permissionDetail: 'outside_awslogs_prefix',
        notes: ['central_bucket', 'additional_bucket_required'],
        details: { bucket: 'logs-centrais', customPrefix: 'auditoria' },
      }),
      sourceFixture('vpc_flow_logs', {
        name: 'fl-rede',
        permission: 'missing',
        permissionDetail: 'bucket_denied',
        details: { bucket: 'flow-logs-da-rede' },
      }),
      sourceFixture('guardduty_export', {
        name: 'export-antigo',
        permission: 'missing',
        permissionDetail: 'bucket_missing',
        details: { bucket: 'export-apagado' },
      }),
      sourceFixture('inspector', {
        name: 'Inspector',
        permission: 'unknown',
        permissionDetail: 'probe_failed',
      }),
      sourceFixture('access_analyzer', {
        name: 'analisador',
        permission: 'missing',
        permissionDetail: 'access-analyzer:ListFindings',
      }),
      sourceFixture('guardduty', { name: 'GuardDuty', permission: 'unknown', permissionDetail: null }),
    ]);
    const needs = group(await sourcesRegion(), /^Precisam de permissão adicional \(8\)$/);
    const item = (name: string) => {
      const found = within(needs)
        .getAllByRole('listitem')
        .find((candidate) => candidate.textContent?.includes(name));
      if (!found) throw new Error(`fonte não encontrada: ${name}`);
      return found;
    };
    // A autorização desligada: atualizar a pilha.
    expect(item('Security Hub')).toHaveTextContent(
      'A autorização “Achados de segurança” está desligada na pilha. Para o Verax ler esta fonte, ligue-a em Atualize a pilha.',
    );
    expect(within(item('Security Hub')).getByRole('link', { name: 'Atualize a pilha' })).toHaveAttribute(
      'href',
      '#aws-pilha',
    );
    // A chave KMS: a declaração para a política da chave, com cópia.
    expect(item('loja-acl')).toHaveTextContent(
      'O bucket aws-waf-logs-loja é cifrado com uma chave KMS que não decifra para o Verax (arn:aws:kms:sa-east-1:111111111111:key/exemplo)',
    );
    await user.click(
      within(item('loja-acl')).getByRole('button', {
        name: 'Copiar a declaração para a política da chave KMS',
      }),
    );
    expect(JSON.parse(await navigator.clipboard.readText())).toMatchObject({
      Action: 'kms:Decrypt',
      Principal: { AWS: 'arn:aws:iam::111111111111:role/verax/verax-control-reader' },
      Condition: { StringLike: { 'kms:ViaService': 's3.*.amazonaws.com' } },
    });
    // O prefixo antes de AWSLogs/: o cadastro dos buckets fora do padrão.
    expect(item('trilha-da-organizacao')).toHaveTextContent(
      /prefixo antes de AWSLogs\/ \(auditoria\).*Cadastre o bucket logs-centrais em Avançado: buckets fora do padrão/,
    );
    expect(
      within(item('trilha-da-organizacao')).getByRole('link', { name: 'Avançado: buckets fora do padrão' }),
    ).toHaveAttribute('href', '#aws-buckets');
    expect(item('trilha-da-organizacao')).toHaveTextContent(
      'Trilha de organização: o bucket fica em outra conta',
    );
    expect(item('fl-rede')).toHaveTextContent(
      'O bucket flow-logs-da-rede não deixa o Verax listar nem ler os arquivos.',
    );
    expect(item('fl-rede')).toHaveTextContent('arn:aws:iam::111111111111:role/verax/verax-control-reader');
    expect(item('export-antigo')).toHaveTextContent('O bucket export-apagado não existe mais.');
    expect(item('Inspector')).toHaveTextContent('A AWS não respondeu à conferência da permissão.');
    expect(item('analisador')).toHaveTextContent(
      'A AWS negou a ação access-analyzer:ListFindings. Atualize a pilha para o modelo atual',
    );
    expect(item('GuardDuty (API)')).toHaveTextContent('A permissão desta fonte ainda não foi conferida.');
    // Todas têm o "Verificar de novo".
    expect(within(needs).getAllByRole('button', { name: /^Verificar de novo: / })).toHaveLength(8);
  });

  it('sem fonte para autorizar, a seção diz por quê: antes da descoberta e depois de autorizar tudo', async () => {
    open([authorizedSourceFixture('guardduty', 'collecting')]);
    expect(await sourcesRegion()).toHaveTextContent(
      'Não há fonte de log para autorizar agora: tudo o que a descoberta encontrou já está em "Fontes autorizadas".',
    );
  });
});

describe('autorizar fontes', () => {
  it('marca, confirma e autoriza: o pedido leva só as marcadas, e a tela mostra o que a API respondeu', async () => {
    const user = userEvent.setup();
    const trail = sourceFixture('cloudtrail', { name: 'management-events' });
    const hub = sourceFixture('security_hub', { name: 'Security Hub' });
    const { fake, view } = open([trail, hub]);
    fake.on('authorize', () => view([authorized(trail), hub]));
    const region = await sourcesRegion();
    await user.click(within(region).getByRole('checkbox', { name: /CloudTrail \(trilha\)/ }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    // A confirmação: o que entra e que a coleta começa hoje, sem histórico. Nenhum pedido ainda.
    const confirmation = within(region).getByRole('group', { name: 'Confirmar a autorização de 1 fonte' });
    expect(confirmation).toHaveTextContent('CloudTrail (trilha) · management-events');
    expect(confirmation).toHaveTextContent('A coleta começa hoje: o Verax não busca o histórico anterior.');
    // Uma trilha não é de volume alto nem sensível: sem esses avisos.
    expect(confirmation).not.toHaveTextContent('volume mensal do seu plano');
    expect(confirmation).not.toHaveTextContent('dados pessoais');
    expect(fake.calls).toEqual([]);
    await user.click(within(confirmation).getByRole('button', { name: 'Confirmar autorização' }));
    await waitFor(() =>
      expect(fake.calls).toEqual([{ route: 'authorize', sourceId: null, body: { sourceIds: [trail.id] } }]),
    );
    // A trilha sai das disponíveis e entra nas autorizadas, aguardando o coletor.
    const monitor = await screen.findByRole('region', { name: 'Fontes autorizadas' });
    expect(
      within(monitor).getByRole('rowheader', { name: /CloudTrail \(trilha\) · management-events/ }),
    ).toBeInTheDocument();
    expect(monitor).toHaveTextContent('Aguardando o coletor iniciar');
    expect(within(region).queryByRole('checkbox', { name: /CloudTrail \(trilha\)/ })).not.toBeInTheDocument();
    expect(within(region).getByRole('checkbox', { name: /Security Hub/ })).not.toBeChecked();
    expect(within(region).queryByRole('group', { name: /Confirmar a autorização/ })).not.toBeInTheDocument();
  });

  it('a recusa da API aparece na confirmação, e nada muda na tela (a autorização nunca é adiantada)', async () => {
    const user = userEvent.setup();
    const trail = sourceFixture('cloudtrail', { name: 'management-events' });
    const { fake } = open([trail]);
    fake.on('authorize', () => refusal(409, 'SOURCE_NOT_AVAILABLE'));
    const region = await sourcesRegion();
    await user.click(within(region).getByRole('checkbox', { name: /CloudTrail \(trilha\)/ }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    await user.click(within(region).getByRole('button', { name: 'Confirmar autorização' }));
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      AWS_ONBOARDING_ERROR_TEXTS.SOURCE_NOT_AVAILABLE,
    );
    expect(within(region).getByRole('checkbox', { name: /CloudTrail \(trilha\)/ })).toBeChecked();
    expect(screen.queryByRole('region', { name: 'Fontes autorizadas' })).not.toBeInTheDocument();
    // Cancelar fecha a confirmação e apaga o erro.
    await user.click(within(region).getByRole('button', { name: 'Cancelar' }));
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(
    AWS_ONBOARDING_ERROR_CODES.filter((code) => code.startsWith('SOURCE_') || code.startsWith('SENSITIVE_')),
  )('recusa %s da autorização: o texto do código', async (code) => {
    const user = userEvent.setup();
    const { fake } = open([sourceFixture('guardduty', { name: 'GuardDuty' })]);
    fake.on('authorize', () => refusal(code === 'SENSITIVE_CONFIRMATION_REQUIRED' ? 400 : 409, code));
    const region = await sourcesRegion();
    await user.click(within(region).getByRole('checkbox', { name: /GuardDuty/ }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    await user.click(within(region).getByRole('button', { name: 'Confirmar autorização' }));
    expect(await within(region).findByRole('alert')).toHaveTextContent(AWS_ONBOARDING_ERROR_TEXTS[code]);
  });

  it('fontes de volume alto: o aviso de que podem aumentar o volume do plano, antes de autorizar', async () => {
    const user = userEvent.setup();
    open([sourceFixture('vpc_flow_logs', { name: 'fl-0a1b', notes: ['high_volume'] })]);
    const region = await sourcesRegion();
    expect(group(region, /^Disponíveis para coletar/)).toHaveTextContent(
      'Volume alto: pode aumentar o volume mensal do seu plano.',
    );
    await user.click(within(region).getByRole('checkbox', { name: /VPC Flow Logs/ }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    const confirmation = within(region).getByRole('group', { name: /Confirmar a autorização/ });
    expect(confirmation).toHaveTextContent('Pode aumentar o volume mensal do seu plano.');
    expect(confirmation).toHaveTextContent('A coleta começa hoje: o Verax não busca o histórico anterior.');
  });

  it('flow log: a linha e a confirmação dizem que os do mesmo bucket são lidos juntos, e só o tráfego recusado', async () => {
    const user = userEvent.setup();
    const flow = sourceFixture('vpc_flow_logs', {
      name: 'fl-0a1b (vpc-0a1b)',
      notes: ['high_volume', 'flow_logs_read_together'],
      details: { bucket: 'exemplo-fluxo', prefix: 'AWSLogs/111111111111/vpcflowlogs/sa-east-1/' },
    });
    const { fake, view } = open([flow, sourceFixture('cloudtrail', { name: 'management-events' })]);
    fake.on('authorize', () => view([authorized(flow)]));
    const region = await sourcesRegion();
    // Na lista, antes de marcar: a nota e de onde vêm as detecções.
    const row = within(group(region, /^Disponíveis para coletar/))
      .getByRole('checkbox', { name: /VPC Flow Logs/ })
      .closest('li');
    expect(row).toHaveTextContent(AWS_SOURCE_NOTE_TEXTS.flow_logs_read_together);
    expect(row).toHaveTextContent('Só o tráfego recusado é lido.');
    expect(row).toHaveTextContent('varredura de rede');
    expect(row).toHaveTextContent('insistência em porta de administração remota');
    // A trilha não leva nada disso.
    const trail = within(group(region, /^Disponíveis para coletar/))
      .getByRole('checkbox', { name: /CloudTrail/ })
      .closest('li');
    expect(trail).not.toHaveTextContent('Flow Logs desta conta');
    expect(trail).not.toHaveTextContent('tráfego recusado');

    await user.click(within(region).getByRole('checkbox', { name: /VPC Flow Logs/ }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    const confirmation = within(region).getByRole('group', { name: 'Confirmar a autorização de 1 fonte' });
    expect(confirmation).toHaveTextContent('A autorização vale para todos os Flow Logs do mesmo bucket.');
    expect(confirmation).toHaveTextContent(
      'Ao autorizar este Flow Log, o Verax lê todos os Flow Logs desta conta e região que gravam no mesmo bucket.',
    );
    expect(confirmation).toHaveTextContent(AWS_SOURCE_COLLECTION_NOTES.vpc_flow_logs ?? '');
    // O aviso não trava a autorização: é só para o cliente saber antes de confirmar.
    await user.click(within(confirmation).getByRole('button', { name: 'Confirmar autorização' }));
    await waitFor(() =>
      expect(fake.calls).toEqual([{ route: 'authorize', sourceId: null, body: { sourceIds: [flow.id] } }]),
    );
  });

  it('flow log sem a nota (uma descoberta de antes dela) e outras fontes: a confirmação não inventa o aviso do bucket', async () => {
    const user = userEvent.setup();
    open([
      sourceFixture('vpc_flow_logs', { name: 'fl-0a1b', notes: ['high_volume'] }),
      sourceFixture('cloudtrail', { name: 'management-events' }),
    ]);
    const region = await sourcesRegion();
    await user.click(within(region).getByRole('checkbox', { name: /VPC Flow Logs/ }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    const confirmation = within(region).getByRole('group', { name: /Confirmar a autorização/ });
    expect(confirmation).toHaveTextContent('O que o Verax lê dos Flow Logs.');
    expect(confirmation).toHaveTextContent('Só o tráfego recusado é lido.');
    expect(confirmation).not.toHaveTextContent('todos os Flow Logs do mesmo bucket');
    // Só a trilha escolhida: nada sobre flow logs.
    await user.click(within(region).getByRole('checkbox', { name: /VPC Flow Logs/ }));
    await user.click(within(region).getByRole('checkbox', { name: /CloudTrail/ }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    expect(within(region).getByRole('group', { name: /Confirmar a autorização/ })).not.toHaveTextContent(
      'Flow Logs',
    );
  });

  it('a API e o export do GuardDuty juntos: o aviso de que basta a API', async () => {
    const user = userEvent.setup();
    open([
      sourceFixture('guardduty', { name: 'GuardDuty' }),
      sourceFixture('guardduty_export', { name: 'export' }),
    ]);
    const region = await sourcesRegion();
    await user.click(within(region).getByRole('checkbox', { name: /GuardDuty \(API\)/ }));
    await user.click(within(region).getByRole('checkbox', { name: /GuardDuty \(export/ }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (2)' }));
    expect(
      within(region).getByRole('group', { name: 'Confirmar a autorização de 2 fontes' }),
    ).toHaveTextContent('A API e o export do GuardDuty trazem os mesmos achados.');
  });

  it('quem só lê vê as fontes, sem caixas nem botões', async () => {
    open([sourceFixture('cloudtrail', { name: 'management-events' })], { canWrite: false });
    const region = await sourcesRegion();
    expect(region).toHaveTextContent('management-events');
    expect(within(region).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(region).queryByRole('button')).not.toBeInTheDocument();
    expect(region).toHaveTextContent('Quem administra as contas autoriza as fontes.');
  });
});

describe('grupos do CloudWatch Logs', () => {
  const logGroup = (name: string, overrides: Partial<AwsSource> = {}) =>
    sourceFixture('cloudwatch_log_group', {
      name,
      details: {
        logGroup: name,
        storedBytes: 2_500_000_000,
        retentionDays: 30,
        category: 'lambda',
        tagged: true,
      },
      ...overrides,
    });
  const untagged = (name: string) =>
    logGroup(name, {
      permission: 'missing',
      permissionDetail: 'tag_missing',
      notes: ['tag_required'],
      details: {
        arn: `arn:aws:logs:sa-east-1:111111111111:log-group:${name}`,
        logGroup: name,
        storedBytes: 100_000_000,
        retentionDays: null,
        category: 'other',
        tagged: false,
      },
    });

  it('a lista com busca: nome, região, tamanho, retenção, categoria e etiqueta; sem "marcar todos"', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 60 }, (_, index) =>
      untagged(`/aws/lambda/servico-${String(index + 1).padStart(2, '0')}`),
    );
    open([logGroup('/aplicacao/auditoria'), logGroup('/aws/rds/loja', { region: 'us-east-1' }), ...many]);
    const groups = group(await sourcesRegion(), /^Grupos do CloudWatch Logs \(62\)$/);
    expect(groups).toHaveTextContent('Logs de aplicação podem conter dados pessoais.');
    expect(within(groups).getByRole('status')).toHaveTextContent('Mostrando 25 de 62 grupos.');
    const list = within(groups).getByRole('list', { name: 'Grupos do CloudWatch Logs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(25);
    // Os que já podem ser marcados vêm primeiro, cada um com a própria caixa; não há caixa para todos.
    const first = within(list).getAllByRole('listitem')[0];
    expect(first).toHaveTextContent('/aplicacao/auditoria');
    expect(first).toHaveTextContent('com a etiqueta de leitura');
    expect(first).toHaveTextContent('sa-east-1 · 2,5 GB guardados · retenção de 30 dias · Lambda');
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(groups).queryByRole('checkbox', { name: /todos/i })).not.toBeInTheDocument();
    expect(within(groups).queryByRole('button', { name: /todos/i })).not.toBeInTheDocument();
    // Mais uma página.
    await user.click(within(groups).getByRole('button', { name: 'Mostrar mais 25' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    // A busca é pelo nome ou pela região.
    await user.type(within(groups).getByLabelText('Buscar grupo de logs'), 'servico-4');
    expect(within(groups).getByRole('status')).toHaveTextContent('Mostrando 10 de 10 grupos.');
    await user.clear(within(groups).getByLabelText('Buscar grupo de logs'));
    await user.type(within(groups).getByLabelText('Buscar grupo de logs'), 'us-east');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('/aws/rds/loja');
    await user.clear(within(groups).getByLabelText('Buscar grupo de logs'));
    await user.click(within(groups).getByRole('checkbox', { name: 'Só os que têm a etiqueta' }));
    expect(within(groups).getByRole('status')).toHaveTextContent('Mostrando 2 de 2 grupos.');
    await user.type(within(groups).getByLabelText('Buscar grupo de logs'), 'nada-disso');
    expect(within(groups).getByRole('status')).toHaveTextContent('Nenhum grupo com esse filtro.');
  });

  it('grupo sem a etiqueta: o comando de uma linha com cópia, e o "Verificar de novo"', async () => {
    const user = userEvent.setup();
    const source = untagged('/aws/lambda/loja-checkout');
    const { fake, view } = open([source]);
    fake.on('retry', () => view([{ ...source, probeRequestedAt: new Date().toISOString() }]));
    const groups = group(await sourcesRegion(), /^Grupos do CloudWatch Logs \(1\)$/);
    expect(groups).toHaveTextContent('sem a etiqueta de leitura');
    expect(groups).toHaveTextContent('0,1 GB guardados · sem prazo de retenção · Aplicação ou outro');
    expect(within(groups).queryByRole('checkbox', { name: /loja-checkout/ })).not.toBeInTheDocument();
    const command =
      "aws logs tag-resource --resource-arn 'arn:aws:logs:sa-east-1:111111111111:log-group:/aws/lambda/loja-checkout' --tags verax-control=leitura";
    expect(within(groups).getByText(command)).toBeInTheDocument();
    await user.click(
      within(groups).getByRole('button', {
        name: 'Copiar o comando da etiqueta do grupo /aws/lambda/loja-checkout',
      }),
    );
    expect(await navigator.clipboard.readText()).toBe(command);
    await user.click(within(groups).getByRole('button', { name: /^Verificar de novo: / }));
    await waitFor(() =>
      expect(fake.calls).toEqual([{ route: 'retry', sourceId: source.id, body: undefined }]),
    );
    // O pedido gravado e ainda não respondido: o botão diz que está conferindo, no texto e no nome.
    const checking = await within(groups).findByRole('button', {
      name: 'Conferindo…: Grupo do CloudWatch Logs /aws/lambda/loja-checkout',
    });
    expect(checking).toHaveTextContent('Conferindo…');
    expect(checking).toBeDisabled();
    expect(within(groups).queryByRole('button', { name: /^Verificar de novo/ })).not.toBeInTheDocument();
  });

  it('a autorização dos grupos desligada na pilha: o aviso antes da lista, e nenhum grupo pode ser marcado', async () => {
    open([
      logGroup('/aplicacao/auditoria', {
        permission: 'missing',
        permissionDetail: 'capability_off',
        notes: ['stack_update_required'],
      }),
    ]);
    const groups = group(await sourcesRegion(), /^Grupos do CloudWatch Logs \(1\)$/);
    expect(groups).toHaveTextContent('A leitura de grupos de logs está desligada na pilha.');
    expect(within(groups).getAllByRole('link', { name: 'Atualize a pilha' })[0]).toHaveAttribute(
      'href',
      '#aws-pilha',
    );
    expect(within(within(groups).getByRole('list')).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('autorizar um grupo pede a confirmação explícita, e o pedido repete o grupo em sensitiveSourceIds', async () => {
    const user = userEvent.setup();
    const audit = logGroup('/aplicacao/auditoria');
    const trail = sourceFixture('cloudtrail', { name: 'management-events' });
    const { fake, view } = open([audit, trail]);
    fake.on('authorize', () => view([authorized(audit), authorized(trail)]));
    const region = await sourcesRegion();
    await user.click(within(region).getByRole('checkbox', { name: '/aplicacao/auditoria' }));
    await user.click(within(region).getByRole('checkbox', { name: /CloudTrail \(trilha\)/ }));
    expect(within(region).getByText(/1 marcado para autorizar\./)).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (2)' }));
    const confirmation = within(region).getByRole('group', { name: 'Confirmar a autorização de 2 fontes' });
    expect(confirmation).toHaveTextContent('Logs de aplicação podem conter dados pessoais.');
    expect(confirmation).toHaveTextContent('Pode aumentar o volume mensal do seu plano.');
    // Sem a confirmação, o botão não sai do lugar.
    const confirm = within(confirmation).getByRole('button', { name: 'Confirmar autorização' });
    expect(confirm).toBeDisabled();
    await user.click(
      within(confirmation).getByRole('checkbox', {
        name: 'Confirmo que o Verax pode ler o conteúdo deste grupo de logs',
      }),
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]).toMatchObject({ route: 'authorize' });
    const body = fake.calls[0]?.body as { sourceIds: string[]; sensitiveSourceIds: string[] };
    expect([...body.sourceIds].sort()).toEqual([audit.id, trail.id].sort());
    expect(body.sensitiveSourceIds).toEqual([audit.id]);
    const monitor = await screen.findByRole('region', { name: 'Fontes autorizadas' });
    expect(monitor).toHaveTextContent('/aplicacao/auditoria');
    expect(monitor).toHaveTextContent('Sensível');
  });

  it('antes e na confirmação: os alertas dos grupos demoram ao menos 10 min e só são atribuídos com uma conta só', async () => {
    const user = userEvent.setup();
    open([
      sourceFixture('cloudwatch_log_group', {
        name: '/aplicacao/auditoria',
        details: { logGroup: '/aplicacao/auditoria', tagged: true, storedBytes: 1_000_000 },
      }),
    ]);
    const region = await sourcesRegion();
    const groups = group(region, /^Grupos do CloudWatch Logs/);
    expect(groups).toHaveTextContent(AWS_SOURCE_COLLECTION_NOTES.cloudwatch_log_group ?? '');
    await user.click(within(groups).getByRole('checkbox', { name: '/aplicacao/auditoria' }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    const confirmation = within(region).getByRole('group', { name: /Confirmar a autorização/ });
    expect(confirmation).toHaveTextContent('Os alertas dos grupos de logs demoram um pouco mais.');
    expect(confirmation).toHaveTextContent('pelo menos 10 minutos de atraso');
    expect(confirmation).toHaveTextContent('fila de alertas sem dono, que só a Verax vê');
    // O aviso do atraso não é o da confirmação explícita, que segue valendo.
    expect(within(confirmation).getByRole('button', { name: 'Confirmar autorização' })).toBeDisabled();
  });

  it('mudar a escolha depois de confirmar desmarca a confirmação: ela vale para a lista que está na tela', async () => {
    const user = userEvent.setup();
    open([logGroup('/aplicacao/auditoria'), logGroup('/aplicacao/autenticacao')]);
    const region = await sourcesRegion();
    await user.click(within(region).getByRole('checkbox', { name: '/aplicacao/auditoria' }));
    await user.click(within(region).getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    await user.click(within(region).getByRole('checkbox', { name: /^Confirmo que o Verax pode ler/ }));
    expect(within(region).getByRole('button', { name: 'Confirmar autorização' })).toBeEnabled();
    await user.click(within(region).getByRole('checkbox', { name: '/aplicacao/autenticacao' }));
    const confirmation = within(region).getByRole('group', { name: 'Confirmar a autorização de 2 fontes' });
    expect(
      within(confirmation).getByRole('checkbox', {
        name: 'Confirmo que o Verax pode ler o conteúdo destes 2 grupos de logs',
      }),
    ).not.toBeChecked();
    expect(within(confirmation).getByRole('button', { name: 'Confirmar autorização' })).toBeDisabled();
  });
});

describe('fontes autorizadas: a saúde de cada uma, revogar e tentar de novo', () => {
  const monitorRegion = () => screen.findByRole('region', { name: 'Fontes autorizadas' });
  const rowOf = (monitor: HTMLElement, name: RegExp) => {
    const header = within(monitor).getByRole('rowheader', { name });
    const row = header.closest('tr');
    if (!row) throw new Error('linha não encontrada');
    return row;
  };
  const cells = (row: HTMLElement) =>
    within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  it('a tabela: fonte, região, estado, último evento, última leitura, atraso e volume, sem valor inventado', async () => {
    open([
      authorizedSourceFixture('cloudtrail', 'collecting', {
        name: 'management-events',
        health: {
          lastSyncAt: minutesAgo(1),
          lastEventAt: minutesAgo(3),
          lastIngestedAt: minutesAgo(2),
          lagSeconds: 95,
          eventsLast24h: 12_480,
          bytesLast24h: 300_000_000,
        },
      }),
      authorizedSourceFixture('guardduty', 'collecting', {
        name: 'GuardDuty',
        health: {
          lastSyncAt: minutesAgo(1),
          lastEventAt: null,
          lastIngestedAt: null,
          lagSeconds: 40,
          eventsLast24h: 0,
          bytesLast24h: 0,
        },
      }),
      authorizedSourceFixture('waf', 'waiting_events', { name: 'loja-acl' }),
      authorizedSourceFixture('security_hub', 'authorized', { name: 'Security Hub' }),
      authorizedSourceFixture('inspector', 'configuring', { name: 'Inspector' }),
      authorizedSourceFixture('vpc_flow_logs', 'stalled', {
        name: 'fl-0a1b',
        health: {
          lastSyncAt: minutesAgo(1),
          lastEventAt: minutesAgo(180),
          lastIngestedAt: minutesAgo(179),
          lagSeconds: 3 * 3_600,
          eventsLast24h: 1,
          bytesLast24h: null,
        },
      }),
      authorizedSourceFixture('access_analyzer', 'ingestion_error', {
        name: 'analisador',
        stateCode: 'throttled',
      }),
      authorizedSourceFixture('access_analyzer', 'collecting', {
        name: 'sem-achados',
        stateCode: 'no_findings_yet',
        health: {
          lastSyncAt: minutesAgo(2),
          lastEventAt: null,
          lastIngestedAt: null,
          lagSeconds: 120,
          eventsLast24h: null,
          bytesLast24h: null,
        },
      }),
      authorizedSourceFixture('inspector', 'source_missing', {
        name: 'desligado',
        region: 'us-east-1',
        stateCode: 'not_enabled',
      }),
      authorizedSourceFixture('guardduty_export', 'source_missing', {
        name: 'export',
        stateCode: 'not_found',
      }),
    ]);
    const monitor = await monitorRegion();
    expect(
      within(monitor)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Fonte',
      'Região',
      'Estado',
      'Último evento',
      'Última leitura',
      'Atraso',
      'Volume (24 h)',
      'Ações',
    ]);
    expect(cells(rowOf(monitor, /management-events/)).slice(0, 6)).toEqual([
      'sa-east-1',
      'Coletando',
      'há 3 minutos',
      'há 1 minuto',
      '2 min',
      '12.480 eventos · 0,3 GB',
    ]);
    // Fonte de achados sem achado novo: sincronizada, sem fingir evento.
    expect(cells(rowOf(monitor, /GuardDuty \(API\)/)).slice(1, 6)).toEqual([
      'Sincronizada, sem achados novos',
      'nenhum ainda',
      'há 1 minuto',
      '40 s',
      '0 eventos · 0 GB',
    ]);
    expect(cells(rowOf(monitor, /loja-acl/)).slice(1, 6)).toEqual([
      'Configurada, ainda sem eventos',
      'nenhum ainda',
      'nenhuma ainda',
      'sem medida',
      '—',
    ]);
    expect(cells(rowOf(monitor, /Security Hub/))[1]).toBe('Aguardando o coletor iniciar');
    expect(cells(rowOf(monitor, /Inspector · Inspector/))[1]).toBe('Configurando o coletor');
    expect(cells(rowOf(monitor, /fl-0a1b/)).slice(1, 6)).toEqual([
      'ParadaEsta fonte entrega eventos o tempo todo, e parou de entregar há mais de 2 horas.',
      'há 3 horas',
      'há 1 minuto',
      '3 h',
      '1 evento',
    ]);
    // O código do coletor de achados: a leitura deu certo e o serviço ainda não trouxe achado (sem depender do volume).
    expect(cells(rowOf(monitor, /sem-achados/)).slice(1, 6)).toEqual([
      `Sincronizada, sem achados novos${AWS_SOURCE_STATE_CODE_TEXTS.no_findings_yet}`,
      'nenhum ainda',
      'há 2 minutos',
      '2 min',
      '—',
    ]);
    // A AWS limitando as chamadas: o que o Verax faz a respeito, sem código cru.
    expect(cells(rowOf(monitor, /analisador/))[1]).toBe(
      'Falha de ingestãoA AWS está limitando as chamadas a este serviço. O Verax tenta de novo sozinho, com intervalos maiores: não é preciso fazer nada.',
    );
    expect(cells(rowOf(monitor, /GuardDuty \(export/))[1]).toBe(
      'Não encontrada na contaO Verax não achou mais esta fonte na conta (foi apagada ou trocada). Se ela voltar, clique em Tentar de novo; senão, retire a autorização.',
    );
    expect(cells(rowOf(monitor, /desligado/))[1]).toBe(
      'Não encontrada na contaO serviço foi desligado na conta depois da autorização. Se você o ligar de novo na AWS, clique em Tentar de novo; senão, retire a autorização.',
    );
    expect(monitor).toHaveTextContent('Coleta desde 20/11/2026');
    // "Tentar de novo" só onde ler a fonte de novo pode destravar: a falha de leitura, a parada e as que sumiram.
    expect(
      within(monitor)
        .getAllByRole('button', { name: /^Tentar de novo: / })
        .map((button) => button.getAttribute('aria-label'))
        .sort(),
    ).toEqual([
      'Tentar de novo: GuardDuty (export para o S3) export',
      'Tentar de novo: IAM Access Analyzer analisador',
      'Tentar de novo: Inspector desligado',
      'Tentar de novo: VPC Flow Logs fl-0a1b',
    ]);
    expect(within(monitor).getAllByRole('button', { name: /^Revogar: / })).toHaveLength(10);
  });

  it('as fontes de bucket e os grupos de logs: o motivo que a coleta grava em cada estado, e o que cada tipo lê', async () => {
    open([
      authorizedSourceFixture('waf', 'configuring', { name: 'checkout-acl', stateCode: 'awaiting_apply' }),
      authorizedSourceFixture('cloudtrail', 'waiting_events', { name: 'trilha-de-dados' }),
      authorizedSourceFixture('vpc_flow_logs', 'collecting', {
        name: 'fl-coletando',
        health: {
          lastSyncAt: minutesAgo(1),
          lastEventAt: minutesAgo(9),
          lastIngestedAt: minutesAgo(2),
          lagSeconds: 7 * 60,
          eventsLast24h: 52_300,
          bytesLast24h: 700_000_000,
        },
      }),
      authorizedSourceFixture('vpc_flow_logs', 'stalled', { name: 'fl-parado', stateCode: 'no_progress' }),
      authorizedSourceFixture('vpc_flow_logs', 'ingestion_error', {
        name: 'fl-mexico',
        region: 'mx-central-1',
        stateCode: 'region_unsupported',
      }),
      authorizedSourceFixture('cloudwatch_log_group', 'ingestion_error', {
        name: '/aplicacao/auditoria',
        stateCode: 'log_group_name_conflict',
      }),
      legacySourceFixture('exemplo-trilha-do-cadastro'),
    ]);
    const monitor = await monitorRegion();
    expect(cells(rowOf(monitor, /checkout-acl/))[1]).toBe(
      `Configurando o coletor${AWS_WAZUH_SOURCE_STATE_CODE_TEXTS.awaiting_apply}`,
    );
    expect(cells(rowOf(monitor, /trilha-de-dados/))[1]).toBe('Configurada, ainda sem eventos');
    // Coletando, com o atraso que o coletor mediu na última leitura.
    expect(cells(rowOf(monitor, /fl-coletando/)).slice(1, 6)).toEqual([
      'Coletando',
      'há 9 minutos',
      'há 1 minuto',
      '7 min',
      '52.300 eventos · 0,7 GB',
    ]);
    expect(cells(rowOf(monitor, /fl-parado/))[1]).toBe(
      `Parada${AWS_WAZUH_SOURCE_STATE_CODE_TEXTS.no_progress}`,
    );
    expect(cells(rowOf(monitor, /fl-mexico/))[1]).toBe(
      `Falha de ingestão${AWS_WAZUH_SOURCE_STATE_CODE_TEXTS.region_unsupported}`,
    );
    expect(cells(rowOf(monitor, /\/aplicacao\/auditoria/))[1]).toBe(
      `Falha de ingestão${AWS_WAZUH_SOURCE_STATE_CODE_TEXTS.log_group_name_conflict}`,
    );
    // Na linha de cada flow log e de cada grupo, o que o Verax lê e o que esperar; na trilha e no bucket do cadastro, não.
    for (const name of [/fl-coletando/, /fl-parado/, /fl-mexico/]) {
      expect(within(monitor).getByRole('rowheader', { name })).toHaveTextContent(
        AWS_SOURCE_COLLECTION_NOTES.vpc_flow_logs ?? '',
      );
    }
    expect(within(monitor).getByRole('rowheader', { name: /\/aplicacao\/auditoria/ })).toHaveTextContent(
      AWS_SOURCE_COLLECTION_NOTES.cloudwatch_log_group ?? '',
    );
    expect(within(monitor).getByRole('rowheader', { name: /trilha-de-dados/ })).not.toHaveTextContent(
      'tráfego recusado',
    );
    expect(within(monitor).getByRole('rowheader', { name: /Cadastrada manualmente/ })).not.toHaveTextContent(
      'tráfego recusado',
    );
  });

  it('revogar pede a confirmação; confirmada, a fonte volta para as disponíveis com a data da retirada', async () => {
    const user = userEvent.setup();
    const hub = authorizedSourceFixture('security_hub', 'collecting', { name: 'Security Hub' });
    const { fake, view } = open([hub]);
    fake.on('revoke', () =>
      view([
        {
          ...hub,
          state: 'revoked',
          authorization: { ...hub.authorization, revokedAt: new Date().toISOString() },
        },
      ]),
    );
    const monitor = await monitorRegion();
    await user.click(within(monitor).getByRole('button', { name: 'Revogar: Security Hub Security Hub' }));
    const confirmation = within(monitor).getByRole('group', { name: 'Confirmação' });
    expect(confirmation).toHaveTextContent('O Verax para de ler esta fonte.');
    expect(fake.calls).toEqual([]);
    await user.click(within(confirmation).getByRole('button', { name: 'Confirmar revogação' }));
    await waitFor(() => expect(fake.calls).toEqual([{ route: 'revoke', sourceId: hub.id, body: undefined }]));
    const available = group(await sourcesRegion(), /^Disponíveis para coletar \(1\)$/);
    expect(available).toHaveTextContent(
      /Autorização retirada em \d{2}\/\d{2}\/\d{4}\. Pode ser autorizada de novo\./,
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Fontes autorizadas' })).not.toBeInTheDocument(),
    );
  });

  it('erro de permissão numa fonte autorizada: a correção fica na linha dela, e "Tentar de novo" pede a conferência', async () => {
    const user = userEvent.setup();
    const waf = authorizedSourceFixture('waf', 'permission_error', {
      name: 'loja-acl',
      permission: 'missing',
      permissionDetail: 'kms_denied',
      stateCode: 'kms_denied',
      details: { bucket: 'aws-waf-logs-loja' },
    });
    const { fake } = open([waf], {
      onboarding: {
        state: 'permission_error',
        checks: checksFixture({
          assume_role: { status: 'ok' },
          permission: { status: 'failed', code: 'kms_denied' },
        }),
      },
    });
    fake.on('retry', () => refusal(409, 'ACCOUNT_NOT_CONNECTED'));
    const monitor = await monitorRegion();
    expect(cells(rowOf(monitor, /loja-acl/))[1]).toBe(
      'Erro de permissãoFalta permissão: a chave KMS do bucket não decifra os logs para o Verax.',
    );
    expect(monitor).toHaveTextContent('inclua esta declaração na política dela');
    // A correção cita o botão da própria linha.
    expect(monitor).toHaveTextContent('Depois, clique em Tentar de novo.');
    await user.click(
      within(monitor).getByRole('button', { name: 'Tentar de novo: WAF (log da Web ACL) loja-acl' }),
    );
    await waitFor(() => expect(fake.calls).toEqual([{ route: 'retry', sourceId: waf.id, body: undefined }]));
    expect(await within(monitor).findByRole('alert')).toHaveTextContent(
      AWS_ONBOARDING_ERROR_TEXTS.ACCOUNT_NOT_CONNECTED,
    );
    // A API não gravou pedido nenhum: o botão não fica esperando os 30 s.
    expect(
      await within(monitor).findByRole('button', { name: 'Tentar de novo: WAF (log da Web ACL) loja-acl' }),
    ).toBeEnabled();
  });

  it('depois do clique, o botão fica desligado pelos segundos que faltam dos 30 s da mesma fonte', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const user = userEvent.setup();
    const waf = authorizedSourceFixture('waf', 'permission_error', {
      name: 'loja-acl',
      permission: 'missing',
      permissionDetail: 'kms_denied',
      stateCode: 'kms_denied',
      details: { bucket: 'aws-waf-logs-loja' },
    });
    const trail = authorizedSourceFixture('cloudtrail', 'stalled', { name: 'management-events' });
    // A conferência já respondeu (a chave KMS continua negando): a fonte volta sem pedido pendente.
    const { fake } = open([waf, trail]);
    const monitor = await monitorRegion();
    await user.click(
      within(monitor).getByRole('button', { name: 'Tentar de novo: WAF (log da Web ACL) loja-acl' }),
    );
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    const waiting = await within(monitor).findByRole('button', {
      name: 'Tentar de novo em 30 s: WAF (log da Web ACL) loja-acl',
    });
    expect(waiting).toBeDisabled();
    expect(waiting).toHaveTextContent('Tentar de novo em 30 s');
    // A espera é da fonte: a outra continua podendo ser conferida.
    expect(
      within(monitor).getByRole('button', { name: 'Tentar de novo: CloudTrail (trilha) management-events' }),
    ).toBeEnabled();
    // A contagem anda com o relógio, e o botão volta sozinho quando os 30 s passam.
    vi.setSystemTime(Date.now() + 12_000);
    expect(
      await within(monitor).findByRole(
        'button',
        { name: 'Tentar de novo em 18 s: WAF (log da Web ACL) loja-acl' },
        { timeout: 3_000 },
      ),
    ).toBeDisabled();
    vi.setSystemTime(Date.now() + 18_000);
    expect(
      await within(monitor).findByRole(
        'button',
        { name: 'Tentar de novo: WAF (log da Web ACL) loja-acl' },
        { timeout: 3_000 },
      ),
    ).toBeEnabled();
    expect(fake.calls).toHaveLength(1);
  });

  it('a recusa do intervalo (429) tem o texto dela, e o botão segue esperando', async () => {
    const user = userEvent.setup();
    const hub = authorizedSourceFixture('security_hub', 'ingestion_error', {
      name: 'Security Hub',
      stateCode: 'throttled',
    });
    const { fake } = open([hub]);
    fake.on('retry', () => refusal(429, 'SOURCE_RETRY_RATE_LIMITED'));
    const monitor = await monitorRegion();
    await user.click(
      within(monitor).getByRole('button', { name: 'Tentar de novo: Security Hub Security Hub' }),
    );
    expect(await within(monitor).findByRole('alert')).toHaveTextContent(
      AWS_ONBOARDING_ERROR_TEXTS.SOURCE_RETRY_RATE_LIMITED,
    );
    expect(AWS_ONBOARDING_ERROR_TEXTS.SOURCE_RETRY_RATE_LIMITED).toMatch(/30 segundos depois/);
    expect(
      within(monitor).getByRole('button', { name: /^Tentar de novo em \d+ s: Security Hub Security Hub$/ }),
    ).toBeDisabled();
  });

  it.each([
    ['SOURCE_NOT_AUTHORIZED', AWS_ONBOARDING_ERROR_TEXTS.SOURCE_NOT_AUTHORIZED],
    ['SOURCE_LEGACY', AWS_ONBOARDING_ERROR_TEXTS.SOURCE_LEGACY],
    [CONSOLE_MANAGED_CODE, 'Esta conta foi cadastrada pela Verax: peça a alteração à Verax.'],
  ])('recusa %s ao revogar: o texto do código', async (code, text) => {
    const user = userEvent.setup();
    const { fake } = open([authorizedSourceFixture('guardduty', 'collecting', { name: 'GuardDuty' })]);
    fake.on('revoke', () => refusal(409, code));
    const monitor = await monitorRegion();
    await user.click(within(monitor).getByRole('button', { name: /^Revogar: / }));
    await user.click(within(monitor).getByRole('button', { name: 'Confirmar revogação' }));
    expect(await within(monitor).findByRole('alert')).toHaveTextContent(text);
  });

  it('as fontes dos buckets do cadastro aparecem como "cadastrada manualmente", sem revogar nem tentar de novo', async () => {
    open([
      legacySourceFixture('exemplo-trilha', {
        health: {
          lastSyncAt: minutesAgo(1),
          lastEventAt: minutesAgo(4),
          lastIngestedAt: minutesAgo(3),
          lagSeconds: 120,
          eventsLast24h: null,
          bytesLast24h: null,
        },
      }),
    ]);
    const monitor = await monitorRegion();
    const row = rowOf(monitor, /exemplo-trilha/);
    expect(within(row).getByRole('rowheader')).toHaveTextContent('Cadastrada manualmente');
    expect(cells(row).slice(0, 2)).toEqual(['conta inteira', 'Coletando']);
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Avançado: buckets fora do padrão' })).toHaveAttribute(
      'href',
      '#aws-buckets',
    );
    // E não entram na lista do que pode ser autorizado.
    expect(await sourcesRegion()).not.toHaveTextContent('exemplo-trilha');
  });

  it('quem só lê vê a saúde das fontes, sem ações; a tabela rola dentro de um quadro que recebe o foco', async () => {
    const user = userEvent.setup();
    open([authorizedSourceFixture('guardduty', 'collecting', { name: 'GuardDuty' })], { canWrite: false });
    const monitor = await monitorRegion();
    expect(within(monitor).queryByRole('button')).not.toBeInTheDocument();
    expect(within(monitor).queryByRole('link')).not.toBeInTheDocument();
    // Sem botão nem link na tabela, o quadro dela é o único ponto de foco: é ele que deixa rolar pelo teclado.
    const frame = within(monitor).getByRole('region', {
      name: 'Tabela: Saúde da coleta de cada fonte autorizada',
    });
    expect(frame).toHaveAttribute('tabindex', '0');
    expect(
      within(frame).getByRole('table', { name: 'Saúde da coleta de cada fonte autorizada' }),
    ).toBeInTheDocument();
    frame.focus();
    expect(frame).toHaveFocus();
    await user.tab({ shift: true });
    expect(frame).not.toHaveFocus();
  });
});

describe('na VM própria do cliente (a chave de leitura)', () => {
  const keyMode = { credentialMode: 'access_key' } as const;

  it('antes de conectar: os passos da chave, com as autorizações na política e nas etiquetas do usuário', async () => {
    const user = userEvent.setup();
    const account = awsAccountFixture();
    const fake = onboardingApi(account, onboardingFixture(account.id, 'not_started', keyMode));
    server.use(...fake.handlers, ...createHandlers({ me: demoMe('admin_cliente'), nodePlatform: 'vm' }));
    renderAwsSection(account);
    const steps = await screen.findByRole('region', { name: 'Conectar a conta 111111111111' });
    // Nada da pilha nem do arquivo: quem lê é o usuário IAM.
    expect(within(steps).queryByRole('button', { name: 'Conectar com AWS' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pilha na AWS' })).not.toBeInTheDocument();
    expect(steps).toHaveTextContent('"Sid": "LerAchadosDeSeguranca"');
    expect(steps).toHaveTextContent(
      "'Key=verax-control:capabilities,Value=discovery service-logs findings log-groups'",
    );
    // Aqui nada é baixado: o cliente salva cada política com o nome que o bloco dela dá, e os comandos leem esses nomes.
    for (const file of ['verax-control-reader.json', 'verax-control-guardrails.json']) {
      expect(within(steps).getByRole('button', { name: `Copiar a política ${file}` })).toBeInTheDocument();
      expect(steps).toHaveTextContent(`--policy-document file://${file}`);
    }
    // Desligar uma autorização tira a declaração dela da política e do valor da etiqueta.
    await user.click(within(steps).getByRole('checkbox', { name: 'Achados de segurança' }));
    expect(steps).not.toHaveTextContent('"Sid": "LerAchadosDeSeguranca"');
    expect(steps).toHaveTextContent(
      "'Key=verax-control:capabilities,Value=discovery service-logs log-groups'",
    );
    expect(within(steps).getByLabelText('Chave secreta')).toHaveAttribute('type', 'password');
    await user.click(within(steps).getByRole('button', { name: 'Verificar conexão' }));
    await waitFor(() => expect(fake.calls.map((call) => call.route)).toEqual(['verify']));
  });

  it('aceita a chave, a conta ganha a mesma descoberta, as fontes e a saúde; os passos da chave ficam recolhidos', async () => {
    const account = awsAccountFixture({ connection: 'connected', ingestFrom: '2026-11-01' });
    const fake = onboardingApi(
      account,
      onboardingFixture(account.id, 'partial', {
        ...keyMode,
        template: {
          version: 1,
          capabilities: ['discovery'],
          outdated: true,
          checkedAt: new Date().toISOString(),
        },
        sources: [
          authorizedSourceFixture('guardduty', 'collecting', { name: 'GuardDuty' }),
          sourceFixture('waf', {
            name: 'loja-acl',
            permission: 'missing',
            permissionDetail: 'kms_denied',
            details: { bucket: 'aws-waf-logs-loja' },
          }),
        ],
      }),
    );
    server.use(...fake.handlers, ...createHandlers({ me: demoMe('admin_cliente'), nodePlatform: 'vm' }));
    renderAwsSection(account);
    expect(await screen.findByRole('region', { name: 'O que encontramos' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Fontes autorizadas' })).toHaveTextContent('GuardDuty (API)');
    // A correção cita o usuário de leitura, não o papel.
    expect(screen.getByRole('region', { name: 'Fontes de log' })).toHaveTextContent(
      'arn:aws:iam::111111111111:user/verax/verax-control-reader',
    );
    // O modelo anterior: atualizar é a política e as etiquetas do usuário, não uma pilha.
    const reader = screen.getByRole('region', { name: 'Usuário de leitura na AWS' });
    expect(reader).toHaveTextContent('Atualize as políticas do usuário de leitura');
    expect(reader).toHaveTextContent('aws iam create-policy-version --policy-arn');
    expect(reader).toHaveTextContent('aws iam tag-user --user-name verax-control-reader');
    expect(reader).not.toHaveTextContent('CloudFormation');
    // O comando lê o arquivo com o nome que o bloco da política dá.
    expect(
      within(reader).getByRole('button', { name: 'Copiar a política verax-control-reader.json' }),
    ).toBeInTheDocument();
    expect(reader).toHaveTextContent('--policy-document file://verax-control-reader.json --set-as-default');
    expect(
      within(screen.getByRole('list', { name: 'Conferências da conexão' })).getAllByRole('listitem')[0],
    ).toHaveTextContent('Leitura com a chave de acesso');
    expect(
      screen.getByText('Chave de leitura e políticas do usuário').closest('details'),
    ).not.toHaveAttribute('open');
  });
});
