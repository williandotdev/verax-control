import type { S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { awsSourceSchema, WEB_SOURCE_STATE_CODES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { ACCOUNT, Harness, LB, objectKey, REGION, T0, times } from '../../../test/support/alb-lines.js';
import type { Sender } from '../../aws/discovery/clients.js';
import { commandName } from '../../aws/discovery/read-only.js';
import type { WebFindingDraft } from '../draft.js';
import { AlbBucket } from './alb-bucket.js';
import {
  type AlbTarget,
  albTargetOf,
  compactTime,
  folderOf,
  ownObject,
  slotOf,
  utcDays,
} from './alb-target.js';
import {
  MAX_ENGINE_STATE_BYTES,
  mergeSuppressed,
  readEngineState,
  SUPPRESSED_KEEP_MS,
  writeEngineState,
} from './engine-state.js';
import { Observation } from './observation.js';
import { RunBudget } from './run-budget.js';
import { AlbCallError, albFailureOf, isArchived, isGone } from './s3-errors.js';
import { webLogsStream } from './source-config.js';
import { evaluateEngine } from './source-reader.js';
import { spread } from './web-estimate-job.js';
import { webLagSeconds, type WebOutcome, webSourceChange, type WebSourceFacts } from './web-health.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date(T0);
const DETAILS = {
  arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/${LB}`,
  bucket: 'logs-do-alb',
  prefix: `AWSLogs/${ACCOUNT}/elasticloadbalancing/${REGION}/`,
};
const target = albTargetOf(ACCOUNT, REGION, DETAILS) as AlbTarget;
const fault = (name: string, extra: object = {}) =>
  Object.assign(new Error('mensagem da AWS'), { name, ...extra });

describe('onde ficam os arquivos de um balanceador', () => {
  it('a pasta do dia com o começo exato do nome, com e sem prefixo', () => {
    expect(folderOf(target, '2026-11-24')).toBe(
      `AWSLogs/${ACCOUNT}/elasticloadbalancing/${REGION}/2026/11/24/${ACCOUNT}_elasticloadbalancing_${REGION}_app.loja.0123456789abcdef_`,
    );
    const custom = albTargetOf(ACCOUNT, REGION, {
      ...DETAILS,
      customPrefix: 'logs/alb',
      prefix: `logs/alb/${DETAILS.prefix}`,
    }) as AlbTarget;
    expect(folderOf(custom, '2026-11-24').startsWith('logs/alb/AWSLogs/')).toBe(true);
    expect(ownObject(custom, objectKey(T0, { prefix: 'logs/alb' }), 1)?.index).toBe(slotOf(T0));
    expect(ownObject(custom, objectKey(T0), 1)).toBeNull();
    expect(ownObject(target, objectKey(T0, { prefix: 'logs/alb' }), 1)).toBeNull();
  });

  it.each([
    ['sem bucket', { bucket: undefined }],
    ['bucket inválido', { bucket: 'Com.Maiuscula' }],
    ['sem ARN', { arn: undefined }],
    ['ARN de NLB', { arn: DETAILS.arn.split('/app/').join('/net/') }],
    ['ARN com id torto', { arn: `${DETAILS.arn}zz` }],
    ['ARN com mais um pedaço', { arn: `${DETAILS.arn}/x` }],
    ['prefixo de outra conta', { prefix: DETAILS.prefix.split(ACCOUNT).join('222222222222') }],
    ['prefixo sem o do bucket', { customPrefix: 'logs' }],
    ['sem prefixo', { prefix: undefined }],
  ])('%s: não serve', (_, change) => {
    expect(albTargetOf(ACCOUNT, REGION, { ...DETAILS, ...change })).toBe('invalid_details');
  });

  it.each(['com espaço', 'com"aspas', 'acentuação', 'x'.repeat(450)])(
    'prefixo que nenhuma chave aceitaria: %s',
    (customPrefix) => {
      expect(
        albTargetOf(ACCOUNT, REGION, {
          ...DETAILS,
          customPrefix,
          prefix: `${customPrefix}/${DETAILS.prefix}`,
        }),
      ).toBe('web_prefix_unsupported');
    },
  );

  it('dias, horários e slots', () => {
    const midnight = Date.UTC(2026, 10, 25);
    expect(utcDays(midnight - 10 * MINUTE, midnight + 5 * MINUTE)).toEqual(['2026-11-24', '2026-11-25']);
    expect(utcDays(midnight, midnight)).toEqual(['2026-11-25']);
    expect(utcDays(midnight - 49 * HOUR, midnight - 1)).toEqual(['2026-11-22', '2026-11-23', '2026-11-24']);
    expect(utcDays(midnight + HOUR, midnight)).toEqual(['2026-11-25']);
    expect(compactTime(Date.UTC(2026, 0, 2, 3, 4, 59))).toBe('20260102T0304Z');
    // A lista começa no próprio horário: a chave é maior que o horário sozinho.
    expect(objectKey(T0) > `${folderOf(target, '2026-11-24')}${compactTime(T0)}`).toBe(true);
    expect(webLogsStream('loja')).toMatch(/^aws_web_[0-9a-f]{10}$/);
    expect(webLogsStream('loja')).not.toBe(webLogsStream('loja2'));
  });
});

describe('S3 de um balanceador', () => {
  function fakeSender(respond: (input: Record<string, unknown>, command: string) => unknown) {
    const commands: string[] = [];
    const send = (command: unknown): Promise<unknown> => {
      commands.push(commandName(command));
      return Promise.resolve(
        respond((command as { input: Record<string, unknown> }).input, commandName(command)),
      );
    };
    return { sender: { send } as unknown as Sender<S3Client>, commands };
  }

  it('só aceita da listagem o que é do balanceador, e conta o resto', async () => {
    const good = objectKey(T0);
    const keys: unknown[] = [
      { Key: good, Size: 10 },
      { Key: `${good}.extra`, Size: 10 },
      { Key: objectKey(T0, { lb: 'app/outro/0123456789abcdef' }), Size: 10 },
      { Key: objectKey(T0, { random: 'b' }), Size: -1 },
      { Key: objectKey(T0, { random: 'c' }), Size: 1.5 },
      { Key: objectKey(T0, { random: 'd' }), Size: Infinity },
      { Key: objectKey(T0, { random: 'e' }) },
      { Key: 42, Size: 1 },
      {},
    ];
    const { sender } = fakeSender(() => ({ Contents: keys, IsTruncated: false }));
    const page = await new AlbBucket(sender, sender, target).list('2026-11-24', null);
    expect(page.objects).toEqual([{ key: good, size: 10, endMs: T0, index: slotOf(T0) }]);
    expect(page).toMatchObject({ ignored: 6, next: null });
  });

  it('a página seguinte sai da última chave; a que não anda acaba', async () => {
    const { sender } = fakeSender(() => ({ Contents: [{ Key: objectKey(T0), Size: 1 }], IsTruncated: true }));
    const bucket = new AlbBucket(sender, sender, target);
    expect((await bucket.list('2026-11-24', null)).next).toBe(objectKey(T0));
    expect((await bucket.list('2026-11-24', objectKey(T0))).next).toBeNull();
    const empty = fakeSender(() => ({ IsTruncated: true }));
    expect(await new AlbBucket(empty.sender, empty.sender, target).list('2026-11-24', null)).toEqual({
      objects: [],
      ignored: 0,
      next: null,
    });
  });

  it('nunca abre a chave que não é do balanceador, nem quando pedida', async () => {
    const { sender, commands } = fakeSender(() => ({ Body: Readable.from([]) }));
    const bucket = new AlbBucket(sender, sender, target);
    const foreign = {
      key: objectKey(T0, { lb: 'app/outro/0123456789abcdef' }),
      size: 1,
      endMs: T0,
      index: 1,
    };
    await expect(bucket.open(foreign)).rejects.toThrow('fora do balanceador');
    await expect(bucket.tail({ ...foreign, key: '../../segredo' })).rejects.toThrow('fora do balanceador');
    expect(commands).toEqual([]);
  });

  it('corpo que não é um fluxo é recusado; os 4 bytes nunca são mais que 4', async () => {
    const object = { key: objectKey(T0), size: 1, endMs: T0, index: slotOf(T0) };
    const { sender } = fakeSender(() => ({ Body: 'texto' }));
    await expect(new AlbBucket(sender, sender, target).open(object)).rejects.toMatchObject({
      name: 'InvalidResponse',
    });
    const tail = fakeSender((input) => {
      expect(input['Range']).toBe('bytes=-4');
      return { Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3, 4, 5, 6])) } };
    });
    expect([...(await new AlbBucket(tail.sender, tail.sender, target).tail(object))]).toEqual([3, 4, 5, 6]);
    const none = fakeSender(() => ({}));
    expect(await new AlbBucket(none.sender, none.sender, target).tail(object)).toHaveLength(0);
  });
});

describe('falhas do S3', () => {
  const list = (name: string, extra = {}) => new AlbCallError('s3:ListBucket', fault(name, extra));
  const get = (name: string, extra = {}) => new AlbCallError('s3:GetObject', fault(name, extra));

  it.each([
    [list('AccessDenied'), { type: 'permission', detail: 'bucket_denied' }],
    [list('NoSuchBucket'), { type: 'permission', detail: 'bucket_missing' }],
    [get('AccessDenied'), { type: 'permission', detail: 's3:GetObject' }],
    [get('KMS.NotFoundException'), { type: 'permission', detail: 'kms_denied' }],
    [list('SlowDown'), { type: 'failed', code: 'throttled' }],
    [list('Outro', { $metadata: { httpStatusCode: 429 } }), { type: 'failed', code: 'throttled' }],
    [get('AbortError'), { type: 'failed', code: 'TimeoutError' }],
    [get('InternalError'), { type: 'failed', code: 'InternalError' }],
    [get('Error', { code: 'ECONNRESET' }), { type: 'failed', code: 'NetworkError' }],
    [get('Error'), { type: 'failed', code: 'Error' }],
    [fault('IncompleteBody'), { type: 'failed', code: 'IncompleteBody' }],
    // Fora de uma chamada, a recusa não diz nada da permissão.
    [fault('AccessDenied'), { type: 'failed', code: 'AccessDenied' }],
    [new AlbCallError('s3:ListBucket', null), { type: 'failed', code: 'Unknown' }],
    [
      new AlbCallError('s3:ListBucket', fault('com espaço e "aspas"')),
      { type: 'failed', code: 'comespaoeaspas' },
    ],
  ])('%o', (error, expected) => {
    expect(albFailureOf(error)).toEqual(expected);
  });

  it('apagado e arquivado só pela leitura', () => {
    expect([isGone(get('NoSuchKey')), isGone(fault('NoSuchKey')), isGone(get('AccessDenied'))]).toEqual([
      true,
      false,
      false,
    ]);
    expect([isArchived(get('InvalidObjectState')), isArchived(get('NoSuchKey'))]).toEqual([true, false]);
  });
});

describe('orçamento da execução', () => {
  const amounts = { objects: 10, lines: 100, bytes: 1_000 };
  it.each([
    ['objetos', { objects: 10, lines: 0, bytes: 0 }],
    ['linhas', { objects: 0, lines: 100, bytes: 0 }],
    ['bytes', { objects: 0, lines: 0, bytes: 1_000 }],
  ])('acaba por %s', (_, spent) => {
    const budget = new RunBudget(amounts, () => false);
    expect(budget.exhausted).toBe(false);
    budget.spend(spent);
    expect(budget.exhausted).toBe(true);
  });

  it('acaba pelo tempo, e a fatia gasta do todo', () => {
    let late = false;
    const budget = new RunBudget(amounts, () => late);
    const half = budget.slice(2);
    half.spend({ objects: 5, lines: 1, bytes: 1 });
    expect([half.exhausted, budget.exhausted]).toEqual([true, false]);
    const other = budget.slice(2);
    expect(other.exhausted).toBe(false);
    other.spend({ objects: 4, lines: 0, bytes: 0 });
    budget.spend({ objects: 1, lines: 0, bytes: 0 });
    // O todo acabou: a fatia também.
    expect(other.exhausted).toBe(true);
    late = true;
    expect(new RunBudget(amounts, () => late).slice(1).exhausted).toBe(true);
  });
});

describe('saúde da fonte', () => {
  const facts = (over: Partial<WebSourceFacts> = {}): WebSourceFacts => ({
    state: 'authorized',
    stateCode: 'awaiting_collector',
    permission: 'granted',
    permissionDetail: null,
    authorizedAt: new Date(T0 - 10 * HOUR),
    lastEventAt: null,
    lastIngestedAt: null,
    ...over,
  });
  const synced = (over: Partial<Extract<WebOutcome, { type: 'synced' }>> = {}): WebOutcome => ({
    type: 'synced',
    ingested: false,
    opened: false,
    newestEventAt: null,
    unread: 0,
    gap: false,
    quarantined: false,
    volume: { events: 0, bytes: 0 },
    lagSeconds: 600,
    ...over,
  });
  const stateOf = (current: Partial<WebSourceFacts>, outcome: WebOutcome) => {
    const { data } = webSourceChange(facts(current), outcome, NOW);
    return [data.state, data.stateCode];
  };
  const ago = (ms: number) => new Date(T0 - ms);

  it.each([
    ['nada lido ainda', {}, synced(), ['waiting_events', null]],
    ['leu agora', {}, synced({ ingested: true }), ['collecting', null]],
    ['leu antes, e o site está quieto', { lastIngestedAt: ago(9 * HOUR) }, synced(), ['collecting', null]],
    [
      'lido só antes desta autorização',
      { lastIngestedAt: ago(11 * HOUR) },
      synced(),
      ['waiting_events', null],
    ],
    [
      'arquivo recusado',
      { lastIngestedAt: ago(HOUR) },
      synced({ quarantined: true }),
      ['collecting', 'web_quarantined'],
    ],
    ['à espera há pouco', { lastIngestedAt: ago(2 * HOUR) }, synced({ unread: 1 }), ['collecting', null]],
    [
      'à espera há mais de 2 h',
      { lastIngestedAt: ago(2 * HOUR + 1) },
      synced({ unread: 1 }),
      ['stalled', 'web_unread'],
    ],
    [
      'à espera, mas lendo',
      { lastIngestedAt: ago(5 * HOUR) },
      synced({ unread: 9, ingested: true }),
      ['collecting', null],
    ],
    ['à espera desde a autorização', {}, synced({ unread: 1 }), ['stalled', 'web_unread']],
    [
      'à espera desde uma autorização nova',
      { authorizedAt: ago(HOUR) },
      synced({ unread: 1 }),
      ['waiting_events', null],
    ],
    [
      'lacuna',
      { lastIngestedAt: ago(HOUR) },
      synced({ gap: true, ingested: true, quarantined: true }),
      ['ingestion_error', 'web_gap'],
    ],
  ] as [string, Partial<WebSourceFacts>, WebOutcome, [string, string | null]][])(
    '%s',
    (_, current, outcome, expected) => {
      expect(stateOf(current, outcome)).toEqual(expected);
    },
  );

  it('a mudança de estado vai para a trilha; a de código, não', () => {
    expect(webSourceChange(facts(), synced({ ingested: true }), NOW).transition).toEqual({
      from: { state: 'authorized', stateCode: 'awaiting_collector' },
      to: { state: 'collecting', stateCode: null },
    });
    const same = webSourceChange(
      facts({ state: 'collecting', stateCode: null }),
      synced({ ingested: true, quarantined: true }),
      NOW,
    );
    expect(same.transition).toBeNull();
    expect(same.data).toMatchObject({ stateCode: 'web_quarantined' });
    expect(same.data).not.toHaveProperty('stateSince');
  });

  it('a falha passageira só muda o estado na terceira; a do que está guardado, na primeira', () => {
    const failed = (failures: number, immediate?: boolean): WebOutcome => ({
      type: 'failed',
      code: 'throttled',
      failures,
      ...(immediate !== undefined && { immediate }),
      lagSeconds: 9,
    });
    expect(webSourceChange(facts(), failed(2), NOW)).toEqual({ data: { lagSeconds: 9 }, transition: null });
    expect(stateOf({}, failed(3))).toEqual(['ingestion_error', 'throttled']);
    expect(stateOf({}, failed(1, true))).toEqual(['ingestion_error', 'throttled']);
    expect(
      webSourceChange(facts(), { type: 'failed', code: 'x', failures: 1, lagSeconds: null }, NOW).data,
    ).toEqual({});
  });

  it('a permissão: negada com o motivo, provada por quem a desmente', () => {
    const denied = webSourceChange(
      facts(),
      { type: 'permission', detail: 'bucket_denied', lagSeconds: 1 },
      NOW,
    );
    expect(denied.data).toMatchObject({
      state: 'permission_error',
      stateCode: 'bucket_denied',
      permission: 'missing',
      permissionDetail: 'bucket_denied',
      permissionCheckedAt: NOW,
    });
    const again = webSourceChange(
      facts({
        permission: 'missing',
        permissionDetail: 'bucket_denied',
        state: 'permission_error',
        stateCode: 'bucket_denied',
      }),
      { type: 'permission', detail: 'bucket_denied', lagSeconds: 1 },
      NOW,
    );
    expect(again.data).not.toHaveProperty('permissionCheckedAt');
    const permissionOf = (detail: string, outcome: WebOutcome) =>
      webSourceChange(
        facts({
          permission: 'missing',
          permissionDetail: detail,
          state: 'permission_error',
          stateCode: detail,
        }),
        outcome,
        NOW,
      ).data;
    expect(permissionOf('bucket_denied', synced())).toMatchObject({
      permission: 'granted',
      state: 'waiting_events',
    });
    expect(permissionOf('outside_awslogs_prefix', synced())).toMatchObject({ permission: 'granted' });
    expect(permissionOf('s3:GetObject', synced())).not.toHaveProperty('permission');
    expect(permissionOf('s3:GetObject', synced())).toMatchObject({
      state: 'permission_error',
      stateCode: 's3:GetObject',
    });
    expect(permissionOf('kms_denied', synced({ opened: true, ingested: true }))).toMatchObject({
      permission: 'granted',
      state: 'collecting',
    });
    expect(webSourceChange(facts({ permission: 'unknown' }), synced(), NOW).data).not.toHaveProperty(
      'permission',
    );
    expect(
      webSourceChange(facts({ permission: 'unknown' }), synced({ opened: true }), NOW).data,
    ).toMatchObject({ permission: 'granted' });
    expect(webSourceChange(facts(), synced({ opened: true }), NOW).data).not.toHaveProperty('permission');
  });

  it('horários, volume e atraso', () => {
    const change = webSourceChange(
      facts({ lastEventAt: ago(HOUR) }),
      synced({ ingested: true, newestEventAt: ago(2 * HOUR), volume: { events: 2 ** 40, bytes: 7 } }),
      NOW,
    );
    // O evento mais recente não anda para trás; a contagem cabe na coluna.
    expect(change.data).toMatchObject({
      lastEventAt: ago(HOUR),
      lastSyncAt: NOW,
      lastIngestedAt: NOW,
      eventsLast24h: 2_147_483_647,
      bytesLast24h: 7n,
    });
    expect(webSourceChange(facts(), synced(), NOW).data).not.toHaveProperty('lastIngestedAt');
    expect(webLagSeconds(null, NOW)).toBeNull();
    expect(webLagSeconds(ago(90_500), NOW)).toBe(90);
    expect(webLagSeconds(new Date(T0 + HOUR), NOW)).toBe(0);
    expect(webLagSeconds(new Date(0), new Date(8.64e15))).toBe(2_147_483_647);
  });

  it('os códigos novos passam no contrato estrito da fonte', () => {
    const code = awsSourceSchema.shape.stateCode;
    for (const value of WEB_SOURCE_STATE_CODES) expect(code.safeParse(value).success).toBe(true);
  });
});

describe('observação', () => {
  const draft = (id: string, over: { ruleId?: string; level?: number; first?: number; last?: number } = {}) =>
    ({
      sourceEventId: `aws/${ACCOUNT}/alb:${id}`,
      ruleId: over.ruleId ?? '990405',
      ruleLevel: over.level ?? 7,
      sourceIp: '198.51.100.7',
      evidence: {
        firstSeenAt: new Date(T0 + (over.first ?? 0)).toISOString(),
        lastSeenAt: new Date(T0 + (over.last ?? 0)).toISOString(),
      },
    }) as unknown as WebFindingDraft;
  const SINCE = NOW.toISOString();

  it('cada achado conta uma vez, por regra e nível, com o primeiro e o último', () => {
    const observation = new Observation(SINCE);
    expect(observation.record([draft('a'), draft('b', { first: -5_000 }), draft('c', { level: 10 })])).toBe(
      3,
    );
    expect(observation.record([draft('a', { last: 9_000 }), draft('a')])).toBe(0);
    expect(observation.state().rules).toEqual([
      {
        ruleId: '990405',
        level: 7,
        findings: 2,
        firstSeenAt: new Date(T0 - 5_000).toISOString(),
        lastSeenAt: new Date(T0 + 9_000).toISOString(),
      },
      { ruleId: '990405', level: 10, findings: 1, firstSeenAt: SINCE, lastSeenAt: SINCE },
    ]);
    expect(JSON.stringify(observation.state())).not.toContain('198.51');
  });

  it('volta do banco sem contar de novo; a de outra observação, ou estragada, recomeça', () => {
    const observation = new Observation(SINCE);
    observation.record([draft('a'), draft('b')]);
    const state: unknown = JSON.parse(JSON.stringify(observation.state()));
    const resumed = Observation.resume(state, SINCE);
    expect(resumed.record([draft('a'), draft('b'), draft('c')])).toBe(1);
    expect(resumed.state().rules).toMatchObject([{ findings: 3 }]);
    for (const other of [
      null,
      'x',
      {},
      { ...(state as object), keys: ['zz'] },
      { ...(state as object), extra: 1 },
    ]) {
      expect(Observation.resume(other, SINCE).state().rules).toEqual([]);
    }
    expect(Observation.resume(state, new Date(T0 + 1).toISOString()).state().rules).toEqual([]);
  });

  it('no teto, para de contar o novo e diz que é um piso', () => {
    const observation = new Observation(SINCE);
    observation.record(times(4_000, (i) => draft(`k${i}`)));
    expect(observation.state()).toMatchObject({ truncated: false });
    expect(observation.record([draft('mais um'), draft('k1', { last: 1 })])).toBe(0);
    const state = observation.state();
    expect(state).toMatchObject({ truncated: true, rules: [{ findings: 4_000 }] });
    expect(state.keys).toHaveLength(4_000);
    expect(Observation.resume(state, SINCE).state().truncated).toBe(true);
  });
});

describe('estado guardado do motor', () => {
  const base = () => {
    const harness = new Harness();
    harness.feed(times(12, (i) => ({ client: '198.51.100.7', path: `/a${i}/.env`, status: 404 })));
    harness.evaluate();
    return {
      digest: harness.engine.snapshot(),
      observation: new Observation(NOW.toISOString()).state(),
      suppressed: [],
      notes: [],
    };
  };

  it('vai e volta', () => {
    const state = base();
    const read = readEngineState(1, JSON.parse(writeEngineState(state)));
    expect(read.digest).toEqual(state.digest);
    expect(read.observation).toEqual(state.observation);
  });

  it('versão desconhecida, texto e pedaço estragado: o que serve fica', () => {
    const json = JSON.parse(writeEngineState(base())) as Record<string, unknown>;
    const empty = { digest: null, observation: null, suppressed: [] };
    expect(readEngineState(2, json)).toEqual(empty);
    expect(readEngineState(1, null)).toEqual(empty);
    expect(readEngineState(1, 'x')).toEqual(empty);
    expect(readEngineState(1, { ...json, digest: { version: 1 } })).toMatchObject({
      digest: null,
      observation: json['observation'],
    });
    expect(readEngineState(1, { ...json, suppressed: [{ a: 1 }] })).toMatchObject({
      digest: json['digest'],
      suppressed: [],
    });
  });

  it('acima do teto do banco, sai a barra e depois o resumo, e o resto é gravado', () => {
    const state = base();
    const client = { requests: 1, tool: 0, probes: 1, errors: 0, families: 1, firstMs: 1, lastMs: 2 };
    const track = { slots: [1, 2, 3], seriousMs: null, targetedMs: null };
    const clients = (count: number) =>
      times(count, (i) => [`2001:db8:0:${i.toString(16)}::/64`, client] as [string, typeof client]);
    const tracks = times(
      4_000,
      (i) => [`2001:db8:0:${i.toString(16)}::/64`, track] as [string, typeof track],
    );
    const parse = (text: string) =>
      JSON.parse(text) as { digest: { days: unknown[]; tracks: unknown[] } | null };
    const day = (count: number) => ({ day: 1, clients: clients(count), dropped: 0 });
    const small = parse(
      writeEngineState({ ...state, digest: { ...state.digest, days: [day(2_000)], tracks } }),
    );
    expect(small.digest?.tracks).toHaveLength(4_000);
    const big = parse(
      writeEngineState({ ...state, digest: { ...state.digest, days: [day(29_000)], tracks } }),
    );
    expect(big.digest?.tracks).toEqual([]);
    expect(big.digest?.days).toHaveLength(1);
    const huge = writeEngineState({ ...state, digest: { ...state.digest, days: [day(40_000)], tracks } });
    expect(parse(huge).digest).toBeNull();
    expect(Buffer.byteLength(huge)).toBeLessThan(MAX_ENGINE_STATE_BYTES);
  });

  it('o calado pelas fontes confiáveis: o último de cada uma, por 24 h, até 100', () => {
    const first = mergeSuppressed([], [{ sourceId: 'x', rule: '990405', clients: 3 }], T0);
    expect(first).toEqual([{ trustedId: 'x', ruleId: '990405', clients: 3, lastSeenAt: NOW.toISOString() }]);
    expect(mergeSuppressed(first, [], T0 + SUPPRESSED_KEEP_MS - 1)).toEqual(first);
    expect(mergeSuppressed(first, [], T0 + SUPPRESSED_KEEP_MS)).toEqual([]);
    expect(mergeSuppressed(first, [{ sourceId: 'x', rule: '990405', clients: 1 }], T0 + 1)).toMatchObject([
      { clients: 1 },
    ]);
    const many = mergeSuppressed(
      first,
      times(150, (i) => ({ sourceId: `s${i}`, rule: '990401' as const, clients: 1 })),
      T0 + 5,
    );
    expect(many).toHaveLength(100);
    expect(many.some((row) => row.trustedId === 'x')).toBe(false);
  });
});

describe('avaliação em passos', () => {
  it('solta o laço de eventos no meio, e dá o mesmo que a avaliação de uma vez', async () => {
    const flood = times(6_000, (i) => ({
      client: `2001:db8:0:${i.toString(16)}::1`,
      method: 'POST',
      path: '/login',
      status: 401,
    }));
    const [stepped, whole] = [new Harness(), new Harness()];
    stepped.feed(flood);
    whole.feed(flood);
    let turns = 0;
    let running = true;
    const spin = (): void => {
      turns += 1;
      if (running) setImmediate(spin);
    };
    setImmediate(spin);
    const result = await evaluateEngine(stepped.engine, { now: T0 + MINUTE }, new AbortController().signal);
    running = false;
    expect(turns).toBeGreaterThan(5);
    expect(result).toEqual(whole.evaluate());
  });

  it('para no meio com o sinal', async () => {
    const harness = new Harness();
    harness.feed(times(50, () => ({ client: '198.51.100.7' })));
    const signal = AbortSignal.abort(new DOMException('parada', 'AbortError'));
    await expect(evaluateEngine(harness.engine, { now: T0 + MINUTE }, signal)).rejects.toThrow('parada');
  });
});

it('a amostra da estimativa é espalhada pela lista', () => {
  expect(spread([1, 2, 3], 5)).toEqual([1, 2, 3]);
  expect(
    spread(
      times(100, (i) => i),
      4,
    ),
  ).toEqual([0, 25, 50, 75]);
  expect(
    new Set(
      spread(
        times(21, (i) => i),
        20,
      ),
    ).size,
  ).toBe(20);
  expect(spread([], 3)).toEqual([]);
});
