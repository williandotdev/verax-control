import {
  AWS_ONBOARDING_CHECK_IDS,
  AWS_SOURCE_AVAILABILITIES,
  AWS_SOURCE_KINDS,
  AWS_SOURCE_PERMISSION_CODES,
  AWS_SOURCE_RETRY_INTERVAL_MS,
  AWS_SOURCE_STATES,
  type AwsOnboarding,
  awsOnboardingSchema,
  type CloudAccount,
  cloudAccountSchema,
  paginatedSchema,
} from '@verax/shared';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequestError } from '@/lib/api-client';
import { api } from '@/lib/api';
import {
  DEMO_AWS_COLLECTOR_MS,
  DEMO_AWS_CONNECT_DELAY_MS,
  DEMO_AWS_CONNECT_TIMEOUT_MS,
  DEMO_AWS_DISCOVERY_QUEUE_MS,
  DEMO_AWS_DISCOVERY_REQUEST_MS,
  DEMO_AWS_DISCOVERY_RUN_MS,
  DEMO_AWS_PROBE_DELAY_MS,
  DEMO_AWS_SCENARIO_ACCOUNTS,
} from './aws-onboarding';
import { DEMO_ACCOUNTS, DEMO_AWS_CHECK_DELAY_MS, demoMe } from './fixtures';
import { createHandlers, type MockState } from './handlers';

/**
 * A imitação do onboarding da AWS (`aws-onboarding.ts`) pelas rotas, como o painel a usa. Só o relógio é falso: cada
 * passo do "worker" da demonstração acontece quando o tempo dele passa, e toda resposta é conferida pelo schema do
 * contrato (o cliente HTTP recusa o que não bate).
 */

const ALFA = '018f2c1e-0000-7000-8000-0000000c0001';
const HOMOLOGACAO = '018f2c1e-0000-7000-8000-0000000c0002';
const BETA = '018f2c1e-0000-7000-8000-0000000c0003';
const START = Date.parse('2026-11-23T12:00:00.000Z');

const server = setupServer();
beforeAll(() => server.listen());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.useRealTimers();
});
afterAll(() => server.close());

const start = (state: MockState = { me: demoMe('admin_cliente') }) => server.use(...createHandlers(state));
const pass = (ms: number) => vi.setSystemTime(Date.now() + ms);
const path = (id: string, rest: string) => `/v1/cloud-accounts/${id}/aws/${rest}`;
const view = (id: string) => api.get(path(id, 'onboarding'), awsOnboardingSchema);
const write = (id: string, rest: string, body?: unknown) =>
  api.post(path(id, rest), body, awsOnboardingSchema);
const create = (accountId: string) =>
  api.post('/v1/cloud-accounts', { provider: 'aws', accountId, regions: ['sa-east-1'] }, cloudAccountSchema);
const accounts = async (): Promise<CloudAccount[]> =>
  (await api.get('/v1/cloud-accounts?page=1&pageSize=20', paginatedSchema(cloudAccountSchema))).items;
const checkOf = (onboarding: AwsOnboarding, id: (typeof AWS_ONBOARDING_CHECK_IDS)[number]) =>
  onboarding.checks.find((check) => check.id === id);
const refusal = (code: string, status: number) =>
  expect.objectContaining({ code, status }) as ApiRequestError;

/** Do "Conectar" até a descoberta terminar. */
async function connectAndDiscover(id: string): Promise<AwsOnboarding> {
  await write(id, 'connect');
  pass(DEMO_AWS_CONNECT_DELAY_MS);
  await view(id);
  pass(DEMO_AWS_DISCOVERY_REQUEST_MS);
  await view(id);
  pass(DEMO_AWS_DISCOVERY_QUEUE_MS);
  await view(id);
  pass(DEMO_AWS_DISCOVERY_RUN_MS);
  return view(id);
}

