import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AWS_MAX_AUTHORIZED_WEB_SOURCES,
  type AwsSource,
  type AwsSourcesAuthorize,
  awsSourcesAuthorizeSchema,
  WEB_ESTIMATE_MAX_AGE_MS,
  type WebLogSource,
} from '@verax/shared';
import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESTIMATE_POLL_MS, ESTIMATE_SLOW_AFTER_MS } from '@/features/web-attacks/web-logs-api';
import { api } from '@/lib/api';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers } from '@/mocks/handlers';
import { awsAccountFixture, onboardingFixture, sourceFixture } from '@/test/aws-onboarding-fixtures';
import { type OnboardingApi, onboardingApi, refusal, renderAwsSection } from '@/test/aws-onboarding-harness';
import {
  albFixture,
  authorizedAlbFixture,
  estimateFixture,
  pendingOf,
  settingsFixture,
  type WebLogsApi,
  webLogsApi,
  webLogsDisabled,
  webSourceFixture,
} from '@/test/web-logs-harness';

/** Os balanceadores na lista de fontes: a estimativa antes de marcar, a ciência dela no pedido, e por que um não serve. */

const server = setupServer();
beforeAll(() => server.listen());
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.useRealTimers();
});
afterAll(() => server.close());

const userOf = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const ready = (percent: number, overrides = {}) =>
  estimateFixture({
    projection: {
      gbPerDay: 0.3,
      percent,
      basis: 'monthly',
      acknowledgementRequired: percent > 20,
      validUntil: iso(6 * 24 * HOUR),
    },
    ...overrides,
  });

interface Setup {
  sources: AwsSource[];
  web?: WebLogSource[];
  canWrite?: boolean;
}

function open({ sources, web = [], canWrite = true }: Setup): {
  onboarding: OnboardingApi;
  webLogs: WebLogsApi;
} {
  const account = awsAccountFixture({ connection: 'connected', ingestFrom: '2026-11-01' });
  const onboarding = onboardingApi(account, onboardingFixture(account.id, 'awaiting_sources', { sources }));
  const webLogs = webLogsApi({ sources: web });
  server.use(
    ...webLogs.handlers,
    ...onboarding.handlers,
    ...createHandlers({ me: demoMe(canWrite ? 'admin_cliente' : 'leitura') }),
  );
  renderAwsSection(account, canWrite);
  return { onboarding, webLogs };
}

const available = async () => screen.findByRole('region', { name: /^Disponíveis para coletar/ });
const box = (name: string) =>
  screen.getByRole('checkbox', {
    name: (text) => text.startsWith('Balanceador (log de acesso)') && text.includes(`· ${name}`),
  });
const row = (name: string) => {
  const item = box(name).closest('li');
  if (item === null) throw new Error('sem a linha');
  return within(item);
};
const bodyOf = (onboarding: OnboardingApi): AwsSourcesAuthorize =>
  awsSourcesAuthorizeSchema.parse(onboarding.calls.find((call) => call.route === 'authorize')?.body);

