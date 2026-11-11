import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SyncLease } from '../src/alerts/finding-store.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import type { TenantPlans } from '../src/plan/tenant-plan.js';
import { RetentionJob, type RetentionJobOptions } from '../src/retention/retention-job.js';
import { DAY_MS, retentionCutoffs } from '../src/retention/retention-policy.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const HOUR = 60 * 60 * 1000;

/** A fila de saída dos avisos por e-mail (PR-16): o teste do expurgo dela roda quando o model existe no client. */
const hasNotificationModel = 'Notification' in Prisma.ModelName;

/**
 * Hoje às 05:00 UTC: depois da janela das 04:00 e a menos de um dia do relógio real. Os pisos do banco usam o relógio
 * real (`now()`), e a folga de um dia dos cortes cobre a diferença.
 */
function today(): Date {
  const real = new Date();
  return new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), 5));
}

const daysBefore = (at: Date, days: number) => new Date(at.getTime() - days * DAY_MS);

/** A única linha de uma consulta. */
function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('a consulta não devolveu linha');
  return row;
}

/**
 * O banco de teste é dividido com as outras suítes: as fases de cliente rodam só nos clientes de cada teste
 * (`tenantIds`), e as fases sem cliente só encontram, de antigo, o que este arquivo grava (as outras suítes gravam
 * dados de horas ou dias). Todo o expurgo da auditoria fica neste arquivo, que roda em sequência.
 */
