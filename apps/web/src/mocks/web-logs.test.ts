import {
  awsOnboardingSchema,
  findingEvidenceSchema,
  findingDetailSchema,
  findingSchema,
  paginatedSchema,
  type Role,
  WEB_OBSERVE_MS,
  WEB_ROUTES_LIMIT,
  type WebLogSource,
  webLogSourceListSchema,
  webLogSourceSchema,
  webRouteListSchema,
  webRouteSchema,
  webSourceHealthSchema,
  webTrustedSourceListSchema,
  webTrustedSourceSchema,
} from '@verax/shared';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ApiRequestError } from '@/lib/api-client';
import { fetchWebLogSources } from '@/features/web-attacks/web-logs-api';
import { acknowledgementOf, usableEstimate } from '@/features/web-attacks/estimate';
import { DEMO_AWS_COLLECTOR_MS } from './aws-onboarding';
import { demoMe } from './fixtures';
import { createHandlers, type MockState } from './handlers';
import { DEMO_ALBS, DEMO_WEB_ESTIMATE_DELAY_MS } from './web-logs';

/** Os ataques web na demonstração: as mesmas regras da API, e os estados que as telas precisam mostrar. */

const ALFA = '018f2c1e-0000-7000-8000-0000000c0001';
const server = setupServer();
beforeAll(() => server.listen());
beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-24T15:00:00.000Z'), toFake: ['Date'] }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.useRealTimers();
});
afterAll(() => server.close());

const pass = (ms: number) => vi.setSystemTime(Date.now() + ms);
const HOUR = 3_600_000;
const start = (role: Role = 'admin_cliente', state: Partial<MockState> = {}) =>
  server.use(...createHandlers({ me: demoMe(role), ...state }));

async function all(): Promise<WebLogSource[]> {
  const sources = await fetchWebLogSources(ALFA);
  if (sources === null) throw new Error('os ataques web estão ligados na demonstração');
  return sources;
}
async function byName(name: string): Promise<WebLogSource> {
  const source = (await all()).find((item) => item.name === name);
  if (source === undefined) throw new Error(`sem o balanceador ${name}`);
  return source;
}
const path = (source: Pick<WebLogSource, 'id'>, rest = '') => `/v1/web-logs/sources/${source.id}${rest}`;
const refused = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ApiRequestError)) throw new Error('o pedido não foi recusado');
  return { status: error.status, code: error.code };
};
const authorize = (source: WebLogSource, acknowledged: boolean, overrides = {}) => {
  const usable = usableEstimate(source, Date.now());
  if (usable === null) throw new Error('a estimativa não vale');
  return api.post(
    `/v1/cloud-accounts/${ALFA}/aws/sources/authorize`,
    {
      sourceIds: [source.id],
      webLogs: [{ ...acknowledgementOf(source.id, usable, acknowledged), ...overrides }],
    },
    awsOnboardingSchema,
  );
};