describe('balanceadores: a estimativa antes de autorizar', () => {
  it('nunca pedida: a caixa fica desligada, o pedido sai, a tela acompanha até a resposta e aí dá para marcar', async () => {
    const user = userOf();
    const source = albFixture('loja-alb');
    const { webLogs } = open({ sources: [source], web: [webSourceFixture(source)] });
    await available();
    await screen.findByRole('button', { name: 'Estimar o volume: loja-alb' });
    expect(box('loja-alb')).toBeDisabled();
    expect(box('loja-alb')).toHaveAccessibleDescription('Para marcar, falta a estimativa de volume, abaixo.');
    expect(row('loja-alb').getByRole('status')).toHaveTextContent(
      'lê só os nomes e os tamanhos dos arquivos',
    );

    await user.click(screen.getByRole('button', { name: 'Estimar o volume: loja-alb' }));
    expect(await row('loja-alb').findByText(/aguardando o servidor do Verax/)).toBeInTheDocument();
    expect(webLogs.writes()).toEqual([
      { method: 'POST', path: `sources/${source.id}/estimate`, body: undefined },
    ]);
    // Com o pedido em andamento, não há como pedir outro.
    expect(row('loja-alb').queryByRole('button', { name: /Estimar/ })).not.toBeInTheDocument();
    expect(box('loja-alb')).toBeDisabled();

    // Enquanto o worker não responde, a tela relê sozinha, a cada poucos segundos.
    const polls = () => webLogs.calls.filter((call) => call.path === `sources/${source.id}`).length;
    await waitFor(() => expect(polls()).toBeGreaterThan(0));
    const before = polls();
    for (let turn = 1; turn <= 3; turn += 1) {
      await act(() => vi.advanceTimersByTimeAsync(ESTIMATE_POLL_MS));
      await waitFor(() => expect(polls()).toBe(before + turn));
    }
    // O worker responde: a releitura mostra o resultado.
    webLogs.state.sources = [webSourceFixture(source, { estimate: ready(14) })];
    await act(() => vi.advanceTimersByTimeAsync(ESTIMATE_POLL_MS + 100));
    expect(
      await row('loja-alb').findByText(
        /Estimativa: cerca de 0,3 GB por dia \(14% do volume do mês do plano\)/,
      ),
    ).toBeInTheDocument();
    expect(box('loja-alb')).toBeEnabled();
    // E para de reler: quem perguntava era o pedido.
    const reads = webLogs.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(5 * ESTIMATE_POLL_MS));
    expect(webLogs.calls.length).toBe(reads);
    // Pedir outra só 5 minutos depois.
    expect(screen.getByRole('button', { name: /^Estimar de novo em \d min: loja-alb$/ })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(screen.getByRole('button', { name: 'Estimar de novo: loja-alb' })).toBeEnabled();
  });

  it('demorando: avisa, relê mais devagar e continua mostrando a anterior, que ainda vale para marcar', async () => {
    const source = albFixture('loja-alb');
    const estimate = { ...pendingOf(ready(14)), requestedAt: iso(-ESTIMATE_SLOW_AFTER_MS + 1_000) };
    const { webLogs } = open({ sources: [source], web: [webSourceFixture(source, { estimate })] });
    await available();
    expect(await row('loja-alb').findByText(/Costuma levar menos de um minuto/)).toBeInTheDocument();
    expect(row('loja-alb').getByText(/Enquanto isso, a anterior/)).toBeInTheDocument();
    expect(box('loja-alb')).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(await row('loja-alb').findByText(/Está demorando mais do que o normal/)).toBeInTheDocument();
    const reads = webLogs.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(webLogs.calls.length - reads).toBeLessThanOrEqual(1);
  });

  it('cada resultado com o texto dele, e só o que vale pode ser marcado', async () => {
    const names = ['vencida', 'falhou', 'sem-amostra', 'cortada', 'pesada'] as const;
    const sources = Object.fromEntries(names.map((name) => [name, albFixture(name)])) as Record<
      (typeof names)[number],
      AwsSource
    >;
    open({
      sources: Object.values(sources),
      web: [
        webSourceFixture(sources.vencida, {
          estimate: ready(14, { computedAt: iso(-WEB_ESTIMATE_MAX_AGE_MS - HOUR), projection: null }),
        }),
        webSourceFixture(sources.falhou, {
          estimate: estimateFixture({
            status: 'failed',
            errorCode: 'bucket_denied',
            day: null,
            objects: null,
            projection: null,
          }),
        }),
        webSourceFixture(sources['sem-amostra'], {
          estimate: estimateFixture({
            status: 'no_sample',
            objects: 0,
            projection: {
              gbPerDay: null,
              percent: null,
              basis: 'monthly',
              acknowledgementRequired: true,
              validUntil: iso(HOUR),
            },
          }),
        }),
        webSourceFixture(sources.cortada, {
          estimate: ready(14, {
            truncated: true,
            projection: {
              gbPerDay: 0.3,
              percent: 14,
              basis: 'franchise',
              acknowledgementRequired: true,
              validUntil: iso(HOUR),
            },
          }),
        }),
        webSourceFixture(sources.pesada, { estimate: ready(46.6) }),
      ],
    });
    await available();
    await waitFor(() => expect(box('pesada')).toBeEnabled());
    expect(row('vencida').getByRole('status')).toHaveTextContent('foi feita há 7 dias e não vale mais');
    expect(row('falhou').getByRole('status')).toHaveTextContent(
      'o bucket não deixa o Verax listar nem ler os arquivos. Corrija a permissão',
    );
    expect(row('sem-amostra').getByRole('status')).toHaveTextContent(
      'Sem amostra: não deu para medir o volume.',
    );
    expect(row('cortada').getByRole('status')).toHaveTextContent(
      'pelo menos 0,3 GB por dia (14% da franquia por dia do plano)',
    );
    expect(row('cortada').getByRole('status')).toHaveTextContent('o volume é um mínimo');
    expect(row('pesada').getByRole('status')).toHaveTextContent('Passa de 20% do plano');
    for (const name of ['vencida', 'falhou']) expect(box(name), name).toBeDisabled();
    for (const name of ['sem-amostra', 'cortada', 'pesada']) expect(box(name), name).toBeEnabled();
  });

  it('o pedido recusado pela pressa diz quanto esperar, e o botão continua valendo', async () => {
    const user = userOf();
    const source = albFixture('loja-alb');
    const { webLogs } = open({ sources: [source], web: [webSourceFixture(source)] });
    webLogs.on('POST', () => refusal(429, 'WEB_ESTIMATE_RATE_LIMITED'));
    await available();
    await user.click(await screen.findByRole('button', { name: 'Estimar o volume: loja-alb' }));
    expect(await row('loja-alb').findByRole('alert')).toHaveTextContent(
      'Só é possível pedir outra 5 minutos depois',
    );
  });

  it('quem só lê vê a situação, sem caixa, sem botão e sem a parte do plano', async () => {
    const [fresh, done] = [albFixture('nova'), albFixture('feita')];
    open({
      sources: [fresh, done],
      web: [webSourceFixture(fresh), webSourceFixture(done, { estimate: ready(46.6, { projection: null }) })],
      canWrite: false,
    });
    const region = await available();
    expect(
      await within(region).findByText('Quem administra as contas pede a estimativa.'),
    ).toBeInTheDocument();
    expect(within(region).getByText(/aparecem para quem administra o cliente/)).toBeInTheDocument();
    expect(region).not.toHaveTextContent('%');
    expect(within(region).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(region).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('balanceadores: num nó em que eles não existem', () => {
  it.each([
    ['desligados (404 com o código)', 'WEB_LOGS_DISABLED'],
    ['de antes deles (404 sem código)', null],
  ])('%s: sem caixa, sem estimativa, sem erro e sem a seção', async (_name, code) => {
    const account = awsAccountFixture({ connection: 'connected', ingestFrom: '2026-11-01' });
    const onboarding = onboardingApi(
      account,
      onboardingFixture(account.id, 'awaiting_sources', {
        sources: [
          albFixture('loja-alb'),
          authorizedAlbFixture('api-alb'),
          sourceFixture('cloudtrail', { name: 'trilha' }),
        ],
      }),
    );
    server.use(
      webLogsDisabled(code),
      ...onboarding.handlers,
      ...createHandlers({ me: demoMe('admin_cliente') }),
    );
    renderAwsSection(account);
    const region = await available();
    await waitFor(() =>
      expect(within(region).queryByText(/Carregando a estimativa/)).not.toBeInTheDocument(),
    );
    expect(within(region).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(region).queryByText(/[Ee]stimativa/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Ataques web' })).not.toBeInTheDocument();
  });

  it('o nó que não os coleta: nenhum pedido sai', async () => {
    const { webLogs } = open({
      sources: [
        sourceFixture('elb_logs', { name: 'loja-alb', notes: ['not_collected_yet'] }),
        sourceFixture('cloudtrail', { name: 'trilha' }),
      ],
    });
    await available();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(webLogs.calls).toEqual([]);
  });

  it('a falha de leitura que não é 404 aparece, com a saída, sem derrubar o resto da lista', async () => {
    const user = userOf();
    const source = albFixture('loja-alb');
    const { webLogs } = open({
      sources: [source, sourceFixture('cloudtrail', { name: 'trilha' })],
      web: [webSourceFixture(source, { estimate: ready(14) })],
    });
    let broken = true;
    webLogs.on('GET sources?', () => (broken ? refusal(400) : undefined));
    const region = await available();
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'A estimativa de volume dos balanceadores não pôde ser lida.',
    );
    expect(screen.getByRole('checkbox', { name: /trilha/ })).toBeEnabled();
    broken = false;
    await user.click(within(region).getByRole('button', { name: 'Ler de novo' }));
    await waitFor(() => expect(box('loja-alb')).toBeEnabled());
  });
});

describe('balanceadores: o pedido de autorização', () => {
  const start = async (estimates: Record<string, WebLogSource['estimate']>, others: AwsSource[] = []) => {
    const sources = Object.keys(estimates).map((name) => albFixture(name));
    const web = sources.map((source) =>
      webSourceFixture(source, { estimate: estimates[source.name] ?? null }),
    );
    const setup = open({ sources: [...sources, ...others], web });
    await available();
    for (const source of sources) await waitFor(() => expect(box(source.name)).toBeEnabled());
    return { ...setup, sources, web };
  };
  const confirmation = () => screen.getByRole('group', { name: /^Confirmar a autorização/ });
  const confirmButton = () => within(confirmation()).getByRole('button', { name: 'Confirmar autorização' });

  it('abaixo de 20%: sem clique a mais, e o pedido leva os números vistos', async () => {
    const user = userOf();
    const { onboarding, webLogs, sources, web } = await start({ 'loja-alb': ready(14) });
    await user.click(box('loja-alb'));
    await user.click(screen.getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    expect(confirmation()).toHaveTextContent('cerca de 0,3 GB por dia (14% do volume do mês do plano)');
    expect(confirmation()).toHaveTextContent('analisa todas as linhas do log e não guarda nenhuma');
    expect(confirmation()).toHaveTextContent('Os endereços IP de quem visita a sua aplicação são tratados');
    expect(confirmation()).toHaveTextContent('começa só observando, por 72 horas');
    // O aviso genérico de volume é das outras fontes.
    expect(confirmation()).not.toHaveTextContent('VPC Flow Logs e grupos do CloudWatch Logs');
    expect(within(confirmation()).queryByRole('checkbox')).not.toBeInTheDocument();
    const reads = webLogs.calls.filter((call) => call.path.startsWith('sources?')).length;
    await user.click(confirmButton());
    await waitFor(() => expect(onboarding.calls).toHaveLength(1));
    const id = sources[0]?.id;
    expect(bodyOf(onboarding)).toEqual({
      sourceIds: [id],
      webLogs: [
        {
          sourceId: id,
          estimatedAt: web[0]?.estimate?.computedAt,
          estimatedGbPerDay: 0.3,
          projectedPercent: 14,
          acknowledged: false,
        },
      ],
    });
    // A autorização criou a configuração: a lista é relida.
    await waitFor(() =>
      expect(webLogs.calls.filter((call) => call.path.startsWith('sources?')).length).toBeGreaterThan(reads),
    );
  });

  it('acima de 20%: só com cada confirmação, uma por balanceador; desmarcar a fonte a desfaz', async () => {
    const user = userOf();
    const { onboarding } = await start({ pesado: ready(46.6), leve: ready(14) });
    await user.click(box('pesado'));
    await user.click(box('leve'));
    await user.click(screen.getByRole('button', { name: 'Autorizar selecionadas (2)' }));
    const acknowledgement = () =>
      within(confirmation()).getByRole('checkbox', {
        name: /^Entendi: o pesado deve consumir cerca de 0,3 GB por dia \(46,6%/,
      });
    expect(within(confirmation()).getAllByRole('checkbox')).toHaveLength(1);
    expect(confirmButton()).toBeDisabled();
    await user.click(acknowledgement());
    expect(confirmButton()).toBeEnabled();
    // Outra escolha pede outra confirmação.
    await user.click(box('leve'));
    expect(acknowledgement()).not.toBeChecked();
    expect(confirmButton()).toBeDisabled();
    await user.click(acknowledgement());
    await user.click(confirmButton());
    await waitFor(() => expect(onboarding.calls).toHaveLength(1));
    expect(bodyOf(onboarding).webLogs).toHaveLength(1);
    expect(bodyOf(onboarding).webLogs?.[0]).toMatchObject({ projectedPercent: 46.6, acknowledged: true });
  });

  it('sem balanceador no pedido, o campo não vai: o nó de antes o recusaria', async () => {
    const user = userOf();
    const { onboarding } = await start({ 'loja-alb': ready(14) }, [
      sourceFixture('cloudtrail', { name: 'trilha' }),
    ]);
    await user.click(screen.getByRole('checkbox', { name: /trilha/ }));
    await user.click(screen.getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    await user.click(confirmButton());
    await waitFor(() => expect(onboarding.calls).toHaveLength(1));
    expect(Object.keys(bodyOf(onboarding))).toEqual(['sourceIds']);
  });

  it('a estimativa mudou no meio: a recusa é explicada, os números são relidos e a confirmação volta desmarcada', async () => {
    const user = userOf();
    const { onboarding, webLogs, sources } = await start({ 'loja-alb': ready(46.6) });
    const [source] = sources;
    if (source === undefined) throw new Error('sem a fonte');
    onboarding.on('authorize', () => refusal(409, 'WEB_LOGS_ESTIMATE_CHANGED'));
    await user.click(box('loja-alb'));
    await user.click(screen.getByRole('button', { name: 'Autorizar selecionadas (1)' }));
    await user.click(within(confirmation()).getByRole('checkbox', { name: /46,6%/ }));
    webLogs.state.sources = [
      webSourceFixture(source, { estimate: ready(81.5, { computedAt: iso(-60_000) }) }),
    ];
    await user.click(confirmButton());
    expect(await within(confirmation()).findByRole('alert')).toHaveTextContent(
      'A estimativa de volume de um dos balanceadores mudou.',
    );
    const again = await within(confirmation()).findByRole('checkbox', { name: /81,5%/ });
    expect(again).not.toBeChecked();
    expect(confirmButton()).toBeDisabled();
  });

  it('a estimativa que vence com a tela aberta sai da escolha', async () => {
    const user = userOf();
    await start({ 'loja-alb': ready(14, { computedAt: iso(-WEB_ESTIMATE_MAX_AGE_MS + 60_000) }) });
    await user.click(box('loja-alb'));
    expect(screen.getByRole('button', { name: 'Autorizar selecionadas (1)' })).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(2 * 60_000));
    await waitFor(() => expect(box('loja-alb')).toBeDisabled());
    expect(box('loja-alb')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Autorizar selecionadas' })).toBeDisabled();
  });

  it('o teto de balanceadores da conta é dito antes de pedir', async () => {
    const user = userOf();
    // Uma a mais do que o teto de hoje: o que já está autorizado não impede o resto.
    const authorized = Array.from({ length: AWS_MAX_AUTHORIZED_WEB_SOURCES + 1 }, (_, index) =>
      authorizedAlbFixture(`cheio-${index}`),
    );
    await start({ 'loja-alb': ready(14) }, [...authorized, sourceFixture('cloudtrail', { name: 'trilha' })]);
    await user.click(box('loja-alb'));
    expect(screen.getByText(/pode ter até 20 balanceadores autorizados/)).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Autorizar selecionadas (1)' })).toBeDisabled();
    // As outras fontes continuam podendo ser autorizadas.
    await user.click(box('loja-alb'));
    await user.click(screen.getByRole('checkbox', { name: /trilha/ }));
    expect(screen.queryByText(/pode ter até 20 balanceadores autorizados/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Autorizar selecionadas (1)' })).toBeEnabled();
  });
});

describe('balanceadores: os que não dá para ler', () => {
  it('sem log: os passos do cliente, com a região, a política e os comandos prontos; nome de bucket errado não vira comando', async () => {
    const user = userOf();
    open({
      sources: [
        albFixture('site-alb', {
          availability: 'no_destination',
          state: 'unavailable',
          loggingState: 'disabled',
          notes: ['aws_cost_alb_logs'],
          permission: 'unknown',
        }),
      ],
    });
    const region = await screen.findByRole('region', { name: /^Não habilitadas na AWS \(1\)/ });
    expect(region).toHaveTextContent('O log de acesso está desligado.');
    expect(region).toHaveTextContent('tem custo na AWS, pelo volume gravado no S3');
    await user.click(within(region).getByText('Como ligar o log de acesso do site-alb'));
    expect(region).toHaveTextContent('na região sa-east-1');
    expect(region).toHaveTextContent('SSE-S3');
    expect(region).toHaveTextContent('sem prefixo');
    expect(region).toHaveTextContent('recomendamos ao menos 180 dias');
    expect(region).toHaveTextContent('logdelivery.elasticloadbalancing.amazonaws.com');
    expect(region).toHaveTextContent('/AWSLogs/111111111111/*');
    const enable = /Key=access_logs\.s3\.enabled,Value=true/;
    expect(within(region).getByText(enable)).toBeInTheDocument();
    const field = within(region).getByLabelText('Nome do bucket do log');
    await user.clear(field);
    await user.type(field, 'Bucket Errado');
    expect(within(region).queryByText(enable)).not.toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(/Use só letras minúsculas/);
    await user.clear(field);
    await user.type(field, 'meus-logs');
    expect(within(region).getByText(enable)).toHaveTextContent("Value='meus-logs'");
  });

  it('NLB e GWLB: cada um com o motivo dele', async () => {
    const other = (type: string, name: string) =>
      albFixture(name, {
        availability: 'unsupported_format',
        state: 'unavailable',
        permission: 'unknown',
        notes: [],
        details: {
          arn: `arn:aws:elasticloadbalancing:sa-east-1:111111111111:loadbalancer/${type}/${name}/50dc6c495c0c9188`,
        },
      });
    open({ sources: [other('net', 'rede'), other('gwy', 'porta')] });
    const region = await screen.findByRole('region', {
      name: /^Em destino ou formato que o Verax não lê \(2\)/,
    });
    expect(region).toHaveTextContent('Não é um balanceador de aplicação (ALB)');
    expect(region).toHaveTextContent('só existe nas conexões TLS e não traz a URL');
    expect(region).toHaveTextContent('É um GWLB');
    expect(region).not.toHaveTextContent('Parquet');
  });

  it('prefixo no bucket: tirar o prefixo, e não os buckets de outras fontes; bucket de outra conta: a política dele', async () => {
    const denied = { permission: 'missing', state: 'needs_permission' } as const;
    open({
      sources: [
        albFixture('legado', {
          ...denied,
          permissionDetail: 'outside_awslogs_prefix',
          notes: ['high_volume', 'additional_bucket_required'],
          details: { customPrefix: 'balanceadores' },
        }),
        albFixture('parceiros', { ...denied, permissionDetail: 'bucket_denied' }),
      ],
    });
    const region = await screen.findByRole('region', { name: /^Precisam de permissão adicional \(2\)/ });
    const [prefixed, other] = within(region)
      .getAllByRole('listitem')
      .filter((item) => item.textContent?.includes('Balanceador'));
    expect(prefixed).toHaveTextContent('Tire o prefixo na configuração do log de acesso');
    expect(prefixed).toHaveTextContent('Key=access_logs.s3.prefix,Value=');
    expect(prefixed).not.toHaveTextContent('buckets fora do padrão');
    expect(other).toHaveTextContent(
      'a política do bucket precisa citar arn:aws:iam::111111111111:role/verax/verax-control-reader',
    );
  });
});

describe('balanceadores autorizados', () => {
  it('a linha da tabela leva para a configuração dele', async () => {
    const source = authorizedAlbFixture('api-alb', 'collecting', { stateCode: 'web_quarantined' });
    open({ sources: [source], web: [webSourceFixture(source, { settings: settingsFixture() })] });
    const link = await screen.findByRole('link', { name: 'Ver em Ataques web: api-alb' });
    expect(link).toHaveAttribute('href', `#ataques-web-${source.id}`);
    const monitor = screen.getByRole('region', { name: 'Fontes autorizadas' });
    expect(monitor).toHaveTextContent('Coletando, com arquivos recusados');
  });

  it('a resposta fora do contrato não derruba a tela das fontes', async () => {
    const source = albFixture('loja-alb');
    const { webLogs } = open({ sources: [source], web: [webSourceFixture(source)] });
    webLogs.on('GET sources?', () => HttpResponse.json({ items: [{ ip: '203.0.113.7' }], total: 1 }));
    const region = await available();
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'O servidor respondeu algo inesperado',
    );
  });
});