describe('expurgo diário do histórico (PR-19)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Cliente com um autor de comentários (o usuário é gravado direto: sem senha, sem login). */
  async function customer(name: string): Promise<{ tenantId: string; authorId: string }> {
    const tenantId = await createTenant(app, `Cliente Demo ${name} (expurgo)`);
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        name: 'Analista de teste',
        email: `analista-${randomUUID()}@cliente.example`,
        role: 'analista_cliente',
        tenantId,
        status: 'active',
      },
      select: { id: true },
    });
    return { tenantId, authorId: user.id };
  }

  const job = (tenantIds: readonly string[], options: Partial<RetentionJobOptions> = {}) =>
    new RetentionJob(prisma, {
      historyDays: 90,
      name: `ret-${randomBytes(4).toString('hex')}`,
      batch: 2,
      pauseMs: 0,
      tenantIds,
      ...options,
    });

  async function insertFinding(
    tenantId: string,
    occurredAt: Date,
    extra: Partial<Prisma.FindingUncheckedCreateInput> = {},
  ): Promise<string> {
    const finding = await prisma.finding.create({
      data: {
        tenantId,
        accountId: '111111111111',
        source: 'wazuh',
        sourceEventId: `retencao-${randomUUID()}`,
        logSource: 'cloudtrail',
        occurredAt,
        severity: 'high',
        ruleId: '80255',
        ruleLevel: 10,
        title: 'Achado de teste do expurgo',
        mitreTactics: [],
        mitreTechniques: [],
        // Gravado na hora do evento, como o sync grava; ninguém mexeu depois.
        createdAt: occurredAt,
        updatedAt: occurredAt,
        ...extra,
      },
      select: { id: true },
    });
    return finding.id;
  }

  /** Incidente com um achado em cada horário, sem mudança depois do último (a menos que `updatedAt` diga). */
  async function insertIncident(
    tenantId: string,
    times: readonly Date[],
    updatedAt?: Date,
  ): Promise<{ id: string; findings: string[] }> {
    const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
    const first = sorted[0] as Date;
    const last = sorted.at(-1) as Date;
    const incident = await prisma.incident.create({
      data: {
        tenantId,
        severity: 'high',
        riskScore: 50,
        findingCount: sorted.length,
        firstSeenAt: first,
        lastSeenAt: last,
        keys: ['ip:198.51.100.23'],
        accounts: ['111111111111'],
        resources: [],
        mitreTactics: [],
        mitreTechniques: [],
        createdAt: first,
        updatedAt: updatedAt ?? last,
      },
      select: { id: true },
    });
    const findings: string[] = [];
    for (const at of sorted) findings.push(await insertFinding(tenantId, at, { incidentId: incident.id }));
    return { id: incident.id, findings };
  }

  const insertComment = async (tenantId: string, findingId: string, authorId: string, createdAt: Date) =>
    (
      await prisma.findingComment.create({
        data: { tenantId, findingId, authorId, body: 'registro de teste', createdAt },
        select: { id: true },
      })
    ).id;

  const insertAudit = async (tenantId: string | null, occurredAt: Date) =>
    (
      await prisma.auditLog.create({
        data: { occurredAt, actorType: 'system', tenantId, action: 'teste.expurgo', outcome: 'success' },
        select: { id: true },
      })
    ).id;

  async function insertScan(tenantId: string, accountId: string, scannedAt: Date): Promise<string> {
    const scan = await prisma.postureScan.create({
      data: {
        tenantId,
        accountId,
        scannedAt,
        score: 50,
        weightPassed: 5,
        weightTotal: 10,
        passed: 1,
        failed: 2,
        failedCritical: 0,
        failedHigh: 2,
        failedMedium: 0,
        failedLow: 0,
        failedInformational: 0,
      },
      select: { id: true },
    });
    for (const uid of ['a', 'b']) {
      await prisma.postureFailure.create({
        data: {
          tenantId,
          scanId: scan.id,
          findingUid: `reprovacao-${uid}`,
          checkId: 'iam_root_mfa_enabled',
          title: 'Root sem MFA',
          severity: 'high',
          region: 'sa-east-1',
          references: [],
        },
      });
    }
    return scan.id;
  }

  const insertSnapshot = async (tenantId: string, accountId: string, collectedAt: Date) =>
    (
      await prisma.inventorySnapshot.create({
        data: { tenantId, accountId, collectedAt, items: {} },
        select: { id: true },
      })
    ).id;

  const findingsLeft = async (ids: readonly string[]) =>
    (await prisma.finding.findMany({ where: { id: { in: [...ids] } }, select: { id: true } })).map(
      (r) => r.id,
    );
  const incidentExists = async (id: string) => (await prisma.incident.count({ where: { id } })) === 1;
  const commentExists = async (id: string) => (await prisma.findingComment.count({ where: { id } })) === 1;
  const auditExists = async (id: string) => (await prisma.auditLog.count({ where: { id } })) === 1;

  /** Os `retention.purge` de um cliente, do mais antigo para o mais novo. */
  const purgeTrail = (tenantId: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, action: 'retention.purge' },
      orderBy: { occurredAt: 'asc' },
      select: { actorType: true, outcome: true, resourceType: true, after: true },
    });

  describe('o que sai e o que fica', () => {
    it('no limite do corte: um milissegundo antes apaga, o corte exato fica', async () => {
      const { tenantId, authorId } = await customer('limite');
      const now = today();
      const cutoffs = retentionCutoffs(now, 90);
      const history = cutoffs.history as Date;
      const audit = cutoffs.audit as Date;
      const justBefore = new Date(history.getTime() - 1);

      const gone = await insertFinding(tenantId, justBefore);
      const kept = await insertFinding(tenantId, history);
      const goneComment = await insertComment(tenantId, gone, authorId, justBefore);
      const keptComment = await insertComment(tenantId, kept, authorId, history);
      const goneIncident = await insertIncident(tenantId, [justBefore]);
      const keptIncident = await insertIncident(tenantId, [history]);
      const goneAudit = await insertAudit(tenantId, new Date(audit.getTime() - 1));
      const keptAudit = await insertAudit(tenantId, audit);
      const account = '222222222222';
      const goneScan = await insertScan(tenantId, account, justBefore);
      const keptScan = await insertScan(tenantId, account, history);
      await insertScan(tenantId, account, daysBefore(now, 1));

      expect(await job([tenantId]).maybeRun(now)).toMatchObject({ status: 'done', historyDays: 90 });

      expect(await findingsLeft([gone, kept, ...goneIncident.findings, ...keptIncident.findings])).toEqual(
        expect.arrayContaining([kept, ...keptIncident.findings]),
      );
      expect(await findingsLeft([gone, ...goneIncident.findings])).toEqual([]);
      expect(await commentExists(goneComment)).toBe(false);
      expect(await commentExists(keptComment)).toBe(true);
      expect(await incidentExists(goneIncident.id)).toBe(false);
      expect(await incidentExists(keptIncident.id)).toBe(true);
      expect(await auditExists(goneAudit)).toBe(false);
      expect(await auditExists(keptAudit)).toBe(true);
      expect(await prisma.postureScan.count({ where: { id: { in: [goneScan, keptScan] } } })).toBe(1);
      expect(await prisma.postureFailure.count({ where: { scanId: goneScan } })).toBe(0);
      expect(await prisma.postureFailure.count({ where: { scanId: keptScan } })).toBe(2);
    });

    it('incidente com achado recente fica inteiro; o antigo sai com os achados e os comentários', async () => {
      const { tenantId, authorId } = await customer('incidentes');
      const now = today();
      // Começou há 200 dias e teve achado há 10: fica tudo, inclusive o achado antigo.
      const alive = await insertIncident(tenantId, [daysBefore(now, 200), daysBefore(now, 10)]);
      // Tudo antigo, com comentário antigo: sai inteiro.
      const old = await insertIncident(tenantId, [daysBefore(now, 200), daysBefore(now, 150)]);
      const oldComment = await insertComment(
        tenantId,
        old.findings[0] as string,
        authorId,
        daysBefore(now, 149),
      );
      // Antigo, mas alguém mudou o status há 5 dias: fica.
      const touched = await insertIncident(tenantId, [daysBefore(now, 200)], daysBefore(now, 5));
      // Antigo, mas um achado ganhou comentário há 3 dias: fica.
      const discussed = await insertIncident(tenantId, [daysBefore(now, 200)]);
      const recentComment = await insertComment(
        tenantId,
        discussed.findings[0] as string,
        authorId,
        daysBefore(now, 3),
      );
      // Achado solto antigo, mas triado há 2 dias: fica.
      const triaged = await insertFinding(tenantId, daysBefore(now, 200), { updatedAt: daysBefore(now, 2) });

      const report = await job([tenantId]).maybeRun(now);
      expect(report).toMatchObject({ status: 'done', deleted: { incidents: 1, findings: 2, comments: 1 } });

      expect(await incidentExists(alive.id)).toBe(true);
      expect(await findingsLeft(alive.findings)).toHaveLength(2);
      expect(await incidentExists(old.id)).toBe(false);
      expect(await findingsLeft(old.findings)).toEqual([]);
      expect(await commentExists(oldComment)).toBe(false);
      expect(await incidentExists(touched.id)).toBe(true);
      expect(await incidentExists(discussed.id)).toBe(true);
      expect(await commentExists(recentComment)).toBe(true);
      expect(await findingsLeft([triaged])).toEqual([triaged]);
    });

    it('recorrência: a cadeia antiga sai inteira; o original de uma recorrência que fica, fica', async () => {
      const { tenantId } = await customer('recorrência');
      const now = today();
      const original = await insertFinding(tenantId, daysBefore(now, 200));
      const recurrence = await insertFinding(tenantId, daysBefore(now, 150), { recurrenceOfId: original });
      const second = await insertFinding(tenantId, daysBefore(now, 120), { recurrenceOfId: recurrence });
      const heldOriginal = await insertFinding(tenantId, daysBefore(now, 200));
      const recent = await insertFinding(tenantId, daysBefore(now, 10), { recurrenceOfId: heldOriginal });
      // O original num incidente antigo, a recorrência num incidente recente: o antigo espera o recente.
      const oldIncident = await insertIncident(tenantId, [daysBefore(now, 300)]);
      const liveIncident = await insertIncident(tenantId, [daysBefore(now, 5)]);
      await prisma.finding.update({
        where: { id: liveIncident.findings[0] as string },
        data: { recurrenceOfId: oldIncident.findings[0] as string, updatedAt: daysBefore(now, 5) },
      });

      expect(await job([tenantId]).maybeRun(now)).toMatchObject({ status: 'done' });

      expect(await findingsLeft([original, recurrence, second])).toEqual([]);
      expect(await findingsLeft([heldOriginal, recent]).then((ids) => ids.sort())).toEqual(
        [heldOriginal, recent].sort(),
      );
      expect(await incidentExists(oldIncident.id)).toBe(true);
      expect(await incidentExists(liveIncident.id)).toBe(true);
    });

    it('fica a varredura e o retrato mais recentes de cada conta, mesmo antigos', async () => {
      const { tenantId } = await customer('postura');
      const now = today();
      const [quiet, busy] = ['333333333333', '444444444444'];
      // Conta parada: as duas varreduras são antigas; a mais recente fica.
      const quietOld = await insertScan(tenantId, quiet, daysBefore(now, 200));
      const quietLatest = await insertScan(tenantId, quiet, daysBefore(now, 150));
      // Conta ativa: a antiga sai, a recente fica.
      const busyOld = await insertScan(tenantId, busy, daysBefore(now, 100));
      const busyLatest = await insertScan(tenantId, busy, daysBefore(now, 10));
      // Inventário: 30 dias, sempre com o mais recente de cada conta.
      const quietSnapshots = [
        await insertSnapshot(tenantId, quiet, daysBefore(now, 90)),
        await insertSnapshot(tenantId, quiet, daysBefore(now, 60)),
      ];
      const busySnapshots = [
        await insertSnapshot(tenantId, busy, daysBefore(now, 40)),
        await insertSnapshot(tenantId, busy, daysBefore(now, 20)),
        await insertSnapshot(tenantId, busy, daysBefore(now, 1)),
      ];

      const report = await job([tenantId]).maybeRun(now);
      expect(report).toMatchObject({
        status: 'done',
        deleted: { postureScans: 2, postureFailures: 4, inventorySnapshots: 2 },
      });

      const scans = await prisma.postureScan.findMany({ where: { tenantId }, select: { id: true } });
      expect(scans.map((s) => s.id).sort()).toEqual([quietLatest, busyLatest].sort());
      expect(await prisma.postureFailure.count({ where: { scanId: { in: [quietOld, busyOld] } } })).toBe(0);
      const snapshots = await prisma.inventorySnapshot.findMany({
        where: { tenantId },
        select: { id: true },
      });
      expect(snapshots.map((s) => s.id).sort()).toEqual(
        [quietSnapshots[1], busySnapshots[1], busySnapshots[2]].sort(),
      );
    });

    it('fila sem dono: sai com mais de 90 dias', async () => {
      const now = today();
      const insert = async (createdAt: Date) =>
        (
          await prisma.unownedAlert.create({
            data: {
              source: 'wazuh',
              sourceEventId: `retencao-${randomUUID()}`,
              reason: 'unknown_account',
              accounts: [],
              createdAt,
            },
            select: { id: true },
          })
        ).id;
      const gone = await insert(daysBefore(now, 91));
      const kept = await insert(daysBefore(now, 89));
      await job([]).maybeRun(now);
      expect(await prisma.unownedAlert.count({ where: { id: gone } })).toBe(0);
      expect(await prisma.unownedAlert.count({ where: { id: kept } })).toBe(1);
    });

    it('tabelas de operação: sai o vencido há mais de um dia; sessão válida e bloqueio vigente ficam', async () => {
      const now = today();
      const { authorId: userId } = await customer('operação');
      const session = async (expiresAt: Date) =>
        (
          await prisma.session.create({
            data: { id: randomUUID(), token: randomBytes(16).toString('hex'), userId, expiresAt },
            select: { id: true },
          })
        ).id;
      const oldSession = await session(daysBefore(now, 2));
      const freshlyExpired = await session(new Date(now.getTime() - HOUR));
      const validSession = await session(new Date(now.getTime() + HOUR));
      const verification = async (expiresAt: Date) =>
        (
          await prisma.verification.create({
            data: { id: randomUUID(), identifier: `teste-${randomUUID()}`, value: 'x', expiresAt },
            select: { id: true },
          })
        ).id;
      const oldLink = await verification(daysBefore(now, 2));
      const validLink = await verification(new Date(now.getTime() + HOUR));
      const attempt = async (firstFailureAt: Date, lockedUntil: Date | null) =>
        (
          await prisma.loginAttempt.create({
            data: {
              email: `tentativa-${randomUUID()}@exemplo.com.br`,
              failures: 5,
              firstFailureAt,
              lockedUntil,
            },
            select: { email: true },
          })
        ).email;
      const oldAttempt = await attempt(daysBefore(now, 3), daysBefore(now, 3));
      const recentAttempt = await attempt(new Date(now.getTime() - HOUR), null);
      const lockedAttempt = await attempt(daysBefore(now, 3), new Date(now.getTime() + HOUR));
      await prisma.usedTotpCode.createMany({
        data: [
          { userId, code: '111111', usedAt: daysBefore(now, 2) },
          { userId, code: '222222', usedAt: new Date(now.getTime() - 60_000) },
        ],
      });
      const limit = async (lastRequest: Date) =>
        (
          await prisma.rateLimit.create({
            data: {
              id: randomUUID(),
              key: `teste-${randomUUID()}`,
              count: 1,
              lastRequest: BigInt(lastRequest.getTime()),
            },
            select: { id: true },
          })
        ).id;
      const oldLimit = await limit(daysBefore(now, 2));
      const recentLimit = await limit(new Date(now.getTime() - 60_000));

      await job([]).maybeRun(now);

      const sessions = await prisma.session.findMany({
        where: { id: { in: [oldSession, freshlyExpired, validSession] } },
        select: { id: true },
      });
      expect(sessions.map((s) => s.id).sort()).toEqual([freshlyExpired, validSession].sort());
      expect(await prisma.verification.count({ where: { id: oldLink } })).toBe(0);
      expect(await prisma.verification.count({ where: { id: validLink } })).toBe(1);
      const attempts = await prisma.loginAttempt.findMany({
        where: { email: { in: [oldAttempt, recentAttempt, lockedAttempt] } },
        select: { email: true },
      });
      expect(attempts.map((a) => a.email).sort()).toEqual([recentAttempt, lockedAttempt].sort());
      const codes = await prisma.usedTotpCode.findMany({ where: { userId }, select: { code: true } });
      expect(codes.map((c) => c.code)).toEqual(['222222']);
      expect(await prisma.rateLimit.count({ where: { id: oldLimit } })).toBe(0);
      expect(await prisma.rateLimit.count({ where: { id: recentLimit } })).toBe(1);
    });

    it.runIf(hasNotificationModel)(
      'avisos por e-mail resolvidos saem com 90 dias; o pendente e o recente ficam',
      async () => {
        const { tenantId } = await customer('avisos');
        const now = today();
        // Pelo formato do model do PR-16; enquanto ele não está no client, este teste não roda.
        const notifications = (
          prisma as unknown as {
            notification: {
              create(args: { data: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }>;
              count(args: { where: { id: { in: string[] } } }): Promise<number>;
            };
          }
        ).notification;
        const insert = async (status: string, updatedAt: Date) =>
          (
            await notifications.create({
              data: {
                tenantId,
                kind: 'plan_usage',
                dedupeKey: `usage:teste-${randomUUID()}`,
                usageMonth: new Date('2026-07-01T00:00:00.000Z'),
                usagePercent: 80,
                status,
                createdAt: updatedAt,
                updatedAt,
              },
              select: { id: true },
            })
          ).id;
        const gone = [
          await insert('sent', daysBefore(now, 91)),
          await insert('skipped', daysBefore(now, 120)),
          await insert('failed', daysBefore(now, 200)),
        ];
        const kept = [
          await insert('pending', daysBefore(now, 200)),
          await insert('sent', daysBefore(now, 89)),
        ];

        expect(await job([tenantId]).maybeRun(now)).toMatchObject({
          status: 'done',
          deleted: { notifications: 3 },
        });
        expect(await notifications.count({ where: { id: { in: gone } } })).toBe(0);
        expect(await notifications.count({ where: { id: { in: kept } } })).toBe(2);
        const [record] = await purgeTrail(tenantId);
        expect(record?.after).toMatchObject({ deleted: { notifications: 3 } });
      },
    );

    it("horas de avisos (PR-17'): o resumo resolvido e a hora só de contagem saem com 90 dias; o pendente e o recente ficam", async () => {
      const { tenantId, authorId } = await customer('resumos');
      const now = today();
      let hour = 0;
      const insert = async (status: 'sent' | 'failed' | 'skipped' | 'pending' | null, updatedAt: Date) =>
        (
          await prisma.notificationDigest.create({
            data: {
              tenantId,
              userId: authorId,
              hourStart: new Date(Date.UTC(2026, 0, 1, (hour += 1))),
              status,
              // A hora só de contagem não reúne aviso; o resumo reúne (o CHECK da migration).
              noticeIds: status === null ? [] : [randomUUID()],
              nextAttemptAt: status === null ? null : updatedAt,
              individualSent: 5,
              createdAt: updatedAt,
              updatedAt,
            },
            select: { id: true },
          })
        ).id;
      const gone = [
        await insert('sent', daysBefore(now, 91)),
        await insert('skipped', daysBefore(now, 120)),
        await insert('failed', daysBefore(now, 200)),
        await insert(null, daysBefore(now, 95)),
      ];
      const kept = [
        await insert('pending', daysBefore(now, 200)),
        await insert('sent', daysBefore(now, 89)),
        await insert(null, daysBefore(now, 10)),
      ];

      expect(await job([tenantId]).maybeRun(now)).toMatchObject({
        status: 'done',
        deleted: { noticeDigests: 4 },
      });
      expect(await prisma.notificationDigest.count({ where: { id: { in: gone } } })).toBe(0);
      expect(await prisma.notificationDigest.count({ where: { id: { in: kept } } })).toBe(3);
      const [record] = await purgeTrail(tenantId);
      expect(record?.after).toMatchObject({ deleted: { notifications: 0, noticeDigests: 4 } });
    });

    it('plano interno (sem limite): o histórico e a auditoria ficam; inventário e operação seguem', async () => {
      const { tenantId } = await customer('interno');
      const now = today();
      const ancient = await insertFinding(tenantId, daysBefore(now, 2000));
      const ancientAudit = await insertAudit(tenantId, daysBefore(now, 2000));
      const oldSnapshot = await insertSnapshot(tenantId, '555555555555', daysBefore(now, 60));
      await insertSnapshot(tenantId, '555555555555', daysBefore(now, 1));

      expect(await job([tenantId], { historyDays: null }).maybeRun(now)).toMatchObject({
        status: 'done',
        historyDays: null,
      });
      expect(await findingsLeft([ancient])).toEqual([ancient]);
      expect(await auditExists(ancientAudit)).toBe(true);
      expect(await prisma.inventorySnapshot.count({ where: { id: oldSnapshot } })).toBe(0);
    });
  });

  describe('trilha e isolamento', () => {
    it('retention.purge na trilha de cada cliente, só com cortes e contagens; o expurgo de A não toca em B', async () => {
      const a = await customer('A');
      const b = await customer('B');
      const now = today();
      const oldA = await insertFinding(a.tenantId, daysBefore(now, 200));
      const oldCommentA = await insertComment(a.tenantId, oldA, a.authorId, daysBefore(now, 199));
      const oldB = await insertFinding(b.tenantId, daysBefore(now, 200));
      const oldCommentB = await insertComment(b.tenantId, oldB, b.authorId, daysBefore(now, 199));
      const recentB = await insertFinding(b.tenantId, daysBefore(now, 5));

      // Só o cliente A: nada de B sai, e B não ganha registro.
      await job([a.tenantId]).maybeRun(now);
      expect(await findingsLeft([oldA])).toEqual([]);
      expect(await commentExists(oldCommentA)).toBe(false);
      expect(await findingsLeft([oldB, recentB]).then((ids) => ids.sort())).toEqual([oldB, recentB].sort());
      expect(await commentExists(oldCommentB)).toBe(true);
      expect(await purgeTrail(b.tenantId)).toEqual([]);

      const [recordA] = await purgeTrail(a.tenantId);
      expect(recordA).toMatchObject({
        actorType: 'system',
        outcome: 'success',
        resourceType: 'retention',
        after: {
          historyDays: 90,
          planHistoryDays: 90,
          graceUntil: null,
          complete: true,
          deleted: {
            incidents: 0,
            findings: 1,
            comments: 1,
            postureScans: 0,
            postureFailures: 0,
            inventorySnapshots: 0,
            notifications: 0,
            noticeDigests: 0,
            auditLogs: 0,
          },
        },
      });
      const cutoffs = retentionCutoffs(now, 90);
      expect(recordA?.after).toMatchObject({
        cutoffs: {
          history: cutoffs.history?.toISOString(),
          inventory: cutoffs.inventory.toISOString(),
          notifications: cutoffs.notifications.toISOString(),
          audit: cutoffs.audit?.toISOString(),
        },
      });
      // Só contagens: nenhum ID do que saiu.
      expect(JSON.stringify(recordA?.after)).not.toContain(oldA);
      expect(JSON.stringify(recordA?.after)).not.toContain(oldCommentA);

      // Os dois clientes: o antigo de B sai, o recente fica; cada trilha conta só o próprio.
      await job([a.tenantId, b.tenantId]).maybeRun(now);
      expect(await findingsLeft([oldB, recentB])).toEqual([recentB]);
      expect(await commentExists(oldCommentB)).toBe(false);
      const trailB = await purgeTrail(b.tenantId);
      expect(trailB).toHaveLength(1);
      expect(trailB[0]?.after).toMatchObject({ deleted: { findings: 1, comments: 1 } });
      const trailA = await purgeTrail(a.tenantId);
      expect(trailA).toHaveLength(2);
      expect(trailA[1]?.after).toMatchObject({ deleted: { findings: 0, comments: 0 } });
    });

    it('a auditoria antiga conta na trilha do próprio cliente; a sem cliente vai para o registro global', async () => {
      const { tenantId } = await customer('auditoria');
      const now = today();
      const old = daysBefore(now, 500);
      await insertAudit(tenantId, old);
      await insertAudit(tenantId, old);
      const globalOld = await insertAudit(null, old);
      const since = new Date();

      await job([tenantId], { batch: 1 }).maybeRun(now);

      const [record] = await purgeTrail(tenantId);
      expect(record?.after).toMatchObject({ deleted: { auditLogs: 2 } });
      expect(await auditExists(globalOld)).toBe(false);
      const global = await prisma.auditLog.findFirst({
        where: { tenantId: null, action: 'retention.purge', occurredAt: { gte: since } },
        orderBy: { occurredAt: 'desc' },
        select: { after: true },
      });
      const globalAfter = global?.after as { complete: boolean; deleted: { auditLogs: number } } | undefined;
      expect(globalAfter?.complete).toBe(true);
      expect(globalAfter?.deleted.auditLogs).toBeGreaterThanOrEqual(1);
    });
  });

  describe('agenda, concessão e tempo', () => {
    it('antes das 04:00 UTC espera; a segunda execução no mesmo dia não faz nada; a de ontem não segura a de hoje', async () => {
      const { tenantId } = await customer('agenda');
      const now = today();
      const name = `ret-${randomBytes(4).toString('hex')}`;
      const retention = job([tenantId], { name });
      const early = new Date(now.getTime() - 61 * 60 * 1000); // 03:59 UTC
      expect(await retention.maybeRun(early)).toEqual({ status: 'waiting' });

      const first = await insertFinding(tenantId, daysBefore(now, 200));
      expect(await retention.maybeRun(now)).toMatchObject({ status: 'done', deleted: { findings: 1 } });

      // Mesmo dia, mais tarde: nada roda, nem com dado novo para apagar.
      const second = await insertFinding(tenantId, daysBefore(now, 200));
      expect(await retention.maybeRun(new Date(now.getTime() + 2 * HOUR))).toEqual({ status: 'already_ran' });
      expect(await findingsLeft([second])).toEqual([second]);
      expect(await purgeTrail(tenantId)).toHaveLength(1);
      expect(await findingsLeft([first])).toEqual([]);

      // A execução de ontem não segura a de hoje.
      expect(await prisma.syncState.findUniqueOrThrow({ where: { name } })).toMatchObject({
        lastSuccessAt: now,
        lastError: null,
        leaseOwner: null,
      });
      await prisma.syncState.update({ where: { name }, data: { lastSuccessAt: daysBefore(now, 1) } });
      expect(await retention.maybeRun(now)).toMatchObject({ status: 'done', deleted: { findings: 1 } });
      expect(await findingsLeft([second])).toEqual([]);
    });

    it('com a concessão em outra réplica, fica `locked` e não apaga nada', async () => {
      const { tenantId } = await customer('concessão');
      const now = today();
      const name = `ret-${randomBytes(4).toString('hex')}`;
      const old = await insertFinding(tenantId, daysBefore(now, 200));
      // Concessão longa: o `now` do teste fica a até um dia do relógio real.
      const other = new SyncLease(prisma, name, 'outra-replica', 2 * DAY_MS);
      expect(await other.acquire(new Date())).toBe(true);

      expect(await job([tenantId], { name }).maybeRun(now)).toEqual({ status: 'locked' });
      expect(await findingsLeft([old])).toEqual([old]);

      await other.release();
      expect(await job([tenantId], { name }).maybeRun(now)).toMatchObject({ status: 'done' });
      expect(await findingsLeft([old])).toEqual([]);
    });

    it('para no tempo máximo: termina como parcial, registra o que saiu e deixa o resto para o dia seguinte', async () => {
      const { tenantId } = await customer('tempo');
      const now = today();
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1)
        ids.push(await insertFinding(tenantId, daysBefore(now, 200)));
      // Relógio que anda 1 ms a cada leitura: a partida e dois lotes cabem em 3 ms.
      let tick = 0;
      const retention = job([tenantId], { batch: 1, maxRunMs: 3, clock: () => (tick += 1) });

      expect(await retention.maybeRun(now)).toMatchObject({ status: 'partial', deleted: { findings: 2 } });
      expect(await findingsLeft(ids)).toHaveLength(3);
      const [record] = await purgeTrail(tenantId);
      expect(record).toMatchObject({
        outcome: 'success',
        after: { complete: false, deleted: { findings: 2 } },
      });

      // O dia conta como feito: o resto fica para amanhã.
      expect(await retention.maybeRun(now)).toEqual({ status: 'already_ran' });
      expect(await findingsLeft(ids)).toHaveLength(3);
    });

    it('a parada do worker interrompe: o dia não conta como feito e a trilha registra a interrupção', async () => {
      const { tenantId } = await customer('parada');
      const now = today();
      await insertFinding(tenantId, daysBefore(now, 200));
      const name = `ret-${randomBytes(4).toString('hex')}`;
      const stop = new AbortController();
      stop.abort(new DOMException('o worker está parando', 'AbortError'));

      await expect(job([tenantId], { name }).maybeRun(now, stop.signal)).rejects.toThrow(/parando/);
      const state = await prisma.syncState.findUniqueOrThrow({ where: { name } });
      expect(state).toMatchObject({ lastSuccessAt: null, lastError: 'AbortError', leaseOwner: null });
      const [record] = await purgeTrail(tenantId);
      expect(record).toMatchObject({ outcome: 'failure', after: { complete: false, error: 'AbortError' } });
    });
  });

  describe('triagem pela API ao mesmo tempo que o lote (concorrência)', () => {
    /**
     * Uma escrita da API numa transação aberta em outra conexão, como a do `FindingsService` ou do `IncidentsService`:
     * ela segura a linha até `commit`.
     */
    async function openWrite(
      sql: string,
      params: unknown[],
    ): Promise<{ pid: number; commit(): Promise<void> }> {
      const client = new pg.Client({ connectionString: inject('testDatabaseUrl') });
      await client.connect();
      const { pid } = only((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows);
      await client.query('BEGIN');
      await client.query(sql, params);
      return {
        pid,
        commit: async () => {
          try {
            await client.query('COMMIT');
          } finally {
            await client.end();
          }
        },
      };
    }

    /** Espera o expurgo ficar parado na linha que a escrita segura (até 15 s). */
    async function waitUntilBlockedBy(pid: number): Promise<void> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const { blocked } = only(
          await prisma.$queryRaw<{ blocked: number }[]>`
            SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`,
        );
        if (blocked > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('o expurgo não chegou a esperar a escrita da API');
    }

    /**
     * O lote busca a linha antiga, a triagem chega com a transação aberta, o lote para na trava da linha, a triagem é
     * confirmada e só então o lote confere de novo: nada do que a triagem tocou sai.
     */
    it.each([
      [
        'triagem de um achado solto',
        async (tenantId: string) => {
          const finding = await insertFinding(tenantId, daysBefore(today(), 200));
          return {
            findings: [finding],
            incident: null,
            sql: `UPDATE "Finding" SET status = 'resolved', "updatedAt" = now() WHERE id = $1`,
            params: [finding],
          };
        },
      ],
      [
        'comentário num achado solto',
        async (tenantId: string, authorId: string) => {
          const finding = await insertFinding(tenantId, daysBefore(today(), 200));
          return {
            findings: [finding],
            incident: null,
            sql: `INSERT INTO "FindingComment" (id, "tenantId", "findingId", "authorId", body)
                  VALUES (gen_random_uuid(), $1, $2, $3, 'decisão tomada agora')`,
            params: [tenantId, finding, authorId],
          };
        },
      ],
      [
        'triagem do incidente',
        async (tenantId: string) => {
          const incident = await insertIncident(tenantId, [
            daysBefore(today(), 200),
            daysBefore(today(), 150),
          ]);
          return {
            findings: incident.findings,
            incident: incident.id,
            sql: `UPDATE "Incident" SET status = 'investigating', "updatedAt" = now() WHERE id = $1`,
            params: [incident.id],
          };
        },
      ],
      [
        'triagem de um achado do incidente',
        async (tenantId: string) => {
          const incident = await insertIncident(tenantId, [
            daysBefore(today(), 200),
            daysBefore(today(), 150),
          ]);
          return {
            findings: incident.findings,
            incident: incident.id,
            sql: `UPDATE "Finding" SET status = 'legitimate', "updatedAt" = now() WHERE id = $1`,
            params: [incident.findings[1]],
          };
        },
      ],
    ])('escrita da API confirmada no meio do lote (%s): nada do que ela tocou sai', async (_name, setup) => {
      const { tenantId, authorId } = await customer('corrida');
      const { findings, incident, sql, params } = await setup(tenantId, authorId);
      const write = await openWrite(sql, params);

      const running = job([tenantId]).maybeRun(today());
      await waitUntilBlockedBy(write.pid);
      await write.commit();

      expect(await running).toMatchObject({ status: 'done', deleted: { incidents: 0, findings: 0 } });
      expect((await findingsLeft(findings)).sort()).toEqual([...findings].sort());
      if (incident !== null) expect(await incidentExists(incident)).toBe(true);
    });

    it('a trilha da execução interrompida conta o lote que já tinha sido confirmado', async () => {
      const { tenantId } = await customer('lote confirmado');
      const now = today();
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1)
        ids.push(await insertFinding(tenantId, daysBefore(now, 200)));
      const stop = new AbortController();
      let reads = 0;
      // A segunda leitura do relógio é a do primeiro lote: a parada chega com ele em curso, e a execução para logo
      // depois que ele é confirmado.
      const clock = () => {
        reads += 1;
        if (reads === 2) stop.abort(new DOMException('o worker está parando', 'AbortError'));
        return reads;
      };

      await expect(
        job([tenantId], { batch: 1, clock, maxRunMs: 1000 }).maybeRun(now, stop.signal),
      ).rejects.toThrow(/parando/);
      expect(await findingsLeft(ids)).toHaveLength(2);
      const [record] = await purgeTrail(tenantId);
      expect(record).toMatchObject({
        outcome: 'failure',
        after: { complete: false, error: 'AbortError', deleted: { findings: 1 } },
      });
    });
  });

  describe('carência quando o plano diminui', () => {
    it('o prazo anterior vale por 30 dias; depois, o novo', async () => {
      const { tenantId } = await customer('carência');
      const now = today();
      const name = `ret-${randomBytes(4).toString('hex')}`;
      const middle = await insertFinding(tenantId, daysBefore(now, 200));
      const yesterday = async () =>
        prisma.syncState.update({ where: { name }, data: { lastSuccessAt: daysBefore(now, 1) } });

      // Profissional: 365 dias. O achado de 200 dias fica.
      await job([tenantId], { name, historyDays: 365 }).maybeRun(now);
      expect(await findingsLeft([middle])).toEqual([middle]);

      // Desce para o Essencial: a carência começa, e o prazo de 365 continua.
      await yesterday();
      expect(await job([tenantId], { name, historyDays: 90 }).maybeRun(now)).toMatchObject({
        status: 'done',
        historyDays: 365,
      });
      expect(await findingsLeft([middle])).toEqual([middle]);
      const graceRecord = (await purgeTrail(tenantId)).at(-1);
      expect(graceRecord?.after).toMatchObject({
        historyDays: 365,
        planHistoryDays: 90,
        graceUntil: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
      });

      // 30 dias depois do começo da carência, o prazo novo vale.
      // A carência é do cliente (CE-02): o estado fica em `TenantRetentionState`, por tarefa e cliente.
      await prisma.tenantRetentionState.update({
        where: { job_tenantId: { job: name, tenantId } },
        data: { pendingSince: daysBefore(now, 30) },
      });
      await yesterday();
      expect(await job([tenantId], { name, historyDays: 90 }).maybeRun(now)).toMatchObject({
        status: 'done',
        historyDays: 90,
      });
      expect(await findingsLeft([middle])).toEqual([]);
      expect(
        await prisma.tenantRetentionState.findUniqueOrThrow({
          where: { job_tenantId: { job: name, tenantId } },
        }),
      ).toMatchObject({
        appliedDays: 90,
        pendingSince: null,
      });
    });
  });

  describe('funções e triggers do banco (o piso vale mesmo sem a aplicação)', () => {
    it('verax_purge_audit_log recusa corte mais novo que 13 meses e lote fora de 1 a 1000', async () => {
      await expect(prisma.$queryRaw`SELECT * FROM verax_purge_audit_log(now(), 10)`).rejects.toThrow(
        /piso de 13 meses/,
      );
      await expect(
        prisma.$queryRaw`SELECT * FROM verax_purge_audit_log(now() - interval '13 months' + interval '1 hour', 10)`,
      ).rejects.toThrow(/piso de 13 meses/);
      await expect(
        prisma.$queryRaw`SELECT * FROM verax_purge_audit_log(${null}::timestamptz, 10)`,
      ).rejects.toThrow(/piso de 13 meses/);
      await expect(
        prisma.$queryRaw`SELECT * FROM verax_purge_audit_log(now() - interval '14 months', 0)`,
      ).rejects.toThrow(/1 a 1000/);
      await expect(
        prisma.$queryRaw`SELECT * FROM verax_purge_audit_log(now() - interval '14 months', 1001)`,
      ).rejects.toThrow(/1 a 1000/);
    });

    it('verax_purge_audit_log apaga só antes do corte, do mais antigo, no tamanho do lote, e desliga a flag', async () => {
      // Bem mais antigo que qualquer outro registro deste arquivo: o lote limitado só alcança os deste teste.
      const { cutoff } = only(
        await prisma.$queryRaw<{ cutoff: Date }[]>`
          SELECT date_trunc('milliseconds', now() - interval '10 years') AS cutoff`,
      );
      const tenant = randomUUID();
      const oldest = await insertAudit(tenant, new Date(cutoff.getTime() - 3 * DAY_MS));
      const older = await insertAudit(tenant, new Date(cutoff.getTime() - 2 * DAY_MS));
      const justBefore = await insertAudit(null, new Date(cutoff.getTime() - 1));
      const atCutoff = await insertAudit(tenant, cutoff);

      const result = await prisma.$transaction(async (tx) => {
        const first = await tx.$queryRaw<{ tenant_id: string | null; deleted: number }[]>`
          SELECT * FROM verax_purge_audit_log(${cutoff}::timestamptz, 2)`;
        const { flag } = only(
          await tx.$queryRaw<
            { flag: string | null }[]
          >`SELECT current_setting('verax.retention', true) AS flag`,
        );
        return { first, flag };
      });
      expect(result.flag).not.toBe('on');
      expect(result.first).toEqual([{ tenant_id: tenant, deleted: 2 }]);
      expect(await auditExists(oldest)).toBe(false);
      expect(await auditExists(older)).toBe(false);
      expect(await auditExists(justBefore)).toBe(true);

      const second = await prisma.$queryRaw<{ tenant_id: string | null; deleted: number }[]>`
        SELECT * FROM verax_purge_audit_log(${cutoff}::timestamptz, 10)`;
      expect(second).toContainEqual({ tenant_id: null, deleted: 1 });
      expect(await auditExists(justBefore)).toBe(false);
      expect(await auditExists(atCutoff)).toBe(true);
    });

    it('auditoria: UPDATE e TRUNCATE bloqueados mesmo com a flag; DELETE só com a flag e só com mais de 13 meses', async () => {
      const recent = await insertAudit(null, daysBefore(new Date(), 360));
      const { old } = only(
        await prisma.$queryRaw<{ old: Date }[]>`SELECT now() - interval '14 months' AS old`,
      );
      const ancient = await insertAudit(null, old);

      // Sem a flag, nem o registro antigo sai.
      await expect(prisma.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${ancient}::uuid`).rejects.toThrow(
        'somente inserção: DELETE bloqueado',
      );
      const withFlag = (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('verax.retention', 'on', true)`;
          return work(tx);
        });
      // Com a flag, o recente continua bloqueado; UPDATE e TRUNCATE também.
      await expect(
        withFlag((tx) => tx.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${recent}::uuid`),
      ).rejects.toThrow('somente inserção: DELETE bloqueado');
      await expect(
        withFlag(
          (tx) => tx.$executeRaw`UPDATE "AuditLog" SET action = 'adulterado' WHERE id = ${ancient}::uuid`,
        ),
      ).rejects.toThrow('somente inserção: UPDATE bloqueado');
      await expect(withFlag((tx) => tx.$executeRaw`TRUNCATE "AuditLog"`)).rejects.toThrow(
        'somente inserção: TRUNCATE bloqueado',
      );
      expect(await auditExists(recent)).toBe(true);
      // O caminho estreito: flag e mais de 13 meses (é o que a função faz, com o dono das tabelas).
      expect(await withFlag((tx) => tx.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${ancient}::uuid`)).toBe(
        1,
      );
    });

    it('verax_purge_finding_comments: piso de 30 dias no achado e no comentário; UPDATE e TRUNCATE bloqueados', async () => {
      const { tenantId, authorId } = await customer('funções');
      const now = new Date();
      const recentFinding = await insertFinding(tenantId, daysBefore(now, 29));
      const recentComment = await insertComment(tenantId, recentFinding, authorId, daysBefore(now, 29));
      const oldFinding = await insertFinding(tenantId, daysBefore(now, 200));
      const oldComment = await insertComment(tenantId, oldFinding, authorId, daysBefore(now, 199));
      const lateComment = await insertComment(tenantId, oldFinding, authorId, daysBefore(now, 10));

      // Achado com menos de 30 dias: o lote inteiro é recusado.
      await expect(
        prisma.$queryRaw`SELECT verax_purge_finding_comments(${[oldFinding, recentFinding]}::uuid[])`,
      ).rejects.toThrow(/piso de 30 dias/);
      // Achado antigo com um comentário recente: o trigger recusa, e nada sai.
      await expect(
        prisma.$queryRaw`SELECT verax_purge_finding_comments(${[oldFinding]}::uuid[])`,
      ).rejects.toThrow('somente inserção: DELETE bloqueado');
      expect(await commentExists(oldComment)).toBe(true);
      // Lote grande demais.
      const many = Array.from({ length: 1001 }, () => randomUUID());
      await expect(prisma.$queryRaw`SELECT verax_purge_finding_comments(${many}::uuid[])`).rejects.toThrow(
        /até 1000/,
      );

      // Sem a flag, o DELETE direto continua bloqueado; com ela, UPDATE e TRUNCATE também.
      await expect(
        prisma.$executeRaw`DELETE FROM "FindingComment" WHERE id = ${oldComment}::uuid`,
      ).rejects.toThrow('somente inserção: DELETE bloqueado');
      const withFlag = (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('verax.retention', 'on', true)`;
          return work(tx);
        });
      await expect(
        withFlag(
          (tx) => tx.$executeRaw`UPDATE "FindingComment" SET body = 'outro' WHERE id = ${oldComment}::uuid`,
        ),
      ).rejects.toThrow('somente inserção: UPDATE bloqueado');
      await expect(withFlag((tx) => tx.$executeRaw`TRUNCATE "FindingComment"`)).rejects.toThrow(
        'somente inserção: TRUNCATE bloqueado',
      );
      await expect(
        withFlag((tx) => tx.$executeRaw`DELETE FROM "FindingComment" WHERE id = ${recentComment}::uuid`),
      ).rejects.toThrow('somente inserção: DELETE bloqueado');

      // Sem o comentário recente, os antigos do achado antigo saem pela função, e a flag volta a desligada.
      const other = await insertFinding(tenantId, daysBefore(now, 200));
      const otherComments = [
        await insertComment(tenantId, other, authorId, daysBefore(now, 199)),
        await insertComment(tenantId, other, authorId, daysBefore(now, 100)),
      ];
      const outcome = await prisma.$transaction(async (tx) => {
        const { deleted } = only(
          await tx.$queryRaw<{ deleted: number }[]>`
            SELECT verax_purge_finding_comments(${[other]}::uuid[]) AS deleted`,
        );
        const { flag } = only(
          await tx.$queryRaw<
            { flag: string | null }[]
          >`SELECT current_setting('verax.retention', true) AS flag`,
        );
        return { deleted, flag };
      });
      expect(outcome.deleted).toBe(2);
      expect(outcome.flag).not.toBe('on');
      for (const id of otherComments) expect(await commentExists(id)).toBe(false);
      expect(await commentExists(lateComment)).toBe(true);
      expect(await commentExists(recentComment)).toBe(true);
    });
  });
  describe('prazo de cada cliente (CE-02)', () => {
    /** O plano de cada cliente do teste: só o histórico importa ao expurgo (null é o cliente da célula sem plano). */
    function plansOf(historyByTenant: ReadonlyMap<string, number | null | 'missing'>): TenantPlans {
      return {
        planOf: (tenantId) => {
          const history = historyByTenant.get(tenantId);
          if (history === undefined || history === 'missing') return Promise.resolve(null);
          return Promise.resolve({
            id: 'enterprise',
            label: 'Enterprise',
            limits: { maxCloudAccounts: null, maxUsers: null, monthlyGib: null, historyDays: history },
          });
        },
      };
    }

    it('dois clientes, dois prazos: o achado de 100 dias sai de A (30) e fica em B (365), cada trilha com o seu', async () => {
      const a = await customer('A (prazo curto)');
      const b = await customer('B (prazo longo)');
      const now = today();
      const oldA = await insertFinding(a.tenantId, daysBefore(now, 100));
      const oldB = await insertFinding(b.tenantId, daysBefore(now, 100));
      const plans = plansOf(
        new Map([
          [a.tenantId, 30],
          [b.tenantId, 365],
        ]),
      );

      const report = await job([a.tenantId, b.tenantId], { plans }).maybeRun(now);
      expect(report).toMatchObject({ status: 'done', tenants: 2 });
      // Com prazos diferentes, o relatório não tem um prazo só.
      expect(report).not.toHaveProperty('historyDays');
      expect(await findingsLeft([oldA, oldB])).toEqual([oldB]);
      expect((await purgeTrail(a.tenantId)).at(-1)?.after).toMatchObject({
        historyDays: 30,
        planHistoryDays: 30,
        cutoffs: { history: retentionCutoffs(now, 30).history?.toISOString() },
        deleted: { findings: 1 },
      });
      expect((await purgeTrail(b.tenantId)).at(-1)?.after).toMatchObject({
        historyDays: 365,
        planHistoryDays: 365,
        cutoffs: { history: retentionCutoffs(now, 365).history?.toISOString() },
        deleted: { findings: 0 },
      });
    });

    it('a auditoria de cada cliente sai pelo prazo dele; a sem cliente segue o mais longo', async () => {
      const a = await customer('A (auditoria curta)');
      const b = await customer('B (auditoria longa)');
      const now = today();
      const old = daysBefore(now, 500);
      const auditA = await insertAudit(a.tenantId, old);
      const auditB = await insertAudit(b.tenantId, old);
      const global = await insertAudit(null, old);
      const plans = plansOf(
        new Map([
          [a.tenantId, 90],
          [b.tenantId, 730],
        ]),
      );

      await job([a.tenantId, b.tenantId], { plans }).maybeRun(now);

      // A guarda 13 meses: o registro de 500 dias sai pela função do cliente. B guarda 730 dias: o dele fica, e o
      // corte global (o de B, o mais antigo) segura também o registro sem cliente.
      expect(await auditExists(auditA)).toBe(false);
      expect(await auditExists(auditB)).toBe(true);
      expect(await auditExists(global)).toBe(true);
      expect((await purgeTrail(a.tenantId)).at(-1)?.after).toMatchObject({ deleted: { auditLogs: 1 } });
      expect((await purgeTrail(b.tenantId)).at(-1)?.after).toMatchObject({
        deleted: { auditLogs: 0 },
        cutoffs: { audit: retentionCutoffs(now, 730).audit?.toISOString() },
      });
    });

    it('cliente da célula ainda sem plano: fica fora do histórico e da auditoria, e a trilha diz por quê', async () => {
      const a = await customer('A (com plano)');
      const c = await customer('C (sem plano)');
      const now = today();
      const oldA = await insertFinding(a.tenantId, daysBefore(now, 200));
      const oldC = await insertFinding(c.tenantId, daysBefore(now, 200));
      const auditC = await insertAudit(c.tenantId, daysBefore(now, 500));
      const plans = plansOf(
        new Map<string, number | 'missing'>([
          [a.tenantId, 90],
          [c.tenantId, 'missing'],
        ]),
      );

      const report = await job([a.tenantId, c.tenantId], { plans }).maybeRun(now);
      expect(report).toMatchObject({ status: 'done', historyDays: 90, withoutPlan: 1 });
      expect(await findingsLeft([oldA, oldC])).toEqual([oldC]);
      expect(await auditExists(auditC)).toBe(true);
      const trailC = (await purgeTrail(c.tenantId)).at(-1)?.after as Record<string, unknown> | undefined;
      expect(trailC).toMatchObject({ planMissing: true, cutoffs: { history: null, audit: null } });
      expect(trailC).not.toHaveProperty('historyDays');
    });

    it('a carência é de cada cliente: a redução de A não mexe no prazo de B', async () => {
      const a = await customer('A (carência)');
      const b = await customer('B (sem carência)');
      const now = today();
      const name = `ret-${randomBytes(4).toString('hex')}`;
      const middleA = await insertFinding(a.tenantId, daysBefore(now, 200));
      const middleB = await insertFinding(b.tenantId, daysBefore(now, 200));
      const yesterday = () =>
        prisma.syncState.update({ where: { name }, data: { lastSuccessAt: daysBefore(now, 1) } });

      await job([a.tenantId, b.tenantId], {
        name,
        plans: plansOf(
          new Map([
            [a.tenantId, 365],
            [b.tenantId, 365],
          ]),
        ),
      }).maybeRun(now);
      await yesterday();
      // A desce para 90 dias e entra na carência de 30 (o achado de 200 dias fica); B continua em 365, sem carência.
      await job([a.tenantId, b.tenantId], {
        name,
        plans: plansOf(
          new Map([
            [a.tenantId, 90],
            [b.tenantId, 365],
          ]),
        ),
      }).maybeRun(now);
      expect(await findingsLeft([middleA, middleB]).then((ids) => ids.sort())).toEqual(
        [middleA, middleB].sort(),
      );
      const state = (tenantId: string) =>
        prisma.tenantRetentionState.findUniqueOrThrow({ where: { job_tenantId: { job: name, tenantId } } });
      expect(await state(a.tenantId)).toMatchObject({ appliedDays: 365, pendingSince: now });
      expect(await state(b.tenantId)).toMatchObject({ appliedDays: 365, pendingSince: null });
    });
  });
});
