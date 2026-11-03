import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertSync, type AlertSearchClient } from '../src/alerts/alert-sync.js';
import { DEFAULT_SYNC_SETTINGS } from '../src/alerts/sync-query.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { AlertSearch } from '../src/indexer/alert-queries.js';
import type { AlertHit } from '../src/indexer/indexer.client.js';
import { cloudTrailAlert, guardDutyAlert, withAws } from './alerts/fixtures.js';
import { createTenant, createUser } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const MINUTE = 60_000;

/** Horário no formato que o Wazuh grava (fuso sem dois-pontos). */
function wazuhTime(at: Date): string {
  return at.toISOString().replace('Z', '+0000');
}

/**
 * Indexer falso com a mesma semântica do real: só alertas a partir de `since`, em ordem de horário e id, depois do
 * cursor (exclusivo) e no tamanho de página pedido. Os filtros de fonte e nível são do indexer e não entram aqui.
 */
class FakeIndexer implements AlertSearchClient {
  requests: AlertSearch[] = [];
  failWith: Error | null = null;
  /** Falha só a partir desta chamada (1 é a primeira): simula o indexer caindo no meio de uma execução. */
  failFromCall: number | null = null;

  constructor(private readonly documents: Record<string, unknown>[]) {}

  search(request: AlertSearch): Promise<AlertHit[]> {
    this.requests.push(request);
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.failFromCall !== null && this.requests.length >= this.failFromCall) {
      return Promise.reject(new Error('indexer caiu no meio'));
    }
    const body = request.body as {
      size: number;
      search_after?: [string, string];
      query: { bool: { filter: { range?: { timestamp: { gte: string } } }[] } };
    };
    const since = body.query.bool.filter.find((clause) => clause.range)?.range?.timestamp.gte;
    const sortOf = (doc: Record<string, unknown>): [number, string] => [
      Date.parse(String(doc['timestamp']).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')),
      String(doc['id']),
    ];
    const after = body.search_after ? [Date.parse(body.search_after[0]), body.search_after[1]] : null;
    const hits = this.documents
      .map((doc) => ({ doc, sort: sortOf(doc) }))
      .filter(({ sort }) => since === undefined || sort[0] >= Date.parse(since))
      .filter(
        ({ sort }) =>
          after === null ||
          sort[0] > (after[0] as number) ||
          (sort[0] === after[0] && sort[1] > (after[1] as string)),
      )
      .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1].localeCompare(b.sort[1]))
      .slice(0, body.size);
    return Promise.resolve(
      hits.map(({ doc, sort }) => ({
        index: 'wazuh-alerts-4.x-2026.11.03',
        id: randomUUID(),
        sort,
        source: doc,
      })),
    );
  }
}

