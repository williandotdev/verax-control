import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertSync, type AlertSearchClient } from '../src/alerts/alert-sync.js';
import { toFindingDraft, wazuhFindingKey } from '../src/alerts/finding-draft.js';
import { parseWazuhAlert } from '../src/alerts/wazuh-alert.js';
import { IncidentGrouping, protectedItemsOf } from '../src/incidents/incident-grouping.js';
import { DEFAULT_SYNC_SETTINGS } from '../src/alerts/sync-query.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { cloudTrailAlert, guardDutyAlert, portProbeAlerts, wafAlert, withAws } from './alerts/fixtures.js';
import { createTenant, createUser } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { FakeIndexer, wazuhTime } from './support/fake-indexer.js';

const MINUTE = 60_000;

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
  const wafA = `aws-waf-logs-a-${randomInt(1e6, 9e6)}`;

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

  /** Chave do achado de um alerta, pela mesma função do sync (o formato é conferido em test/alerts). */
  function keyOf(doc: Record<string, unknown>, account = accountA): string {
    const parsed = parseWazuhAlert(doc);
    if (!parsed.ok) throw new Error(parsed.reason);
    return wazuhFindingKey(parsed.alert, account);
  }
  const byKey = (doc: Record<string, unknown>, account = accountA) => ({
    source_sourceEventId: { source: 'wazuh', sourceEventId: keyOf(doc, account) },
  });

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
        cloudtrailBucket: trailA,
        guarddutyBucket: guardDutyA,
        wafBucket: wafA,
      },
    });
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenantB,
        accountId: accountB,
        regions: ['sa-east-1'],
        cloudtrailBucket: trailB,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('alerta com dono vira achado do cliente certo; sem dono e inválido vão para a fila', async () => {
    const owned = trailAlertA(30, {
      sourceIp: '198.51.100.7',
      eventName: 'StopLogging',
      level: 12,
      rule: { id: '100310', description: 'Verax Control: CloudTrail parado ou apagado (StopLogging).' },
    });
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

    const finding = await prisma.finding.findUniqueOrThrow({ where: byKey(owned) });
    expect(finding).toMatchObject({
      tenantId: tenantA,
      accountId: accountA,
      // O id do alerta fica para o detalhe buscar o evento bruto no indexer.
      rawEventId: owned.id,
      logSource: 'cloudtrail',
      severity: 'critical',
      status: 'new',
      eventName: 'StopLogging',
      sourceIp: '198.51.100.7',
      exceptionId: null,
      // O título fixo da regra (fase 2, PR-V7), sem o que a descrição do Wazuh cita do evento.
      ruleId: '100310',
      title: 'CloudTrail parado ou apagado',
    });
    const queue = await prisma.unownedAlert.findMany({
      where: { sourceEventId: { in: [String(unknownBucket['id']), invalidId] } },
      orderBy: { sourceEventId: 'asc' },
    });
    expect(queue.map((item) => [item.reason, item.title]).sort()).toEqual([
      ['invalid_alert', null],
      ['unknown_source', 'Login no console com falha'],
    ]);
    // A fila não guarda o evento bruto.
    expect(JSON.stringify(queue)).not.toContain('full_log');

    const account = await prisma.cloudAccount.findFirstOrThrow({ where: { accountId: accountA } });
    expect(account.lastEventAt?.toISOString()).toBe(finding.occurredAt.toISOString());
    // O evento recebido conecta a conta, que aguardava desde o cadastro.
    expect(account.connection).toBe('connected');
  });

  it('reler a janela não duplica e não desfaz a triagem', async () => {
    const alert = trailAlertA(15);
    const indexer = new FakeIndexer([alert]);
    const sync = syncFor(indexer);
    await sync.runOnce();
    const where = byKey(alert);
    await prisma.finding.update({ where, data: { status: 'resolved' } });

    const again = await sync.runOnce();
    expect(again).toMatchObject({ read: 1, created: 0, duplicates: 1 });
    expect((await prisma.finding.findUniqueOrThrow({ where })).status).toBe('resolved');
    expect(await prisma.finding.count({ where: { sourceEventId: keyOf(alert) } })).toBe(1);
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
    expect(await prisma.finding.count({ where: { rawEventId: doc.id } })).toBe(0);
    const queued = await prisma.unownedAlert.findFirstOrThrow({
      where: { sourceEventId: String(doc['id']) },
    });
    expect(['source_mismatch', 'unknown_account']).toContain(queued.reason);
  });

  it('alerta de agente com cara de evento da AWS (bucket e conta de A) não passa por este sync', async () => {
    // O log de uma instância é de quem a usa: um agente pode mandar um JSON igual ao do módulo aws-s3.
    const forged = { ...trailAlertA(5), agent: { id: '001', name: 'web-01' } };
    const manager = trailAlertA(4);
    const report = await syncFor(new FakeIndexer([forged, manager])).runOnce();
    expect(report).toMatchObject({ read: 2, created: 1, skipped: 1, unowned: 0 });
    expect(await prisma.finding.findUnique({ where: byKey(forged) })).toBeNull();
    expect(await prisma.unownedAlert.count({ where: { sourceEventId: String(forged['id']) } })).toBe(0);
    expect(await prisma.finding.findUniqueOrThrow({ where: byKey(manager) })).toMatchObject({
      tenantId: tenantA,
      accountId: accountA,
    });
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

    const byDoc = (doc: Record<string, unknown>) => prisma.finding.findUniqueOrThrow({ where: byKey(doc) });
    expect(await byDoc(matched)).toMatchObject({ status: 'legitimate', exceptionId: exception.id });
    expect(await byDoc(other)).toMatchObject({ status: 'new', exceptionId: null });
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
    expect(await prisma.finding.findUniqueOrThrow({ where: byKey(doc, accountB) })).toMatchObject({
      tenantId: tenantB,
      status: 'new',
      exceptionId: null,
    });
    // A exceção ampla não fica valendo para os testes seguintes do cliente A.
    await prisma.alertException.delete({ where: { id: catchAll.id } });
  });

  it('GuardDuty da conta A, pelo bucket cadastrado, usa a severidade da AWS', async () => {
    // A regra padrão da fixture tem nível 10, que pelo nível daria alta. A fixture grava a severidade em texto, como
    // o Wazuh ("5.500000", "9.500000"): média e crítica no banco só saem da severidade da AWS, lida até a gravação.
    const docOf = (severity: number) => ({
      ...guardDutyAlert({ account: accountA, bucket: guardDutyA, severity }),
      id: `gd.${severity}.${randomInt(1e6, 9e6)}`,
      timestamp: wazuhTime(new Date(Date.now() - MINUTE)),
    });
    const medium = docOf(5.5);
    const critical = docOf(9.5);
    const report = await syncFor(new FakeIndexer([medium, critical])).runOnce();
    expect(report.created).toBe(2);
    expect(await prisma.finding.findUniqueOrThrow({ where: byKey(medium) })).toMatchObject({
      tenantId: tenantA,
      logSource: 'guardduty',
      ruleLevel: 10,
      severity: 'medium',
    });
    expect(await prisma.finding.findUniqueOrThrow({ where: byKey(critical) })).toMatchObject({
      ruleLevel: 10,
      severity: 'critical',
    });
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
      await prisma.finding.count({ where: { sourceEventId: { in: docs.map((doc) => keyOf(doc)) } } }),
    ).toBe(5);
  });

  it('sobreposição maior que o limite de páginas não trava a leitura: a continuação avança', async () => {
    // Seis alertas em dez minutos, páginas de dois e limite de duas páginas, com a sobreposição padrão (dez
    // minutos): sem a continuação, toda execução relia os mesmos quatro e parava no quarto.
    const docs = [9, 8, 7, 6, 5, 4].map((minutesAgo) => trailAlertA(minutesAgo));
    const settings = { ...DEFAULT_SYNC_SETTINGS, pageSize: 2 };
    const sync = syncFor(new FakeIndexer(docs), { settings, maxPages: 2 });
    const keys = docs.map((doc) => keyOf(doc));

    expect(await sync.runOnce()).toMatchObject({ created: 4 });
    expect(await sync.runOnce()).toMatchObject({ created: 2 });
    expect(await prisma.finding.count({ where: { sourceEventId: { in: keys } } })).toBe(6);
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

  it('o evento recebido pelo Wazuh conecta a conta que aguardava; a conta com erro continua com erro', async () => {
    const tenant = await createTenant(app, 'Cliente da conexão pelo Wazuh');
    const waiting = String(randomInt(100_000_000_000, 999_999_999_999));
    const failed = String(randomInt(100_000_000_000, 999_999_999_999));
    const bucketOf = (prefix: string) => `${prefix}-${randomInt(1e6, 9e6)}`;
    const [waitingBucket, failedBucket] = [bucketOf('trilha-aguardando'), bucketOf('trilha-com-erro')];
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenant,
        accountId: waiting,
        regions: ['sa-east-1'],
        cloudtrailBucket: waitingBucket,
      },
    });
    // Só o sync da fonte tira a conta do erro: o evento que chega pelo Wazuh não apaga o erro registrado.
    await prisma.cloudAccount.create({
      data: {
        tenantId: tenant,
        accountId: failed,
        regions: ['sa-east-1'],
        cloudtrailBucket: failedBucket,
        connection: 'error',
        connectionError: 'AccessDenied',
      },
    });
    const at = new Date(Date.now() - 2 * MINUTE);
    const doc = (account: string, bucket: string) => ({
      ...cloudTrailAlert({ account, bucket }),
      id: `conexao.${randomInt(1e6, 9e6)}`,
      timestamp: wazuhTime(at),
    });
    const report = await syncFor(
      new FakeIndexer([doc(waiting, waitingBucket), doc(failed, failedBucket)]),
    ).runOnce();
    expect(report).toMatchObject({ read: 2, unowned: 0 });

    const state = (accountId: string) =>
      prisma.cloudAccount.findFirstOrThrow({
        where: { provider: 'aws', accountId },
        select: { connection: true, connectionError: true, lastEventAt: true },
      });
    expect(await state(waiting)).toEqual({ connection: 'connected', connectionError: null, lastEventAt: at });
    expect(await state(failed)).toEqual({
      connection: 'error',
      connectionError: 'AccessDenied',
      lastEventAt: at,
    });
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
    it('lista de proteção no formato do achado: s3:, ec2: e sg:', () => {
      const items = protectedItemsOf([
        { type: 's3_bucket', identifier: 'relatorios' },
        { type: 'ec2_instance', identifier: 'i-0abc1234' },
        { type: 'security_group', identifier: 'sg-0123456789abcdef0' },
      ]);
      expect([...items]).toEqual(
        expect.arrayContaining(['s3:relatorios', 'ec2:i-0abc1234', 'sg:sg-0123456789abcdef0']),
      );
      expect(items.has('ec2:sg-0123456789abcdef0')).toBe(false);
    });

    it('falha no meio do agrupamento não deixa o achado gravado sem incidente: a próxima execução refaz', async () => {
      class FailingOnce extends IncidentGrouping {
        failed = false;
        override place(...args: Parameters<IncidentGrouping['place']>) {
          if (!this.failed) {
            this.failed = true;
            return Promise.reject(new Error('banco caiu no meio'));
          }
          return super.place(...args);
        }
      }
      const name = `teste-${randomUUID().slice(0, 8)}`;
      const doc = trailAlertA(7, { sourceIp: `100.65.${randomInt(0, 255)}.${randomInt(1, 254)}`, level: 12 });
      const where = byKey(doc);
      const grouping = new FailingOnce();

      await expect(
        new AlertSync(prisma, new FakeIndexer([doc]), { name, grouping }).runOnce(),
      ).rejects.toThrow();
      expect(await prisma.finding.findUnique({ where })).toBeNull();

      const report = await new AlertSync(prisma, new FakeIndexer([doc]), { name, grouping }).runOnce();
      expect(report.created).toBe(1);
      expect((await prisma.finding.findUniqueOrThrow({ where })).incidentId).not.toBeNull();
    });

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
    const findingOf = (doc: Record<string, unknown>, account = accountA) =>
      prisma.finding.findUniqueOrThrow({ where: byKey(doc, account) });

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
      const [b, a] = [await findingOf(fromB, accountB), await findingOf(fromA)];
      expect(a.incidentId).not.toBeNull();
      expect(b.incidentId).not.toBeNull();
      expect(a.incidentId).not.toBe(b.incidentId);
    });
  });

  describe('chave estável do achado (fase 2, PR-W2)', () => {
    /** IP e usuário próprios: os achados destes testes não entram em incidente de outro teste. */
    const actor = () => {
      const name = `chave-${randomInt(1e6, 9e6)}`;
      return {
        sourceIp: `100.66.${randomInt(0, 255)}.${randomInt(1, 254)}`,
        identity: { type: 'IAMUser', arn: `arn:aws:iam::${accountA}:user/${name}`, userName: name },
      };
    };
    const newAlertId = () => `${Date.now()}.${randomInt(1e6, 9e6)}`;

    it('o mesmo evento relido com outro id de alerta (snapshot, --reparse) não duplica nem desfaz a triagem', async () => {
      const eventId = randomUUID();
      const first = trailAlertA(14, { ...actor(), eventId });
      await syncFor(new FakeIndexer([first])).runOnce();
      await prisma.finding.update({ where: byKey(first), data: { status: 'resolved' } });

      // Releitura numa execução posterior: o Wazuh dá outro id e outro horário ao mesmo evento da AWS.
      const reparsed = { ...first, id: newAlertId(), timestamp: wazuhTime(new Date(Date.now() - MINUTE)) };
      const report = await syncFor(new FakeIndexer([reparsed])).runOnce();
      expect(report).toMatchObject({ read: 1, created: 0, duplicates: 1 });

      const finding = await prisma.finding.findUniqueOrThrow({ where: byKey(first) });
      expect(finding).toMatchObject({
        sourceEventId: `wazuh/${accountA}/cloudtrail:${eventId}:80254`,
        status: 'resolved',
        // O detalhe segue no alerta da primeira leitura.
        rawEventId: first.id,
      });
      expect(await prisma.finding.count({ where: { rawEventId: { in: [first.id, reparsed.id] } } })).toBe(1);
    });

    describe('achado do GuardDuty atualizado: reincidência depois da triagem (decisão de 2026-11-04)', () => {
      /**
       * Versões do mesmo achado do GuardDuty na conta A: o `count` sobe e a última atividade (`eventLastSeen`, que
       * a fixture também grava no `updatedAt`) avança a cada atualização. O IP próprio separa os incidentes.
       */
      const versionsOf =
        (findingId: string, ip = `100.69.${randomInt(0, 255)}.${randomInt(1, 254)}`) =>
        (count: number, minutesAgo: number, severity?: number) => {
          const at = new Date(Date.now() - minutesAgo * MINUTE);
          return {
            ...guardDutyAlert({
              account: accountA,
              bucket: guardDutyA,
              findingId,
              count,
              ...(severity !== undefined && { severity }),
              updatedAt: at.toISOString(),
              action: {
                actionType: 'AWS_API_CALL',
                awsApiCallAction: { api: 'ListBuckets', remoteIpDetails: { ipAddressV4: ip } },
              },
            }),
            id: newAlertId(),
            timestamp: wazuhTime(at),
          };
        };
      /** A versão de um alerta e a reincidência do rascunho (cadeia e chave da recorrência), pelas funções do sync. */
      const lastSeenOf = (doc: Record<string, unknown>): Date => {
        const parsed = parseWazuhAlert(doc);
        if (!parsed.ok || parsed.alert.lastSeenAt === undefined) throw new Error('versão sem horário');
        return new Date(parsed.alert.lastSeenAt);
      };
      const recurrenceOf = (doc: Record<string, unknown>) => {
        const parsed = parseWazuhAlert(doc);
        if (!parsed.ok) throw new Error(parsed.reason);
        const draft = toFindingDraft(parsed.alert, { owned: true, tenantId: tenantA, accountId: accountA });
        if (!draft.recurrence) throw new Error('versão sem reincidência');
        return draft.recurrence;
      };
      const byRecurrence = (doc: Record<string, unknown>) => ({
        source_sourceEventId: { source: 'wazuh', sourceEventId: recurrenceOf(doc).sourceEventId },
      });
      const findingsOf = (findingId: string) =>
        prisma.finding.findMany({
          where: { sourceEventId: { contains: findingId } },
          orderBy: { createdAt: 'asc' },
        });
      /**
       * A versão de uma sondagem de porta como o wodle a entrega: um alerta por IP, na ordem dada (o horário do
       * alerta cresce com a posição, e o indexer falso lê nessa ordem), todos com o mesmo `updatedAt`.
       */
      const probeVersionsOf =
        (findingId: string, instanceId: string) => (minutesAgo: number, ips: readonly string[]) => {
          const at = new Date(Date.now() - minutesAgo * MINUTE);
          return portProbeAlerts(
            ips.map((ip) => ({ ip, port: 22 })),
            { account: accountA, bucket: guardDutyA, findingId, instanceId, updatedAt: at.toISOString() },
          ).map((doc, index) => ({
            ...doc,
            id: newAlertId(),
            timestamp: wazuhTime(new Date(at.getTime() + index * 1000)),
          }));
        };

      it('ainda não triado, o achado absorve as versões novas: um achado só, com a última atividade da mais nova', async () => {
        const findingId = randomUUID().replace(/-/g, '');
        const version = versionsOf(findingId);
        const [first, second, third] = [version(1, 25), version(4, 12), version(9, 2)];
        const report = await syncFor(new FakeIndexer([first, second, third])).runOnce();
        expect(report).toMatchObject({ read: 3, created: 1, duplicates: 2 });

        const findings = await findingsOf(findingId);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
          sourceEventId: `wazuh/${accountA}/guardduty:${findingId}:80303`,
          status: 'new',
          // Os campos e o evento bruto seguem os da primeira versão; só a última atividade avança.
          rawEventId: first.id,
          lastSeenAt: lastSeenOf(third),
          recurrenceOfId: null,
        });
        // A versão do meio, relida depois (sobreposição), já está coberta.
        expect(await syncFor(new FakeIndexer([{ ...second, id: newAlertId() }])).runOnce()).toMatchObject({
          created: 0,
          duplicates: 1,
        });
        expect((await findingsOf(findingId))[0]?.lastSeenAt).toEqual(lastSeenOf(third));
      });

      for (const status of ['investigating', 'legitimate', 'resolved'] as const) {
        it(`atividade nova num achado ${status} vira outro achado, ligado ao original, que não muda; reler a versão nova não faz um terceiro`, async () => {
          const findingId = randomUUID().replace(/-/g, '');
          const version = versionsOf(findingId);
          const first = version(1, 30, 5.5);
          await syncFor(new FakeIndexer([first])).runOnce();
          await prisma.finding.update({ where: byKey(first), data: { status, triagedAt: new Date() } });
          const original = await prisma.finding.findUniqueOrThrow({ where: byKey(first) });
          expect(original.severity).toBe('medium');

          // A atividade nova, mais grave: o GuardDuty exporta o mesmo achado com a contagem e a severidade novas.
          const second = version(7, 5, 9.5);
          const report = await syncFor(new FakeIndexer([second])).runOnce();
          expect(report).toMatchObject({ read: 1, created: 1, duplicates: 0 });
          const recurrence = await prisma.finding.findUniqueOrThrow({ where: byRecurrence(second) });
          expect(recurrence).toMatchObject({
            tenantId: tenantA,
            accountId: accountA,
            status: 'new',
            triagedAt: null,
            // Os campos, a severidade (faixa da AWS) e o evento bruto são os da versão nova.
            severity: 'critical',
            rawEventId: second.id,
            lastSeenAt: lastSeenOf(second),
            recurrenceOfId: original.id,
          });
          expect(recurrence.id).not.toBe(original.id);
          // O original não muda: nem o status, nem a última atividade, nem o evento bruto.
          expect(await prisma.finding.findUniqueOrThrow({ where: byKey(first) })).toEqual(original);

          // Reler a versão nova (outro id de alerta) e a antiga (sobreposição): nada.
          const reread = await syncFor(
            new FakeIndexer([
              { ...second, id: newAlertId() },
              { ...first, id: newAlertId() },
            ]),
          ).runOnce();
          expect(reread).toMatchObject({ read: 2, created: 0, duplicates: 2 });
          expect(await findingsOf(findingId)).toHaveLength(2);
          expect(await prisma.finding.findUniqueOrThrow({ where: byKey(first) })).toEqual(original);
          expect(await prisma.finding.findUniqueOrThrow({ where: byRecurrence(second) })).toEqual(recurrence);
        });
      }

      it('já triado, a mesma versão ou uma mais antiga relida não vira nada', async () => {
        const findingId = randomUUID().replace(/-/g, '');
        const version = versionsOf(findingId);
        const first = version(3, 20);
        await syncFor(new FakeIndexer([first])).runOnce();
        await prisma.finding.update({
          where: byKey(first),
          data: { status: 'resolved', triagedAt: new Date() },
        });
        const original = await prisma.finding.findUniqueOrThrow({ where: byKey(first) });

        // A mesma versão com outro id de alerta (snapshot, `--reparse`) e uma versão mais antiga que voltou ao índice.
        const older = version(1, 40);
        const report = await syncFor(new FakeIndexer([older, { ...first, id: newAlertId() }])).runOnce();
        expect(report).toMatchObject({ read: 2, created: 0, duplicates: 2 });
        expect(await findingsOf(findingId)).toHaveLength(1);
        expect(await prisma.finding.findUniqueOrThrow({ where: byKey(first) })).toEqual(original);
      });

      it('a recorrência ainda aberta absorve a atividade seguinte; triada, a próxima vira a terceira, ligada ao original', async () => {
        const findingId = randomUUID().replace(/-/g, '');
        const version = versionsOf(findingId);
        const first = version(1, 50);
        await syncFor(new FakeIndexer([first])).runOnce();
        await prisma.finding.update({
          where: byKey(first),
          data: { status: 'resolved', triagedAt: new Date() },
        });
        const original = await prisma.finding.findUniqueOrThrow({ where: byKey(first) });

        const second = version(5, 30);
        expect(await syncFor(new FakeIndexer([second])).runOnce()).toMatchObject({ created: 1 });
        // A terceira versão chega com a recorrência ainda aberta: entra nela, sem abrir outra.
        const third = version(8, 20);
        expect(await syncFor(new FakeIndexer([third])).runOnce()).toMatchObject({
          created: 0,
          duplicates: 1,
        });
        const recurrence = await prisma.finding.findUniqueOrThrow({ where: byRecurrence(second) });
        expect(recurrence).toMatchObject({
          status: 'new',
          rawEventId: second.id,
          lastSeenAt: lastSeenOf(third),
        });
        expect(await findingsOf(findingId)).toHaveLength(2);

        // Triada a recorrência, a quarta versão vira o terceiro achado, também ligado ao original.
        await prisma.finding.update({ where: { id: recurrence.id }, data: { status: 'legitimate' } });
        const fourth = version(13, 5);
        expect(await syncFor(new FakeIndexer([fourth])).runOnce()).toMatchObject({
          created: 1,
          duplicates: 0,
        });
        expect(await prisma.finding.findUniqueOrThrow({ where: byRecurrence(fourth) })).toMatchObject({
          status: 'new',
          rawEventId: fourth.id,
          recurrenceOfId: original.id,
        });
        // A terceira versão, relida agora, é mais antiga que a última atividade conhecida: nada.
        expect(await syncFor(new FakeIndexer([{ ...third, id: newAlertId() }])).runOnce()).toMatchObject({
          created: 0,
          duplicates: 1,
        });
        expect(await findingsOf(findingId)).toHaveLength(3);
        expect(await prisma.finding.findUniqueOrThrow({ where: byKey(first) })).toEqual(original);
      });

      it('nascido legítimo pela exceção, a atividade nova vira outro achado esperado, e a exceção conta o uso', async () => {
        const findingId = randomUUID().replace(/-/g, '');
        const ip = `100.69.${randomInt(0, 255)}.${randomInt(1, 254)}`;
        const exception = await prisma.alertException.create({
          data: {
            tenantId: tenantA,
            ruleId: '80303',
            field: 'ip',
            value: ip,
            reason: 'Integração conhecida',
            createdById: creatorA,
          },
        });
        const version = versionsOf(findingId, ip);
        const first = version(1, 15);
        expect(await syncFor(new FakeIndexer([first])).runOnce()).toMatchObject({ created: 1, excepted: 1 });
        const second = version(4, 3);
        expect(await syncFor(new FakeIndexer([second])).runOnce()).toMatchObject({
          created: 1,
          excepted: 1,
          incidentsOpened: 0,
          incidentsJoined: 0,
        });
        const findings = await findingsOf(findingId);
        expect(findings.map((finding) => finding.status)).toEqual(['legitimate', 'legitimate']);
        expect(findings[1]).toMatchObject({ exceptionId: exception.id, recurrenceOfId: findings[0]?.id });
        expect(await prisma.alertException.findUniqueOrThrow({ where: { id: exception.id } })).toMatchObject({
          matchedCount: 2,
        });
        await prisma.alertException.delete({ where: { id: exception.id } });
      });

      it('A/B: o mesmo id de achado no bucket de outro cliente é achado dele, nunca recorrência do de A', async () => {
        const tenant = await createTenant(app, 'Cliente B (GuardDuty)');
        const account = String(randomInt(100_000_000_000, 999_999_999_999));
        const bucket = `guardduty-b-${randomInt(1e6, 9e6)}`;
        await prisma.cloudAccount.create({
          data: {
            tenantId: tenant,
            accountId: account,
            regions: ['sa-east-1'],
            guarddutyBucket: bucket,
          },
        });
        const findingId = randomUUID().replace(/-/g, '');
        const version = versionsOf(findingId);
        const first = version(1, 25);
        await syncFor(new FakeIndexer([first])).runOnce();
        await prisma.finding.update({
          where: byKey(first),
          data: { status: 'resolved', triagedAt: new Date() },
        });
        const original = await prisma.finding.findUniqueOrThrow({ where: byKey(first) });

        // B exporta o mesmo id com atividade mais nova: a chave leva a conta, então é o primeiro achado de B.
        const at = new Date(Date.now() - 2 * MINUTE);
        const fromB = {
          ...guardDutyAlert({ account, bucket, findingId, count: 9, updatedAt: at.toISOString() }),
          id: newAlertId(),
          timestamp: wazuhTime(at),
        };
        expect(await syncFor(new FakeIndexer([fromB])).runOnce()).toMatchObject({
          created: 1,
          duplicates: 0,
        });
        expect(await prisma.finding.findUniqueOrThrow({ where: byKey(fromB, account) })).toMatchObject({
          tenantId: tenant,
          status: 'new',
          recurrenceOfId: null,
        });
        expect(await prisma.finding.findUniqueOrThrow({ where: byKey(first) })).toEqual(original);
        expect(await prisma.finding.count({ where: { recurrenceOfId: original.id } })).toBe(0);
      });

      it('sondagem de porta: a versão nova de um achado com três IPs triados vira um achado só, e relida não vira nada', async () => {
        const findingId = randomUUID().replace(/-/g, '');
        const version = probeVersionsOf(findingId, `i-0${randomInt(1e6, 9e6)}abcdef0`);
        const ips = [1, 2, 3].map(() => `100.70.${randomInt(0, 255)}.${randomInt(1, 254)}`);
        const first = version(40, ips);
        expect(await syncFor(new FakeIndexer(first)).runOnce()).toMatchObject({ created: 3, duplicates: 0 });
        const chain = recurrenceOf(first[0]!).chainKey;
        expect(chain).toBe(`wazuh/${accountA}/guardduty:${findingId}:80305`);
        const originals = await findingsOf(findingId);
        expect(originals.map((finding) => finding.chainKey)).toEqual([chain, chain, chain]);
        await prisma.finding.updateMany({
          where: { id: { in: originals.map((finding) => finding.id) } },
          data: { status: 'resolved', triagedAt: new Date() },
        });
        const triaged = await findingsOf(findingId);

        // A versão nova repete os três IPs (o wodle reemite todos): um achado só, com a chave do achado inteiro, sem
        // o IP, ligado ao original do primeiro item lido; os outros dois itens caem como duplicados.
        const second = version(30, ips);
        expect(await syncFor(new FakeIndexer(second)).runOnce()).toMatchObject({
          read: 3,
          created: 1,
          duplicates: 2,
        });
        const recurrence = await prisma.finding.findUniqueOrThrow({ where: byRecurrence(second[0]!) });
        expect(recurrence).toMatchObject({
          sourceEventId: `${chain}@${lastSeenOf(second[0]!).toISOString()}`,
          chainKey: chain,
          status: 'new',
          sourceIp: ips[0],
          lastSeenAt: lastSeenOf(second[0]!),
          recurrenceOfId: originals.find((finding) => finding.sourceIp === ips[0])?.id,
        });
        // Relida (outros ids de alerta): nada.
        const reread = second.map((doc) => ({ ...doc, id: newAlertId() }));
        expect(await syncFor(new FakeIndexer(reread)).runOnce()).toMatchObject({ created: 0, duplicates: 3 });
        expect(await findingsOf(findingId)).toHaveLength(4);

        // Ainda aberta, a recorrência absorve a versão seguinte, mesmo que o primeiro item lido seja o IP de outro
        // original (a cadeia é do achado inteiro, não de cada IP).
        const third = version(20, [...ips].reverse());
        expect(await syncFor(new FakeIndexer(third)).runOnce()).toMatchObject({ created: 0, duplicates: 3 });
        expect((await prisma.finding.findUniqueOrThrow({ where: { id: recurrence.id } })).lastSeenAt).toEqual(
          lastSeenOf(third[0]!),
        );
        expect(await findingsOf(findingId)).toHaveLength(4);

        // Triada a recorrência, a versão seguinte vira outro achado, também um só.
        await prisma.finding.update({
          where: { id: recurrence.id },
          data: { status: 'resolved', triagedAt: new Date() },
        });
        const fourth = version(10, [...ips].reverse());
        expect(await syncFor(new FakeIndexer(fourth)).runOnce()).toMatchObject({ created: 1, duplicates: 2 });
        expect(await prisma.finding.findUniqueOrThrow({ where: byRecurrence(fourth[0]!) })).toMatchObject({
          chainKey: chain,
          status: 'new',
          sourceIp: ips[2],
        });
        const all = await findingsOf(findingId);
        expect(all).toHaveLength(5);
        // Os originais por IP não mudam.
        expect(all.slice(0, 3)).toEqual(triaged);
      });

      it('sondagem de porta: o IP com exceção não cria a recorrência; o IP sem exceção cria; o IP novo é outro achado por IP', async () => {
        const findingId = randomUUID().replace(/-/g, '');
        const version = probeVersionsOf(findingId, `i-0${randomInt(1e6, 9e6)}abcdef0`);
        const [allowed, other, newcomer] = [1, 2, 3].map(
          () => `100.71.${randomInt(0, 255)}.${randomInt(1, 254)}`,
        ) as [string, string, string];
        const exception = await prisma.alertException.create({
          data: {
            tenantId: tenantA,
            ruleId: '80305',
            field: 'ip',
            value: allowed,
            reason: 'Varredura autorizada',
            createdById: creatorA,
          },
        });
        const first = version(40, [allowed, other]);
        expect(await syncFor(new FakeIndexer(first)).runOnce()).toMatchObject({ created: 2, excepted: 1 });
        await prisma.finding.update({
          where: byKey(first[1]!),
          data: { status: 'resolved', triagedAt: new Date() },
        });

        // O IP autorizado chega primeiro e não fala pela versão inteira: a recorrência nasce do outro, sem exceção.
        const second = version(30, [allowed, other]);
        expect(await syncFor(new FakeIndexer(second)).runOnce()).toMatchObject({
          created: 1,
          excepted: 0,
          duplicates: 1,
        });
        const recurrence = await prisma.finding.findUniqueOrThrow({ where: byRecurrence(second[0]!) });
        expect(recurrence).toMatchObject({
          status: 'new',
          exceptionId: null,
          sourceIp: other,
          rawEventId: second[1]!.id,
        });
        // Resolvida a recorrência, a versão só com o IP autorizado não vira nada.
        await prisma.finding.update({
          where: { id: recurrence.id },
          data: { status: 'resolved', triagedAt: new Date() },
        });
        expect(await syncFor(new FakeIndexer(version(20, [allowed]))).runOnce()).toMatchObject({
          created: 0,
          duplicates: 1,
        });
        // Um IP que aparece pela primeira vez é outro achado por IP, na mesma cadeia, e não uma recorrência.
        const fourth = version(10, [allowed, newcomer]);
        expect(await syncFor(new FakeIndexer(fourth)).runOnce()).toMatchObject({ created: 1, duplicates: 1 });
        expect(await prisma.finding.findUniqueOrThrow({ where: byKey(fourth[1]!) })).toMatchObject({
          sourceEventId: `wazuh/${accountA}/guardduty:${findingId}/${newcomer}:22:80305`,
          sourceIp: newcomer,
          status: 'new',
          recurrenceOfId: null,
          chainKey: recurrence.chainKey,
        });
        expect(await findingsOf(findingId)).toHaveLength(4);
        // A exceção contou só o achado do IP autorizado.
        expect(await prisma.alertException.findUniqueOrThrow({ where: { id: exception.id } })).toMatchObject({
          matchedCount: 1,
        });
        await prisma.alertException.delete({ where: { id: exception.id } });
      });

      it('achado triado sem versão conhecida: a versão relida vira a base de comparação, e só a seguinte vira recorrência', async () => {
        const findingId = randomUUID().replace(/-/g, '');
        const version = versionsOf(findingId);
        const first = version(2, 30);
        // Gravado antes da coluna, ou com o `updatedAt` fora do formato na primeira versão: sem versão nem cadeia.
        const seeded = await prisma.finding.create({
          data: {
            tenantId: tenantA,
            accountId: accountA,
            source: 'wazuh',
            sourceEventId: keyOf(first),
            logSource: 'guardduty',
            occurredAt: new Date(Date.now() - 30 * MINUTE),
            severity: 'high',
            status: 'resolved',
            triagedAt: new Date(),
            ruleId: '80303',
            ruleLevel: 10,
            title: 'Achado gravado sem versão',
          },
        });
        expect(seeded).toMatchObject({ lastSeenAt: null, chainKey: null });

        expect(await syncFor(new FakeIndexer([first])).runOnce()).toMatchObject({
          read: 1,
          created: 0,
          duplicates: 1,
        });
        expect(await prisma.finding.findUniqueOrThrow({ where: { id: seeded.id } })).toMatchObject({
          status: 'resolved',
          lastSeenAt: lastSeenOf(first),
          chainKey: recurrenceOf(first).chainKey,
        });
        expect(await findingsOf(findingId)).toHaveLength(1);
        // Relida de novo: nada. A versão seguinte, mais nova, aí sim vira recorrência.
        expect(await syncFor(new FakeIndexer([{ ...first, id: newAlertId() }])).runOnce()).toMatchObject({
          created: 0,
          duplicates: 1,
        });
        const second = version(5, 10);
        expect(await syncFor(new FakeIndexer([second])).runOnce()).toMatchObject({ created: 1 });
        expect(await prisma.finding.findUniqueOrThrow({ where: byRecurrence(second) })).toMatchObject({
          recurrenceOfId: seeded.id,
        });
      });

      it('a versão é sempre o updatedAt: o eventLastSeen atrás do updatedAt da versão anterior não esconde a nova', async () => {
        const findingId = randomUUID().replace(/-/g, '');
        const ip = `100.69.${randomInt(0, 255)}.${randomInt(1, 254)}`;
        const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE);
        const versionOf = (count: number, updatedAt: Date, eventLastSeen: string | null) => ({
          ...guardDutyAlert({
            account: accountA,
            bucket: guardDutyA,
            findingId,
            count,
            updatedAt: updatedAt.toISOString(),
            eventLastSeen,
            action: {
              actionType: 'AWS_API_CALL',
              awsApiCallAction: { api: 'ListBuckets', remoteIpDetails: { ipAddressV4: ip } },
            },
          }),
          id: newAlertId(),
          timestamp: wazuhTime(updatedAt),
        });
        // A primeira versão saiu sem `eventLastSeen`; a segunda traz um `eventLastSeen` anterior ao `updatedAt` da
        // primeira. Comparadas ora por um, ora por outro, a segunda cairia como antiga.
        const first = versionOf(1, ago(30), null);
        const secondAt = ago(10);
        const second = versionOf(2, secondAt, ago(40).toISOString());
        await syncFor(new FakeIndexer([first])).runOnce();
        await prisma.finding.update({
          where: byKey(first),
          data: { status: 'resolved', triagedAt: new Date() },
        });

        expect(await syncFor(new FakeIndexer([second])).runOnce()).toMatchObject({
          created: 1,
          duplicates: 0,
        });
        expect(await prisma.finding.findUniqueOrThrow({ where: byRecurrence(second) })).toMatchObject({
          lastSeenAt: secondAt,
          sourceEventId: `${keyOf(second)}@${secondAt.toISOString()}`,
        });
      });

      it('A/B: a chave ocupada por um achado de outro cliente não é vista nem tocada, e nada é criado', async () => {
        // A conta só é de um cliente por vez; a chave de A em B simula a conta recadastrada em outro cliente.
        const findingId = randomUUID().replace(/-/g, '');
        const version = versionsOf(findingId);
        const first = version(1, 10);
        const held = await prisma.finding.create({
          data: {
            tenantId: tenantB,
            accountId: accountB,
            source: 'wazuh',
            sourceEventId: keyOf(first),
            logSource: 'guardduty',
            occurredAt: new Date(Date.now() - 60 * MINUTE),
            lastSeenAt: new Date(Date.now() - 60 * MINUTE),
            severity: 'high',
            status: 'resolved',
            ruleId: '80303',
            ruleLevel: 10,
            title: 'Achado de B com a chave de A',
          },
        });
        const report = await syncFor(new FakeIndexer([first])).runOnce();
        expect(report).toMatchObject({ read: 1, created: 0, duplicates: 1 });
        expect(await findingsOf(findingId)).toHaveLength(1);
        expect(await prisma.finding.findUniqueOrThrow({ where: { id: held.id } })).toEqual(held);
        expect(
          await prisma.finding.count({
            where: { tenantId: tenantA, sourceEventId: { contains: findingId } },
          }),
        ).toBe(0);
        await prisma.finding.delete({ where: { id: held.id } });
      });
    });

    it('a sondagem de porta que o wodle separa por IP vira um achado por IP, cada um com a própria exceção', async () => {
      const findingId = randomUUID().replace(/-/g, '');
      const instanceId = `i-0${randomInt(1e6, 9e6)}abcdef0`;
      const [allowed, first, second] = [1, 2, 3].map(
        () => `100.67.${randomInt(0, 255)}.${randomInt(1, 254)}`,
      ) as [string, string, string];
      // O primeiro item é de um IP com exceção (varredura autorizada): ele não pode levar os outros junto.
      const exception = await prisma.alertException.create({
        data: {
          tenantId: tenantA,
          ruleId: '80305',
          field: 'ip',
          value: allowed,
          reason: 'Varredura autorizada',
          createdById: creatorA,
        },
      });
      const docs = portProbeAlerts(
        [
          { ip: allowed, port: 22 },
          { ip: first, port: 22 },
          { ip: second, port: 3389 },
        ],
        { account: accountA, bucket: guardDutyA, findingId, instanceId },
      ).map((doc, index) => ({
        ...doc,
        id: newAlertId(),
        timestamp: wazuhTime(new Date(Date.now() - (5 - index) * MINUTE)),
      }));
      // Releitura do mesmo item (outro id de alerta) não duplica.
      const again = { ...docs[1]!, id: newAlertId() };
      const report = await syncFor(new FakeIndexer([...docs, again])).runOnce();
      expect(report).toMatchObject({ read: 4, created: 3, excepted: 1, duplicates: 1 });

      const findings = await prisma.finding.findMany({
        where: { tenantId: tenantA, sourceEventId: { contains: findingId } },
        select: { sourceEventId: true, sourceIp: true, status: true, exceptionId: true },
      });
      const bySourceIp = new Map(findings.map((finding) => [finding.sourceIp, finding]));
      expect(findings).toHaveLength(3);
      expect(bySourceIp.get(allowed)).toMatchObject({
        sourceEventId: `wazuh/${accountA}/guardduty:${findingId}/${allowed}:22:80305`,
        status: 'legitimate',
        exceptionId: exception.id,
      });
      expect(bySourceIp.get(first)).toMatchObject({ status: 'new', exceptionId: null });
      expect(bySourceIp.get(second)).toMatchObject({
        sourceEventId: `wazuh/${accountA}/guardduty:${findingId}/${second}:3389:80305`,
        status: 'new',
      });
      await prisma.alertException.delete({ where: { id: exception.id } });
    });

    it('WAF atrás do ALB: o mesmo trace ID em rajadas diferentes vira um achado por rajada', async () => {
      // Quem ataca fixa o `X-Amzn-Trace-Id: Root=...`; o WAF grava esse Root como requestId em toda requisição.
      const root = `1-6720a0b0-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      const clientIp = `100.68.${randomInt(0, 255)}.${randomInt(1, 254)}`;
      const webaclId = `arn:aws:wafv2:sa-east-1:${accountA}:regional/webacl/painel-${randomInt(1e6, 9e6)}/0000`;
      const burst = (minutesAgo: number) => {
        const at = new Date(Date.now() - minutesAgo * MINUTE);
        return {
          ...wafAlert({
            account: accountA,
            bucket: wafA,
            webaclId,
            clientIp,
            requestId: root,
            loggedAt: at.getTime(),
          }),
          id: newAlertId(),
          timestamp: wazuhTime(at),
        };
      };
      const first = burst(30);
      const later = burst(3);
      // A primeira rajada relida (snapshot, `--reparse`) continua sem duplicar.
      const reread = { ...first, id: newAlertId() };
      const report = await syncFor(new FakeIndexer([first, later, reread])).runOnce();
      expect(report).toMatchObject({ read: 3, created: 2, duplicates: 1 });
      expect(
        await prisma.finding.count({ where: { tenantId: tenantA, sourceEventId: { contains: root } } }),
      ).toBe(2);
      expect(await prisma.finding.findUniqueOrThrow({ where: byKey(later) })).toMatchObject({
        logSource: 'waf',
        sourceIp: clientIp,
        rawEventId: later.id,
      });
    });

    it('a correlação ganha chave própria, e relida também não duplica', async () => {
      const eventId = randomUUID();
      const who = actor();
      const single = trailAlertA(9, { ...who, eventId });
      const burst = trailAlertA(8, {
        ...who,
        eventId,
        level: 10,
        rule: {
          id: '80255',
          description: 'AWS Cloudtrail: Possible breakin attempt (high number of login attempts).',
        },
      });
      const burstAgain = { ...burst, id: newAlertId() };
      const report = await syncFor(new FakeIndexer([single, burst, burstAgain])).runOnce();
      expect(report).toMatchObject({ read: 3, created: 2, duplicates: 1 });

      const findings = await prisma.finding.findMany({
        where: { tenantId: tenantA, sourceEventId: { contains: eventId } },
        select: { sourceEventId: true, ruleId: true, severity: true },
        orderBy: { ruleId: 'asc' },
      });
      expect(findings).toEqual([
        { sourceEventId: `wazuh/${accountA}/cloudtrail:${eventId}:80254`, ruleId: '80254', severity: 'low' },
        { sourceEventId: `wazuh/${accountA}/cloudtrail:${eventId}:80255`, ruleId: '80255', severity: 'high' },
      ]);
    });

    it('o mesmo id de evento no bucket de outro cliente não apaga o achado de A, e vira o achado de B', async () => {
      const eventId = randomUUID();
      // B chega primeiro, citando o id de um evento de A: se a chave não separasse as contas, o de A viraria duplicado.
      const fromB = {
        ...cloudTrailAlert({ account: accountB, bucket: trailB, eventId, sourceIp: actor().sourceIp }),
        id: newAlertId(),
        timestamp: wazuhTime(new Date(Date.now() - 7 * MINUTE)),
      };
      const fromA = trailAlertA(6, { ...actor(), eventId });
      const report = await syncFor(new FakeIndexer([fromB, fromA])).runOnce();
      expect(report).toMatchObject({ read: 2, created: 2, duplicates: 0 });
      expect(await prisma.finding.findUniqueOrThrow({ where: byKey(fromA) })).toMatchObject({
        tenantId: tenantA,
        accountId: accountA,
      });
      expect(await prisma.finding.findUniqueOrThrow({ where: byKey(fromB, accountB) })).toMatchObject({
        tenantId: tenantB,
        accountId: accountB,
      });
    });

    it('sem id do evento na AWS, a chave é o id do alerta', async () => {
      const doc = trailAlertA(4, { ...actor(), eventId: null });
      await syncFor(new FakeIndexer([doc])).runOnce();
      expect(await prisma.finding.findFirstOrThrow({ where: { rawEventId: doc.id } })).toMatchObject({
        sourceEventId: `wazuh/${accountA}/alert:${doc.id}:80254`,
      });
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