describe('contas da demonstração', () => {
  it('a produção da Alfa: erro de permissão numa fonte, com a descoberta parcial e a leitura dos grupos desligada', async () => {
    start();
    const alfa = await view(ALFA);
    expect(alfa.state).toBe('permission_error');
    expect(alfa.credentialMode).toBe('role');
    expect(alfa.template).toMatchObject({
      version: 2,
      outdated: false,
      capabilities: ['discovery', 'service-logs', 'findings'],
    });
    expect(alfa.checks.map((check) => check.id)).toEqual([...AWS_ONBOARDING_CHECK_IDS]);
    expect(checkOf(alfa, 'discovery')).toMatchObject({ status: 'ok', code: 'partial' });
    // A permissão que falta é a ação do IAM que a AWS negou; a falha de leitura, o limite de requisições.
    expect(checkOf(alfa, 'permission')).toMatchObject({
      status: 'failed',
      code: 'access-analyzer:ListFindings',
    });
    expect(checkOf(alfa, 'events')).toMatchObject({ status: 'failed', code: 'throttled' });
    expect(checkOf(alfa, 'lag')).toMatchObject({ status: 'failed', code: 'stalled' });
    // Uma Web ACL acabou de ser autorizada: a configuração da coleta ainda não foi aplicada no servidor.
    expect(checkOf(alfa, 'collector_config')).toMatchObject({
      status: 'pending',
      code: 'awaiting_collector',
    });
    expect(alfa.discovery.run).toMatchObject({ status: 'partial' });
    expect(
      alfa.discovery.run?.errors.map((error) => `${error.service}|${error.region}|${error.code}`),
    ).toEqual([
      'inspector|us-east-1|AccessDeniedException',
      'cloudwatch_logs|us-east-1|TimeoutError',
      'elb|sa-east-1|Truncated',
    ]);
    // A leitura que ficou de fora aparece como "não lido", não como zero.
    expect(alfa.infrastructure).toMatchObject({ loadBalancers: null, instances: 14 });
    // Os três buckets do cadastro são fontes autorizadas "cadastradas manualmente".
    const legacy = alfa.sources.filter((source) => source.origin === 'legacy');
    expect(legacy.map((source) => source.kind).sort()).toEqual(['cloudtrail', 'guardduty_export', 'waf']);
    expect(legacy.every((source) => source.authorization.authorizedAt !== null)).toBe(true);
    // Todo grupo de logs espera a autorização da pilha.
    const groups = alfa.sources.filter((source) => source.kind === 'cloudwatch_log_group');
    expect(groups.length).toBeGreaterThan(30);
    expect(groups.every((source) => source.permissionDetail === 'capability_off')).toBe(true);
  });

  it('as fontes de achados da Alfa: com achados, sem achado nenhum, limitada pela AWS, sem permissão e desligada', async () => {
    start();
    const alfa = await view(ALFA);
    const authorized = alfa.sources.filter(
      (source) => source.method === 'api' && source.authorization.authorizedAt !== null,
    );
    const of = (kind: string, state: string) =>
      authorized.find((source) => source.kind === kind && source.state === state);
    // Com achados: coletando, sem código, com o volume do dia.
    expect(of('guardduty', 'collecting')).toMatchObject({ stateCode: null, health: { eventsLast24h: 3 } });
    // A leitura dá certo e o serviço ainda não trouxe achado: o código do coletor de achados.
    expect(of('security_hub', 'collecting')).toMatchObject({
      stateCode: 'no_findings_yet',
      health: { lastEventAt: null, eventsLast24h: 0 },
    });
    // A leitura limitada pela AWS: o atraso é o tempo desde a última leitura que deu certo, contado na hora.
    expect(of('security_hub', 'ingestion_error')).toMatchObject({
      stateCode: 'throttled',
      permission: 'granted',
      health: { lagSeconds: 3 * 3_600 },
    });
    pass(60_000);
    expect(
      (await view(ALFA)).sources.find((source) => source.state === 'ingestion_error')?.health.lagSeconds,
    ).toBe(3 * 3_600 + 60);
    // A ação do IAM que a AWS negou: o motivo é a própria ação, não um dos códigos.
    expect(of('access_analyzer', 'permission_error')).toMatchObject({
      stateCode: 'access-analyzer:ListFindings',
      permission: 'missing',
      permissionDetail: 'access-analyzer:ListFindings',
    });
    // O serviço desligado na conta depois da autorização.
    expect(of('inspector', 'source_missing')).toMatchObject({
      stateCode: 'not_enabled',
      missingSince: expect.any(String) as string,
    });
  });

  it('as fontes de bucket da Alfa: uma em cada estado que a coleta grava, com o motivo, e a nota dos flow logs', async () => {
    start();
    const alfa = await view(ALFA);
    const buckets = alfa.sources.filter(
      (source) =>
        source.method === 's3' &&
        source.origin === 'discovered' &&
        source.authorization.authorizedAt !== null,
    );
    const summary = buckets
      .filter((source) => source.authorization.revokedAt === null && source.state !== 'source_missing')
      .map((source) => `${source.kind}|${source.state}|${source.stateCode ?? '-'}`)
      .sort();
    expect(summary).toEqual([
      'cloudtrail|waiting_events|-',
      'vpc_flow_logs|collecting|-',
      'vpc_flow_logs|ingestion_error|region_unsupported',
      'vpc_flow_logs|stalled|no_progress',
      'waf|configuring|awaiting_apply',
    ]);
    const of = (state: string) => buckets.find((source) => source.state === state);
    // Autorizada agora: ainda sem leitura nenhuma.
    expect(of('configuring')).toMatchObject({
      collectFrom: '2026-11-23',
      health: { lastSyncAt: null, lagSeconds: null },
    });
    expect(of('waiting_events')?.health).toMatchObject({ lastEventAt: null, lagSeconds: null });
    expect(of('waiting_events')?.health.lastSyncAt).not.toBeNull();
    // Coletando: o atraso é o da leitura do último arquivo (gravado há 9 min, lido há 2).
    expect(of('collecting')?.health).toMatchObject({ lagSeconds: 7 * 60, eventsLast24h: 52_300 });
    // Parada: sem leitura há 3 horas.
    expect(of('stalled')?.health.lagSeconds).toBe(3 * 3_600);
    // De fora da coleta: numa região que o coletor não lê, sem leitura nenhuma.
    expect(of('ingestion_error')).toMatchObject({ region: 'mx-central-1', health: { lastSyncAt: null } });
    // Todo flow log que grava num bucket e dá para ler avisa que os do mesmo bucket são lidos juntos.
    const flows = alfa.sources.filter((source) => source.kind === 'vpc_flow_logs');
    expect(flows.length).toBeGreaterThanOrEqual(5);
    for (const flow of flows) {
      expect(flow.notes.includes('flow_logs_read_together'), flow.name).toBe(
        flow.availability === 'available',
      );
    }
  });

  it('sem a fonte parada, o atraso que sobra é o da leitura das fontes de achados (sync_delayed)', async () => {
    start();
    const alfa = await view(ALFA);
    const stalled = alfa.sources.find((source) => source.state === 'stalled');
    if (!stalled) throw new Error('a demonstração não tem fonte parada');
    const revoked = await write(ALFA, `sources/${stalled.id}/revoke`);
    expect(checkOf(revoked, 'lag')).toMatchObject({ status: 'failed', code: 'sync_delayed' });
    expect(checkOf(revoked, 'events')).toMatchObject({ status: 'failed', code: 'throttled' });
  });

  it('numa conta nova, o Security Hub vai direto para a coleta, sincronizado e ainda sem achado', async () => {
    start();
    const { id } = await create('135792468024');
    const discovered = await connectAndDiscover(id);
    const hub = discovered.sources.find(
      (source) => source.kind === 'security_hub' && source.state === 'available',
    );
    if (!hub) throw new Error('a descoberta da demonstração não achou o Security Hub');
    await write(id, 'sources/authorize', { sourceIds: [hub.id] });
    pass(DEMO_AWS_COLLECTOR_MS.api);
    const collecting = await view(id);
    expect(collecting.state).toBe('collecting');
    expect(collecting.sources.find((source) => source.id === hub.id)).toMatchObject({
      state: 'collecting',
      stateCode: 'no_findings_yet',
      health: { lastEventAt: null, eventsLast24h: 0 },
    });
    expect(checkOf(collecting, 'lag')).toMatchObject({ status: 'ok' });
  });

  it('a homologação: desconectada; a Beta: coletando, com a pilha do modelo anterior', async () => {
    start();
    const refused = await view(HOMOLOGACAO);
    expect(refused.state).toBe('disconnected');
    expect(checkOf(refused, 'assume_role')).toMatchObject({ status: 'failed', code: 'trust_denied' });
    start({ me: demoMe('admin_verax', { scopeTenantId: '018f2c1e-0000-7000-8000-00000000be7a' }) });
    const beta = await view(BETA);
    expect(beta.state).toBe('collecting');
    expect(beta.template).toMatchObject({ version: 1, outdated: true, capabilities: ['discovery'] });
    expect(checkOf(beta, 'template')).toMatchObject({ status: 'failed', code: 'template_outdated' });
  });

  it('juntas, as contas da demonstração e uma conta nova mostram todo tipo, disponibilidade e motivo de permissão', async () => {
    start();
    const fresh = await connectAndDiscover((await create('135792468024')).id);
    const sources = [...(await view(ALFA)).sources, ...fresh.sources];
    expect(new Set(sources.map((source) => source.kind))).toEqual(new Set(AWS_SOURCE_KINDS));
    expect(new Set(sources.map((source) => source.availability))).toEqual(new Set(AWS_SOURCE_AVAILABILITIES));
    const details = new Set(sources.map((source) => source.permissionDetail));
    for (const code of AWS_SOURCE_PERMISSION_CODES) expect(details.has(code), code).toBe(true);
    // E a ação do IAM negada, que não é um dos códigos.
    expect(details.has('access-analyzer:ListFindings')).toBe(true);
  });
});

