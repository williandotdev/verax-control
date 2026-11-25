import 'reflect-metadata';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  type Role,
  ROLES,
  WEB_OBSERVE_MS,
  type WebSourceHealth,
  webObservationSchema,
  webSourceHealthSchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import {
  ENGINE_STATE_VERSION,
  type EngineStateJson,
  writeEngineState,
} from '../src/weblogs/collect/engine-state.js';
import { ENGINE_NOTES } from '../src/weblogs/engine.js';
import { SLOT_MS } from '../src/weblogs/limits.js';
import { WEB_RULES } from '../src/weblogs/rules.js';
import { readWebEngineView } from '../src/weblogs/store/web-engine-state.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
/** O começo do intervalo de 5 minutos. */
const slot = (ms: number) => new Date(Math.floor((Date.now() - ms) / SLOT_MS) * SLOT_MS);
const hex = () => randomInt(0x10000000, 0xffffffff).toString(16).padStart(16, '0');
/** Um endereço que só existe no resumo do dia guardado (RFC 5737). */
const DIGEST_IP = '203.0.113.77';
const KEYS = ['0123456789ab', 'abcdef012345'];

/**
 * `GET /v1/web-logs/sources/:sourceId/health`, com os ataques web ligados no nó: as contagens da leitura das últimas 24 h e o
 * que o painel pode ver da memória do motor. Nada de endereço, caminho ou chave.
 */
