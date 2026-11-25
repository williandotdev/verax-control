import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AwsSourceFeatures } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AwsDiscovery } from '../src/aws/discovery/discovery-job.js';
import { requestAwsDiscovery } from '../src/aws/discovery/discovery-runs.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { fakeDiscovery, type FakeDiscoveryAccount } from './aws/discovery/fake-discovery.js';
import { clockAt, FakeCredentials } from './inventory/fake-job.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const START = new Date('2026-11-24T10:00:00.000Z');
const REGION = 'sa-east-1';

interface Balancer {
  type: 'app' | 'net';
  logs: { bucket: string; prefix?: string } | null;
}

/** Os balanceadores da conta, pelo nome. */
function accountWith(balancers: Record<string, Balancer>): FakeDiscoveryAccount {
  const arn = (name: string) =>
    `arn:aws:elasticloadbalancing:${REGION}:111111111111:loadbalancer/${balancers[name]?.type ?? 'app'}/${name}/0123456789abcdef`;
  return {
    regions: [REGION],
    handlers: {
      [`elbv2:${REGION}`]: {
        DescribeLoadBalancersCommand: () => ({
          LoadBalancers: Object.keys(balancers).map((name) => ({
            LoadBalancerName: name,
            LoadBalancerArn: arn(name),
            Scheme: 'internet-facing',
          })),
        }),
        DescribeLoadBalancerAttributesCommand: (input) => {
          const name = Object.keys(balancers).find(
            (candidate) => arn(candidate) === input['LoadBalancerArn'],
          );
          const logs = balancers[name ?? '']?.logs ?? null;
          return {
            Attributes:
              logs === null
                ? []
                : [
                    { Key: 'access_logs.s3.enabled', Value: 'true' },
                    { Key: 'access_logs.s3.bucket', Value: logs.bucket },
                    { Key: 'access_logs.s3.prefix', Value: logs.prefix ?? '' },
                  ],
          };
        },
      },
    },
  };
}