describe('uma conta nova, do "Conectar com AWS" até coletar', () => {
  it('passa por todos os estados do caminho feliz, na ordem, só com o relógio andando', async () => {
    start();
    const { id } = await create('135792468024');
    expect((await view(id)).state).toBe('not_started');

    // O clique: a janela de 60 min abre, e a entrada no papel fica esperando a pilha.
    const waiting = await write(id, 'connect');
    expect(waiting.state).toBe('awaiting_authorization');
    expect(waiting.connect.waitingUntil).toBe(new Date(START + 60 * 60_000).toISOString());
    expect(checkOf(waiting, 'assume_role')).toMatchObject({ status: 'pending', code: 'awaiting_stack' });
    // Clicar de novo não adia o fim da janela.
    pass(1_000);
    expect((await write(id, 'connect')).connect.waitingUntil).toBe(waiting.connect.waitingUntil);
    expect((await accounts()).find((account) => account.id === id)?.checkRequestedAt).not.toBeNull();

    pass(DEMO_AWS_CONNECT_DELAY_MS);
    const authenticated = await view(id);
    expect(authenticated.state).toBe('authenticated');
    expect(authenticated.template).toMatchObject({ version: 2, outdated: false });
    expect(authenticated.connect.waitingUntil).toBeNull();

    pass(DEMO_AWS_DISCOVERY_REQUEST_MS);
    expect(await view(id)).toMatchObject({ state: 'discovering', discovery: { run: { status: 'pending' } } });
    pass(DEMO_AWS_DISCOVERY_QUEUE_MS);
    expect(await view(id)).toMatchObject({ state: 'discovering', discovery: { run: { status: 'running' } } });
    pass(DEMO_AWS_DISCOVERY_RUN_MS);
    const discovered = await view(id);
    expect(discovered.state).toBe('awaiting_sources');
    expect(discovered.discovery.run).toMatchObject({ status: 'succeeded', errors: [] });
    expect(discovered.infrastructure).not.toBeNull();
    // As regiões com recurso entram nas monitoradas da conta.
    expect((await accounts()).find((account) => account.id === id)?.regions).toEqual([
      'sa-east-1',
      'us-east-1',
    ]);

    const trail = discovered.sources.find(
      (source) => source.kind === 'cloudtrail' && source.state === 'available',
    );
    const guardduty = discovered.sources.find((source) => source.kind === 'guardduty');
    if (!trail || !guardduty)
      throw new Error('a descoberta da demonstração não achou a trilha ou o GuardDuty');
    const authorized = await write(id, 'sources/authorize', { sourceIds: [trail.id, guardduty.id] });
    expect(authorized.state).toBe('configuring');
    expect(authorized.sources.find((source) => source.id === trail.id)).toMatchObject({
      state: 'authorized',
      stateCode: 'awaiting_collector',
      collectFrom: '2026-11-23',
      authorization: { authorizedBy: 'demo-admin_cliente', revokedAt: null },
    });

    pass(DEMO_AWS_COLLECTOR_MS.configuring);
    const configuring = await view(id);
    // A fonte de bucket diz por que está configurando: a coleta ainda não foi aplicada no servidor.
    expect(configuring.sources.find((source) => source.id === trail.id)).toMatchObject({
      state: 'configuring',
      stateCode: 'awaiting_apply',
    });
    // A fonte de achados não tem passo intermediário: espera o coletor até a primeira leitura.
    expect(configuring.sources.find((source) => source.id === guardduty.id)).toMatchObject({
      state: 'authorized',
      stateCode: 'awaiting_collector',
    });
    pass(DEMO_AWS_COLLECTOR_MS.waitingEvents - DEMO_AWS_COLLECTOR_MS.configuring);
    const waitingEvents = await view(id);
    expect(waitingEvents.sources.find((source) => source.id === trail.id)?.state).toBe('waiting_events');
    expect(waitingEvents.sources.find((source) => source.id === guardduty.id)?.state).toBe('authorized');
    // A API de achados coleta antes da trilha: só parte das fontes coletando.
    pass(DEMO_AWS_COLLECTOR_MS.api - DEMO_AWS_COLLECTOR_MS.waitingEvents);
    const partial = await view(id);
    expect(partial.state).toBe('partial');
    expect(partial.sources.find((source) => source.id === guardduty.id)).toMatchObject({
      state: 'collecting',
      stateCode: null,
    });
    pass(DEMO_AWS_COLLECTOR_MS.collecting - DEMO_AWS_COLLECTOR_MS.api);
    const collecting = await view(id);
    expect(collecting.state).toBe('collecting');
    expect(collecting.checks.map((check) => check.status)).toEqual(AWS_ONBOARDING_CHECK_IDS.map(() => 'ok'));
    expect(collecting.sources.find((source) => source.id === trail.id)?.health).toMatchObject({
      lagSeconds: 95,
      eventsLast24h: 12_480,
    });

    // Retirar a autorização da trilha: sobra o GuardDuty, coletando; a trilha volta a poder ser autorizada.
    const revoked = await write(id, `sources/${trail.id}/revoke`);
    expect(revoked.state).toBe('collecting');
    expect(revoked.sources.find((source) => source.id === trail.id)).toMatchObject({
      state: 'revoked',
      authorization: { revokedAt: expect.any(String) as string },
    });
    await expect(write(id, `sources/${trail.id}/revoke`)).rejects.toEqual(
      refusal('SOURCE_NOT_AUTHORIZED', 409),
    );
    expect((await write(id, 'sources/authorize', { sourceIds: [trail.id] })).state).toBe('partial');
  });

  it('o tempo esgotado, o erro de permissão e a falha de ingestão têm a conta de demonstração deles', async () => {
    start();
    const timeout = await create(DEMO_AWS_SCENARIO_ACCOUNTS.timeout);
    const waiting = await write(timeout.id, 'connect');
    // A janela da demonstração é curta, e a tela mostra o prazo que a API manda.
    expect(waiting.connect.waitingUntil).toBe(
      new Date(Date.now() + DEMO_AWS_CONNECT_TIMEOUT_MS).toISOString(),
    );
    pass(DEMO_AWS_CONNECT_TIMEOUT_MS);
    const timedOut = await view(timeout.id);
    expect(timedOut.state).toBe('authorization_timeout');
    expect(checkOf(timedOut, 'assume_role')).toMatchObject({
      status: 'failed',
      code: 'authorization_timeout',
    });
    // Conectar de novo abre outra janela.
    expect((await write(timeout.id, 'connect')).state).toBe('awaiting_authorization');

    // A trilha (lida do bucket) e o GuardDuty (lido pela API) param no erro do cenário, cada um com o motivo dele.
    for (const [accountId, state, sourceState, kind, code] of [
      [
        DEMO_AWS_SCENARIO_ACCOUNTS.permissionError,
        'permission_error',
        'permission_error',
        'cloudtrail',
        'kms_denied',
      ],
      [
        DEMO_AWS_SCENARIO_ACCOUNTS.permissionError,
        'permission_error',
        'permission_error',
        'guardduty',
        'guardduty:ListFindings',
      ],
      [
        DEMO_AWS_SCENARIO_ACCOUNTS.ingestionFailure,
        'ingestion_failure',
        'ingestion_error',
        'cloudtrail',
        'TimeoutError',
      ],
      [
        DEMO_AWS_SCENARIO_ACCOUNTS.ingestionFailure,
        'ingestion_failure',
        'ingestion_error',
        'guardduty',
        'throttled',
      ],
    ] as const) {
      start();
      const { id } = await create(accountId);
      const discovered = await connectAndDiscover(id);
      const source = discovered.sources.find(
        (candidate) => candidate.kind === kind && candidate.state === 'available',
      );
      if (!source) throw new Error(`a descoberta da demonstração não achou a fonte ${kind}`);
      await write(id, 'sources/authorize', { sourceIds: [source.id] });
      pass(DEMO_AWS_COLLECTOR_MS.collecting);
      const failed = await view(id);
      expect(failed.state, `${accountId} ${kind}`).toBe(state);
      expect(
        failed.sources.find((candidate) => candidate.id === source.id),
        `${accountId} ${kind}`,
      ).toMatchObject({ state: sourceState, stateCode: code });
    }
  });

  it('juntos, os cenários mostram todos os estados de fonte', async () => {
    start();
    const seen = new Set((await view(ALFA)).sources.map((source) => source.state));
    const { id } = await create(DEMO_AWS_SCENARIO_ACCOUNTS.permissionError);
    const discovered = await connectAndDiscover(id);
    for (const source of discovered.sources) seen.add(source.state);
    const available = discovered.sources.filter(
      (source) => source.state === 'available' && !source.sensitive,
    );
    // Duas fontes lidas de bucket e uma de achados: uma para no erro do cenário, e a outra de bucket passa por
    // "configurando" e "ainda sem eventos" (a de achados vai direto para a coleta).
    const buckets = available.filter((source) => source.method !== 'api').slice(0, 2);
    const findings = available.find((source) => source.method === 'api');
    if (buckets.length < 2 || !findings) throw new Error('a descoberta da demonstração não achou as fontes');
    await write(id, 'sources/authorize', { sourceIds: [...buckets, findings].map((source) => source.id) });
    for (const source of (await view(id)).sources) seen.add(source.state);
    for (const step of [
      DEMO_AWS_COLLECTOR_MS.configuring,
      DEMO_AWS_COLLECTOR_MS.waitingEvents - DEMO_AWS_COLLECTOR_MS.configuring,
      DEMO_AWS_COLLECTOR_MS.collecting - DEMO_AWS_COLLECTOR_MS.waitingEvents,
    ]) {
      pass(step);
      for (const source of (await view(id)).sources) seen.add(source.state);
    }
    const other = await create(DEMO_AWS_SCENARIO_ACCOUNTS.ingestionFailure);
    const again = await connectAndDiscover(other.id);
    const first = again.sources.find((source) => source.state === 'available' && !source.sensitive);
    if (!first) throw new Error('nenhuma fonte disponível');
    await write(other.id, 'sources/authorize', { sourceIds: [first.id] });
    pass(DEMO_AWS_COLLECTOR_MS.collecting);
    for (const source of (await view(other.id)).sources) seen.add(source.state);
    expect(seen).toEqual(new Set(AWS_SOURCE_STATES));
  });
});