describe('sync de alertas para achados (T5.3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let creatorA: string;
  const accountA = String(randomInt(100_000_000_000, 999_999_999_999));
  const accountB = String(randomInt(100_000_000_000, 999_999_999_999));
  const trailA = `trilha-a-${randomInt(1e6, 9e6)}`;
  const trailB = `trilha-b-${randomInt(1e6, 9e6)}`;
  const guardDutyA = `guardduty-a-${randomInt(1e6, 9e6)}`;

  /** Alerta do CloudTrail da conta A, no bucket dela, `minutesAgo` minutos atrás. */
  function trailAlertA(minutesAgo: number, options: Parameters<typeof cloudTrailAlert>[0] = {}) {
    const doc = cloudTrailAlert({ account: accountA, bucket: trailA, ...options });
    return {
      ...doc,
      id: `${Date.now()}.${randomInt(1e6, 9e6)}`,
      timestamp: wazuhTime(new Date(Date.now() - minutesAgo * MINUTE)),
    };
  }

  const syncFor = (indexer: AlertSearchClient, options: ConstructorParameters<typeof AlertSync>[2] = {}) =>
    new AlertSync(prisma, indexer, { name: `teste-${randomUUID().slice(0, 8)}`, ...options });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (sync)');
    tenantB = await createTenant(app, 'Cliente B (sync)');
    creatorA = (await createUser(app, { role: 'admin_cliente', tenantId: tenantA })).id;
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenantA,
        accountId: accountA,
        regions: ['sa-east-1'],
        externalId: 'x'.repeat(43),
        cloudtrailBucket: trailA,
        guarddutyBucket: guardDutyA,
      },
    });
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenantB,
        accountId: accountB,
        regions: ['sa-east-1'],
        externalId: 'y'.repeat(43),
        cloudtrailBucket: trailB,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('alerta com dono vira achado do cliente certo; sem dono e inválido vão para a fila', async () => {
    const owned = trailAlertA(30, { sourceIp: '198.51.100.7', eventName: 'StopLogging', level: 12 });
    const unknownBucket = withAws(trailAlertA(20), {
      log_info: { s3bucket: 'bucket-de-ninguem', log_file: `AWSLogs/${accountA}/x.gz` },
    });
    const invalidId = `quebrado.${randomInt(1e6, 9e6)}`;
    const invalid = {
      id: invalidId,
      timestamp: wazuhTime(new Date(Date.now() - 10 * MINUTE)),
      rule: 'não é objeto',
    };
    const sync = syncFor(new FakeIndexer([owned, unknownBucket, invalid]));

    const report = await sync.runOnce();
    expect(report).toMatchObject({ status: 'done', read: 3, created: 1, unowned: 2, duplicates: 0 });

    const finding = await prisma.finding.findUniqueOrThrow({
      where: { source_sourceEventId: { source: 'wazuh', sourceEventId: String(owned['id']) } },
    });
    expect(finding).toMatchObject({
      tenantId: tenantA,
      accountId: accountA,
      logSource: 'cloudtrail',
      severity: 'critical',
      status: 'new',
      eventName: 'StopLogging',
      sourceIp: '198.51.100.7',
      exceptionId: null,
    });
    const queue = await prisma.unownedAlert.findMany({
      where: { sourceEventId: { in: [String(unknownBucket['id']), invalidId] } },
      orderBy: { sourceEventId: 'asc' },
    });
    expect(queue.map((item) => item.reason).sort()).toEqual(['invalid_alert', 'unknown_source']);
    // A fila não guarda o evento bruto.
    expect(JSON.stringify(queue)).not.toContain('full_log');

    const account = await prisma.cloudAccount.findFirstOrThrow({ where: { accountId: accountA } });
    expect(account.lastEventAt?.toISOString()).toBe(finding.occurredAt.toISOString());
  });

  it('reler a janela não duplica e não desfaz a triagem', async () => {
    const alert = trailAlertA(15);
    const indexer = new FakeIndexer([alert]);
    const sync = syncFor(indexer);
    await sync.runOnce();
    const where = { source_sourceEventId: { source: 'wazuh', sourceEventId: String(alert['id']) } };
    await prisma.finding.update({ where, data: { status: 'resolved' } });

    const again = await sync.runOnce();
    expect(again).toMatchObject({ read: 1, created: 0, duplicates: 1 });
    expect((await prisma.finding.findUniqueOrThrow({ where })).status).toBe('resolved');
    expect(await prisma.finding.count({ where: { sourceEventId: String(alert['id']) } })).toBe(1);
  });

  it('evento forjado no bucket de B citando a conta de A não vira achado de ninguém', async () => {
    const forged = cloudTrailAlert({ account: accountA, bucket: trailB });
    const doc = {
      ...forged,
      id: `forjado.${randomInt(1e6, 9e6)}`,
      timestamp: wazuhTime(new Date(Date.now() - 5 * MINUTE)),
    };
    const report = await syncFor(new FakeIndexer([doc])).runOnce();
    expect(report).toMatchObject({ created: 0, unowned: 1 });
    expect(await prisma.finding.count({ where: { sourceEventId: String(doc['id']) } })).toBe(0);
    const queued = await prisma.unownedAlert.findFirstOrThrow({
      where: { sourceEventId: String(doc['id']) },
    });
    expect(['source_mismatch', 'unknown_account']).toContain(queued.reason);
  });

  it('exceção em vigor: o achado já nasce legítimo, e a exceção conta o uso', async () => {
    const exception = await prisma.alertException.create({
      data: {
        tenantId: tenantA,
        ruleId: '80254',
        field: 'ip',
        value: '192.0.2.0/24',
        reason: 'Varredura autorizada do fornecedor',
        createdById: creatorA,
      },
    });
    const expired = await prisma.alertException.create({
      data: {
        tenantId: tenantA,
        ruleId: '80254',
        field: 'ip',
        value: '192.0.2.10',
        reason: 'Vencida',
        expiresAt: new Date(Date.now() - MINUTE),
        createdById: creatorA,
      },
    });
    const matched = trailAlertA(4, { sourceIp: '192.0.2.10' });
    const other = trailAlertA(3, { sourceIp: '203.0.113.99' });
    const report = await syncFor(new FakeIndexer([matched, other])).runOnce();
    expect(report).toMatchObject({ created: 2, excepted: 1 });

    const byId = (id: unknown) =>
      prisma.finding.findUniqueOrThrow({
        where: { source_sourceEventId: { source: 'wazuh', sourceEventId: String(id) } },
      });
    expect(await byId(matched['id'])).toMatchObject({ status: 'legitimate', exceptionId: exception.id });
    expect(await byId(other['id'])).toMatchObject({ status: 'new', exceptionId: null });
    expect(await prisma.alertException.findUniqueOrThrow({ where: { id: exception.id } })).toMatchObject({
      matchedCount: 1,
    });
    expect((await prisma.alertException.findUniqueOrThrow({ where: { id: expired.id } })).matchedCount).toBe(
      0,
    );
  });

  it('exceção de um cliente não vale para alerta de outro', async () => {
    const catchAll = await prisma.alertException.create({
      data: {
        tenantId: tenantA,
        ruleId: '80254',
        field: 'ip',
        value: '0.0.0.0/0',
        reason: 'Tudo esperado em A',
        createdById: creatorA,
      },
    });
    const alertB = cloudTrailAlert({ account: accountB, bucket: trailB, sourceIp: '198.51.100.200' });
    const doc = {
      ...alertB,
      id: `b.${randomInt(1e6, 9e6)}`,
      timestamp: wazuhTime(new Date(Date.now() - 2 * MINUTE)),
    };
    await syncFor(new FakeIndexer([doc])).runOnce();
    expect(
      await prisma.finding.findUniqueOrThrow({
        where: { source_sourceEventId: { source: 'wazuh', sourceEventId: String(doc['id']) } },
      }),
    ).toMatchObject({ tenantId: tenantB, status: 'new', exceptionId: null });
    // A exceção ampla não fica valendo para os testes seguintes do cliente A.
    await prisma.alertException.delete({ where: { id: catchAll.id } });
  });

  it('GuardDuty da conta A, pelo bucket cadastrado, usa a severidade da AWS', async () => {
    const alert = guardDutyAlert({ account: accountA, bucket: guardDutyA });
    const doc = {
      ...alert,
      id: `gd.${randomInt(1e6, 9e6)}`,
      timestamp: wazuhTime(new Date(Date.now() - MINUTE)),
    };
    const report = await syncFor(new FakeIndexer([doc])).runOnce();
    expect(report.created).toBe(1);
    expect(
      await prisma.finding.findUniqueOrThrow({
        where: { source_sourceEventId: { source: 'wazuh', sourceEventId: String(doc['id']) } },
      }),
    ).toMatchObject({ tenantId: tenantA, logSource: 'guardduty' });
  });

  it('pagina pelo cursor; com limite de páginas, a próxima execução continua de onde parou', async () => {
    const docs = [50, 40, 30, 20, 10].map((minutesAgo) => trailAlertA(minutesAgo));
    const indexer = new FakeIndexer(docs);
    const settings = { ...DEFAULT_SYNC_SETTINGS, pageSize: 2, overlapMs: 0 };
    const sync = syncFor(indexer, { settings, maxPages: 2 });

    const first = await sync.runOnce();
    expect(first).toMatchObject({ read: 4, created: 4 });
    expect(first.lastProcessedAt).toBe(
      new Date(Date.parse(String(docs[3]?.['timestamp']).replace('+0000', 'Z'))).toISOString(),
    );
    expect(indexer.requests).toHaveLength(2);

    const second = await sync.runOnce();
    // A execução anterior bateu o limite: esta segue do cursor dela, sem reler o que já foi lido.
    expect(second).toMatchObject({ read: 1, created: 1, duplicates: 0 });
    expect(
      await prisma.finding.count({ where: { sourceEventId: { in: docs.map((doc) => String(doc['id'])) } } }),
    ).toBe(5);
  });

  it('sobreposição maior que o limite de páginas não trava a leitura: a continuação avança', async () => {
    // Seis alertas em dez minutos, páginas de dois e limite de duas páginas, com a sobreposição padrão (dez
    // minutos): sem a continuação, toda execução relia os mesmos quatro e parava no quarto.
    const docs = [9, 8, 7, 6, 5, 4].map((minutesAgo) => trailAlertA(minutesAgo));
    const settings = { ...DEFAULT_SYNC_SETTINGS, pageSize: 2 };
    const sync = syncFor(new FakeIndexer(docs), { settings, maxPages: 2 });
    const ids = docs.map((doc) => String(doc['id']));

    expect(await sync.runOnce()).toMatchObject({ created: 4 });
    expect(await sync.runOnce()).toMatchObject({ created: 2 });
    expect(await prisma.finding.count({ where: { sourceEventId: { in: ids } } })).toBe(6);
    // Com a leitura em dia, a execução seguinte volta a reler a sobreposição, sem duplicar.
    expect(await sync.runOnce()).toMatchObject({ created: 0 });
  });

  it('depois de uma falha no meio, a nova tentativa grava o último evento da conta', async () => {
    const tenant = await createTenant(app, 'Cliente com falha no meio');
    const account = String(randomInt(100_000_000_000, 999_999_999_999));
    const bucket = `trilha-falha-${randomInt(1e6, 9e6)}`;
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenant,
        accountId: account,
        regions: ['sa-east-1'],
        externalId: 'w'.repeat(43),
        cloudtrailBucket: bucket,
      },
    });
    const alert = cloudTrailAlert({ account, bucket });
    const at = new Date(Date.now() - 3 * MINUTE);
    const doc = { ...alert, id: `falha.${randomInt(1e6, 9e6)}`, timestamp: wazuhTime(at) };
    const settings = { ...DEFAULT_SYNC_SETTINGS, pageSize: 1 };
    const name = `teste-${randomUUID().slice(0, 8)}`;

    // A primeira página grava o achado; a segunda falha, e a execução não chega a gravar o último evento.
    const broken = new FakeIndexer([doc]);
    broken.failFromCall = 2;
    await expect(new AlertSync(prisma, broken, { name, settings }).runOnce()).rejects.toThrow();
    const stored = () => prisma.cloudAccount.findFirstOrThrow({ where: { accountId: account } });
    expect((await stored()).lastEventAt).toBeNull();

    // Na nova tentativa, o achado volta como duplicado, e o último evento é gravado mesmo assim.
    const report = await new AlertSync(prisma, new FakeIndexer([doc]), { name, settings }).runOnce();
    expect(report).toMatchObject({ created: 0, duplicates: 1 });
    expect((await stored()).lastEventAt?.toISOString()).toBe(at.toISOString());
  });

  it('outro worker com a concessão em vigor: a execução não lê nada', async () => {
    const name = `teste-${randomUUID().slice(0, 8)}`;
    await prisma.syncState.create({
      data: { name, leaseOwner: 'outro-worker', leaseUntil: new Date(Date.now() + 5 * MINUTE) },
    });
    const indexer = new FakeIndexer([trailAlertA(1)]);
    const report = await new AlertSync(prisma, indexer, { name }).runOnce();
    expect(report.status).toBe('locked');
    expect(indexer.requests).toHaveLength(0);
  });

  it('concessão vencida (worker que morreu) é retomada', async () => {
    const name = `teste-${randomUUID().slice(0, 8)}`;
    await prisma.syncState.create({
      data: { name, leaseOwner: 'worker-morto', leaseUntil: new Date(Date.now() - MINUTE) },
    });
    const report = await new AlertSync(prisma, new FakeIndexer([]), { name }).runOnce();
    expect(report.status).toBe('done');
    expect(await prisma.syncState.findUniqueOrThrow({ where: { name } })).toMatchObject({
      leaseOwner: null,
      leaseUntil: null,
    });
  });

  it('falha do indexer: grava só o tipo do erro, libera a concessão e não avança a leitura', async () => {
    const name = `teste-${randomUUID().slice(0, 8)}`;
    const indexer = new FakeIndexer([trailAlertA(1)]);
    class IndexerError extends Error {
      override name = 'IndexerError';
    }
    indexer.failWith = new IndexerError('detalhe que não pode ir para o banco');
    await expect(new AlertSync(prisma, indexer, { name }).runOnce()).rejects.toThrow(IndexerError);
    expect(await prisma.syncState.findUniqueOrThrow({ where: { name } })).toMatchObject({
      lastError: 'IndexerError',
      lastProcessedAt: null,
      leaseOwner: null,
    });
  });

  describe('agrupamento em incidentes (T5.6)', () => {
    // Faixa que nenhuma exceção dos outros testes cobre.
    const ip = () => `100.64.${randomInt(0, 255)}.${randomInt(1, 254)}`;
    /** Usuário e chave próprios: os alertas de exemplo dividem o mesmo usuário e cairiam no mesmo incidente. */
    const identity = () => {
      const name = `teste-${randomInt(1e6, 9e6)}`;
      return {
        type: 'IAMUser',
        arn: `arn:aws:iam::${accountA}:user/${name}`,
        accountId: accountA,
        accessKeyId: `AKIA${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
        userName: name,
      };
    };
    const findingOf = (doc: Record<string, unknown>) =>
      prisma.finding.findUniqueOrThrow({
        where: { source_sourceEventId: { source: 'wazuh', sourceEventId: String(doc['id']) } },
      });

    it('o primeiro achado grave abre o incidente; o seguinte com o mesmo IP entra nele', async () => {
      const shared = ip();
      const first = trailAlertA(40, {
        sourceIp: shared,
        level: 12,
        identity: { type: 'IAMUser', userName: 'um' },
      });
      const second = trailAlertA(20, {
        sourceIp: shared,
        level: 10,
        identity: { type: 'IAMUser', userName: 'dois' },
      });
      const report = await syncFor(new FakeIndexer([first, second])).runOnce();
      expect(report).toMatchObject({ created: 2, incidentsOpened: 1, incidentsJoined: 1 });

      const [a, b] = [await findingOf(first), await findingOf(second)];
      expect(a.incidentId).not.toBeNull();
      expect(b.incidentId).toBe(a.incidentId);
      const incident = await prisma.incident.findUniqueOrThrow({ where: { id: a.incidentId as string } });
      expect(incident).toMatchObject({
        tenantId: tenantA,
        severity: 'critical',
        findingCount: 2,
        status: 'open',
      });
      expect(incident.keys).toContain(`ip:${shared}`);
      expect(incident.riskScore).toBe(73);
    });

    it('achado baixo sozinho fica só como achado', async () => {
      const low = trailAlertA(10, { sourceIp: ip(), level: 5, identity: identity() });
      const report = await syncFor(new FakeIndexer([low])).runOnce();
      expect(report).toMatchObject({ created: 1, incidentsOpened: 0, incidentsJoined: 0 });
      expect((await findingOf(low)).incidentId).toBeNull();
    });

    it('achado esperado por exceção não abre incidente', async () => {
      const address = ip();
      await prisma.alertException.create({
        data: {
          tenantId: tenantA,
          ruleId: '80254',
          field: 'ip',
          value: address,
          reason: 'Teste de carga autorizado',
          createdById: creatorA,
        },
      });
      const doc = trailAlertA(8, { sourceIp: address, level: 12 });
      const report = await syncFor(new FakeIndexer([doc])).runOnce();
      expect(report).toMatchObject({ excepted: 1, incidentsOpened: 0 });
      expect((await findingOf(doc)).incidentId).toBeNull();
    });

    it('recurso da lista de proteção soma 15 na nota', async () => {
      const bucketName = `relatorios-${randomInt(1e6, 9e6)}`;
      await prisma.protectedResource.create({
        data: {
          tenantId: tenantA,
          type: 's3_bucket',
          identifier: bucketName,
          reason: 'Dados de clientes',
          createdById: creatorA,
        },
      });
      const doc = trailAlertA(6, {
        sourceIp: ip(),
        identity: identity(),
        level: 10,
        eventName: 'PutBucketPolicy',
        requestParameters: { bucketName },
      });
      await syncFor(new FakeIndexer([doc])).runOnce();
      const finding = await findingOf(doc);
      expect(finding.resource).toBe(`s3:${bucketName}`);
      const incident = await prisma.incident.findUniqueOrThrow({
        where: { id: finding.incidentId as string },
      });
      expect(incident.riskScore).toBe(65);
    });

    it('incidente de outro cliente nunca recebe achado, nem com o mesmo IP', async () => {
      const shared = ip();
      const docB = cloudTrailAlert({ account: accountB, bucket: trailB, sourceIp: shared, level: 12 });
      const fromB = {
        ...docB,
        id: `b.${randomInt(1e6, 9e6)}`,
        timestamp: wazuhTime(new Date(Date.now() - 5 * MINUTE)),
      };
      const fromA = trailAlertA(4, { sourceIp: shared, level: 12 });
      await syncFor(new FakeIndexer([fromB, fromA])).runOnce();
      const [b, a] = [await findingOf(fromB), await findingOf(fromA)];
      expect(a.incidentId).not.toBeNull();
      expect(b.incidentId).not.toBeNull();
      expect(a.incidentId).not.toBe(b.incidentId);
    });
  });

  it('conta desativada deixa de receber alertas: eles vão para a fila', async () => {
    const tenant = await createTenant(app, 'Cliente com conta inativa');
    const account = String(randomInt(100_000_000_000, 999_999_999_999));
    const bucket = `trilha-inativa-${randomInt(1e6, 9e6)}`;
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenant,
        accountId: account,
        regions: ['sa-east-1'],
        externalId: 'z'.repeat(43),
        cloudtrailBucket: bucket,
        status: 'inactive',
      },
    });
    const alert = cloudTrailAlert({ account, bucket });
    const doc = {
      ...alert,
      id: `inativa.${randomInt(1e6, 9e6)}`,
      timestamp: wazuhTime(new Date(Date.now() - MINUTE)),
    };
    const report = await syncFor(new FakeIndexer([doc])).runOnce();
    expect(report).toMatchObject({ created: 0, unowned: 1 });
  });
});
