import {
  AWS_ONBOARDING_CHECK_IDS,
  AWS_SOURCE_AVAILABILITIES,
  AWS_SOURCE_KINDS,
  AWS_SOURCE_PERMISSION_CODES,
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
  it('a produção da Alfa: parcialmente operacional, com a descoberta parcial e a leitura dos grupos desligada', async () => {
    start();
    const alfa = await view(ALFA);
    expect(alfa.state).toBe('partial');
    expect(alfa.credentialMode).toBe('role');
    expect(alfa.template).toMatchObject({
      version: 2,
      outdated: false,
      capabilities: ['discovery', 'service-logs', 'findings'],
    });
    expect(alfa.checks.map((check) => check.id)).toEqual([...AWS_ONBOARDING_CHECK_IDS]);
    expect(checkOf(alfa, 'discovery')).toMatchObject({ status: 'ok', code: 'partial' });
    expect(checkOf(alfa, 'events')).toMatchObject({ status: 'failed', code: 'stalled' });
    expect(checkOf(alfa, 'lag')).toMatchObject({ status: 'failed', code: 'stalled' });
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
    expect((await view(id)).sources.find((source) => source.id === trail.id)?.state).toBe('configuring');
    pass(DEMO_AWS_COLLECTOR_MS.waitingEvents - DEMO_AWS_COLLECTOR_MS.configuring);
    expect((await view(id)).sources.find((source) => source.id === trail.id)?.state).toBe('waiting_events');
    // A API de achados coleta antes da trilha: só parte das fontes coletando.
    pass(DEMO_AWS_COLLECTOR_MS.api - DEMO_AWS_COLLECTOR_MS.waitingEvents);
    expect((await view(id)).state).toBe('partial');
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

    for (const [accountId, state, sourceState] of [
      [DEMO_AWS_SCENARIO_ACCOUNTS.permissionError, 'permission_error', 'permission_error'],
      [DEMO_AWS_SCENARIO_ACCOUNTS.ingestionFailure, 'ingestion_failure', 'ingestion_error'],
    ] as const) {
      const { id } = await create(accountId);
      const discovered = await connectAndDiscover(id);
      const trail = discovered.sources.find(
        (source) => source.kind === 'cloudtrail' && source.state === 'available',
      );
      if (!trail) throw new Error('a descoberta da demonstração não achou a trilha');
      await write(id, 'sources/authorize', { sourceIds: [trail.id] });
      pass(DEMO_AWS_COLLECTOR_MS.collecting);
      const failed = await view(id);
      expect(failed.state, accountId).toBe(state);
      expect(failed.sources.find((source) => source.id === trail.id)?.state, accountId).toBe(sourceState);
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
    await write(id, 'sources/authorize', { sourceIds: available.slice(0, 3).map((source) => source.id) });
    for (const source of (await view(id)).sources) seen.add(source.state);
    pass(DEMO_AWS_COLLECTOR_MS.collecting);
    for (const source of (await view(id)).sources) seen.add(source.state);
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

  it('quem só lê vê o estado e não escreve; a conta de outro cliente não existe; a VM própria lê com a chave', async () => {
    start({ me: demoMe('leitura') });
    expect((await view(ALFA)).state).toBe('partial');
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