/** A tarefa `aws-discovery` com banco de verdade: o que ela grava dos balanceadores, ligados, desligados e na troca. */
describe('tarefa aws-discovery: balanceadores', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function setup() {
    const tenantId = await createTenant(app, 'Cliente Demo A (descoberta de balanceadores)');
    const cloud = await prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: [REGION],
        connection: 'connected',
        ingestFrom: START,
        awsTemplateVersion: 2,
        awsCapabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
        awsCapabilitiesCheckedAt: START,
      },
    });
    const clock = clockAt(START);
    const task = (fake: FakeDiscoveryAccount, features?: AwsSourceFeatures) =>
      new AwsDiscovery(
        prisma,
        new FakeCredentials(),
        (provider, home) => fakeDiscovery(fake).factory(provider, home),
        {
          name: `disc-alb-${randomInt(1e6, 9e6)}`,
          now: clock.now,
          random: () => 0.5,
          tenantIds: [tenantId],
          scheduleEveryMs: 0,
          ...(features !== undefined && { features }),
        },
      );
    const discover = async (fake: FakeDiscoveryAccount, features?: AwsSourceFeatures) => {
      await prisma.$transaction((tx) =>
        requestAwsDiscovery(tx, { tenantId, cloudAccountId: cloud.id, trigger: 'connect', now: clock.now() }),
      );
      const report = await task(fake, features).runOnce();
      expect(report).toMatchObject({ status: 'done', failed: 0 });
      clock.advance(60_000);
      return report.sources;
    };
    const rows = async () =>
      Object.fromEntries(
        (await prisma.awsSource.findMany({ where: { cloudAccountId: cloud.id, kind: 'elb_logs' } })).map(
          (row) => [
            row.name,
            {
              availability: row.availability,
              state: row.state,
              stateCode: row.stateCode,
              permission: row.permission,
              notes: row.notes,
              method: row.method,
            },
          ],
        ),
      );
    const idOf = async (name: string) =>
      (await prisma.awsSource.findFirstOrThrow({ where: { cloudAccountId: cloud.id, name } })).id;
    return { cloud, tenantId, task, discover, rows, idOf };
  }
  const ON = { webLogs: true };
  const FLEET: Record<string, Balancer> = {
    loja: { type: 'app', logs: { bucket: 'acessos' } },
    prefixo: { type: 'app', logs: { bucket: 'acessos', prefix: 'logs' } },
    semlog: { type: 'app', logs: null },
    rede: { type: 'net', logs: { bucket: 'acessos' } },
  };
  const BEFORE = {
    availability: 'available',
    state: 'unavailable',
    stateCode: 'not_collectable_yet',
    permission: 'unknown',
    notes: ['not_collected_yet'],
    method: 's3',
  };

  it('desligados: as linhas de sempre', async () => {
    const { discover, rows } = await setup();
    await discover(accountWith(FLEET));
    expect(await rows()).toEqual({ loja: BEFORE, prefixo: BEFORE, rede: BEFORE });
    await discover(accountWith(FLEET), { webLogs: false });
    expect(await rows()).toEqual({ loja: BEFORE, prefixo: BEFORE, rede: BEFORE });
  });

  it('ligar e desligar: as linhas mudam na descoberta seguinte, e voltam a ser as de sempre', async () => {
    const { discover, rows } = await setup();
    await discover(accountWith(FLEET));
    await discover(accountWith(FLEET), ON);
    const on = await rows();
    expect(on).toEqual({
      loja: {
        availability: 'available',
        state: 'available',
        stateCode: null,
        permission: 'granted',
        notes: ['high_volume'],
        method: 's3',
      },
      prefixo: {
        availability: 'available',
        state: 'needs_permission',
        stateCode: null,
        permission: 'missing',
        notes: ['high_volume', 'additional_bucket_required'],
        method: 's3',
      },
      semlog: {
        availability: 'no_destination',
        state: 'unavailable',
        stateCode: 'no_destination',
        permission: 'unknown',
        notes: ['aws_cost_alb_logs'],
        method: 's3',
      },
      rede: {
        availability: 'unsupported_format',
        state: 'unavailable',
        stateCode: 'unsupported_format',
        permission: 'unknown',
        notes: [],
        method: 's3',
      },
    });
    // A conta descoberta pela primeira vez já com eles ligados nasce igual.
    const fresh = await setup();
    await fresh.discover(accountWith(FLEET), ON);
    expect(await fresh.rows()).toEqual(on);
    // Repetir não muda nada.
    expect(await discover(accountWith(FLEET), ON)).toMatchObject({ created: 0, updated: 0, removed: 0 });
    expect(await rows()).toEqual(on);
    await discover(accountWith(FLEET));
    expect(await rows()).toEqual({ loja: BEFORE, prefixo: BEFORE, rede: BEFORE });
  });

  it('o autorizado: perde e recupera a permissão, some com o log desligado e volta, sem perder a autorização', async () => {
    const { cloud, tenantId, discover, rows, idOf } = await setup();
    await discover(accountWith(FLEET), ON);
    const id = await idOf('loja');
    await prisma.awsSource.update({
      where: { id },
      data: {
        authorizedAt: START,
        authorizedBy: 'usuario-de-teste',
        collectFrom: new Date('2026-11-24'),
        state: 'collecting',
        stateCode: null,
      },
    });
    await prisma.webSourceSettings.create({ data: { sourceId: id, tenantId, thresholdMultiplier: 2 } });
    const state = async () => {
      const row = (await rows())['loja'];
      return [row?.state, row?.stateCode];
    };
    await discover(accountWith(FLEET), ON);
    expect(await state()).toEqual(['collecting', null]);
    await discover(
      accountWith({ ...FLEET, loja: { type: 'app', logs: { bucket: 'acessos', prefix: 'novo' } } }),
      ON,
    );
    expect(await state()).toEqual(['permission_error', 'outside_awslogs_prefix']);
    await discover(accountWith(FLEET), ON);
    expect(await state()).toEqual(['authorized', 'awaiting_collector']);
    await discover(accountWith({ ...FLEET, loja: { type: 'app', logs: null } }), ON);
    expect(await state()).toEqual(['source_missing', 'no_destination']);
    // Apagado e recriado como NLB com o mesmo nome: não é mais um ALB.
    await discover(accountWith({ ...FLEET, loja: { type: 'net', logs: { bucket: 'acessos' } } }), ON);
    expect(await state()).toEqual(['source_missing', 'unsupported_format']);
    const { loja: _gone, ...others } = FLEET;
    await discover(accountWith(others), ON);
    expect((await state())[0]).toBe('source_missing');
    await discover(accountWith(FLEET), ON);
    expect(await state()).toEqual(['authorized', 'awaiting_collector']);
    expect(await prisma.awsSource.findUniqueOrThrow({ where: { id } })).toMatchObject({
      authorizedAt: START,
      authorizedBy: 'usuario-de-teste',
      revokedAt: null,
    });
    expect(await prisma.webSourceSettings.count({ where: { sourceId: id, thresholdMultiplier: 2 } })).toBe(1);
    // Com os ataques web desligados, a descoberta também não tira a autorização nem a linha.
    await discover(accountWith(FLEET));
    expect(await prisma.awsSource.findUniqueOrThrow({ where: { id } })).toMatchObject({
      authorizedAt: START,
      revokedAt: null,
      state: 'authorized',
    });
    expect(cloud.tenantId).toBe(tenantId);
  });

  it('o que nunca foi autorizado sai da lista quando some, com a estimativa, as rotas e as fontes confiáveis dele', async () => {
    const { tenantId, discover, rows, idOf } = await setup();
    await discover(accountWith(FLEET), ON);
    const id = await idOf('loja');
    await prisma.webSourceEstimate.create({ data: { sourceId: id, tenantId, lastRequestAt: START } });
    await prisma.webRoute.create({ data: { sourceId: id, tenantId, path: '/login', kind: 'login' } });
    for (const sourceId of [id, null]) {
      await prisma.webTrustedSource.create({
        data: {
          tenantId,
          sourceId,
          cidr: '192.0.2.0/24',
          kind: 'office',
          reason: 'Teste',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    }
    const { loja: _gone, ...others } = FLEET;
    expect(await discover(accountWith(others), ON)).toMatchObject({ removed: 1 });
    expect(Object.keys(await rows()).sort()).toEqual(['prefixo', 'rede', 'semlog']);
    expect(await prisma.webSourceEstimate.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.webRoute.count({ where: { tenantId } })).toBe(0);
    // A de todos os balanceadores fica.
    expect(await prisma.webTrustedSource.findMany({ where: { tenantId } })).toMatchObject([
      { sourceId: null },
    ]);
  });

  it('"Tentar de novo" usa as mesmas regras: o log que o cliente acabou de ligar passa a poder ser autorizado', async () => {
    const { task, discover, rows, idOf } = await setup();
    await discover(accountWith(FLEET), ON);
    const id = await idOf('semlog');
    const ask = () => prisma.awsSource.update({ where: { id }, data: { probeRequestedAt: START } });
    await ask();
    const fixed = accountWith({ ...FLEET, semlog: { type: 'app', logs: { bucket: 'acessos' } } });
    expect(await task(fixed, ON).runOnce()).toMatchObject({ probes: 1 });
    expect((await rows())['semlog']).toMatchObject({
      availability: 'available',
      state: 'available',
      permission: 'granted',
      notes: ['high_volume'],
    });
    // Com eles desligados, a mesma releitura é a de sempre.
    await ask();
    await task(fixed).runOnce();
    expect((await rows())['semlog']).toEqual(BEFORE);
    expect((await prisma.awsSource.findUniqueOrThrow({ where: { id } })).probeRequestedAt).toBeNull();
  });
});