describe('a demonstração cobre os estados das telas', () => {
  it('três autorizados, e os outros com cada situação da estimativa', async () => {
    start();
    const observing = await byName(DEMO_ALBS.observing);
    expect(observing).toMatchObject({ authorized: true, settings: { mode: 'observe' } });
    const left = Date.parse(observing.settings?.observeUntil ?? '') - Date.now();
    expect(left).toBe(WEB_OBSERVE_MS - 30 * HOUR);
    expect((await byName(DEMO_ALBS.alerting)).settings).toMatchObject({
      mode: 'alert',
      thresholdMultiplier: 1.5,
    });
    const ready = await byName(DEMO_ALBS.ready);
    expect(Date.parse(ready.settings?.observeUntil ?? '')).toBeLessThan(Date.now());
    expect((await byName(DEMO_ALBS.heavy)).estimate?.projection).toMatchObject({
      gbPerDay: 1,
      percent: 46.6,
      basis: 'monthly',
      acknowledgementRequired: true,
    });
    expect((await byName(DEMO_ALBS.noSample)).estimate).toMatchObject({ status: 'no_sample' });
    expect((await byName(DEMO_ALBS.failed)).estimate).toMatchObject({
      status: 'failed',
      errorCode: 'bucket_denied',
    });
    expect((await byName(DEMO_ALBS.expired)).estimate).toMatchObject({ status: 'ready', projection: null });
    expect((await byName(DEMO_ALBS.fresh)).estimate).toBeNull();
  });

  it('a leitura de cada autorizado: a observação, os recusados, a lacuna e a CDN', async () => {
    start();
    const health = async (name: string) =>
      api.get(path(await byName(name), '/health'), webSourceHealthSchema);
    const observing = await health(DEMO_ALBS.observing);
    expect(observing.observation?.rules.length).toBeGreaterThan(2);
    expect(observing.suppressed).toHaveLength(1);
    expect((await health(DEMO_ALBS.alerting)).objects.quarantined).toBeGreaterThan(0);
    const ready = await health(DEMO_ALBS.ready);
    expect(ready.objects.gap).toBeGreaterThan(0);
    expect(ready.gap).not.toBeNull();
    expect(ready.notes).toEqual(['behind_proxy']);
    // Sem autorização, nada foi lido.
    expect(await health(DEMO_ALBS.heavy)).toMatchObject({ bytes: 0, observation: null });
  });

  it('os achados do ALB: os do balanceador que está alertando, cada um com a evidência dele', async () => {
    start();
    const list = await api.get(
      '/v1/findings?source=alb&period=90d&pageSize=100',
      paginatedSchema(findingSchema),
    );
    expect(list.total).toBe(4);
    for (const item of list.items) {
      expect(item.resource).toContain(DEMO_ALBS.alerting);
      const detail = await api.get(`/v1/findings/${item.id}`, findingDetailSchema);
      expect(detail.rawEvent).toBeNull();
      const { evidence, samplesPurgedAt } = await api.get(
        `/v1/findings/${item.id}/evidence`,
        findingEvidenceSchema,
      );
      expect(evidence?.ruleId).toBe(detail.ruleId);
      // A de mais de 30 dias perdeu as amostras, e só ela.
      expect(samplesPurgedAt !== null).toBe(detail.ruleId === '990407');
      if (samplesPurgedAt !== null) expect(evidence?.samples).toEqual([]);
    }
    // Os achados das outras fontes não têm evidência própria.
    const other = await api.get('/v1/findings?source=waf&pageSize=1', paginatedSchema(findingSchema));
    expect(await api.get(`/v1/findings/${other.items[0]?.id}/evidence`, findingEvidenceSchema)).toEqual({
      evidence: null,
      samplesPurgedAt: null,
    });
  });

  it('sem os novos na conta: os altos e críticos para validar continuam os mesmos', async () => {
    start();
    const pending = await api.get(
      '/v1/findings?source=alb&period=90d&status=new',
      paginatedSchema(findingSchema),
    );
    expect(pending.items.map((item) => item.severity).sort()).toEqual(['low', 'medium']);
  });
});

