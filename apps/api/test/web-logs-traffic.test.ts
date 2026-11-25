import 'reflect-metadata';
import { randomBytes, randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type Role, ROLES, type WebTraffic, webTrafficSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestAuth } from '../src/common/auth/request-auth.js';
import { requestContext } from '../src/common/context/request-context.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { webLogsStream } from '../src/weblogs/collect/source-config.js';
import { WebTrafficService } from '../src/weblogs/map/web-traffic.service.js';
import { type TrafficDelta, WebTrafficStore } from '../src/weblogs/store/web-traffic-store.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { times } from './support/alb-lines.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { deliver } from './support/fake-alb-s3.js';
import type { TestSession } from './support/tenant-isolation.js';
import { NOON, START, webLogsHarness } from './support/web-logs-harness.js';

const MINUTE = 60_000;
const SLOT = 5 * MINUTE;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PATH = '/v1/web-logs/traffic';

/** O fim do intervalo fechado mais novo, agora (o leitor o fecha 10 minutos depois). */
const closedNow = (): Date => new Date(Math.floor((Date.now() - 10 * MINUTE) / SLOT) * SLOT);
const before = (at: Date, ms: number): Date => new Date(at.getTime() - ms);

interface Balancer {
  tenantId: string;
  cloudAccountId: string;
  sourceId: string;
  resourceId: string;
  region: string;
}

/**
 * O mapa de origens das requisições (`GET /v1/web-logs/traffic`), com os ataques web ligados no nó: quem lê, só o cliente da
 * sessão (também na memória curta), os estados da leitura, as janelas e o "agora" preso ao último intervalo fechado.
 */
