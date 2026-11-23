import { describe, expect, it } from 'vitest';
import { parseWazuhProgress, type WazuhProgress } from './wazuh-progress.js';
import {
  deriveSourceHealth,
  type SourceHealthContext,
  stallQuestion,
  WAZUH_STALL_AFTER_MS,
  type WazuhNodeState,
} from './wazuh-source-health.js';
import {
  planWazuhSources,
  type PlannedWazuhSource,
  type WazuhAccountRow,
  type WazuhSourceRow,
} from './wazuh-sources.js';

/** Conta fictícia da documentação da AWS. */
const ACCOUNT = '111122223333';
const TENANT = '00000000-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-11-23T12:00:00.000Z');
const AT = '2026-11-23T11:59:00Z';
const COLLECT_FROM = new Date('2026-11-20T00:00:00.000Z');
const FLOW_LOG = 'fl-0123456789abcdef0';

const trailKey = (stamp: string, region = 'sa-east-1'): string =>
  `AWSLogs/${ACCOUNT}/CloudTrail/${region}/${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp.slice(6, 8)}/` +
  `${ACCOUNT}_CloudTrail_${region}_${stamp}_a.json.gz`;

function row(overrides: Partial<WazuhSourceRow> = {}): WazuhSourceRow {
  return {
    id: '00000000-0000-7000-8000-000000000010',
    tenantId: TENANT,
    cloudAccountId: '00000000-0000-7000-8000-000000000001',
    kind: 'cloudtrail',
    region: 'sa-east-1',
    resourceId: 'trilha',
    name: 'trilha',
    details: { bucket: 'trilha-da-conta' },
    method: 's3',
    origin: 'discovered',
    authorizedAt: new Date('2026-11-20T15:00:00.000Z'),
    collectFrom: COLLECT_FROM,
    state: 'authorized',
    stateCode: 'awaiting_collector',
    stateSince: new Date('2026-11-20T15:00:00.000Z'),
    lastSyncAt: null,
    lastEventAt: null,
    lastIngestedAt: null,
    lagSeconds: null,
    ...overrides,
  };
}

const KINDS: Record<string, Partial<WazuhSourceRow>> = {
  cloudtrail: {},
  vpc_flow_logs: {
    kind: 'vpc_flow_logs',
    resourceId: FLOW_LOG,
    details: { bucket: 'fluxo-da-conta', flowLogId: FLOW_LOG },
  },
  waf: {
    kind: 'waf',
    details: { bucket: 'aws-waf-logs-painel', webAclName: 'painel', webAclScope: 'REGIONAL' },
  },
  cloudwatch_log_group: {
    kind: 'cloudwatch_log_group',
    method: 'cloudwatch',
    resourceId: '/aws/lambda/cobranca',
    details: { logGroup: '/aws/lambda/cobranca' },
  },
  legacy: {
    origin: 'legacy',
    region: 'global',
    resourceId: 'legacy',
    details: { bucket: 'trilha-da-conta', legacySource: 'cloudtrail' },
    collectFrom: new Date('2026-11-01T00:00:00.000Z'),
  },
};

/** A fonte como a lista a planeja (o marcador e a pasta dos objetos saem do planejador de verdade). */
function planned(
  overrides: Partial<WazuhSourceRow> = {},
  kind: keyof typeof KINDS = 'cloudtrail',
): PlannedWazuhSource {
  const account: WazuhAccountRow = {
    id: '00000000-0000-7000-8000-000000000001',
    tenantId: TENANT,
    accountId: ACCOUNT,
    regions: ['us-east-1', 'sa-east-1'],
    ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
    cloudtrailBucket: null,
    guarddutyBucket: null,
    wafBucket: null,
    collectionError: null,
    // O planejador decide pela linha autorizada; o estado de agora é posto depois.
    awsSources: [row({ ...KINDS[kind], ...overrides })],
    awsDiscoveryRuns: [],
  };
  const [source] = planWazuhSources([account]).sources;
  if (source === undefined) throw new Error('a fonte de exemplo não entrou no plano');
  return source;
}