describe('recusas, como as da API', () => {
  it('a autorização: tudo ou nada, com o código de cada recusa', async () => {
    start();
    const { id } = await create('135792468024');
    const discovered = await connectAndDiscover(id);
    const by = (match: (source: AwsOnboarding['sources'][number]) => boolean) => {
      const source = discovered.sources.find(match);
      if (!source) throw new Error('fonte da demonstração não encontrada');
      return source;
    };
    const trail = by((source) => source.kind === 'cloudtrail' && source.state === 'available');
    const authorize = (sourceIds: string[], sensitiveSourceIds?: string[]) =>
      write(id, 'sources/authorize', { sourceIds, ...(sensitiveSourceIds && { sensitiveSourceIds }) });

    await expect(authorize([by((source) => source.kind === 'config').id])).rejects.toEqual(
      refusal('SOURCE_NOT_COLLECTABLE', 409),
    );
    await expect(authorize([by((source) => source.availability === 'no_destination').id])).rejects.toEqual(
      refusal('SOURCE_NOT_AVAILABLE', 409),
    );
    await expect(authorize([by((source) => source.permissionDetail === 'kms_denied').id])).rejects.toEqual(
      refusal('SOURCE_PERMISSION_MISSING', 409),
    );
    // Um grupo de logs só entra citado de novo na confirmação; e a fonte boa do mesmo pedido não é autorizada.
    const group = by((source) => source.kind === 'cloudwatch_log_group' && source.state === 'available');
    await expect(authorize([trail.id, group.id])).rejects.toEqual(
      refusal('SENSITIVE_CONFIRMATION_REQUIRED', 400),
    );
    expect((await view(id)).sources.find((source) => source.id === trail.id)?.state).toBe('available');
    const both = await authorize([trail.id, group.id], [group.id]);
    expect(both.sources.find((source) => source.id === group.id)?.state).toBe('authorized');
    await expect(authorize(['018f2c1e-0000-7000-8000-00f5ffffffff'])).rejects.toMatchObject({ status: 404 });
    await expect(write(id, 'sources/authorize', { sourceIds: [] })).rejects.toMatchObject({ status: 400 });
  });

  it('as fontes dos buckets do cadastro não mudam por aqui; a coberta pelo cadastro não é autorizada de novo', async () => {
    start();
    const alfa = await view(ALFA);
    const legacy = alfa.sources.find((source) => source.origin === 'legacy');
    const covered = alfa.sources.find(
      (source) => source.notes.includes('covered_by_legacy') && source.origin !== 'legacy',
    );
    if (!legacy || !covered) throw new Error('fontes da demonstração não encontradas');
    await expect(write(ALFA, 'sources/authorize', { sourceIds: [legacy.id] })).rejects.toEqual(
      refusal('SOURCE_LEGACY', 409),
    );
    await expect(write(ALFA, `sources/${legacy.id}/revoke`)).rejects.toEqual(refusal('SOURCE_LEGACY', 409));
    await expect(write(ALFA, `sources/${legacy.id}/retry`)).rejects.toEqual(refusal('SOURCE_LEGACY', 409));
    await expect(write(ALFA, 'sources/authorize', { sourceIds: [covered.id] })).rejects.toEqual(
      refusal('SOURCE_COVERED_BY_LEGACY', 409),
    );
  });

  it('a descoberta manual: uma a cada 5 min, e só na conta conectada', async () => {
    start();
    const requested = await write(ALFA, 'discovery');
    expect(requested.discovery.run).toMatchObject({
      trigger: 'manual',
      status: 'pending',
      requestedBy: 'demo-admin_cliente',
    });
    // Com uma pendente, o pedido não cria outra.
    expect((await write(ALFA, 'discovery')).discovery.run?.id).toBe(requested.discovery.run?.id);
    pass(DEMO_AWS_DISCOVERY_QUEUE_MS);
    await view(ALFA);
    pass(DEMO_AWS_DISCOVERY_RUN_MS);
    expect((await view(ALFA)).discovery.run?.status).toBe('partial');
    await expect(write(ALFA, 'discovery')).rejects.toEqual(refusal('DISCOVERY_RATE_LIMITED', 429));
    pass(5 * 60_000);
    expect((await write(ALFA, 'discovery')).discovery.run?.status).toBe('pending');
    await expect(write(HOMOLOGACAO, 'discovery')).rejects.toEqual(refusal('ACCOUNT_NOT_CONNECTED', 409));
  });

  it('"verificar de novo" numa fonte: o pedido fica pendente e o grupo etiquetado passa a poder ser autorizado', async () => {
    start();
    const { id } = await create('135792468024');
    const discovered = await connectAndDiscover(id);
    const untagged = discovered.sources.find((source) => source.permissionDetail === 'tag_missing');
    if (!untagged) throw new Error('nenhum grupo sem etiqueta na demonstração');
    const requested = await write(id, `sources/${untagged.id}/retry`);
    expect(requested.sources.find((source) => source.id === untagged.id)?.probeRequestedAt).not.toBeNull();
    pass(DEMO_AWS_PROBE_DELAY_MS);
    expect((await view(id)).sources.find((source) => source.id === untagged.id)).toMatchObject({
      state: 'available',
      permission: 'granted',
      permissionDetail: null,
      probeRequestedAt: null,
      details: { tagged: true },
    });
    await expect(write(HOMOLOGACAO, `sources/${untagged.id}/retry`)).rejects.toMatchObject({ status: 404 });
  });

  it('"verificar de novo" na mesma fonte: um pedido a cada 30 s; o que ainda espera resposta não é recusado', async () => {
    start();
    const { id } = await create('135792468024');
    const discovered = await connectAndDiscover(id);
    const denied = discovered.sources.find((source) => source.permissionDetail === 'kms_denied');
    const untagged = discovered.sources.find((source) => source.permissionDetail === 'tag_missing');
    if (!denied || !untagged) throw new Error('fontes da demonstração não encontradas');
    const retry = (sourceId: string) => write(id, `sources/${sourceId}/retry`);
    const requestedAt = (await retry(denied.id)).sources.find(
      (source) => source.id === denied.id,
    )?.probeRequestedAt;
    expect(requestedAt).toBe(new Date(Date.now()).toISOString());
    // Repetir com o pedido ainda sem resposta não recusa nem renova o pedido.
    pass(500);
    expect((await retry(denied.id)).sources.find((source) => source.id === denied.id)?.probeRequestedAt).toBe(
      requestedAt,
    );
    // Respondido (a chave KMS continua negando): outro pedido da mesma fonte, antes dos 30 s, é recusado.
    pass(DEMO_AWS_PROBE_DELAY_MS);
    expect((await view(id)).sources.find((source) => source.id === denied.id)).toMatchObject({
      probeRequestedAt: null,
      permissionDetail: 'kms_denied',
    });
    await expect(retry(denied.id)).rejects.toEqual(refusal('SOURCE_RETRY_RATE_LIMITED', 429));
    // O intervalo é por fonte: outra fonte confere na hora.
    expect(
      (await retry(untagged.id)).sources.find((source) => source.id === untagged.id)?.probeRequestedAt,
    ).not.toBeNull();
    // Passados os 30 s do pedido anterior, vale de novo.
    pass(AWS_SOURCE_RETRY_INTERVAL_MS - DEMO_AWS_PROBE_DELAY_MS - 500);
    expect(
      (await retry(denied.id)).sources.find((source) => source.id === denied.id)?.probeRequestedAt,
    ).not.toBeNull();
  });

  it('quem só lê vê o estado e não escreve; a conta de outro cliente não existe; a VM própria lê com a chave', async () => {
    start({ me: demoMe('leitura') });
    expect((await view(ALFA)).state).toBe('permission_error');
    await expect(write(ALFA, 'connect')).rejects.toMatchObject({ status: 403 });
    await expect(view(BETA)).rejects.toMatchObject({ status: 404 });
    start({ me: demoMe('admin_cliente'), nodePlatform: 'vm' });
    expect((await view(ALFA)).credentialMode).toBe('access_key');
  });

  it('o "Verificar" comum continua valendo: a homologação segue recusada, e a pilha atualizada é relida', async () => {
    start({ me: demoMe('admin_verax', { scopeTenantId: '018f2c1e-0000-7000-8000-00000000be7a' }) });
    await api.post(path(BETA, 'verify'), undefined, cloudAccountSchema);
    const verifying = await view(BETA);
    expect(verifying.state).toBe('awaiting_authorization');
    expect(verifying.connect.waitingUntil).toBeNull();
    expect(checkOf(verifying, 'assume_role')).toMatchObject({ status: 'pending', code: 'verifying' });
    pass(DEMO_AWS_CHECK_DELAY_MS);
    // A demonstração acha a pilha no modelo atual: as autorizações mudaram, e a descoberta roda de novo.
    const verified = await view(BETA);
    expect(verified.template).toMatchObject({ version: 2, outdated: false });
    expect(verified.template.capabilities).toHaveLength(4);
    pass(DEMO_AWS_DISCOVERY_REQUEST_MS);
    expect((await view(BETA)).discovery.run?.status).toBe('pending');
    expect(DEMO_ACCOUNTS.beta).toBe('777788889999');
  });
});

