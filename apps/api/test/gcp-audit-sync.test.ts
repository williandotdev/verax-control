import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { GcpAuditSync } from '../src/gcp/gcp-audit-sync.js';
import type { PubsubMessage, PubsubReader } from '../src/gcp/pubsub.client.js';
import { IncidentGrouping } from '../src/incidents/incident-grouping.js';
import { auditEntry, pubsubMessage, randomProject } from './gcp/fixtures.js';
import { createTenant, createUser } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

/**
 * Pub/Sub falso com a semântica que importa: a mensagem entregue e não confirmada volta na próxima leitura, e a
 * confirmada some. Uma assinatura pode ser marcada para falhar.
 */
class FakePubsub implements PubsubReader {
  private readonly queues = new Map<string, PubsubMessage[]>();
  readonly acked: string[] = [];
  failing = new Set<string>();

  publish(subscription: string, ...messages: PubsubMessage[]): void {
    this.queues.set(subscription, [...(this.queues.get(subscription) ?? []), ...messages]);
  }

  pending(subscription: string): number {
    return this.queues.get(subscription)?.length ?? 0;
  }

  pull(subscription: string, maxMessages: number): Promise<PubsubMessage[]> {
    if (this.failing.has(subscription)) return Promise.reject(new Error('permissão negada'));
    return Promise.resolve((this.queues.get(subscription) ?? []).slice(0, maxMessages));
  }

  acknowledge(subscription: string, ackIds: readonly string[]): Promise<void> {
    this.acked.push(...ackIds);
    this.queues.set(
      subscription,
      (this.queues.get(subscription) ?? []).filter((message) => !ackIds.includes(message.ackId)),
    );
    return Promise.resolve();
  }
}

const subscriptionOf = (project: string) =>
  `projects/projeto-no/subscriptions/verax-node-security-${project}`;