interface S3Entry {
  table?: string;
  bucketPath?: string;
  region?: string | null;
  flowLogId?: string | null;
  lastKey?: string;
  processedAt?: string;
}

function progress(
  parts: { s3?: S3Entry[]; groups?: { endTime: number | null }[]; status?: string; truncated?: boolean } = {},
): WazuhProgress {
  const section = { status: parts.status ?? 'ok', truncated: parts.truncated ?? false };
  const parsed = parseWazuhProgress({
    version: 1,
    at: AT,
    s3: {
      ...section,
      entries: (parts.s3 ?? []).map((entry) => ({
        table: 'cloudtrail',
        bucketPath: 'trilha-da-conta/',
        accountId: ACCOUNT,
        region: 'sa-east-1',
        flowLogId: null,
        lastKey: trailKey('20261123T1150Z'),
        processedAt: '2026-11-23T11:55:00Z',
        createdDate: 20261123,
        keys: 5,
        ...entry,
      })),
    },
    cloudwatch: {
      ...section,
      entries: (parts.groups ?? []).map((entry) => ({
        region: 'sa-east-1',
        logGroup: '/aws/lambda/cobranca',
        streams: 1,
        ...entry,
      })),
    },
  });
  if (parsed === null) throw new Error('o sinal de exemplo não passou no schema');
  return parsed;
}

const context = (node: WazuhNodeState, signal: WazuhProgress | null = progress()): SourceHealthContext => ({
  now: NOW,
  node,
  progress: signal,
});

const EMPTY = { lastSyncAt: null, lastEventAt: null, lastIngestedAt: null, lagSeconds: null };