describe('ataques web pelos logs do ALB: a saúde da leitura', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession;
  let adminB: TestSession;
  const sessions = new Map<Role, TestSession>();

  async function sessionFor(tenantId: string | null, role: Role): Promise<TestSession> {
    const user = await createSignedInUser(app, { role, ...(tenantId !== null && { tenantId }) });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }
  const get = (as: TestSession, path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', as.cookie);
  const pathOf = (sourceId: string) => `/v1/web-logs/sources/${sourceId}/health`;
  /** A resposta, conferida com o contrato, e o texto dela. */
  async function health(sourceId: string, as = adminA): Promise<{ body: WebSourceHealth; text: string }> {
    const response = await get(as, pathOf(sourceId)).expect(200);
    return { body: webSourceHealthSchema.parse(response.body), text: response.text };
  }

  const AUTHORIZED = ago(30 * HOUR);
  const OBSERVE_UNTIL = new Date(AUTHORIZED.getTime() + WEB_OBSERVE_MS);

  /** Um balanceador autorizado há 30 h, observando. */
  async function balancer(
    tenantId = tenantA,
    data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {},
    observeUntil: Date | null = OBSERVE_UNTIL,
  ) {
    const account = await prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: ago(10 * DAY),
      },
      select: { id: true, accountId: true },
    });
    const name = `alb-${randomInt(1e6, 9e6)}`;
    const loadBalancer = `app/${name}/${hex()}`;
    const source = await prisma.awsSource.create({
      data: {
        tenantId,
        cloudAccountId: account.id,
        kind: 'elb_logs',
        region: 'sa-east-1',
        resourceId: name,
        name,
        details: {
          arn: `arn:aws:elasticloadbalancing:sa-east-1:${account.accountId}:loadbalancer/${loadBalancer}`,
          destinationType: 's3',
          bucket: 'acessos',
        },
        method: 's3',
        availability: 'available',
        permission: 'granted',
        authorizedAt: AUTHORIZED,
        state: 'collecting',
        ...data,
      },
      select: { id: true },
    });
    await prisma.webSourceSettings.create({
      data: { sourceId: source.id, tenantId, mode: 'observe', observeUntil },
    });
    return { id: source.id, tenantId, cloudAccountId: account.id, loadBalancer };
  }
  type Balancer = Awaited<ReturnType<typeof balancer>>;

  const object = (
    source: Balancer,
    status: 'read' | 'late' | 'quarantined' | 'gap',
    data: Partial<Prisma.WebLogObjectUncheckedCreateInput> = {},
  ) =>
    prisma.webLogObject.create({
      data: {
        cloudAccountId: source.cloudAccountId,
        tenantId: source.tenantId,
        sourceId: source.id,
        objectHash: createHash('sha256').update(randomUUID()).digest('hex'),
        status,
        slotStart: slot(HOUR),
        ...data,
      },
    });

  const observation = (overrides: Partial<EngineStateJson['observation']> = {}) => ({
    since: AUTHORIZED.toISOString(),
    rules: [
      {
        ruleId: '990405' as const,
        level: 10,
        findings: 3,
        firstSeenAt: ago(5 * HOUR).toISOString(),
        lastSeenAt: ago(HOUR).toISOString(),
      },
    ],
    truncated: false,
    keys: KEYS,
    ...overrides,
  });
  /** O estado como a tarefa o grava, com o resumo do dia (o único lugar com endereço). */
  const stateOf = (overrides: Partial<EngineStateJson> = {}): string =>
    writeEngineState({
      digest: {
        version: 1,
        settledThrough: null,
        days: [
          {
            day: Math.floor(Date.now() / DAY),
            clients: [
              [
                DIGEST_IP,
                {
                  requests: 12,
                  tool: 0,
                  probes: 12,
                  errors: 12,
                  families: 1,
                  firstMs: Date.now() - HOUR,
                  lastMs: Date.now(),
                },
              ],
            ],
            dropped: 0,
          },
        ],
        tracks: [[DIGEST_IP, { slots: [1], seriousMs: null, targetedMs: null }]],
      },
      observation: observation(),
      suppressed: [
        { trustedId: randomUUID(), ruleId: '990402', clients: 2, lastSeenAt: ago(HOUR).toISOString() },
      ],
      notes: ['behind_proxy'],
      ...overrides,
    });
  const save = (
    source: Balancer,
    json: string,
    data: Partial<Prisma.WebEngineStateUncheckedCreateInput> = {},
  ) =>
    prisma.webEngineState.create({
      data: {
        sourceId: source.id,
        tenantId: source.tenantId,
        loadBalancer: source.loadBalancer,
        version: ENGINE_STATE_VERSION,
        state: JSON.parse(json) as Prisma.InputJsonValue,
        ...data,
      },
    });

  beforeAll(async () => {
    app = await createApp({ awsWebLogs: true });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (saúde da leitura)');
    tenantB = await createTenant(app, 'Cliente Demo B (saúde da leitura)');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    sessions.set('admin_cliente', adminA);
    sessions.set('analista_cliente', await sessionFor(tenantA, 'analista_cliente'));
    sessions.set('leitura', await sessionFor(tenantA, 'leitura'));
    const verax = await sessionFor(null, 'admin_verax');
    await request(app.getHttpServer())
      .post('/v1/session/tenant')
      .set('Cookie', verax.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', verax.csrfToken)
      .send({ tenantId: tenantA })
      .expect(200);
    sessions.set('admin_verax', verax);
  });

  afterAll(async () => {
    await app.close();
  });

  it('sem nada lido: tudo zero, sem observação', async () => {
    const source = await balancer();
    const { body } = await health(source.id);
    expect(body).toEqual({
      sourceId: source.id,
      since: body.since,
      objects: { read: 0, late: 0, quarantined: 0, gap: 0 },
      lines: { analysed: 0, malformed: 0, oversize: 0, foreign: 0 },
      bytes: 0,
      gap: null,
      observation: null,
      suppressed: [],
      notes: [],
      stateAt: null,
    });
    const age = Date.now() - Date.parse(body.since);
    expect(age).toBeGreaterThanOrEqual(DAY);
    expect(age).toBeLessThan(DAY + MINUTE);
  });

  it('as contagens das últimas 24 h: o lido pelo horário do tráfego, o recusado e a lacuna por quando foram tratados', async () => {
    const source = await balancer();
    const counted = { lines: 1_000, bytes: 800_000n, malformed: 3, oversize: 2, foreign: 1 };
    await object(source, 'read', counted);
    await object(source, 'read', { ...counted, slotStart: slot(23 * HOUR) });
    await object(source, 'late', { ...counted, readAt: ago(MINUTE) });
    // Lido agora, de tráfego de mais de 24 h: não entra no volume do dia.
    await object(source, 'late', { ...counted, slotStart: slot(25 * HOUR) });
    await object(source, 'quarantined', { slotStart: null });
    await object(source, 'quarantined', { readAt: ago(25 * HOUR) });
    // A lacuna é sempre de tráfego com mais de 24 h; vale quando foi registrada.
    const [first, last] = [slot(40 * HOUR), slot(38 * HOUR)];
    await object(source, 'gap', { slotStart: first });
    await object(source, 'gap', { slotStart: last });
    await object(source, 'gap', { slotStart: slot(90 * HOUR), readAt: ago(26 * HOUR) });
    const { body } = await health(source.id);
    expect(body.objects).toEqual({ read: 2, late: 1, quarantined: 1, gap: 2 });
    expect(body.lines).toEqual({ analysed: 3 * 994, malformed: 9, oversize: 6, foreign: 3 });
    expect(body.bytes).toBe(2_400_000);
    expect(body.gap).toEqual({
      from: first.toISOString(),
      to: new Date(last.getTime() + SLOT_MS).toISOString(),
    });
  });

  it('a lacuna sem horário nos arquivos: conta, sem intervalo; e o volume maior que 32 bits', async () => {
    const source = await balancer();
    await object(source, 'gap', { slotStart: null });
    await object(source, 'read', { lines: 2_000_000, bytes: 5_000_000_000n });
    await object(source, 'read', { lines: 2_000_000, bytes: 5_000_000_000n });
    const { body } = await health(source.id);
    expect(body.objects.gap).toBe(1);
    expect(body.gap).toBeNull();
    expect(body.bytes).toBe(10_000_000_000);
  });

  it('só os objetos do balanceador pedido, e não os de outro do mesmo cliente', async () => {
    const source = await balancer();
    const other = await balancer();
    await object(other, 'read', { lines: 50, bytes: 50n });
    expect((await health(source.id)).body.objects.read).toBe(0);
    expect((await health(other.id)).body.lines.analysed).toBe(50);
  });

  it('a observação, o calado e as notas: sem as chaves, sem o resumo do dia e sem nenhum endereço', async () => {
    const source = await balancer();
    const held = observation();
    await save(source, stateOf({ observation: held }));
    const stored = await prisma.webEngineState.findFirstOrThrow({ where: { sourceId: source.id } });
    // O que está guardado tem o endereço e as chaves: o teste só prova algo por isso.
    expect(JSON.stringify(stored.state)).toContain(DIGEST_IP);
    expect(JSON.stringify(stored.state)).toContain(KEYS[0]);
    const { body, text } = await health(source.id);
    expect(body.observation).toEqual({
      since: AUTHORIZED.toISOString(),
      rules: held.rules,
      truncated: false,
    });
    expect(body.suppressed).toMatchObject([{ ruleId: '990402', clients: 2 }]);
    expect(body.notes).toEqual(['behind_proxy']);
    expect(body.stateAt).toBe(stored.updatedAt.toISOString());
    for (const secret of [DIGEST_IP, ...KEYS, 'digest', 'keys', 'tracks']) expect(text).not.toContain(secret);
  });

  it('a memória que não é a de agora não vale: outra observação, outro balanceador, outra versão, outra autorização', async () => {
    const started = new Date(AUTHORIZED.getTime() + HOUR);
    const cases: [string, () => Promise<Balancer>, 'nothing' | 'no_observation'][] = [
      [
        'a observação recomeçou',
        async () => {
          const source = await balancer(tenantA, {}, new Date(started.getTime() + WEB_OBSERVE_MS));
          await save(source, stateOf());
          return source;
        },
        'no_observation',
      ],
      [
        'sem o fim da observação, o começo é a autorização: outra data não serve',
        async () => {
          const source = await balancer(tenantA, {}, null);
          await save(source, stateOf({ observation: observation({ since: started.toISOString() }) }));
          return source;
        },
        'no_observation',
      ],
      [
        'o balanceador foi recriado',
        async () => {
          const source = await balancer();
          await save(source, stateOf(), { loadBalancer: 'app/outro/0123456789abcdef' });
          return source;
        },
        'nothing',
      ],
      [
        'formato de outra versão',
        async () => {
          const source = await balancer();
          await save(source, stateOf(), { version: ENGINE_STATE_VERSION + 1 });
          return source;
        },
        'nothing',
      ],
      [
        'gravada antes desta autorização',
        async () => {
          const source = await balancer();
          await save(source, stateOf());
          await prisma.$executeRaw`UPDATE "WebEngineState" SET "updatedAt" = ${ago(31 * HOUR)} WHERE "sourceId" = ${source.id}::uuid`;
          return source;
        },
        'nothing',
      ],
      [
        'a autorização foi retirada',
        async () => {
          const source = await balancer(tenantA, { revokedAt: new Date(), state: 'revoked' });
          await save(source, stateOf());
          return source;
        },
        'nothing',
      ],
      [
        'nunca autorizado',
        async () => {
          const source = await balancer(tenantA, { authorizedAt: null, state: 'available' });
          await save(source, stateOf());
          return source;
        },
        'nothing',
      ],
    ];
    for (const [name, make, expected] of cases) {
      const source = await make();
      const { body } = await health(source.id);
      expect(body.observation, name).toBeNull();
      if (expected === 'nothing') {
        expect(body, name).toMatchObject({ suppressed: [], notes: [], stateAt: null });
      } else {
        expect(body.notes, name).toEqual(['behind_proxy']);
      }
    }
  });

  it('sem o fim da observação, a que começou na autorização vale', async () => {
    const source = await balancer(tenantA, {}, null);
    await save(source, stateOf());
    expect((await health(source.id)).body.observation?.rules).toHaveLength(1);
  });

  it('um pedaço fora do formato não derruba a resposta nem vaza: só ele fica de fora', async () => {
    const good = JSON.parse(stateOf()) as Record<string, unknown>;
    const broken: [string, Record<string, unknown>][] = [
      ['observação nula', { observation: null }],
      ['observação em lista', { observation: ['keys', DIGEST_IP] }],
      ['observação em texto', { observation: `keys ${DIGEST_IP}` }],
      ['observação com campo a mais', { observation: { ...observation(), client: DIGEST_IP } }],
      [
        'calado com campo a mais',
        { suppressed: [{ trustedId: 'x', ruleId: '990402', clients: 1, ip: DIGEST_IP }] },
      ],
      ['calado que não é lista', { suppressed: DIGEST_IP }],
      ['nota fora do formato', { notes: [DIGEST_IP] }],
      ['notas ausentes', { notes: undefined }],
    ];
    for (const [name, piece] of broken) {
      const source = await balancer();
      await save(source, JSON.stringify({ ...good, ...piece }));
      const { body, text } = await health(source.id);
      expect(text, name).not.toContain(DIGEST_IP);
      const [field] = Object.keys(piece) as ['observation' | 'suppressed' | 'notes'];
      expect(body[field] ?? [], name).toEqual([]);
      if (field !== 'notes') expect(body.notes, name).toEqual(['behind_proxy']);
      if (field !== 'observation') expect(body.observation?.rules, name).toHaveLength(1);
    }
  });

  it('o calado há mais de 24 h sai da resposta', async () => {
    const source = await balancer();
    const [recent, old] = [randomUUID(), randomUUID()];
    await save(
      source,
      stateOf({
        suppressed: [
          { trustedId: recent, ruleId: '990402', clients: 1, lastSeenAt: ago(23 * HOUR).toISOString() },
          { trustedId: old, ruleId: '990402', clients: 1, lastSeenAt: ago(25 * HOUR).toISOString() },
        ],
      }),
    );
    expect((await health(source.id)).body.suppressed.map((item) => item.trustedId)).toEqual([recent]);
  });

  it('tudo o que o motor grava cabe no contrato: cada regra, cada nota e os tetos', async () => {
    const levels = [4, 7, 10, 12];
    const at = ago(HOUR).toISOString();
    const rules = (Object.keys(WEB_RULES) as (keyof typeof WEB_RULES)[]).flatMap((ruleId) =>
      levels.map((level) => ({ ruleId, level, findings: 4_000, firstSeenAt: at, lastSeenAt: at })),
    );
    const suppressed = Array.from({ length: 100 }, () => ({
      trustedId: randomUUID(),
      ruleId: '990404',
      clients: 40_000,
      lastSeenAt: at,
    }));
    const state = {
      observation: observation({ rules, truncated: true }),
      suppressed,
      notes: [...ENGINE_NOTES],
    };
    const { keys: _keys, ...view } = state.observation;
    expect(webObservationSchema.safeParse(view).success).toBe(true);
    const source = await balancer();
    await save(source, stateOf(state));
    const { body } = await health(source.id);
    expect(body.observation?.rules).toHaveLength(rules.length);
    expect(body.observation?.truncated).toBe(true);
    expect(body.suppressed).toHaveLength(100);
    expect(body.notes).toEqual([...ENGINE_NOTES]);
  });

  it.each(ROLES)('%s lê', async (role) => {
    const source = await balancer();
    await object(source, 'read', { lines: 5 });
    const { body } = await health(source.id, sessions.get(role));
    expect(body.lines.analysed).toBe(5);
  });

  it('A não lê nada de B, nem quando a fonte de B existe e tem dados', async () => {
    const ofB = await balancer(tenantB);
    await object(ofB, 'read', { lines: 5 });
    await save(ofB, stateOf());
    for (const as of [adminA, sessions.get('admin_verax') as TestSession]) {
      const response = await get(as, pathOf(ofB.id)).expect(404);
      expect(response.text).not.toContain(ofB.id);
    }
    expect((await health(ofB.id, adminB)).body.lines.analysed).toBe(5);
    // A leitura do estado também filtra sozinha pelo cliente, sem depender da conferência de antes.
    const own = { sourceId: ofB.id, tenantId: tenantB };
    expect(await readWebEngineView(prisma, own)).not.toBeNull();
    expect(await readWebEngineView(prisma, { ...own, tenantId: tenantA })).toBeNull();
  });

  it('sem sessão, 401; a Verax sem cliente, 409; id fora do formato, 400; outra fonte ou nenhuma, 404', async () => {
    const source = await balancer();
    await request(app.getHttpServer()).get(pathOf(source.id)).expect(401);
    const verax = await sessionFor(null, 'admin_verax');
    expect((await get(verax, pathOf(source.id)).expect(409)).body).toMatchObject({ code: 'TENANT_REQUIRED' });
    await get(adminA, pathOf('loja')).expect(400);
    await get(adminA, pathOf(randomUUID())).expect(404);
    const trail = await balancer(tenantA, { kind: 'cloudtrail' });
    await get(adminA, pathOf(trail.id)).expect(404);
  });

  it('ler não escreve nada: nem no banco, nem na trilha', async () => {
    const source = await balancer();
    await object(source, 'read', { lines: 5 });
    await save(source, stateOf());
    const snapshot = async () =>
      JSON.stringify([
        await prisma.webEngineState.findFirst({ where: { sourceId: source.id } }),
        await prisma.webSourceSettings.findFirst({ where: { sourceId: source.id } }),
        (await prisma.awsSource.findUnique({ where: { id: source.id } }))?.state,
        await prisma.webLogObject.count({ where: { sourceId: source.id } }),
      ]);
    const before = await snapshot();
    const response = await get(adminA, pathOf(source.id)).expect(200);
    expect(await snapshot()).toBe(before);
    expect(
      await prisma.auditLog.count({ where: { requestId: response.headers['x-request-id'] as string } }),
    ).toBe(0);
  });
});