describe('sync da auditoria da GCP para achados', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let creatorA: string;
  const projectA = randomProject();
  const projectB = randomProject();
  let run = 0;
  const syncFor = (pubsub: PubsubReader, options = {}) => {
    run += 1;
    return new GcpAuditSync(prisma, pubsub, {
      name: `gcp-${projectA.slice(-12)}-${run}`,
      pullSize: 2,
      ...options,
    });
  };

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (GCP)');
    tenantB = await createTenant(app, 'Cliente B (GCP)');
    creatorA = (await createUser(app, { role: 'admin_cliente', tenantId: tenantA })).id;
    for (const [tenantId, project] of [
      [tenantA, projectA],
      [tenantB, projectB],
    ] as const) {
      await prisma.cloudAccount.create({
        data: {
          tenantId,
          provider: 'gcp',
          accountId: project,
          regions: [],
          pubsubSubscription: subscriptionOf(project),
        },
      });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('evento suspeito vira achado do cliente da assinatura; o comum só conta como atividade da conta', async () => {
    const pubsub = new FakePubsub();
    const key = auditEntry({
      project: projectA,
      insertId: `chave-${projectA}`,
      timestamp: '2026-11-03T10:00:00.000Z',
      methodName: 'google.iam.admin.v1.CreateServiceAccountKey',
      principal: 'automacao@exemplo.iam.gserviceaccount.com',
    });
    const list = auditEntry({
      project: projectA,
      timestamp: '2026-11-03T10:05:00.000Z',
      methodName: 'v1.compute.instances.list',
    });
    pubsub.publish(subscriptionOf(projectA), pubsubMessage(key), pubsubMessage(list));

    const report = await syncFor(pubsub).runOnce(new Date('2026-11-03T10:10:00.000Z'));
    expect(report).toMatchObject({
      status: 'done',
      read: 2,
      created: 1,
      ignored: 1,
      unowned: 0,
      failedSubscriptions: 0,
    });
    expect(pubsub.pending(subscriptionOf(projectA))).toBe(0);

    const finding = await prisma.finding.findUniqueOrThrow({
      where: { source_sourceEventId: { source: 'gcp', sourceEventId: `${projectA}/chave-${projectA}` } },
    });
    expect(finding).toMatchObject({
      tenantId: tenantA,
      accountId: projectA,
      logSource: 'gcp_audit',
      ruleId: '990106',
      severity: 'high',
      status: 'new',
      eventName: 'google.iam.admin.v1.CreateServiceAccountKey',
      actorUser: 'automacao@exemplo.iam.gserviceaccount.com',
      actorType: 'service_account',
      sourceIp: '203.0.113.10',
      mitreTechniques: ['T1098.001'],
    });
    expect(finding.incidentId).not.toBeNull();
    // A conta registra o evento mais recente, inclusive o que não era suspeito.
    const account = await prisma.cloudAccount.findFirstOrThrow({ where: { accountId: projectA } });
    expect(account.lastEventAt?.toISOString()).toBe('2026-11-03T10:05:00.000Z');
  });

  it('entregue de novo (sem confirmação anterior) não duplica', async () => {
    const pubsub = new FakePubsub();
    const entry = auditEntry({
      project: projectA,
      insertId: `dup-${projectA}`,
      methodName: 'v1.compute.firewalls.delete',
    });
    pubsub.publish(subscriptionOf(projectA), pubsubMessage(entry));
    expect((await syncFor(pubsub).runOnce()).created).toBe(1);
    pubsub.publish(subscriptionOf(projectA), pubsubMessage(entry));
    expect(await syncFor(pubsub).runOnce()).toMatchObject({ created: 0, duplicates: 1 });
  });

  it('evento de outro projeto chegando pela assinatura, log sem projeto e mensagem inválida vão para a fila sem dono', async () => {
    const pubsub = new FakePubsub();
    const intruder = auditEntry({
      project: projectB,
      insertId: `intruso-${projectA}`,
      methodName: 'google.iam.admin.v1.CreateServiceAccountKey',
    });
    const organization = {
      ...auditEntry({ insertId: `org-${projectA}`, methodName: 'SetOrgPolicy' }),
      logName: 'organizations/123/logs/cloudaudit.googleapis.com%2Factivity',
    };
    pubsub.publish(
      subscriptionOf(projectA),
      pubsubMessage(intruder),
      pubsubMessage(organization),
      pubsubMessage(null, Buffer.from('lixo').toString('base64')),
    );
    const report = await syncFor(pubsub).runOnce();
    expect(report).toMatchObject({ read: 3, created: 0, unowned: 3 });

    const queue = await prisma.unownedAlert.findMany({
      where: { sourceEventId: { in: [`${projectB}/intruso-${projectA}`, `-/org-${projectA}`] } },
      orderBy: { reason: 'asc' },
    });
    expect(queue.map((item) => [item.source, item.reason, item.accounts, item.ruleId])).toEqual([
      ['gcp', 'no_account', [], '990116'],
      ['gcp', 'source_mismatch', [projectB], '990106'],
    ]);
    // Nenhum achado foi para o cliente B por causa do evento que chegou pela assinatura de A.
    expect(await prisma.finding.count({ where: { sourceEventId: `${projectB}/intruso-${projectA}` } })).toBe(
      0,
    );
  });

  it('exceção do cliente marca o achado como esperado já na chegada', async () => {
    const exception = await prisma.alertException.create({
      data: {
        tenantId: tenantA,
        ruleId: '990107',
        field: 'user',
        value: 'terraform@exemplo.iam.gserviceaccount.com',
        reason: 'Contas de serviço criadas pelo Terraform da equipe',
        createdById: creatorA,
      },
    });
    const pubsub = new FakePubsub();
    pubsub.publish(
      subscriptionOf(projectA),
      pubsubMessage(
        auditEntry({
          project: projectA,
          insertId: `excecao-${projectA}`,
          methodName: 'google.iam.admin.v1.CreateServiceAccount',
          principal: 'terraform@exemplo.iam.gserviceaccount.com',
        }),
      ),
    );
    expect(await syncFor(pubsub).runOnce()).toMatchObject({ created: 1, excepted: 1 });
    const finding = await prisma.finding.findFirstOrThrow({
      where: { sourceEventId: `${projectA}/excecao-${projectA}` },
    });
    expect(finding).toMatchObject({ status: 'legitimate', exceptionId: exception.id, incidentId: null });
  });

  it('uma assinatura com problema não para as outras, e a mensagem dela fica para depois', async () => {
    const pubsub = new FakePubsub();
    pubsub.failing.add(subscriptionOf(projectA));
    pubsub.publish(
      subscriptionOf(projectA),
      pubsubMessage(auditEntry({ project: projectA, methodName: 'DeleteProject' })),
    );
    pubsub.publish(
      subscriptionOf(projectB),
      pubsubMessage(
        auditEntry({
          project: projectB,
          insertId: `b-${projectB}`,
          methodName: 'google.api.serviceusage.v1.ServiceUsage.DisableService',
        }),
      ),
    );
    const sync = syncFor(pubsub);
    const report = await sync.runOnce();
    expect(report.failedSubscriptions).toBe(1);
    expect(report.created).toBe(1);
    expect(pubsub.pending(subscriptionOf(projectA))).toBe(1);
    expect(
      await prisma.finding.count({
        where: { tenantId: tenantB, sourceEventId: `${projectB}/b-${projectB}` },
      }),
    ).toBe(1);
  });

  it('assinatura de vários projetos do mesmo cliente (coletor agregado): cada evento vai para a conta do projeto dele', async () => {
    const [first, second] = [randomProject(), randomProject()];
    const shared = `projects/projeto-no/subscriptions/agregada-${first}`;
    for (const project of [first, second]) {
      await prisma.cloudAccount.create({
        data: {
          tenantId: tenantA,
          provider: 'gcp',
          accountId: project,
          regions: [],
          pubsubSubscription: shared,
        },
      });
    }
    const pubsub = new FakePubsub();
    pubsub.publish(
      shared,
      pubsubMessage(auditEntry({ project: first, insertId: `um-${first}`, methodName: 'DeleteProject' })),
      pubsubMessage(auditEntry({ project: second, insertId: `dois-${second}`, methodName: 'DeleteProject' })),
    );
    expect(await syncFor(pubsub).runOnce()).toMatchObject({ created: 2, unowned: 0 });
    const findings = await prisma.finding.findMany({
      where: { sourceEventId: { in: [`${first}/um-${first}`, `${second}/dois-${second}`] } },
      orderBy: { accountId: 'asc' },
    });
    expect(findings.map((finding) => [finding.tenantId, finding.accountId]).sort()).toEqual(
      [
        [tenantA, first],
        [tenantA, second],
      ].sort(),
    );
  });

  it('assinatura cadastrada em clientes diferentes: nenhum evento é atribuído (origem ambígua)', async () => {
    const [ofA, ofB] = [randomProject(), randomProject()];
    const shared = `projects/projeto-no/subscriptions/ambigua-${ofA}`;
    await prisma.cloudAccount.create({
      data: { tenantId: tenantA, provider: 'gcp', accountId: ofA, regions: [], pubsubSubscription: shared },
    });
    await prisma.cloudAccount.create({
      data: { tenantId: tenantB, provider: 'gcp', accountId: ofB, regions: [], pubsubSubscription: shared },
    });
    const pubsub = new FakePubsub();
    pubsub.publish(
      shared,
      pubsubMessage(auditEntry({ project: ofA, insertId: `amb-${ofA}`, methodName: 'DeleteProject' })),
    );
    expect(await syncFor(pubsub).runOnce()).toMatchObject({ created: 0, unowned: 1 });
    const queued = await prisma.unownedAlert.findUniqueOrThrow({
      where: { source_sourceEventId: { source: 'gcp', sourceEventId: `${ofA}/amb-${ofA}` } },
    });
    expect(queued.reason).toBe('ambiguous_source');
  });

  it('operação longa: o registro do início e o do fim viram um achado só', async () => {
    const pubsub = new FakePubsub();
    const operation = `operation-${projectA}`;
    pubsub.publish(
      subscriptionOf(projectA),
      pubsubMessage(
        auditEntry({
          project: projectA,
          methodName: 'v1.compute.firewalls.delete',
          operation: { id: operation, first: true },
        }),
      ),
      pubsubMessage(
        auditEntry({
          project: projectA,
          methodName: 'v1.compute.firewalls.delete',
          operation: { id: operation, last: true },
        }),
      ),
    );
    expect(await syncFor(pubsub).runOnce()).toMatchObject({ created: 1, duplicates: 1 });
    expect(
      await prisma.finding.count({
        where: { accountId: projectA, sourceEventId: { startsWith: `${projectA}/operacao:` } },
      }),
    ).toBe(1);
  });

  it('a conexão segue a leitura e o evento: a leitura vazia deixa aguardando, a falha vira erro com o tipo e o primeiro evento conecta', async () => {
    const project = randomProject();
    const subscription = subscriptionOf(project);
    const account = await prisma.cloudAccount.create({
      data: {
        tenantId: tenantA,
        provider: 'gcp',
        accountId: project,
        regions: [],
        pubsubSubscription: subscription,
      },
    });
    expect(account).toMatchObject({ connection: 'waiting', connectionError: null, lastCollectedAt: null });
    const state = (accountId: string) =>
      prisma.cloudAccount.findFirstOrThrow({
        where: { provider: 'gcp', accountId },
        select: { connection: true, connectionError: true, lastCollectedAt: true, lastEventAt: true },
      });

    // Lida sem nenhum evento: a coleta fica registrada, mas a leitura vazia não prova que os logs chegam.
    const pubsub = new FakePubsub();
    const first = new Date('2026-11-03T12:00:00.000Z');
    await syncFor(pubsub).runOnce(first);
    expect(await state(project)).toEqual({
      connection: 'waiting',
      connectionError: null,
      lastCollectedAt: first,
      lastEventAt: null,
    });

    // A leitura falha: erro com o tipo, nunca a mensagem; a última coleta bem-sucedida fica.
    class PermissionDenied extends Error {
      override name = 'PermissionDenied';
    }
    const failing: PubsubReader = {
      pull: (name, max) =>
        name === subscription
          ? Promise.reject(new PermissionDenied(`Pub/Sub pull respondeu 403 em ${subscription}`))
          : pubsub.pull(name, max),
      acknowledge: (name, ackIds) => pubsub.acknowledge(name, ackIds),
    };
    const second = new Date('2026-11-03T12:01:00.000Z');
    expect(await syncFor(failing).runOnce(second)).toMatchObject({ failedSubscriptions: 1 });
    expect(await state(project)).toEqual({
      connection: 'error',
      connectionError: 'PermissionDenied',
      lastCollectedAt: first,
      lastEventAt: null,
    });
    // A falha numa assinatura de A não mexe na conta de B, lida na mesma execução.
    expect(await state(projectB)).toMatchObject({ connectionError: null, lastCollectedAt: second });

    // Volta a ler, agora com o primeiro evento: sai do erro e fica conectada, com a nova coleta e o evento.
    pubsub.publish(
      subscription,
      pubsubMessage(
        auditEntry({
          project,
          timestamp: '2026-11-03T12:01:30.000Z',
          methodName: 'v1.compute.instances.list',
        }),
      ),
    );
    const third = new Date('2026-11-03T12:02:00.000Z');
    await syncFor(pubsub).runOnce(third);
    expect(await state(project)).toEqual({
      connection: 'connected',
      connectionError: null,
      lastCollectedAt: third,
      lastEventAt: new Date('2026-11-03T12:01:30.000Z'),
    });
  });

  it('assinatura em clientes diferentes: as contas ficam com erro de origem ambígua, sem coleta', async () => {
    const [ofA, ofB] = [randomProject(), randomProject()];
    const shared = `projects/projeto-no/subscriptions/ambigua-conexao-${ofA}`;
    await prisma.cloudAccount.create({
      data: { tenantId: tenantA, provider: 'gcp', accountId: ofA, regions: [], pubsubSubscription: shared },
    });
    await prisma.cloudAccount.create({
      data: { tenantId: tenantB, provider: 'gcp', accountId: ofB, regions: [], pubsubSubscription: shared },
    });
    await syncFor(new FakePubsub()).runOnce();
    const accounts = await prisma.cloudAccount.findMany({
      where: { provider: 'gcp', accountId: { in: [ofA, ofB] } },
      select: { connection: true, connectionError: true, lastCollectedAt: true },
    });
    expect(accounts).toEqual([
      { connection: 'error', connectionError: 'ambiguous_source', lastCollectedAt: null },
      { connection: 'error', connectionError: 'ambiguous_source', lastCollectedAt: null },
    ]);
  });

  it('leitura vazia: a conta que nunca recebeu evento segue aguardando; a que já recebeu fica conectada, mesmo vindo de um erro', async () => {
    const [empty, seen, failed] = [randomProject(), randomProject(), randomProject()];
    const shared = `projects/projeto-no/subscriptions/agregada-vazia-${empty}`;
    const earlier = new Date('2026-11-03T08:00:00.000Z');
    for (const [project, data] of [
      [empty, {}],
      [seen, { lastEventAt: earlier }],
      [failed, { connection: 'error', connectionError: 'PermissionDenied', lastEventAt: earlier }],
    ] as const) {
      await prisma.cloudAccount.create({
        data: {
          tenantId: tenantA,
          provider: 'gcp',
          accountId: project,
          regions: [],
          pubsubSubscription: shared,
          ...data,
        },
      });
    }
    const now = new Date('2026-11-03T12:30:00.000Z');
    expect(await syncFor(new FakePubsub()).runOnce(now)).toMatchObject({ failedSubscriptions: 0 });

    const rows = await prisma.cloudAccount.findMany({
      where: { provider: 'gcp', accountId: { in: [empty, seen, failed] } },
      select: { accountId: true, connection: true, connectionError: true, lastCollectedAt: true },
    });
    // A coleta e o fim do erro valem para todas; "conectada" só para quem já mostrou que os logs chegam.
    expect(Object.fromEntries(rows.map(({ accountId, ...state }) => [accountId, state]))).toEqual({
      [empty]: { connection: 'waiting', connectionError: null, lastCollectedAt: now },
      [seen]: { connection: 'connected', connectionError: null, lastCollectedAt: now },
      [failed]: { connection: 'connected', connectionError: null, lastCollectedAt: now },
    });
  });

  it('falha no acknowledge do Pub/Sub também é erro de conexão, com o tipo do erro original', async () => {
    const project = randomProject();
    const subscription = subscriptionOf(project);
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenantA,
        provider: 'gcp',
        accountId: project,
        regions: [],
        pubsubSubscription: subscription,
      },
    });
    class DeadlineExceeded extends Error {
      override name = 'DeadlineExceeded';
    }
    const pubsub = new FakePubsub();
    pubsub.publish(
      subscription,
      pubsubMessage(auditEntry({ project, methodName: 'v1.compute.instances.list' })),
    );
    const failingAck: PubsubReader = {
      pull: (name, max) => pubsub.pull(name, max),
      acknowledge: (name, ackIds) =>
        name === subscription
          ? Promise.reject(new DeadlineExceeded(`ack expirou em ${subscription}`))
          : pubsub.acknowledge(name, ackIds),
    };
    expect(await syncFor(failingAck).runOnce()).toMatchObject({ failedSubscriptions: 1 });
    expect(
      await prisma.cloudAccount.findFirstOrThrow({
        where: { provider: 'gcp', accountId: project },
        select: { connection: true, connectionError: true },
      }),
    ).toEqual({ connection: 'error', connectionError: 'DeadlineExceeded' });
  });

  it('erro interno (gravação do achado) conta como assinatura com falha, mas não mexe na conexão da conta', async () => {
    class BrokenGrouping extends IncidentGrouping {
      override place(): ReturnType<IncidentGrouping['place']> {
        return Promise.reject(new TypeError('banco caiu no meio da gravação'));
      }
    }
    const project = randomProject();
    const subscription = subscriptionOf(project);
    // A conta vem de um erro do Pub/Sub: só uma leitura bem-sucedida da fonte pode tirá-la dele.
    const before = {
      connection: 'error',
      connectionError: 'PermissionDenied',
      lastCollectedAt: new Date('2026-11-03T11:00:00.000Z'),
    } as const;
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenantA,
        provider: 'gcp',
        accountId: project,
        regions: [],
        pubsubSubscription: subscription,
        ...before,
      },
    });
    const pubsub = new FakePubsub();
    pubsub.publish(
      subscription,
      pubsubMessage(auditEntry({ project, insertId: `interno-${project}`, methodName: 'DeleteProject' })),
    );
    const name = `gcp-interno-${project.slice(-12)}`;
    const sync = new GcpAuditSync(prisma, pubsub, { name, grouping: new BrokenGrouping() });

    expect(await sync.runOnce(new Date('2026-11-03T12:40:00.000Z'))).toMatchObject({
      failedSubscriptions: 1,
      created: 0,
    });
    // Nada confirmado: a mensagem volta na próxima leitura.
    expect(pubsub.pending(subscription)).toBe(1);
    expect(
      await prisma.cloudAccount.findFirstOrThrow({
        where: { provider: 'gcp', accountId: project },
        select: { connection: true, connectionError: true, lastCollectedAt: true },
      }),
    ).toEqual(before);
    // O tipo do erro interno fica no estado do sync, não na conta.
    expect(await prisma.syncState.findUniqueOrThrow({ where: { name } })).toMatchObject({
      lastError: 'TypeError',
    });
  });

  it('dois workers ao mesmo tempo: só um lê', async () => {
    const pubsub = new FakePubsub();
    const name = `gcp-lease-${projectA.slice(-12)}`;
    const first = new GcpAuditSync(prisma, pubsub, { name, owner: 'um' });
    const second = new GcpAuditSync(prisma, pubsub, { name, owner: 'dois' });
    await prisma.syncState.create({
      data: { name, leaseOwner: 'um', leaseUntil: new Date(Date.now() + 60_000) },
    });
    expect((await second.runOnce()).status).toBe('locked');
    expect((await first.runOnce()).status).toBe('done');
  });
});