describe('saúde das fontes lidas pelo Wazuh (onboarding self-service da AWS)', () => {
  describe('o estado, pela lista, pelo que o host aplicou e pelo marcador', () => {
    const READ = [{}];
    const cases: {
      name: string;
      from: [string, string | null];
      node: WazuhNodeState;
      signal?: WazuhProgress | null;
      expected: [string, string | null];
    }[] = [
      // Da autorização à coleta.
      {
        name: 'autorizada, a lista de agora ainda não aplicada',
        from: ['authorized', 'awaiting_collector'],
        node: 'pending',
        expected: ['configuring', 'awaiting_apply'],
      },
      {
        name: 'segue configurando enquanto o host não aplica',
        from: ['configuring', 'awaiting_apply'],
        node: 'pending',
        expected: ['configuring', 'awaiting_apply'],
      },
      {
        name: 'aplicada, sem nada lido: aguardando eventos',
        from: ['configuring', 'awaiting_apply'],
        node: 'ok',
        expected: ['waiting_events', null],
      },
      {
        name: 'aplicada direto da autorização (a lista não mudou de hash)',
        from: ['authorized', 'awaiting_collector'],
        node: 'ok',
        expected: ['waiting_events', null],
      },
      {
        name: 'aplicada, com objeto lido: coletando',
        from: ['configuring', 'awaiting_apply'],
        node: 'ok',
        signal: progress({ s3: READ }),
        expected: ['collecting', null],
      },
      {
        name: 'aguardava, e o módulo leu',
        from: ['waiting_events', null],
        node: 'ok',
        signal: progress({ s3: READ }),
        expected: ['collecting', null],
      },
      {
        name: 'coletando continua coletando',
        from: ['collecting', null],
        node: 'ok',
        signal: progress({ s3: READ }),
        expected: ['collecting', null],
      },
      // O manager já lia a fonte: uma lista nova pendente ou que falhou não a tira do que o marcador diz.
      {
        name: 'coletando, outra fonte muda a lista',
        from: ['collecting', null],
        node: 'pending',
        signal: progress({ s3: READ }),
        expected: ['collecting', null],
      },
      {
        name: 'coletando, a lista nova não subiu (o manager segue com a anterior)',
        from: ['collecting', null],
        node: 'wazuh_apply_failed',
        signal: progress({ s3: READ }),
        expected: ['collecting', null],
      },
      {
        name: 'aguardava, a lista nova não subiu',
        from: ['waiting_events', null],
        node: 'wazuh_apply_failed',
        expected: ['waiting_events', null],
      },
      // Os avisos do nó.
      {
        name: 'ainda não aplicada, e a aplicação falhou',
        from: ['authorized', 'awaiting_collector'],
        node: 'wazuh_apply_failed',
        expected: ['ingestion_error', 'wazuh_apply_failed'],
      },
      {
        name: 'configurando, e a aplicação falhou',
        from: ['configuring', 'awaiting_apply'],
        node: 'wazuh_apply_failed',
        expected: ['ingestion_error', 'wazuh_apply_failed'],
      },
      {
        name: 'o token do nó parou: nada é lido, de fonte nenhuma',
        from: ['collecting', null],
        node: 'aws_token_stale',
        signal: progress({ s3: READ }),
        expected: ['ingestion_error', 'aws_token_stale'],
      },
      {
        name: 'o token parou antes de a fonte ser aplicada',
        from: ['authorized', 'awaiting_collector'],
        node: 'aws_token_stale',
        expected: ['ingestion_error', 'aws_token_stale'],
      },
      // A saída dos erros.
      {
        name: 'a aplicação que falhava passou',
        from: ['ingestion_error', 'wazuh_apply_failed'],
        node: 'ok',
        expected: ['waiting_events', null],
      },
      {
        name: 'o token voltou, e o marcador está lá',
        from: ['ingestion_error', 'aws_token_stale'],
        node: 'ok',
        signal: progress({ s3: READ }),
        expected: ['collecting', null],
      },
      {
        name: 'o token voltou com a lista ainda por aplicar',
        from: ['ingestion_error', 'aws_token_stale'],
        node: 'pending',
        expected: ['configuring', 'awaiting_apply'],
      },
      {
        name: 'a fonte que estava fora da lista entrou',
        from: ['ingestion_error', 'unsupported_name'],
        node: 'pending',
        expected: ['configuring', 'awaiting_apply'],
      },
      // Sem saber o que o módulo leu, nada muda por falta de informação.
      {
        name: 'sem o sinal progress: a que coletava fica',
        from: ['collecting', null],
        node: 'ok',
        signal: null,
        expected: ['collecting', null],
      },
      {
        name: 'sem o sinal progress: a que aguardava fica',
        from: ['waiting_events', null],
        node: 'ok',
        signal: null,
        expected: ['waiting_events', null],
      },
      {
        name: 'sem o sinal progress: a recém-aplicada espera os eventos',
        from: ['configuring', 'awaiting_apply'],
        node: 'ok',
        signal: null,
        expected: ['waiting_events', null],
      },
      {
        name: 'o banco travado pelo módulo: a que coletava fica',
        from: ['collecting', null],
        node: 'ok',
        signal: progress({ status: 'locked' }),
        expected: ['collecting', null],
      },
      {
        name: 'o banco com erro: a parada fica parada',
        from: ['stalled', 'no_progress'],
        node: 'ok',
        signal: progress({ status: 'error' }),
        expected: ['stalled', 'no_progress'],
      },
      {
        name: 'a parte cortada sem a fonte: fica',
        from: ['collecting', null],
        node: 'ok',
        signal: progress({ truncated: true }),
        expected: ['collecting', null],
      },
      {
        name: 'o banco ainda não existe: nada lido',
        from: ['configuring', 'awaiting_apply'],
        node: 'ok',
        signal: progress({ status: 'missing' }),
        expected: ['waiting_events', null],
      },
    ];
    it.each(cases)('$name', ({ from, node, signal, expected }) => {
      const source = planned({ state: from[0], stateCode: from[1] });
      const next = deriveSourceHealth(source, context(node, signal === undefined ? progress() : signal));
      expect([next.state, next.stateCode]).toEqual(expected);
    });
  });

  it('a fonte de fora da lista: erro de ingestão com o motivo, em qualquer estado do nó', () => {
    const source = planned({ details: { bucket: 'trilha-da-conta', organizationTrail: true } });
    expect(source.outcome).toEqual({ included: false, code: 'organization_id_unknown' });
    for (const node of ['ok', 'pending', 'wazuh_apply_failed', 'aws_token_stale'] as const) {
      expect(deriveSourceHealth(source, context(node))).toEqual({
        state: 'ingestion_error',
        stateCode: 'organization_id_unknown',
        ...EMPTY,
      });
    }
  });

  it('coletando: a leitura, o evento mais recente e o atraso entre os dois', () => {
    const source = planned({ state: 'waiting_events', stateCode: null });
    const next = deriveSourceHealth(source, context('ok', progress({ s3: [{}] })));
    expect(next).toEqual({
      state: 'collecting',
      stateCode: null,
      lastSyncAt: new Date(AT),
      lastIngestedAt: new Date('2026-11-23T11:55:00Z'),
      // O horário do nome do objeto.
      lastEventAt: new Date('2026-11-23T11:50:00Z'),
      lagSeconds: 300,
    });
  });

  it('o atraso é o da entrada do último objeto, e não o tempo sem novidade: a conta quieta não fica atrasada', () => {
    const source = planned({ state: 'collecting', stateCode: null });
    const quiet = progress({
      s3: [{ lastKey: trailKey('20261122T0900Z'), processedAt: '2026-11-22T09:04:00Z' }],
    });
    const next = deriveSourceHealth(source, context('ok', quiet));
    expect(next.state).toBe('collecting');
    // Nada chega há mais de um dia, e o último objeto entrou 4 min depois de gravado.
    expect(next.lagSeconds).toBe(240);
    expect(next.lastSyncAt).toEqual(new Date(AT));
  });

  it('o marcador de antes do início da coleta não conta (a fonte autorizada de novo espera objeto novo)', () => {
    const source = planned({
      state: 'configuring',
      stateCode: 'awaiting_apply',
      collectFrom: new Date('2026-11-23T00:00:00.000Z'),
      lastIngestedAt: new Date('2026-10-01T10:00:00Z'),
      lastEventAt: new Date('2026-10-01T09:55:00Z'),
      lagSeconds: 300,
    });
    const old = progress({
      s3: [{ lastKey: trailKey('20261122T2350Z'), processedAt: '2026-11-22T23:58:00Z' }],
    });
    expect(deriveSourceHealth(source, context('ok', old))).toEqual({
      state: 'waiting_events',
      stateCode: null,
      // A última confirmação é de agora; os horários da coleta anterior ficam como história.
      lastSyncAt: new Date(AT),
      lastIngestedAt: new Date('2026-10-01T10:00:00Z'),
      lastEventAt: new Date('2026-10-01T09:55:00Z'),
      lagSeconds: 300,
    });
    const fresh = progress({
      s3: [{ lastKey: trailKey('20261123T0005Z'), processedAt: '2026-11-23T00:09:00Z' }],
    });
    expect(deriveSourceHealth(source, context('ok', fresh))).toMatchObject({
      state: 'collecting',
      lagSeconds: 240,
    });
  });

  it('a linha do cadastro anterior: coletando pelo marcador que já existia, em qualquer região', () => {
    const source = planned({}, 'legacy');
    const signal = progress({
      s3: [
        {
          region: 'eu-west-1',
          lastKey: trailKey('20261123T1140Z', 'eu-west-1'),
          processedAt: '2026-11-23T11:45:00Z',
        },
        {
          region: 'us-east-1',
          lastKey: trailKey('20261123T1150Z', 'us-east-1'),
          processedAt: '2026-11-23T11:56:00Z',
        },
      ],
    });
    expect(deriveSourceHealth(source, context('ok', signal))).toMatchObject({
      state: 'collecting',
      lastIngestedAt: new Date('2026-11-23T11:56:00Z'),
      lastEventAt: new Date('2026-11-23T11:50:00Z'),
      lagSeconds: 360,
    });
  });

  it('o grupo do CloudWatch Logs: o evento mais recente, e a leitura no momento em que o nó viu o marcador andar', () => {
    const group = (overrides: Partial<WazuhSourceRow> = {}) =>
      planned({ state: 'waiting_events', stateCode: null, ...overrides }, 'cloudwatch_log_group');
    const endTime = Date.parse('2026-11-23T11:52:00Z');
    // O módulo olhou o grupo e ainda não leu evento: aguardando, com a confirmação de agora.
    expect(deriveSourceHealth(group(), context('ok', progress({ groups: [{ endTime: null }] })))).toEqual({
      state: 'waiting_events',
      stateCode: null,
      ...EMPTY,
      lastSyncAt: new Date(AT),
    });
    // O primeiro evento: lido "agora" (o módulo não guarda quando leu).
    const first = deriveSourceHealth(group(), context('ok', progress({ groups: [{ endTime }] })));
    expect(first).toEqual({
      state: 'collecting',
      stateCode: null,
      lastSyncAt: new Date(AT),
      lastEventAt: new Date(endTime),
      lastIngestedAt: new Date(AT),
      lagSeconds: 420,
    });
    // O marcador parado: a leitura e o atraso ficam os de quando ele andou.
    const seen = group({
      state: 'collecting',
      lastEventAt: new Date(endTime),
      lastIngestedAt: new Date('2026-11-23T11:54:00Z'),
      lagSeconds: 120,
    });
    expect(deriveSourceHealth(seen, context('ok', progress({ groups: [{ endTime }] })))).toMatchObject({
      state: 'collecting',
      lastIngestedAt: new Date('2026-11-23T11:54:00Z'),
      lagSeconds: 120,
    });
    // Um evento de antes do início da coleta (o marcador de outra autorização) não conta.
    const before = Date.parse('2026-11-19T23:00:00Z');
    expect(
      deriveSourceHealth(group(), context('ok', progress({ groups: [{ endTime: before }] }))),
    ).toMatchObject({
      state: 'waiting_events',
      lastEventAt: null,
    });
  });

  describe('fonte parada: só a contínua, sem leitura há mais de 2 h e com objeto novo na origem', () => {
    const old = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
    const reading = (processedAt: string, lastKey = trailKey('20261123T0850Z')) =>
      progress({ s3: [{ processedAt, lastKey }] });

    it('com o marcador parado há mais de 2 h, pergunta à origem pelas pastas de ontem e de hoje', () => {
      const source = planned({ state: 'collecting', stateCode: null });
      const question = stallQuestion(source, context('ok', reading(old(3))));
      expect(question).toEqual({
        tenantId: TENANT,
        cloudAccountId: '00000000-0000-7000-8000-000000000001',
        accountId: ACCOUNT,
        homeRegion: 'us-east-1',
        bucket: 'trilha-da-conta',
        prefixes: [
          `AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/2026/11/22/${ACCOUNT}_CloudTrail_sa-east-1_`,
          `AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/2026/11/23/${ACCOUNT}_CloudTrail_sa-east-1_`,
        ],
        afterKey: trailKey('20261123T0850Z'),
        olderThan: new Date('2026-11-23T11:30:00.000Z'),
      });
    });

    it('leu há menos de 2 h: não pergunta (e a fonte que estava parada volta)', () => {
      const source = planned({ state: 'stalled', stateCode: 'no_progress' });
      const signal = reading(new Date(NOW.getTime() - WAZUH_STALL_AFTER_MS + 60_000).toISOString());
      expect(stallQuestion(source, context('ok', signal))).toBeNull();
      expect(deriveSourceHealth(source, context('ok', signal), null)).toMatchObject({ state: 'collecting' });
    });

    it('com objeto novo não lido: parada; sem ele, a conta só está quieta', () => {
      const source = planned({ state: 'collecting', stateCode: null });
      const signal = reading(old(5));
      expect(deriveSourceHealth(source, context('ok', signal), true)).toMatchObject({
        state: 'stalled',
        stateCode: 'no_progress',
        lastIngestedAt: new Date(old(5)),
      });
      for (const stalled of [false, null]) {
        expect(deriveSourceHealth(source, context('ok', signal), stalled)).toMatchObject({
          state: 'collecting',
          stateCode: null,
        });
      }
    });

    it('aguardando eventos há mais de 2 h: pergunta desde o início da coleta, só pelos dias que ela cobre', () => {
      const waiting = { state: 'waiting_events', stateCode: null, stateSince: new Date(old(3)) };
      const source = planned({ ...waiting, collectFrom: new Date('2026-11-23T00:00:00.000Z') });
      const question = stallQuestion(source, context('ok'));
      expect(question?.prefixes).toEqual([
        `AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/2026/11/23/${ACCOUNT}_CloudTrail_sa-east-1_`,
      ]);
      expect(question?.afterKey).toBeNull();
      expect(deriveSourceHealth(source, context('ok'), true)).toMatchObject({
        state: 'stalled',
        stateCode: 'no_progress',
      });
      // Há pouco tempo esperando: nada a perguntar.
      const recent = planned({ ...waiting, stateSince: new Date(old(1)) });
      expect(stallQuestion(recent, context('ok'))).toBeNull();
      // Parada sem marcador: perguntada de novo sem esperar, para poder voltar.
      const halted = planned({ state: 'stalled', stateCode: 'no_progress', stateSince: new Date(old(0.1)) });
      expect(stallQuestion(halted, context('ok'))).not.toBeNull();
    });

    it('os flow logs perguntam só pelos objetos do flow log da fonte; o cadastro anterior, pela região do marcador', () => {
      const flow = planned({ state: 'collecting', stateCode: null }, 'vpc_flow_logs');
      const flowSignal = progress({
        s3: [{ table: 'vpcflow', bucketPath: 'fluxo-da-conta/', flowLogId: FLOW_LOG, processedAt: old(4) }],
      });
      expect(stallQuestion(flow, context('ok', flowSignal))?.prefixes[1]).toBe(
        `AWSLogs/${ACCOUNT}/vpcflowlogs/sa-east-1/2026/11/23/${ACCOUNT}_vpcflowlogs_sa-east-1_${FLOW_LOG}_`,
      );
      const legacy = planned({ state: 'collecting', stateCode: null }, 'legacy');
      const legacySignal = progress({ s3: [{ region: 'eu-west-1', processedAt: old(4) }] });
      expect(stallQuestion(legacy, context('ok', legacySignal))?.prefixes[0]).toBe(
        `AWSLogs/${ACCOUNT}/CloudTrail/eu-west-1/2026/11/22/${ACCOUNT}_CloudTrail_eu-west-1_`,
      );
      // Sem marcador, a linha do cadastro anterior (região `global`) pergunta pela região de partida da conta.
      const waiting = planned(
        { state: 'waiting_events', stateCode: null, stateSince: new Date(old(3)) },
        'legacy',
      );
      expect(stallQuestion(waiting, context('ok'))?.prefixes[0]).toContain(
        '/CloudTrail/us-east-1/2026/11/22/',
      );
    });

    it('nunca pergunta pelo que não é contínuo, pelo que não foi aplicado, nem sem saber do marcador', () => {
      const stale = progress({
        s3: [
          {
            table: 'waf',
            bucketPath: `aws-waf-logs-painel/AWSLogs/${ACCOUNT}/WAFLogs/sa-east-1/painel/`,
            region: null,
            processedAt: old(30),
          },
        ],
        groups: [{ endTime: Date.parse(old(30)) }],
      });
      const collecting = { state: 'collecting', stateCode: null };
      // O WAF e o grupo de logs quietos há mais de um dia: nada a conferir, e seguem coletando.
      for (const kind of ['waf', 'cloudwatch_log_group'] as const) {
        const source = planned({ ...collecting, collectFrom: new Date('2026-11-01T00:00:00.000Z') }, kind);
        expect(stallQuestion(source, context('ok', stale))).toBeNull();
        expect(deriveSourceHealth(source, context('ok', stale), true)).toMatchObject({ state: 'collecting' });
      }
      const trail = planned(collecting);
      const signal = reading(old(5));
      expect(stallQuestion(trail, context('aws_token_stale', signal))).toBeNull();
      expect(stallQuestion(planned(), context('pending', signal))).toBeNull();
      expect(stallQuestion(trail, context('ok', null))).toBeNull();
      expect(stallQuestion(trail, context('ok', progress({ status: 'locked' })))).toBeNull();
      expect(stallQuestion(trail, context('ok', reading(old(5))))).not.toBeNull();
    });
  });
});