describe('as regras, como as da API', () => {
  it('a estimativa: o pedido pendente não renova, a resposta chega, e outro só 5 minutos depois do anterior', async () => {
    start();
    const source = await byName(DEMO_ALBS.fresh);
    const asked = await api.post(path(source, '/estimate'), undefined, webLogSourceSchema);
    expect(asked.estimate).toMatchObject({ status: null, projection: null });
    const first = asked.estimate?.requestedAt;
    pass(1_000);
    expect(
      (await api.post(path(source, '/estimate'), undefined, webLogSourceSchema)).estimate?.requestedAt,
    ).toBe(first);
    pass(DEMO_WEB_ESTIMATE_DELAY_MS);
    const answered = await api.get(path(source), webLogSourceSchema);
    expect(answered.estimate).toMatchObject({
      requestedAt: null,
      status: 'ready',
      projection: { percent: 5.6, acknowledgementRequired: false },
    });
    expect(await refused(api.post(path(source, '/estimate')))).toEqual({
      status: 429,
      code: 'WEB_ESTIMATE_RATE_LIMITED',
    });
    pass(5 * 60_000);
    expect(
      (await api.post(path(source, '/estimate'), undefined, webLogSourceSchema)).estimate?.requestedAt,
    ).not.toBeNull();
  });

  it('o balanceador que não dá para ler não é estimado', async () => {
    start();
    expect(await refused(api.post(path(await byName(DEMO_ALBS.noLogs), '/estimate')))).toMatchObject({
      code: 'SOURCE_NOT_AVAILABLE',
    });
    expect(await refused(api.post(path(await byName(DEMO_ALBS.otherAccount), '/estimate')))).toMatchObject({
      code: 'SOURCE_PERMISSION_MISSING',
    });
  });

  it('a autorização confere a estimativa; aceita, começa a observar e chega à coleta', async () => {
    start();
    const heavy = await byName(DEMO_ALBS.heavy);
    const base = `/v1/cloud-accounts/${ALFA}/aws/sources/authorize`;
    expect(await refused(api.post(base, { sourceIds: [heavy.id] }))).toEqual({
      status: 409,
      code: 'WEB_LOGS_ESTIMATE_REQUIRED',
    });
    expect(await refused(authorize(heavy, true, { estimatedGbPerDay: 0.9 }))).toMatchObject({
      code: 'WEB_LOGS_ESTIMATE_CHANGED',
    });
    expect(await refused(authorize(heavy, false))).toMatchObject({
      code: 'WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED',
    });
    const after = await authorize(heavy, true);
    expect(after.sources.find((source) => source.id === heavy.id)).toMatchObject({ state: 'authorized' });
    const settings = (await byName(DEMO_ALBS.heavy)).settings;
    expect(settings).toMatchObject({ mode: 'observe', thresholdMultiplier: 1 });
    expect(Date.parse(settings?.observeUntil ?? '') - Date.now()).toBe(WEB_OBSERVE_MS);
    pass(DEMO_AWS_COLLECTOR_MS.collecting);
    const health = await api.get(path(heavy, '/health'), webSourceHealthSchema);
    expect(health.observation).toMatchObject({ rules: [], truncated: false });
    expect((await byName(DEMO_ALBS.heavy)).state).toBe('collecting');
  });

  it('o modo: alertar só depois da observação; e só do autorizado', async () => {
    start();
    const patch = async (name: string, body: object) =>
      api.patch(path(await byName(name), '/settings'), body, webLogSourceSchema);
    expect(await refused(patch(DEMO_ALBS.observing, { mode: 'alert' }))).toEqual({
      status: 409,
      code: 'WEB_OBSERVATION_PENDING',
    });
    expect((await patch(DEMO_ALBS.observing, { thresholdMultiplier: 2 })).settings).toMatchObject({
      mode: 'observe',
      thresholdMultiplier: 2,
    });
    expect((await patch(DEMO_ALBS.ready, { mode: 'alert' })).settings?.mode).toBe('alert');
    expect((await patch(DEMO_ALBS.alerting, { mode: 'observe' })).settings?.mode).toBe('observe');
    expect(await refused(patch(DEMO_ALBS.heavy, { mode: 'observe' }))).toMatchObject({
      code: 'SOURCE_NOT_AUTHORIZED',
    });
    expect(await refused(patch(DEMO_ALBS.ready, {}))).toMatchObject({ status: 400 });
  });

  it('as rotas: criar, recusar a repetida e o código nos dois lados, alterar, remover e o teto', async () => {
    start();
    const source = await byName(DEMO_ALBS.observing);
    const route = {
      host: null,
      method: 'POST',
      path: '/entrar',
      kind: 'login',
      failureCodes: [401],
      successCodes: [200],
      multiplier: 1,
    };
    const created = await api.post(path(source, '/routes'), route, webRouteSchema);
    expect(await refused(api.post(path(source, '/routes'), route))).toMatchObject({
      code: 'WEB_ROUTE_DUPLICATE',
    });
    expect(
      await refused(api.patch(path(source, `/routes/${created.id}`), { failureCodes: [200] })),
    ).toMatchObject({ status: 400 });
    expect(
      (await api.patch(path(source, `/routes/${created.id}`), { kind: 'mfa' }, webRouteSchema)).kind,
    ).toBe('mfa');
    for (let index = 1; index < WEB_ROUTES_LIMIT; index += 1) {
      await api.post(path(source, '/routes'), { ...route, path: `/entrar-${index}` });
    }
    expect(await refused(api.post(path(source, '/routes'), { ...route, path: '/mais' }))).toMatchObject({
      code: 'WEB_ROUTE_LIMIT_REACHED',
    });
    await api.delete(path(source, `/routes/${created.id}`));
    const list = await api.get(path(source, '/routes'), webRouteListSchema);
    expect(list.items).toHaveLength(WEB_ROUTES_LIMIT - 1);
    expect(await refused(api.delete(path(source, `/routes/${created.id}`)))).toMatchObject({ status: 404 });
  });

  it('as fontes confiáveis: a vencida à vista, a repetida e a validade recusadas, criar e remover', async () => {
    start();
    const base = '/v1/web-logs/trusted-sources';
    const list = await api.get(base, webTrustedSourceListSchema);
    expect(list.items.map((item) => item.active)).toEqual([true, true, false]);
    const body = {
      sourceId: null,
      cidr: '192.0.2.10/32',
      kind: 'office',
      reason: 'Escritório',
      expiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    };
    expect(await refused(api.post(base, body))).toMatchObject({ code: 'WEB_TRUSTED_DUPLICATE' });
    expect(
      await refused(
        api.post(base, { ...body, cidr: '192.0.2.11/32', expiresAt: new Date(Date.now() - 1).toISOString() }),
      ),
    ).toMatchObject({ code: 'WEB_TRUSTED_EXPIRY_INVALID' });
    const created = await api.post(base, { ...body, cidr: '192.0.2.11/32' }, webTrustedSourceSchema);
    const [, , expired] = list.items;
    const renewed = await api.patch(
      `${base}/${expired?.id}`,
      { expiresAt: body.expiresAt },
      webTrustedSourceSchema,
    );
    expect(renewed.active).toBe(true);
    await api.delete(`${base}/${created.id}`);
    expect((await api.get(base, webTrustedSourceListSchema)).items).toHaveLength(3);
  });
});

