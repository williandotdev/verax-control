import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import {
  DescribeLoadBalancerAttributesCommand,
  ModifyLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ALB_ACCESS_LOG_KEYS, type Role, webAlbLoggingSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiscoveryClientFactory } from '../src/aws/discovery/clients.js';
import type { ReaderSession } from '../src/aws/web-identity.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { WebAlbLoggingTask } from '../src/weblogs/alb-logging/web-alb-logging-job.js';
import { FakeCredentials } from './inventory/fake-job.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

const VERIFIED = new Date('2026-11-21T00:00:00.000Z');
const accountNumber = () => String(randomInt(100_000_000_000, 999_999_999_999));
const hex = () => randomInt(0x10000000, 0xffffffff).toString(16).padStart(16, '0');
const STACK_BUCKET = 'verax-control-reader-alblogsbucket-1a2b3c4d5e6f';
const ALLOWED_KEYS = new Set<string>(Object.values(ALB_ACCESS_LOG_KEYS));

interface Cloud {
  id: string;
  tenantId: string;
  accountId: string;
}
type Attribute = { Key: string; Value: string };

const named = (name: string) => Object.assign(new Error('mensagem da AWS com o ARN e o bucket'), { name });

/** A conta AWS falsa: as etiquetas do papel, os atributos de cada ALB e o que chegaria à AWS. */
class FakeAws {
  tags: Attribute[] | Error = [{ Key: 'verax-control:alb-logs-bucket', Value: `sa-east-1/${STACK_BUCKET}` }];
  readonly attributes = new Map<string, Attribute[]>();
  modifyError: Error | null = null;
  readonly sent: unknown[] = [];

  get modifies(): ModifyLoadBalancerAttributesCommand[] {
    return this.sent.filter((command) => command instanceof ModifyLoadBalancerAttributesCommand);
  }

  readonly factory: DiscoveryClientFactory = () => {
    const refuse = (): never => {
      throw new Error('serviço que o log do ALB não usa');
    };
    return {
      ec2: refuse,
      cloudtrail: refuse,
      guardduty: refuse,
      s3: refuse,
      logs: refuse,
      wafv2: refuse,
      securityhub: refuse,
      inspector2: refuse,
      accessanalyzer: refuse,
      rds: refuse,
      config: refuse,
      iam: () => ({
        send: (command: unknown) => {
          this.sent.push(command);
          if (!(command instanceof GetRoleCommand)) throw new Error('só GetRole');
          if (this.tags instanceof Error) return Promise.reject(this.tags);
          return Promise.resolve({ Role: { Tags: this.tags } });
        },
      }),
      elbv2: () => ({
        send: (command: unknown) => {
          this.sent.push(command);
          if (command instanceof DescribeLoadBalancerAttributesCommand) {
            return Promise.resolve({
              Attributes: this.attributes.get(command.input.LoadBalancerArn ?? '') ?? [],
            });
          }
          if (command instanceof ModifyLoadBalancerAttributesCommand) {
            if (this.modifyError !== null) return Promise.reject(this.modifyError);
            const arn = command.input.LoadBalancerArn ?? '';
            const current = new Map((this.attributes.get(arn) ?? []).map((a) => [a.Key, a.Value]));
            for (const { Key, Value } of command.input.Attributes ?? []) current.set(Key ?? '', Value ?? '');
            this.attributes.set(
              arn,
              [...current].map(([Key, Value]) => ({ Key, Value })),
            );
            return Promise.resolve({});
          }
          throw new Error('comando do ELB fora do log');
        },
      }),
    };
  };
}

/** A sessão da chave de um usuário de leitura (a VM própria do cliente). */
class KeyCredentials extends FakeCredentials {
  override async session(accountId: string, region: string): Promise<ReaderSession> {
    return { ...(await super.session(accountId, region)), principal: 'iam_user' };
  }
}