describe('a escolha das autorizações, as conferências com as fontes e a descoberta disponível', () => {
  it('a escolha do "Conectar" fica gravada, volta em toda leitura, e a pilha da demonstração sai com ela', async () => {
    start();
    const account = await create('246813579135');
    expect((await view(account.id)).connect.capabilities).toBeNull();
    // Em qualquer ordem no pedido; guardada na ordem do catálogo.
    const requested = await write(account.id, 'connect', { capabilities: ['findings', 'service-logs'] });
    expect(requested.connect.capabilities).toEqual(['service-logs', 'findings']);
    // O pedido pendente não é renovado, mas a escolha nova é gravada (o cliente mudou as caixas na espera).
    const changed = await write(account.id, 'connect', { capabilities: ['service-logs'] });
    expect(changed.connect).toEqual({ ...requested.connect, capabilities: ['service-logs'] });
    // Sem corpo, a escolha fica.
    expect((await write(account.id, 'connect')).connect.capabilities).toEqual(['service-logs']);
    pass(DEMO_AWS_CONNECT_DELAY_MS);
    const connected = await view(account.id);
    // A pilha "criada" tem a descoberta e só o que foi escolhido: nunca as três por conta própria.
    expect(connected.template).toMatchObject({ version: 2, capabilities: ['discovery', 'service-logs'] });
    expect(connected.connect.capabilities).toEqual(['service-logs']);
    // Fora do contrato: 400, como na API.
    for (const body of [
      { capabilities: ['discovery'] },
      { capabilities: ['findings', 'findings'] },
      { extra: 1 },
    ]) {
      await expect(write(account.id, 'connect', body)).rejects.toMatchObject({ status: 400 });
    }
    expect((await view(account.id)).connect.capabilities).toEqual(['service-logs']);
  });

  it('o "Verificar" com a escolha nova (depois de atualizar a pilha) a grava, e a pilha da demonstração a acompanha', async () => {
    start();
    const account = await create('246813579136');
    await write(account.id, 'connect', { capabilities: ['service-logs'] });
    pass(DEMO_AWS_CONNECT_DELAY_MS);
    await view(account.id);
    await api.post(
      path(account.id, 'verify'),
      { capabilities: ['service-logs', 'log-groups'] },
      cloudAccountSchema,
    );
    expect((await view(account.id)).connect.capabilities).toEqual(['service-logs', 'log-groups']);
    pass(DEMO_AWS_CHECK_DELAY_MS);
    expect((await view(account.id)).template.capabilities).toEqual([
      'discovery',
      'service-logs',
      'log-groups',
    ]);
    // O "Verificar" sem corpo não toca na escolha; fora do contrato, 400.
    await api.post(path(account.id, 'verify'), undefined, cloudAccountSchema);
    expect((await view(account.id)).connect.capabilities).toEqual(['service-logs', 'log-groups']);
    await expect(
      api.post(path(account.id, 'verify'), { capabilities: ['discovery'] }, cloudAccountSchema),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('as conferências das fontes citam as fontes que as seguram, pelos IDs da própria conta', async () => {
    start();
    const alfa = await view(ALFA);
    const idsOf = (predicate: (source: AwsOnboarding['sources'][number]) => boolean) =>
      alfa.sources
        .filter(
          (source) => source.authorization.authorizedAt !== null && source.authorization.revokedAt === null,
        )
        .filter(predicate)
        .map((source) => source.id)
        .sort();
    const cited = (id: (typeof AWS_ONBOARDING_CHECK_IDS)[number]) =>
      [...(checkOf(alfa, id)?.sourceIds ?? [])].sort();
    // A permissão: todas as negadas; os eventos: as com erro de ingestão ou paradas; o atraso: as paradas.
    expect(cited('permission')).toEqual(
      idsOf((source) => source.state === 'permission_error' || source.permission === 'missing'),
    );
    expect(cited('permission').length).toBeGreaterThan(0);
    expect(cited('events')).toEqual(
      idsOf((source) => source.state === 'ingestion_error' || source.state === 'stalled'),
    );
    expect(cited('lag')).toEqual(idsOf((source) => source.state === 'stalled'));
    expect(cited('collector_config')).toEqual(
      idsOf((source) => source.state === 'authorized' || source.state === 'configuring'),
    );
    // As quatro primeiras nunca citam fonte.
    for (const id of ['assume_role', 'identity', 'template', 'discovery'] as const) {
      expect(checkOf(alfa, id)?.sourceIds).toBeUndefined();
    }
    const known = new Set(alfa.sources.map((source) => source.id));
    for (const check of alfa.checks) for (const id of check.sourceIds ?? []) expect(known.has(id)).toBe(true);
  });

  it('a demonstração descobre as fontes sozinha: a resposta diz isso em toda conta', async () => {
    start();
    for (const id of [ALFA, HOMOLOGACAO]) expect((await view(id)).discoveryAvailable).toBe(true);
  });
});