describe('mapa de origens das requisições', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let store: WebTrafficStore;
  let tenantA: string;
  let tenantB: string;
  let verax: TestSession;
  let adminB: TestSession;
  const sessions = new Map<Role, TestSession>();

  async function sessionFor(tenantId: string | null, role: Role): Promise<TestSession> {
    const user = await createSignedInUser(app, { role, ...(tenantId !== null && { tenantId }) });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }
  const get = (as: TestSession, path = PATH) =>
    request(app.getHttpServer()).get(path).set('Cookie', as.cookie);
  const read = async (as: TestSession, path = PATH): Promise<WebTraffic> =>
    webTrafficSchema.parse((await get(as, path).expect(200)).body);
  /** A equipe da Verax olhando um cliente (troca de cliente na sessão). */
  async function readAs(tenantId: string, path = PATH): Promise<WebTraffic> {
    await request(app.getHttpServer())
      .post('/v1/session/tenant')
      .set('Cookie', verax.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', verax.csrfToken)
      .send({ tenantId })
      .expect(200);
    return read(verax, path);
  }
  const newTenant = (name: string) => createTenant(app, `Cliente Demo ${name} (mapa)`);

  /** Um balanceador autorizado há 5 dias, coletando, com a leitura em dia. */
  async function balancer(
    tenantId: string,
    over: {
      account?: Partial<Prisma.CloudAccountUncheckedCreateInput>;
      source?: Partial<Prisma.AwsSourceUncheckedCreateInput>;
      position?: Date | null;
      mode?: 'observe' | 'alert' | null;
      cloudAccountId?: string;
    } = {},
  ): Promise<Balancer> {
    const cloudAccountId =
      over.cloudAccountId ??
      (
        await prisma.cloudAccount.create({
          data: {
            tenantId,
            provider: 'aws',
            accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
            regions: ['sa-east-1'],
            connection: 'connected',
            ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
            ...over.account,
          },
        })
      ).id;
    const resourceId = `loja-${randomBytes(4).toString('hex')}`;
    const source = await prisma.awsSource.create({
      data: {
        tenantId,
        cloudAccountId,
        kind: 'elb_logs',
        region: 'sa-east-1',
        resourceId,
        name: resourceId,
        method: 's3',
        availability: 'available',
        permission: 'granted',
        authorizedAt: new Date(Date.now() - 5 * DAY),
        state: 'collecting',
        lastEventAt: before(closedNow(), MINUTE),
        lastIngestedAt: new Date(Date.now() - MINUTE),
        ...over.source,
      },
    });
    if (over.mode !== null) {
      await prisma.webSourceSettings.create({
        data: { sourceId: source.id, tenantId, mode: over.mode ?? 'observe' },
      });
    }
    const position = over.position === undefined ? closedNow() : over.position;
    if (position !== null) {
      await prisma.collectorCursor.create({
        data: {
          cloudAccountId,
          stream: webLogsStream(source.resourceId),
          region: source.region,
          cursorAt: position,
        },
      });
    }
    return {
      tenantId,
      cloudAccountId,
      sourceId: source.id,
      resourceId: source.resourceId,
      region: source.region,
    };
  }

  const delta = (target: Balancer, slotStart: Date, over: Partial<TrafficDelta> = {}): TrafficDelta => ({
    tenantId: target.tenantId,
    sourceId: target.sourceId,
    slotStart,
    country: 'BR',
    clientClass: 'direct',
    requests: 10,
    blocked: 1,
    clientErrors: 2,
    serverErrors: 3,
    flagged: 4,
    ...over,
  });
  const add = (...deltas: TrafficDelta[]) => prisma.$transaction((tx) => store.add(tx, deltas));
  const hourOf = (at: Date): Date => new Date(Math.floor(at.getTime() / HOUR) * HOUR);
  /** Uma hora já passada (o que a tarefa grava depois de 48 h). */
  const addHour = (target: Balancer, hourStart: Date, requests: number, country = 'BR') =>
    prisma.webTrafficHour.create({
      data: {
        tenantId: target.tenantId,
        sourceId: target.sourceId,
        hourStart,
        country,
        clientClass: 'direct',
        requests: BigInt(requests),
        blocked: 0n,
        clientErrors: 0n,
        serverErrors: 0n,
        flagged: 0n,
      },
    });
  const codes = (traffic: WebTraffic) => traffic.countries.map((item) => `${item.code} ${item.requests}`);

  beforeAll(async () => {
    app = await createApp({ awsWebLogs: true, plan: { PLAN: 'profissional' } });
    prisma = app.get(PrismaService);
    store = new WebTrafficStore(prisma);
    tenantA = await newTenant('A');
    tenantB = await newTenant('B');
    for (const role of ['admin_cliente', 'analista_cliente', 'leitura'] as const) {
      sessions.set(role, await sessionFor(tenantA, role));
    }
    adminB = await sessionFor(tenantB, 'admin_cliente');
    verax = await sessionFor(null, 'admin_verax');
    sessions.set('admin_verax', verax);
  });

  afterAll(async () => {
    await app.close();
  });

  it('sem sessão, 401; sem cliente escolhido, 409; toda query fora do contrato, 400', async () => {
    await request(app.getHttpServer()).get(PATH).expect(401);
    const staff = await sessionFor(null, 'admin_verax');
    expect((await get(staff).expect(409)).body).toMatchObject({ code: 'TENANT_REQUIRED' });
    const admin = sessions.get('admin_cliente') as TestSession;
    for (const query of [
      'window=1h',
      'window=',
      'window=24h&window=7d',
      `tenantId=${tenantB}`,
      'sourceId=x',
    ]) {
      await get(admin, `${PATH}?${query}`).expect(400);
    }
  });

  it('todos os papéis leem, e cada cliente só o seu, também com a memória quente e o mesmo nome de balanceador', async () => {
    const a = await balancer(tenantA);
    const slot = before(closedNow(), SLOT);
    await add(
      delta(a, slot, { requests: 70 }),
      delta(a, before(slot, 2 * HOUR), { requests: 30, country: 'US', flagged: 0 }),
      delta(a, slot, { requests: 5, country: 'US', clientClass: 'proxy' }),
      delta(a, slot, { requests: 3, country: 'ZZ', clientClass: 'private' }),
      delta(a, slot, { requests: 2, country: 'ZZ' }),
      delta(a, slot, { requests: 1, country: 'DE', clientClass: 'unverified' }),
    );
    // O cliente B ainda não tem balanceador.
    expect(await read(adminB)).toMatchObject({
      state: 'no_source',
      countries: [],
      lastClosedAt: null,
      lastLogAt: null,
    });

    await readAs(tenantA);
    for (const role of ROLES) {
      const traffic = await read(sessions.get(role) as TestSession);
      expect(traffic.state, role).toBe('ok');
      expect(traffic.countries, role).toEqual([
        { code: 'BR', requests: 70, blocked: 1, flagged: 4, recentRequests: 70, recentFlagged: 4 },
        { code: 'US', requests: 30, blocked: 1, flagged: 0, recentRequests: 0, recentFlagged: 0 },
      ]);
      expect(traffic).toMatchObject({
        unknown: { requests: 2 },
        throughProxy: { requests: 5 },
        internal: { requests: 3 },
        unverified: { requests: 1 },
        sources: { authorized: 1, collecting: 1, observing: 1, failing: 0 },
      });
    }

    // Nada que identifique o balanceador, a conta, a fonte ou o cliente sai na resposta.
    const text = JSON.stringify((await get(sessions.get('leitura') as TestSession).expect(200)).body);
    const account = await prisma.cloudAccount.findUniqueOrThrow({ where: { id: a.cloudAccountId } });
    for (const secret of [a.sourceId, a.cloudAccountId, a.tenantId, a.resourceId, account.accountId]) {
      expect(text).not.toContain(secret);
    }

    // Outro cliente, com um balanceador de mesmo nome e região: nem o tráfego, nem a posição, nem o modo de A.
    const tenant = await newTenant('C');
    await balancer(tenant, {
      source: { resourceId: a.resourceId, lastEventAt: null },
      position: null,
      mode: 'alert',
    });
    expect(await readAs(tenant)).toMatchObject({
      state: 'stale',
      countries: [],
      unknown: { requests: 0 },
      lastClosedAt: null,
      sources: { authorized: 1, collecting: 0, observing: 0, failing: 0 },
    });
    expect(codes(await read(sessions.get('admin_cliente') as TestSession))).toEqual(['BR 70', 'US 30']);
  });

  it('a memória de 30 s: pedidos juntos e seguidos dão o mesmo cálculo; cada janela tem a sua', async () => {
    const tenant = await newTenant('D');
    const target = await balancer(tenant);
    await add(delta(target, before(closedNow(), SLOT)));
    const byCountry = vi.spyOn(WebTrafficStore.prototype, 'byCountry');
    try {
      await readAs(tenant);
      const calls = byCountry.mock.calls.length;
      expect(calls).toBe(2);
      expect(byCountry.mock.calls.every(([tenantId]) => tenantId === tenant)).toBe(true);
      await add(delta(target, before(closedNow(), SLOT), { requests: 1_000 }));
      const again = await Promise.all([read(verax), read(verax)]);
      expect(again.map(codes)).toEqual([['BR 10'], ['BR 10']]);
      expect(byCountry).toHaveBeenCalledTimes(calls);
      expect(codes(await read(verax, `${PATH}?window=7d`))).toEqual(['BR 1010']);
      expect(byCountry).toHaveBeenCalledTimes(calls + 2);
    } finally {
      byCountry.mockRestore();
    }
  });

  it('"agora" são os 15 minutos até o último intervalo fechado: o mais novo e o mais velho ficam de fora', async () => {
    const tenant = await newTenant('E');
    const target = await balancer(tenant);
    const closed = closedNow();
    await add(
      // O intervalo depois do fechado (ainda incompleto) conta na janela, e não no agora.
      delta(target, closed, { country: 'AR' }),
      delta(target, before(closed, SLOT), { country: 'BR', requests: 1, flagged: 1 }),
      delta(target, before(closed, 2 * SLOT), { country: 'BR', requests: 2, flagged: 0 }),
      delta(target, before(closed, 3 * SLOT), { country: 'BR', requests: 4, flagged: 0 }),
      delta(target, before(closed, 4 * SLOT), { country: 'BR', requests: 8, flagged: 1 }),
      delta(target, before(closed, 4 * SLOT), { country: 'CL' }),
    );
    const traffic = await readAs(tenant);
    expect(traffic.lastClosedAt).toBe(closed.toISOString());
    expect(
      traffic.countries.map(({ code, requests, recentRequests, recentFlagged }) => [
        code,
        requests,
        recentRequests,
        recentFlagged,
      ]),
    ).toEqual([
      ['BR', 15, 7, 1],
      ['AR', 10, 0, 0],
      ['CL', 10, 0, 0],
    ]);
  });

  it('parado: sem ler um intervalo novo há mais de 45 minutos, nada é de agora, e diz o log mais novo', async () => {
    const tenant = await newTenant('F');
    const position = before(closedNow(), HOUR);
    const lastEventAt = before(position, 2 * MINUTE);
    const target = await balancer(tenant, { position, source: { state: 'stalled', lastEventAt } });
    await add(delta(target, before(position, SLOT)));
    expect(await readAs(tenant)).toMatchObject({
      state: 'stale',
      countries: [{ code: 'BR', requests: 10, recentRequests: 0, recentFlagged: 0 }],
      lastClosedAt: position.toISOString(),
      lastLogAt: lastEventAt.toISOString(),
      sources: { authorized: 1, collecting: 0, observing: 1, failing: 1 },
    });
  });

  it('aguardando: autorizado e ainda sem log; o alertando não conta como só observando', async () => {
    const tenant = await newTenant('G');
    await balancer(tenant, {
      position: null,
      mode: 'alert',
      source: {
        state: 'authorized',
        authorizedAt: new Date(Date.now() - 3 * MINUTE),
        lastEventAt: null,
        lastIngestedAt: null,
      },
    });
    expect(await readAs(tenant)).toMatchObject({
      state: 'waiting',
      countries: [],
      lastClosedAt: null,
      lastLogAt: null,
      sources: { authorized: 1, collecting: 0, observing: 0, failing: 0 },
    });
  });

  it('só conta como fonte o balanceador descoberto, autorizado, não retirado, num estado de coleta, de conta ativa', async () => {
    const tenant = await newTenant('H');
    const now = new Date();
    const revoked = await balancer(tenant, { source: { state: 'revoked', revokedAt: now } });
    await add(delta(revoked, before(closedNow(), SLOT)));
    await balancer(tenant, { source: { state: 'available', authorizedAt: null } });
    await balancer(tenant, { source: { state: 'source_missing' } });
    await balancer(tenant, { account: { status: 'inactive' } });
    await balancer(tenant, { source: { kind: 'waf' } });
    // Sem fonte, nem o que já foi lido aparece: o painel é o de quem não tem os logs.
    expect(await readAs(tenant)).toMatchObject({
      state: 'no_source',
      countries: [],
      sources: { authorized: 0, collecting: 0, observing: 0, failing: 0 },
    });
  });

  it('vários balanceadores, de várias contas: as contagens se somam, e o agora é o do mais em dia', async () => {
    const tenant = await newTenant('I');
    const closed = closedNow();
    const first = await balancer(tenant, { mode: 'alert' });
    const second = await balancer(tenant, {
      position: before(closed, 2 * HOUR),
      source: { state: 'permission_error', lastEventAt: before(closed, 3 * HOUR) },
    });
    const third = await balancer(tenant, { cloudAccountId: first.cloudAccountId, mode: null });
    await add(
      delta(first, before(closed, SLOT), { requests: 1 }),
      delta(second, before(closed, 2 * HOUR + SLOT), { requests: 2 }),
      delta(third, before(closed, SLOT), { requests: 4 }),
      delta(third, before(closed, SLOT), { requests: 8, country: 'PT' }),
    );
    expect(await readAs(tenant)).toMatchObject({
      state: 'ok',
      lastClosedAt: closed.toISOString(),
      countries: [
        { code: 'PT', requests: 8, recentRequests: 8 },
        { code: 'BR', requests: 7, recentRequests: 5 },
      ],
      // Sem a linha da configuração, o balanceador só observa.
      sources: { authorized: 3, collecting: 2, observing: 2, failing: 1 },
    });
  });

  it('as janelas: 24 h por intervalo de 5 minutos; 7 e 30 dias com as horas que já passaram', async () => {
    const tenant = await newTenant('J');
    const target = await balancer(tenant);
    const slotNow = new Date(Math.floor(Date.now() / SLOT) * SLOT);
    const hour = hourOf(new Date());
    await add(
      // A folga de um intervalo: o relógio anda entre a montagem e o pedido.
      delta(target, before(slotNow, 23 * HOUR), { requests: 1 }),
      delta(target, before(slotNow, 24 * HOUR + 2 * SLOT), { requests: 10 }),
    );
    await addHour(target, before(hour, 3 * DAY), 100);
    await addHour(target, before(hour, 6 * DAY), 1_000);
    await addHour(target, before(hour, 7 * DAY + 2 * HOUR), 10_000);
    await addHour(target, before(hour, 29 * DAY), 100_000);
    await addHour(target, before(hour, 30 * DAY + 2 * HOUR), 1_000_000);
    expect(codes(await readAs(tenant))).toEqual(['BR 1']);
    expect(await read(verax)).toMatchObject({ window: '24h', windowHours: 24 });
    expect(codes(await read(verax, `${PATH}?window=24h`))).toEqual(['BR 1']);
    const week = await read(verax, `${PATH}?window=7d`);
    expect(codes(week)).toEqual(['BR 1111']);
    expect(week).toMatchObject({ window: '7d', windowHours: 168 });
    const month = await read(verax, `${PATH}?window=30d`);
    expect(codes(month)).toEqual(['BR 111111']);
    expect(month).toMatchObject({ window: '30d', windowHours: 720 });
  });

  it('do arquivo no S3 ao mapa: a leitura de verdade, passagem a passagem, com o agora andando com ela', async () => {
    const h = webLogsHarness(prisma);
    const site = await h.newSite('mapa');
    const { task, s3, clock } = h.newTask([site.tenantId]);
    deliver(s3, site.balancer, NOON, [
      ...times(10, () => ({ client: '192.0.2.10', path: '/produtos', time: NOON - 2 * MINUTE })),
      ...times(4, (i) => ({
        client: '198.51.100.7',
        method: 'POST',
        path: '/login',
        status: 401,
        time: NOON - 4 * MINUTE + i * 1_000,
      })),
      // Pela CDN: o país do endereço é o da borda.
      ...times(3, () => ({ client: '203.0.113.5', time: NOON - 2 * MINUTE })),
    ]);
    /** O que a rota responde no relógio do teste, sem a memória de antes. */
    const at = async (): Promise<WebTraffic> => {
      vi.useFakeTimers({ toFake: ['Date'], now: clock.now() });
      try {
        const auth = { scopeTenantId: site.tenantId } as RequestAuth;
        const traffic = await requestContext.run({ auth }, () =>
          new WebTrafficService(prisma).traffic({ window: '24h' }),
        );
        return webTrafficSchema.parse(traffic);
      } finally {
        vi.useRealTimers();
      }
    };

    expect(await at()).toMatchObject({ state: 'waiting', countries: [], lastClosedAt: null });
    await task.runOnce();
    // 12:01: o arquivo das 11:55 ao meio-dia já conta, e o último intervalo fechado ainda é o das 11:50.
    expect(await at()).toMatchObject({
      state: 'ok',
      lastClosedAt: new Date(NOON - 10 * MINUTE).toISOString(),
      lastLogAt: new Date(NOON - 2 * MINUTE).toISOString(),
      countries: [
        { code: 'BR', requests: 10, flagged: 0, recentRequests: 0 },
        { code: 'US', requests: 4, flagged: 4, recentRequests: 0, recentFlagged: 0 },
      ],
      throughProxy: { requests: 3 },
      sources: { authorized: 1, collecting: 1, observing: 0, failing: 0 },
    });
    clock.advance(10 * MINUTE);
    await task.runOnce();
    // 12:11: o intervalo fechou, e o que está nele é o agora.
    expect(await at()).toMatchObject({
      state: 'ok',
      lastClosedAt: new Date(NOON).toISOString(),
      countries: [
        { code: 'BR', requests: 10, recentRequests: 10 },
        { code: 'US', requests: 4, recentRequests: 4, recentFlagged: 4 },
      ],
    });
    // Sem mais arquivos, a leitura segue em dia: o site está quieto, e nada é de agora.
    clock.advance(30 * MINUTE);
    await task.runOnce();
    expect(await at()).toMatchObject({
      state: 'ok',
      countries: [
        { code: 'BR', requests: 10, recentRequests: 0 },
        { code: 'US', requests: 4, recentRequests: 0 },
      ],
    });
    // Com o worker parado, o mapa diz que parou.
    clock.advance(40 * MINUTE);
    expect(await at()).toMatchObject({ state: 'stale', countries: [{ code: 'BR' }, { code: 'US' }] });
    expect(clock.now().getTime() - START.getTime()).toBe(80 * MINUTE);
  });

  it('no pior caso de países, a resposta cabe no contrato', async () => {
    const tenant = await newTenant('K');
    const target = await balancer(tenant);
    const all = Array.from({ length: 26 * 26 }, (_, i) =>
      String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
    );
    await add(...all.map((country) => delta(target, before(closedNow(), SLOT), { country })));
    const traffic = await readAs(tenant);
    expect(traffic.countries).toHaveLength(675);
    expect(traffic.unknown.requests).toBe(10);
  });
});