/**
 * O log de acesso de um ALB ligado pelo painel: as rotas (permissão, trilha, isolamento entre clientes e o corpo estrito)
 * e a tarefa do worker contra uma AWS falsa (o que ela manda, e o que nunca manda).
 */
describe('log de acesso do ALB ligado pelo painel', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession & { userId: string };
  let adminB: TestSession & { userId: string };
  const sessions = new Map<Role, TestSession & { userId: string }>();
  /** Tudo o que as tarefas mandaram à AWS, em todos os testes. */
  const everything: unknown[] = [];

  async function sessionFor(tenantId: string, role: Role) {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }
  const get = (as: TestSession, path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', as.cookie);
  const post = (as: TestSession, path: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Cookie', as.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', as.csrfToken);
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  const path = (sourceId: string, action = '') => `/v1/web-logs/sources/${sourceId}/access-logs${action}`;
  const enable = (as: TestSession, sourceId: string, body: object = { confirm: true }) =>
    post(as, path(sourceId, '/enable')).send(body);
  const disable = (as: TestSession, sourceId: string, body: object = { confirm: true }) =>
    post(as, path(sourceId, '/disable')).send(body);
  const rowOf = (sourceId: string) => prisma.webAlbLogging.findFirst({ where: { sourceId } });

  function account(
    tenantId: string,
    data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {},
  ): Promise<Cloud> {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: accountNumber(),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: VERIFIED,
        awsTemplateVersion: 2,
        awsCapabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
        awsCapabilitiesCheckedAt: VERIFIED,
        ...data,
      },
      select: { id: true, tenantId: true, accountId: true },
    });
  }

  /** Um ALB com o log desligado, como a descoberta o grava com os ataques web ligados. */
  async function idle(cloud: Cloud, type = 'app', data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {}) {
    const name = `alb-${randomInt(1e6, 9e6)}`;
    const arn = `arn:aws:elasticloadbalancing:sa-east-1:${cloud.accountId}:loadbalancer/${type}/${name}/${hex()}`;
    const row = await prisma.awsSource.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        kind: 'elb_logs',
        region: 'sa-east-1',
        resourceId: name,
        name,
        details: { arn, internetFacing: true, destinationType: 'none' },
        method: 's3',
        availability: 'no_destination',
        loggingState: 'disabled',
        permission: 'unknown',
        notes: ['aws_cost_alb_logs'],
        state: 'unavailable',
        ...data,
      },
    });
    return { id: row.id, tenantId: cloud.tenantId, arn };
  }

  function newTask(tenantIds: string[], aws = new FakeAws(), credentials = new FakeCredentials()) {
    const task = new WebAlbLoggingTask(prisma, credentials, aws.factory, {
      name: `log-do-alb-${randomInt(1e6, 9e6)}`,
      random: () => 0.5,
      sleep: () => Promise.resolve(),
      tenantIds,
    });
    return {
      task,
      aws,
      run: async () => {
        const before = aws.sent.length;
        const report = await task.runOnce();
        everything.push(...aws.sent.slice(before));
        return report;
      },
    };
  }

  beforeAll(async () => {
    app = await createApp({ awsWebLogs: true, plan: { PLAN: 'profissional' } });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (log do ALB pelo painel)');
    tenantB = await createTenant(app, 'Cliente Demo B (log do ALB pelo painel)');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    sessions.set('admin_cliente', adminA);
    sessions.set('analista_cliente', await sessionFor(tenantA, 'analista_cliente'));
    sessions.set('leitura', await sessionFor(tenantA, 'leitura'));
  });

  afterAll(async () => {
    // Em todos os testes, o que chegou à AWS: só a leitura das etiquetas e dos atributos, e a mudança só com as três
    // chaves do log de acesso. Nenhuma outra chave sai, nunca.
    const modifies = everything.filter((command) => command instanceof ModifyLoadBalancerAttributesCommand);
    expect(modifies.length).toBeGreaterThan(0);
    for (const command of everything) {
      expect(
        command instanceof GetRoleCommand ||
          command instanceof DescribeLoadBalancerAttributesCommand ||
          command instanceof ModifyLoadBalancerAttributesCommand,
      ).toBe(true);
    }
    for (const command of modifies) {
      const attributes = command.input.Attributes ?? [];
      expect(attributes.length).toBeGreaterThan(0);
      for (const { Key } of attributes) expect(ALLOWED_KEYS.has(Key ?? '')).toBe(true);
    }
    await app.close();
  });

  describe('as rotas', () => {
    it('lê o estado vazio, pede para ligar (202, na trilha, com quem pediu) e recusa o segundo pedido', async () => {
      const cloud = await account(tenantA);
      const source = await idle(cloud);
      const empty = webAlbLoggingSchema.parse((await get(adminA, path(source.id)).expect(200)).body);
      expect(empty).toMatchObject({
        sourceId: source.id,
        pending: null,
        status: null,
        enabledByVerax: false,
      });

      const response = await enable(adminA, source.id).expect(202);
      const body = webAlbLoggingSchema.parse(response.body);
      expect(body).toMatchObject({ pending: 'enable', status: null, enabledByVerax: false });
      const row = await rowOf(source.id);
      expect(row).toMatchObject({ pending: 'enable', requestedBy: adminA.userId });
      const entry = await entryOf(response);
      expect(entry).toMatchObject({
        action: 'web_logs.alb_logging_enable',
        outcome: 'success',
        actorId: adminA.userId,
        tenantId: tenantA,
        resourceType: 'cloud_account',
        resourceId: cloud.id,
      });
      expect(entry.after).toMatchObject({ pending: 'enable' });

      const again = await enable(adminA, source.id).expect(409);
      expect(again.body).toMatchObject({ code: 'WEB_ALB_LOGGING_PENDING' });
      // O pedido sai daqui: as tarefas dos testes seguintes leem os pedidos do cliente A.
      await prisma.webAlbLogging.deleteMany({ where: { sourceId: source.id } });
    });

    it('só administradores pedem; todos leem; o corpo é estrito', async () => {
      const source = await idle(await account(tenantA));
      for (const role of ['analista_cliente', 'leitura'] as const) {
        const as = sessions.get(role) as TestSession;
        await get(as, path(source.id)).expect(200);
        await enable(as, source.id).expect(403);
        await disable(as, source.id).expect(403);
      }
      for (const body of [{}, { confirm: false }, { confirm: true, bucket: 'bucket-de-outra-pessoa' }]) {
        await enable(adminA, source.id, body).expect(400);
      }
      expect(await rowOf(source.id)).toBeNull();
    });

    it('o cliente B não lê nem pede nada do balanceador do cliente A', async () => {
      const source = await idle(await account(tenantA));
      await get(adminB, path(source.id)).expect(404);
      await enable(adminB, source.id).expect(404);
      await disable(adminB, source.id).expect(404);
      expect(await rowOf(source.id)).toBeNull();
      await get(adminA, path(randomUUID())).expect(404);
    });

    it('recusa o ALB com o log já ligado, o NLB e a conta desconectada, com o código', async () => {
      const cloud = await account(tenantA);
      const on = await idle(cloud, 'app', { availability: 'available', loggingState: 'logging' });
      expect((await enable(adminA, on.id).expect(409)).body).toMatchObject({
        code: 'WEB_ALB_LOGGING_ALREADY_ON',
      });
      const nlb = await idle(cloud, 'net');
      expect((await enable(adminA, nlb.id).expect(409)).body).toMatchObject({
        code: 'WEB_ALB_LOGGING_NOT_ALB',
      });
      const off = await idle(await account(tenantA, { ingestFrom: null }));
      expect((await enable(adminA, off.id).expect(409)).body).toMatchObject({
        code: 'ACCOUNT_NOT_CONNECTED',
      });
      // Desligar o que a Verax não ligou: não.
      expect((await disable(adminA, on.id).expect(409)).body).toMatchObject({
        code: 'WEB_ALB_LOGGING_NOT_VERAX',
      });
    });
  });

  it('o banco recusa o que o worker e a API nunca gravariam (CHECK da migration)', async () => {
    const source = await idle(await account(tenantA));
    const row = (data: Partial<Prisma.WebAlbLoggingUncheckedCreateInput>) =>
      prisma.webAlbLogging.create({ data: { sourceId: source.id, tenantId: tenantA, ...data } });
    for (const data of [
      { pending: 'ligar', requestedAt: new Date(), requestedBy: adminA.userId },
      { pending: 'enable', requestedBy: adminA.userId },
      { pending: 'enable', requestedAt: new Date() },
      { status: 'enabled', lastAction: 'enable' },
      { status: 'failed', lastAction: 'enable', completedAt: new Date() },
      { status: 'enabled', lastAction: 'enable', completedAt: new Date(), errorCode: 'permission_denied' },
      { enabledByVerax: true, bucket: STACK_BUCKET, prefix: '' },
      {
        enabledByVerax: true,
        bucket: STACK_BUCKET,
        loadBalancerArn: source.arn,
        enabledAt: new Date(),
        prefix: 'outro',
      },
    ] satisfies Partial<Prisma.WebAlbLoggingUncheckedCreateInput>[]) {
      await expect(row(data), JSON.stringify(data)).rejects.toThrow(/WebAlbLogging_values_check/);
    }
    // A cascata: a fonte apagada leva a linha.
    await row({ pending: 'enable', requestedAt: new Date(), requestedBy: adminA.userId });
    await prisma.awsSource.delete({ where: { id: source.id } });
    expect(await rowOf(source.id)).toBeNull();
  });

  describe('a tarefa do worker', () => {
    it('liga no bucket da pilha só as três chaves, guarda quem pediu e o estado de antes, e pede a descoberta', async () => {
      const cloud = await account(tenantA);
      const source = await idle(cloud);
      const aws = new FakeAws();
      aws.attributes.set(source.arn, [
        { Key: 'access_logs.s3.enabled', Value: 'false' },
        { Key: 'access_logs.s3.bucket', Value: '' },
        { Key: 'deletion_protection.enabled', Value: 'true' },
      ]);
      await enable(adminA, source.id).expect(202);
      const { run } = newTask([tenantA], aws);
      const report = await run();
      expect(report).toMatchObject({ enabled: 1, failed: 0, changes: 1 });
      expect(aws.modifies).toHaveLength(1);
      expect(aws.modifies[0]?.input).toEqual({
        LoadBalancerArn: source.arn,
        Attributes: [
          { Key: 'access_logs.s3.enabled', Value: 'true' },
          { Key: 'access_logs.s3.bucket', Value: STACK_BUCKET },
          { Key: 'access_logs.s3.prefix', Value: '' },
        ],
      });
      // Os outros atributos do balanceador ficam como estavam.
      expect(aws.attributes.get(source.arn)).toContainEqual({
        Key: 'deletion_protection.enabled',
        Value: 'true',
      });

      const state = webAlbLoggingSchema.parse((await get(adminA, path(source.id)).expect(200)).body);
      expect(state).toMatchObject({
        pending: null,
        lastAction: 'enable',
        status: 'enabled',
        errorCode: null,
        enabledByVerax: true,
        bucket: STACK_BUCKET,
        enabledBy: adminA.userId,
        previous: { enabled: false, bucket: null, prefix: null },
      });
      expect(await rowOf(source.id)).toMatchObject({ loadBalancerArn: source.arn, prefix: '' });
      const trail = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'web_logs.alb_logging_result', resourceId: cloud.id },
      });
      expect(trail).toMatchObject({ actorType: 'system', tenantId: tenantA, outcome: 'success' });
      expect(JSON.stringify(trail)).not.toMatch(/segredo|token-de-teste/);
      expect(
        await prisma.awsDiscoveryRun.count({ where: { cloudAccountId: cloud.id, status: 'pending' } }),
      ).toBe(1);
      // Ligado pela Verax: um segundo "ligar" não faz sentido.
      expect((await enable(adminA, source.id).expect(409)).body).toMatchObject({
        code: 'WEB_ALB_LOGGING_ALREADY_ON',
      });
    });

    it('com o log já ligado em outro bucket, não muda nada e diz qual é o bucket', async () => {
      const source = await idle(await account(tenantA));
      const aws = new FakeAws();
      aws.attributes.set(source.arn, [
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        { Key: 'access_logs.s3.bucket', Value: 'logs-que-o-cliente-ja-tinha' },
        { Key: 'access_logs.s3.prefix', Value: 'alb' },
      ]);
      await enable(adminA, source.id).expect(202);
      const { run } = newTask([tenantA], aws);
      expect(await run()).toMatchObject({ alreadyEnabled: 1, changes: 0 });
      expect(aws.modifies).toHaveLength(0);
      const state = webAlbLoggingSchema.parse((await get(adminA, path(source.id)).expect(200)).body);
      expect(state).toMatchObject({
        status: 'already_enabled',
        enabledByVerax: false,
        bucket: 'logs-que-o-cliente-ja-tinha',
      });
      expect((await disable(adminA, source.id).expect(409)).body).toMatchObject({
        code: 'WEB_ALB_LOGGING_NOT_VERAX',
      });
    });

    it('a pilha sem a opção, a permissão negada, outra região e a chave de usuário: um código claro, nada muda', async () => {
      const cases: [string, (aws: FakeAws) => void, string, FakeCredentials?][] = [
        [
          'sem a etiqueta',
          (aws) => (aws.tags = [{ Key: 'verax-control:template', Value: '2' }]),
          'stack_update_required',
        ],
        ['papel do modelo 1', (aws) => (aws.tags = named('AccessDenied')), 'stack_update_required'],
        ['negado na mudança', (aws) => (aws.modifyError = named('AccessDenied')), 'permission_denied'],
        [
          'bucket recusado',
          (aws) => (aws.modifyError = named('InvalidConfigurationRequestException')),
          'bucket_rejected',
        ],
        [
          'bucket de outra região',
          (aws) =>
            (aws.tags = [{ Key: 'verax-control:alb-logs-bucket', Value: `us-east-1/${STACK_BUCKET}` }]),
          'other_region',
        ],
        ['limite da AWS', (aws) => (aws.modifyError = named('Throttling')), 'throttled'],
        ['erro qualquer', (aws) => (aws.modifyError = named('InternalFailure')), 'failed'],
        ['chave de usuário', () => undefined, 'stack_update_required', new KeyCredentials()],
      ];
      for (const [name, arrange, code, credentials] of cases) {
        const source = await idle(await account(tenantA));
        const aws = new FakeAws();
        arrange(aws);
        await enable(adminA, source.id).expect(202);
        const { run } = newTask([tenantA], aws, credentials);
        expect(await run(), name).toMatchObject({ failed: 1, changes: 0 });
        const state = webAlbLoggingSchema.parse((await get(adminA, path(source.id)).expect(200)).body);
        expect(state, name).toMatchObject({
          status: 'failed',
          errorCode: code,
          enabledByVerax: false,
          pending: null,
        });
        // Nada foi ligado: o atributo continua como estava.
        expect(aws.attributes.get(source.arn) ?? [], name).not.toContainEqual({
          Key: 'access_logs.s3.enabled',
          Value: 'true',
        });
        // E o pedido pode ser feito de novo (depois de atualizar a pilha, por exemplo).
        await enable(adminA, source.id).expect(202);
        await prisma.webAlbLogging.updateMany({
          where: { sourceId: source.id },
          data: { pending: null, requestedAt: null },
        });
      }
    }, 120_000);

    it('desliga só o que a Verax ligou, só com enabled=false, e só se ninguém mexeu', async () => {
      const cloud = await account(tenantA);
      const aws = new FakeAws();
      const ours = await idle(cloud);
      const changed = await idle(cloud);
      for (const source of [ours, changed]) {
        await enable(adminA, source.id).expect(202);
      }
      await newTask([tenantA], aws).run();
      // Alguém trocou o destino do segundo no console.
      aws.attributes.set(changed.arn, [
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        { Key: 'access_logs.s3.bucket', Value: 'bucket-novo-do-cliente' },
        { Key: 'access_logs.s3.prefix', Value: '' },
      ]);
      // Autorizado, não desliga (a leitura pararia com aviso).
      await prisma.awsSource.update({
        where: { id: ours.id },
        data: { authorizedAt: new Date(), authorizedBy: 'x' },
      });
      expect((await disable(adminA, ours.id).expect(409)).body).toMatchObject({
        code: 'WEB_ALB_LOGGING_SOURCE_AUTHORIZED',
      });
      await prisma.awsSource.update({
        where: { id: ours.id },
        data: { authorizedAt: null, authorizedBy: null },
      });

      const response = await disable(adminA, ours.id).expect(202);
      expect(await entryOf(response)).toMatchObject({
        action: 'web_logs.alb_logging_disable',
        actorId: adminA.userId,
      });
      await disable(adminA, changed.id).expect(202);
      const before = aws.modifies.length;
      const report = await newTask([tenantA], aws).run();
      expect(report).toMatchObject({ disabled: 1, released: 1, changes: 1 });
      const sent = aws.modifies.slice(before);
      expect(sent.map((command) => command.input)).toEqual([
        { LoadBalancerArn: ours.arn, Attributes: [{ Key: 'access_logs.s3.enabled', Value: 'false' }] },
      ]);
      expect(webAlbLoggingSchema.parse((await get(adminA, path(ours.id)).expect(200)).body)).toMatchObject({
        status: 'disabled',
        enabledByVerax: false,
        disabledBy: adminA.userId,
      });
      expect(webAlbLoggingSchema.parse((await get(adminA, path(changed.id)).expect(200)).body)).toMatchObject(
        {
          status: 'released',
          enabledByVerax: false,
        },
      );
      // O do cliente segue no bucket dele.
      expect(aws.attributes.get(changed.arn)).toContainEqual({
        Key: 'access_logs.s3.bucket',
        Value: 'bucket-novo-do-cliente',
      });
    });

    it('a pilha sem a permissão no desligar: o código, e o log continua sendo da Verax', async () => {
      const aws = new FakeAws();
      const source = await idle(await account(tenantA));
      await enable(adminA, source.id).expect(202);
      await newTask([tenantA], aws).run();
      aws.modifyError = named('AccessDenied');
      await disable(adminA, source.id).expect(202);
      expect(await newTask([tenantA], aws).run()).toMatchObject({ failed: 1 });
      expect(webAlbLoggingSchema.parse((await get(adminA, path(source.id)).expect(200)).body)).toMatchObject({
        lastAction: 'disable',
        status: 'failed',
        errorCode: 'permission_denied',
        enabledByVerax: true,
      });
    });

    it('a tarefa de um cliente não toca no pedido de outro', async () => {
      const source = await idle(await account(tenantB));
      await enable(adminB, source.id).expect(202);
      const aws = new FakeAws();
      expect(await newTask([tenantA], aws).run()).toMatchObject({ pending: 0 });
      expect(aws.sent).toHaveLength(0);
      expect(await rowOf(source.id)).toMatchObject({ pending: 'enable' });
      await newTask([tenantB], aws).run();
      expect(await rowOf(source.id)).toMatchObject({ pending: null, status: 'enabled' });
    });
  });
});