describe('quem pode e quando existe', () => {
  it('quem só lê não vê a parte do plano e não escreve nada', async () => {
    start('leitura');
    const source = await byName(DEMO_ALBS.heavy);
    expect(source.estimate).toMatchObject({ status: 'ready', projection: null });
    expect((await api.get(path(source, '/health'), webSourceHealthSchema)).sourceId).toBe(source.id);
    expect(await refused(api.post(path(source, '/estimate')))).toMatchObject({ status: 403 });
    expect(await refused(api.patch(path(source, '/settings'), { mode: 'observe' }))).toMatchObject({
      status: 403,
    });
    expect(await refused(api.post('/v1/web-logs/trusted-sources', {}))).toMatchObject({ status: 403 });
  });

  it('na franquia, a projeção é contra o dia', async () => {
    start('admin_cliente', { platform: true });
    expect((await byName(DEMO_ALBS.heavy)).estimate?.projection).toMatchObject({
      basis: 'franchise',
      percent: 33.3,
    });
  });

  it('desligados: tudo é 404, e o painel entende como inexistente', async () => {
    start('admin_cliente', { webLogs: false });
    expect(await fetchWebLogSources(ALFA)).toBeNull();
    expect(await refused(api.get('/v1/web-logs/trusted-sources'))).toEqual({
      status: 404,
      code: 'WEB_LOGS_DISABLED',
    });
    const onboarding = await api.get(`/v1/cloud-accounts/${ALFA}/aws/onboarding`, awsOnboardingSchema);
    const balancer = onboarding.sources.find((source) => source.name === DEMO_ALBS.heavy);
    expect(
      await refused(
        api.post(`/v1/cloud-accounts/${ALFA}/aws/sources/authorize`, { sourceIds: [balancer?.id] }),
      ),
    ).toMatchObject({ code: 'SOURCE_NOT_COLLECTABLE' });
  });

  it('um cliente não alcança os balanceadores nem as fontes confiáveis de outro', async () => {
    start();
    const source = await byName(DEMO_ALBS.heavy);
    server.resetHandlers();
    start('admin_verax', {
      me: demoMe('admin_verax', { scopeTenantId: '018f2c1e-0000-7000-8000-00000000be7a' }),
    });
    const list = await api.get('/v1/web-logs/sources?page=1&pageSize=100', webLogSourceListSchema);
    expect(list.items.every((item) => item.cloudAccountId !== ALFA)).toBe(true);
    expect(await refused(api.get(path(source)))).toMatchObject({ status: 404 });
    expect(await refused(api.get(path(source, '/health')))).toMatchObject({ status: 404 });
    expect((await api.get('/v1/web-logs/trusted-sources', webTrustedSourceListSchema)).items).toEqual([]);
  });
});
