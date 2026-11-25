import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { FindingStore } from '../src/alerts/finding-store.js';
import { CaseAssignJob } from '../src/cases/case-assign-job.js';
import { caseNoticeKey, caseWaveKey, criticalCasesKey } from '../src/cases/case-notice-policy.js';
import { CaseNoticeMail } from '../src/cases/case-notice-mail.js';
import { CASE_NOTICES_STATE, CaseAlertNotices, CaseNoticeRegime } from '../src/cases/case-notice-regime.js';
import { caseNoticeSetup } from '../src/cases/case-notice-setup.js';
import { CaseNotices } from '../src/cases/case-notices.js';
import { caseTasks } from '../src/cases/case-tasks.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { NotificationKind, NotificationStatus, Prisma } from '../src/generated/prisma/client.js';
import type { NotificationReport } from '../src/notifications/notification-dispatcher.js';
import {
  at,
  customer,
  DAY_MS,
  draft,
  HOUR_MS,
  insertVulnerability,
  keysOf,
  markSent,
  member,
  MINUTE_MS,
  noticesOf,
  noticeWorld,
  plainDispatcher,
  T0,
} from './support/case-notices.js';
import { casesOf, findingData, insertFinding, insertIncident } from './support/cases.js';
import { MemoryMailTransport } from './support/memory-mail.js';
import { createOwnDatabase, type OwnDatabase } from './support/own-database.js';

/**
 * A virada entre o aviso por alerta e o aviso por caso, nos dois sentidos: ligar (`off` e `shadow` para `on`), voltar (`on`
 * para `off` e `shadow`, com esta versão e com a anterior) e ligar de novo. Nenhum crítico se perde, nada se repete, e com
 * `off` e `shadow` nada muda. Num banco só deste arquivo.
 */
describe('a virada dos avisos por caso', () => {
  let database: OwnDatabase;
  let prisma: PrismaService;
  const silent = { warn: () => undefined, error: () => undefined };

  beforeAll(async () => {
    database = await createOwnDatabase('avisos_virada');
    prisma = new PrismaService({ DATABASE_URL: database.url });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.drop();
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany({});
    await prisma.notificationDigest.deleteMany({});
    await prisma.syncState.deleteMany({});
  });

  const at0 = (minutes: number) => at(minutes * MINUTE_MS);
  /** O aviso que o mecanismo por alerta grava junto do alerta. */
  async function alertNotice(
    tenantId: string,
    findingId: string,
    severity: 'critical' | 'high',
    overrides: Partial<Prisma.NotificationUncheckedCreateInput> = {},
  ): Promise<string> {
    const kind: NotificationKind = severity === 'critical' ? 'critical_finding' : 'high_finding';
    const { id } = await prisma.notification.create({
      data: {
        tenantId,
        kind,
        severity,
        findingId,
        dedupeKey: `finding:${findingId}`,
        nextAttemptAt: T0,
        createdAt: at0(-1),
        ...overrides,
      },
      select: { id: true },
    });
    return id;
  }
  /** A atribuição de antes dos avisos por caso (`shadow`, ou a versão anterior): o caso acompanha o que já foi avisado. */
  const assignAsShadow = (tenantIds: readonly string[], now: Date) =>
    new CaseAssignJob(prisma, {
      name: `caso-${randomBytes(6).toString('hex')}`,
      tenantIds,
      workMs: 10 * MINUTE_MS,
      now: () => now,
    }).runOnce();
  const resolved: Partial<Prisma.NotificationUncheckedCreateInput> = {
    status: 'sent',
    attempts: 1,
    deliveredUserIds: ['alguem'],
  };

  describe('off e shadow: exatamente como antes', () => {
    it('os coletores, as tarefas e a entrega não ganham nada que mude uma linha ou um e-mail', () => {
      for (const mode of ['off', 'shadow'] as const) {
        const setup = caseNoticeSetup(mode, prisma, silent);
        expect(setup.alertNotices).toBeUndefined();
        expect(setup.dispatcher.caseMail).toBeInstanceOf(CaseNoticeMail);
      }
      expect(caseTasks('off', prisma, silent)).toEqual([]);
      const on = caseNoticeSetup('on', prisma, silent);
      expect(on.alertNotices).toBeInstanceOf(CaseAlertNotices);
      expect(on.dispatcher.cases).toBeInstanceOf(CaseNotices);
    });

    it('a tarefa da atribuição: com shadow, o caso nasce avisado, como sempre; com on, quem decide são os avisos', async () => {
      const noticed = async (mode: 'shadow' | 'on', ruleId: string) => {
        const tenantId = await customer(prisma);
        await insertFinding(prisma, tenantId, { severity: 'critical', ruleId });
        const task = caseTasks(mode, prisma, silent).find(({ name }) => name === 'case-assign');
        await task?.run(new AbortController().signal);
        return (await casesOf(prisma, tenantId)).map((row) => row.noticedSeverity);
      };
      expect(await noticed('shadow', '100310')).toEqual(['critical']);
      expect(await noticed('on', '100310')).toEqual([null]);
    });

    /** O mesmo roteiro, num cliente novo: coletores, subida na origem, atribuição (com `shadow`) e três execuções. */
    async function scenario(mode: 'before' | 'off' | 'shadow') {
      await prisma.notification.deleteMany({});
      await prisma.notificationDigest.deleteMany({});
      const tenantId = await customer(prisma, 'Cliente Demo A');
      const person = await member(prisma, tenantId);
      const mail = new MemoryMailTransport();
      const setup = mode === 'before' ? null : caseNoticeSetup(mode, prisma, silent);
      await setup?.start();
      const store = new FindingStore(prisma, setup?.alertNotices);
      const start = new Date();
      const drafts: FindingDraft[] = [];
      for (let i = 0; i < 9; i += 1)
        drafts.push(
          draft(tenantId, {
            sourceEventId: `roteiro-${i}`,
            severity: (['critical', 'high', 'medium'] as const)[i % 3] ?? 'high',
            ruleId: `1003${10 + i}`,
            occurredAt: start.toISOString(),
          }),
        );
      const rising = draft(tenantId, {
        sourceEventId: 'roteiro-subida',
        severity: 'medium',
        logSource: 'security_hub',
        occurredAt: start.toISOString(),
        revision: { lastSeenAt: start.toISOString() },
      });
      drafts.push(rising);
      for (const one of drafts) {
        const source = `${one.sourceEventId}-${tenantId}`;
        expect(await store.persist({ ...one, sourceEventId: source }, null, start)).toBe('created');
      }
      if (mode === 'shadow') await assignAsShadow([tenantId], new Date());
      await store.persist(
        {
          ...rising,
          sourceEventId: `${rising.sourceEventId}-${tenantId}`,
          severity: 'critical',
          revision: { lastSeenAt: new Date(start.getTime() + 1_000).toISOString() },
        },
        null,
        start,
      );
      const reports: NotificationReport[] = [];
      const base = new Date(Math.ceil(Date.now() / HOUR_MS) * HOUR_MS);
      for (const minutes of [1, 2, 61]) {
        const now = new Date(base.getTime() + minutes * MINUTE_MS);
        reports.push(await plainDispatcher(prisma, mail, () => now, setup?.dispatcher).runOnce());
      }
      await setup?.finish();
      const findings = new Map(
        (await prisma.finding.findMany({ where: { tenantId } })).map((row) => [
          row.id,
          row.sourceEventId.split(`-${tenantId}`)[0] as string,
        ]),
      );
      const name = (text: string) => {
        let out = text;
        for (const [id, known] of findings) out = out.split(id).join(known);
        return out
          .split(tenantId)
          .join('cliente')
          .split(person.id)
          .join('pessoa')
          .split(person.email)
          .join('email');
      };
      const rows = (await noticesOf(prisma, tenantId)).map(
        ({ id: _id, createdAt: _c, updatedAt: _u, nextAttemptAt: _n, sentAt, ...row }) => ({
          ...(JSON.parse(name(JSON.stringify(row))) as Record<string, unknown> & { dedupeKey: string }),
          sent: sentAt !== null,
        }),
      );
      const digests = (
        await prisma.notificationDigest.findMany({ where: { tenantId }, orderBy: { hourStart: 'asc' } })
      ).map(({ individualSent, status, noticeIds, catchUp, lastError, attempts }) => ({
        individualSent,
        status,
        notices: noticeIds.length,
        catchUp,
        lastError,
        attempts,
      }));
      return {
        rows: rows.sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey)),
        digests,
        mails: mail.messages
          .map(({ to, subject, text, html }) => name([to, subject, text, html].join('\n')))
          .sort(),
        reports,
        states: (await prisma.syncState.findMany({ select: { name: true } }))
          .map((row) => row.name)
          .filter((state) => !state.startsWith('caso-')),
      };
    }

    it('as linhas, os resumos, os e-mails e os relatórios são os mesmos de um worker que não sabe dos casos', async () => {
      const before = await scenario('before');
      expect(before.rows).toHaveLength(7);
      expect(before.mails.length).toBeGreaterThan(5);
      expect(before.states).toEqual(['notifications']);
      // A hora de cada item do resumo é a do relógio de verdade: fora da comparação.
      const comparable = (run: typeof before) => ({
        ...run,
        mails: run.mails.map((text) => text.replaceAll(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}/g, 'hora')),
      });
      expect(comparable(await scenario('off'))).toEqual(comparable(before));
      expect(comparable(await scenario('shadow'))).toEqual(comparable(before));
    }, 60_000);
  });

  describe('os coletores com os avisos por caso', () => {
    it('o alerta novo não põe nada na fila; antes de a virada estar gravada, põe, como sempre', async () => {
      const tenantId = await customer(prisma);
      const made = noticeWorld(prisma, [tenantId], new Date());
      const early = draft(tenantId, { severity: 'critical' });
      expect(await made.store.persist(early, null, new Date())).toBe('created');
      expect(await noticesOf(prisma, tenantId)).toHaveLength(1);
      await made.activate();
      for (const severity of ['critical', 'high', 'medium'] as const)
        expect(await made.store.persist(draft(tenantId, { severity }), null, new Date())).toBe('created');
      expect(await noticesOf(prisma, tenantId)).toHaveLength(1);
      // Fora da fila, mas não calado: o caso avisa. O do instante da partida ainda está na fila, e o caso o troca.
      made.clock.now = new Date(Date.now() + 1_000);
      const report = await made.step();
      expect(report).toMatchObject({ opened: 1, superseded: 1 });
      expect((await noticesOf(prisma, tenantId)).map((row) => row.status).sort()).toEqual([
        'pending',
        'skipped',
      ]);
    });

    it('a severidade que sobe na origem: com caso, quem avisa é ele; num incidente, já tratado ou sem caso, o alerta', async () => {
      const tenantId = await customer(prisma);
      const made = noticeWorld(prisma, [tenantId], new Date());
      await made.activate();
      const seen = (seconds: number) => new Date(Date.now() + seconds * 1_000).toISOString();
      const state = (name: string, severity: FindingDraft['severity'], seconds: number) =>
        draft(tenantId, {
          sourceEventId: `${name}-${tenantId}`,
          severity,
          logSource: 'security_hub',
          eventName: `TTPs/${name}`,
          ruleId: '990502',
          revision: { lastSeenAt: seen(seconds) },
        });
      const idOf = async (name: string) =>
        (
          await prisma.finding.findUniqueOrThrow({
            where: { source_sourceEventId: { source: 'wazuh', sourceEventId: `${name}-${tenantId}` } },
          })
        ).id;
      for (const name of ['caso', 'incidente', 'tratado'])
        await made.store.persist(state(name, 'medium', 0), null, new Date());
      await made.assign();
      await made.store.persist(state('solto', 'medium', 0), null, new Date());
      const incidentId = await insertIncident(prisma, tenantId);
      await prisma.finding.update({ where: { id: await idOf('incidente') }, data: { incidentId } });
      await prisma.finding.update({
        where: { id: await idOf('tratado') },
        data: { status: 'resolved', triagedAt: new Date() },
      });
      for (const name of ['caso', 'incidente', 'tratado', 'solto'])
        await made.store.persist(state(name, 'critical', 60), null, new Date());
      expect((await keysOf(prisma, tenantId)).sort()).toEqual(
        [
          `finding:${await idOf('incidente')}`,
          `finding:${await idOf('tratado')}`,
          `finding:${await idOf('solto')}`,
        ].sort(),
      );
      made.clock.now = new Date(Date.now() + MINUTE_MS);
      expect(await made.step()).toMatchObject({ opened: 2 });
      // O do incidente e o já tratado não são de caso nenhum: continuam na fila.
      const pending = (await noticesOf(prisma, tenantId, { status: 'pending', caseId: null })).map(
        (row) => row.findingId,
      );
      expect(pending.sort()).toEqual([await idOf('incidente'), await idOf('tratado')].sort());
      // A legítima (por uma pessoa) que sobe não avisa, como sempre.
      await prisma.finding.update({ where: { id: await idOf('caso') }, data: { status: 'legitimate' } });
      const before = await keysOf(prisma, tenantId);
      await made.store.persist(state('caso', 'critical', 120), null, new Date());
      expect(await keysOf(prisma, tenantId)).toEqual(before);
    });

    it('a virada que não grava (o banco fora do ar na partida) não para a partida, e o aviso segue por alerta', async () => {
      const tenantId = await customer(prisma);
      const down = new Proxy(prisma, {
        get(target, property) {
          if (property === 'syncState')
            return {
              createMany: () => Promise.reject(Object.assign(new Error('x'), { name: 'DatabaseDown' })),
            };
          return Reflect.get(target, property) as unknown;
        },
      });
      const warnings: object[] = [];
      const setup = caseNoticeSetup('on', down, {
        warn: (fields) => void warnings.push(fields),
        error: () => undefined,
      });
      await setup.start();
      expect(warnings).toEqual([{ error: 'DatabaseDown' }]);
      const store = new FindingStore(prisma, setup.alertNotices);
      await store.persist(draft(tenantId, { severity: 'critical' }), null, new Date());
      expect(await noticesOf(prisma, tenantId)).toHaveLength(1);
    });

    it('na partida, a virada é gravada uma vez; repetir, ou outra réplica, não muda o começo', async () => {
      const name = `virada-${randomUUID().slice(0, 8)}`;
      const first = new CaseNoticeRegime(prisma, { name });
      expect(first.active).toBe(false);
      expect(await first.activate(T0)).toEqual({ activatedAt: T0, mark: at(-HOUR_MS) });
      expect(first.active).toBe(true);
      const second = new CaseNoticeRegime(prisma, { name });
      expect((await second.activate(at(5 * DAY_MS))).activatedAt).toEqual(T0);
      expect((await first.activate(at(6 * DAY_MS))).activatedAt).toEqual(T0);
      expect(await prisma.syncState.findUniqueOrThrow({ where: { name } })).toMatchObject({
        cursorTimestamp: T0,
        cursorId: 'on',
        lastRunAt: at(6 * DAY_MS),
      });
    });

    it('na parada, uma última passagem dá caso e aviso ao que acabou de chegar: a versão anterior acha o aviso na fila', async () => {
      const tenantId = await customer(prisma);
      const person = await member(prisma, tenantId);
      const setup = caseNoticeSetup('on', prisma, silent, { tenantIds: [tenantId], drainMs: 60_000 });
      await setup.start();
      const store = new FindingStore(prisma, setup.alertNotices);
      await store.persist(
        draft(tenantId, { severity: 'critical', occurredAt: new Date().toISOString() }),
        null,
        new Date(),
      );
      expect(await noticesOf(prisma, tenantId)).toEqual([]);
      await setup.finish();
      const [row] = await casesOf(prisma, tenantId);
      expect(await keysOf(prisma, tenantId)).toEqual([caseNoticeKey(row?.id ?? '', 'critical')]);
      // A versão anterior do nó manda o que achou, como um aviso de alerta.
      const mail = new MemoryMailTransport();
      await plainDispatcher(prisma, mail, () => new Date(Date.now() + MINUTE_MS)).runOnce();
      expect(mail.to(person.email).map((message) => message.subject)).toEqual([
        'Alerta de severidade crítica no Verax Control',
      ]);
    });
  });

  describe('ligar (de off para on)', () => {
    it('cada alerta de antes, pelo que aconteceu com o aviso dele', async () => {
      const tenantId = await customer(prisma);
      const states: Record<string, Partial<Prisma.NotificationUncheckedCreateInput> | null> = {
        enviado: { ...resolved },
        falhou: { status: 'failed', attempts: 5, lastError: 'SmtpError' },
        'sem-email': { status: 'skipped', lastError: 'mail_disabled' },
        'na-fila': {},
        'no-meio': { attempts: 1, lastError: 'SmtpError', deliveredUserIds: ['alguem'] },
        tentado: { attempts: 1, lastError: 'SmtpError' },
        'no-resumo': { digestedUserIds: ['alguem'] },
        'sem-linha-antigo': null,
      };
      const ids = new Map<string, string>();
      for (const [index, [name, notice]] of Object.entries(states).entries()) {
        const createdAt = name === 'sem-linha-antigo' ? at(-HOUR_MS - 1) : at0(-1);
        const id = await insertFinding(prisma, tenantId, {
          createdAt,
          updatedAt: createdAt,
          severity: 'critical',
          ruleId: `1003${10 + index}`,
        });
        ids.set(name, id);
        if (notice !== null) await alertNotice(tenantId, id, 'critical', notice);
      }
      // Chegou dentro da folga e não tem linha (a transação que atravessou a virada): não é do passado.
      ids.set(
        'na-virada',
        await insertFinding(prisma, tenantId, {
          createdAt: at(-1_000),
          severity: 'critical',
          ruleId: '100390',
        }),
      );
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      made.clock.now = at0(1);
      expect(await made.step()).toMatchObject({ opened: 2, marked: 7, superseded: 1, lagging: 0 });
      const byRule = new Map((await casesOf(prisma, tenantId)).map((row) => [row.ruleIds[0], row]));
      const caseOf = (index: number) => byRule.get(`1003${10 + index}`)?.id ?? '';
      const waiting = Object.keys(states).indexOf('na-fila');
      const rows = await noticesOf(prisma, tenantId);
      expect(
        rows
          .filter((row) => row.caseId !== null)
          .map((row) => row.dedupeKey)
          .sort(),
      ).toEqual(
        [
          caseNoticeKey(caseOf(waiting), 'critical'),
          caseNoticeKey(byRule.get('100390')?.id ?? '', 'critical'),
        ].sort(),
      );
      const statusOf = (name: string): [NotificationStatus, string | null] | undefined => {
        const row = rows.find((candidate) => candidate.dedupeKey === `finding:${ids.get(name)}`);
        return row === undefined ? undefined : [row.status, row.lastError];
      };
      expect(statusOf('enviado')).toEqual(['sent', null]);
      expect(statusOf('falhou')).toEqual(['failed', 'SmtpError']);
      expect(statusOf('na-fila')).toEqual(['skipped', 'superseded_by_case']);
      // O que já começou a sair termina como começou.
      expect(statusOf('no-meio')).toEqual(['pending', 'SmtpError']);
      expect(statusOf('tentado')).toEqual(['pending', 'SmtpError']);
      expect(statusOf('no-resumo')).toEqual(['pending', null]);
      expect(statusOf('sem-linha-antigo')).toBeUndefined();
      expect((await casesOf(prisma, tenantId)).map((row) => row.noticedSeverity)).toEqual(
        Array.from({ length: 9 }, () => 'critical'),
      );
      expect(await made.step()).toMatchObject({ opened: 0, marked: 0, superseded: 0 });
    });

    it('um caso com alerta já avisado e alerta que ninguém avisou, vistos juntos pela primeira vez, avisa', async () => {
      const tenantId = await customer(prisma);
      const sent = await insertFinding(prisma, tenantId, {
        createdAt: at0(-5),
        updatedAt: at0(-5),
        severity: 'critical',
      });
      await alertNotice(tenantId, sent, 'critical', { ...resolved });
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      await insertFinding(prisma, tenantId, { createdAt: at0(1), severity: 'critical' });
      made.clock.now = at0(2);
      expect(await made.step()).toMatchObject({ opened: 1, marked: 0 });
    });

    it('o aviso do caso que tomou o lugar dos da fila e não chegou a ninguém: o caso que volta avisa, do passado ou não', async () => {
      const tenantId = await customer(prisma);
      const ids: string[] = [];
      for (const [ruleId, minutes] of [
        ['100310', -180],
        ['100311', -1],
      ] as const) {
        const id = await insertFinding(prisma, tenantId, {
          createdAt: at0(minutes),
          updatedAt: at0(minutes),
          severity: 'critical',
          ruleId,
        });
        await alertNotice(tenantId, id, 'critical', { createdAt: at0(minutes) });
        ids.push(id);
      }
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      expect(await made.step()).toMatchObject({ opened: 2, superseded: 2 });
      const treat = (status: 'resolved' | 'new', minutes: number) =>
        prisma.finding.updateMany({
          where: { id: { in: ids } },
          data: { status, triagedAt: at0(minutes), updatedAt: at0(minutes) },
        });
      await treat('resolved', 1);
      const rows = await noticesOf(prisma, tenantId, { caseId: { not: null } });
      expect(
        await new CaseNoticeMail(prisma).skipStale(
          at0(1),
          rows.map((row) => row.id),
        ),
      ).toEqual({ sent: 0, skipped: 2 });
      await treat('new', 2);
      made.clock.now = at0(3);
      expect(await made.check()).toMatchObject({ opened: 2, marked: 0 });
    });

    it('o alerta do passado sem linha de aviso, já marcado, tratado e desfeito, não avisa', async () => {
      const tenantId = await customer(prisma);
      const id = await insertFinding(prisma, tenantId, {
        createdAt: at0(-180),
        updatedAt: at0(-180),
        severity: 'critical',
      });
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      // Sem caso há horas, e do passado: também não avisa sozinho.
      expect(await made.check()).toMatchObject({ lagging: 0 });
      expect(await made.step()).toMatchObject({ opened: 0, marked: 1 });
      await prisma.finding.update({ where: { id }, data: { status: 'resolved', updatedAt: at0(1) } });
      await made.check();
      await prisma.finding.update({ where: { id }, data: { status: 'new', updatedAt: at0(2) } });
      // Um alerta a mais põe o caso na conferência.
      await insertFinding(prisma, tenantId, { createdAt: at0(2), severity: 'high' });
      made.clock.now = at0(3);
      expect(await made.step()).toMatchObject({ opened: 0, marked: 0 });
    });

    it('o aviso de alerta só sai da fila depois que o alerta tem caso e o caso tem aviso', async () => {
      const tenantId = await customer(prisma);
      const id = await insertFinding(prisma, tenantId, {
        createdAt: at0(-1),
        updatedAt: at0(-1),
        severity: 'critical',
      });
      const notice = await alertNotice(tenantId, id, 'critical');
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      // Sem caso: fica, e sairia como antes.
      expect(await made.check()).toMatchObject({ superseded: 0, opened: 0, lagging: 0 });
      expect((await noticesOf(prisma, tenantId))[0]).toMatchObject({ id: notice, status: 'pending' });
      // Com o caso, e o aviso dele impedido de gravar: continua na fila.
      await made.assign();
      const broken = new Proxy(prisma, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (property !== '$transaction') return value;
          return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
            target.$transaction(async (tx) => {
              const result = await work(tx);
              if (await tx.notification.count({ where: { tenantId, caseId: { not: null } } }))
                throw new Error('o processo morreu antes do fim');
              return result;
            }, options);
        },
      });
      const dying = new CaseNotices(broken, { regime: made.regime, tenantIds: [tenantId], now: () => T0 });
      expect(await dying.check(T0)).toMatchObject({ failedTenants: 1, superseded: 0 });
      expect((await noticesOf(prisma, tenantId)).map((row) => [row.id, row.status])).toEqual([
        [notice, 'pending'],
      ]);
      expect(await made.check()).toMatchObject({ opened: 1, superseded: 1 });
    });

    it('muitos avisos na fila saem em lotes, e os casos avisam um por caso', async () => {
      const tenantId = await customer(prisma);
      const findings = Array.from({ length: 120 }, (_, index) => ({
        ...findingData(tenantId, {
          createdAt: at0(-1),
          updatedAt: at0(-1),
          ruleId: `1003${10 + (index % 4)}`,
          severity: index % 3 === 0 ? 'critical' : 'high',
        }),
        id: randomUUID(),
      }));
      await prisma.finding.createMany({ data: findings });
      await prisma.notification.createMany({
        data: findings.map((finding) => ({
          tenantId,
          kind: finding.severity === 'critical' ? ('critical_finding' as const) : ('high_finding' as const),
          severity: finding.severity as 'critical',
          findingId: finding.id,
          dedupeKey: `finding:${finding.id}`,
          createdAt: at0(-1),
        })),
      });
      const made = noticeWorld(prisma, [tenantId], T0, { supersedeBatch: 25 });
      await made.activate();
      expect(await made.step()).toMatchObject({ opened: 4, superseded: 120 });
      expect(await prisma.notification.count({ where: { tenantId, status: 'pending' } })).toBe(4);
    });

    it('o alerta tratado depois do aviso, e o que entrou num incidente, não saem mais; o resto segue como estava', async () => {
      const tenantId = await customer(prisma);
      const made = noticeWorld(prisma, [tenantId], T0);
      const old = await insertIncident(prisma, tenantId, { createdAt: at0(-60) });
      const recent = await insertIncident(prisma, tenantId, { createdAt: at0(5) });
      const alert = (ruleId: string) =>
        insertFinding(prisma, tenantId, {
          createdAt: at0(-1),
          updatedAt: at0(-1),
          severity: 'critical',
          ruleId,
        });
      const ids = {
        treatedAfter: await alert('100310'),
        treatedBefore: await alert('100311'),
        recentIncident: await alert('100312'),
        oldIncident: await alert('100313'),
      };
      for (const id of Object.values(ids)) await alertNotice(tenantId, id, 'critical');
      await made.assign();
      await prisma.finding.update({
        where: { id: ids.treatedAfter },
        data: { status: 'resolved', triagedAt: at0(2) },
      });
      await prisma.finding.update({
        where: { id: ids.treatedBefore },
        data: { status: 'resolved', triagedAt: at0(-2) },
      });
      await prisma.finding.update({ where: { id: ids.recentIncident }, data: { incidentId: recent } });
      await prisma.finding.update({ where: { id: ids.oldIncident }, data: { incidentId: old } });
      made.clock.now = at0(10);
      expect(await made.check()).toMatchObject({ superseded: 2, opened: 0 });
      const state = new Map((await noticesOf(prisma, tenantId)).map((row) => [row.findingId, row]));
      expect(state.get(ids.treatedAfter)).toMatchObject({ status: 'skipped', lastError: 'case_treated' });
      expect(state.get(ids.recentIncident)).toMatchObject({
        status: 'skipped',
        lastError: 'superseded_by_incident',
      });
      // A subida de um alerta já tratado, ou já num incidente: nenhum caso avisa dela.
      expect(state.get(ids.treatedBefore)?.status).toBe('pending');
      expect(state.get(ids.oldIncident)?.status).toBe('pending');
    });

    it('vulnerabilidade: os críticos na fila dão lugar ao aviso imediato; os altos saem como antes', async () => {
      const tenantId = await customer(prisma);
      const critical = await insertVulnerability(prisma, tenantId, {
        createdAt: at0(-1),
        updatedAt: at0(-1),
      });
      const high = await insertVulnerability(prisma, tenantId, {
        createdAt: at0(-1),
        updatedAt: at0(-1),
        severity: 'high',
      });
      const sent = await insertVulnerability(prisma, tenantId, { createdAt: at0(-1), updatedAt: at0(-1) });
      await alertNotice(tenantId, critical, 'critical');
      await alertNotice(tenantId, high, 'high');
      await alertNotice(tenantId, sent, 'critical', { ...resolved });
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      expect(await made.step()).toMatchObject({ critical: 1, marked: 1, superseded: 1, opened: 0 });
      expect((await noticesOf(prisma, tenantId)).map((row) => [row.dedupeKey, row.status]).sort()).toEqual(
        [
          [criticalCasesKey(T0), 'pending'],
          [`finding:${critical}`, 'skipped'],
          [`finding:${high}`, 'pending'],
          [`finding:${sent}`, 'sent'],
        ].sort(),
      );
    });

    it('vulnerabilidade: no mesmo caso, só o aviso do crítico sai da fila; e um de depois do aviso imediato fica', async () => {
      const tenantId = await customer(prisma);
      const resource = 'arn:aws:ec2:sa-east-1:111122223333:instance/i-0000000000000000d';
      const alert = (severity: 'critical' | 'high', minutes: number) =>
        insertVulnerability(prisma, tenantId, {
          resource,
          severity,
          createdAt: at0(minutes),
          updatedAt: at0(minutes),
        });
      const [critical, high] = [await alert('critical', -1), await alert('high', -1)];
      await alertNotice(tenantId, critical, 'critical');
      await alertNotice(tenantId, high, 'high');
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      expect(await made.step()).toMatchObject({ critical: 1, superseded: 1 });
      const state = async (id: string) =>
        (await noticesOf(prisma, tenantId, { findingId: id, caseId: null })).find(
          (row) => row.dedupeKey === `finding:${id}`,
        )?.status;
      expect([await state(critical), await state(high)]).toEqual(['skipped', 'pending']);
      // Uma subida antes de o alerta ter caso (aviso por alerta), no caso já avisado: o aviso imediato é de antes dela.
      const late = await alert('critical', 5);
      await alertNotice(tenantId, late, 'critical', { createdAt: at0(5) });
      made.clock.now = at0(6);
      expect(await made.step()).toMatchObject({ critical: 0, superseded: 0 });
      expect(await state(late)).toBe('pending');
    });

    it('vulnerabilidade: o aviso imediato que não incluiu o caso não tira da fila o aviso do alerta dele', async () => {
      const tenantId = await customer(prisma);
      const late = await insertVulnerability(prisma, tenantId, { createdAt: at0(-1), updatedAt: at0(-1) });
      await alertNotice(tenantId, late, 'critical');
      // Sem caso ainda (a atribuição o pulou), enquanto o aviso imediato sai por outro.
      await prisma.finding.update({ where: { id: late }, data: { status: 'resolved' } });
      await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      expect(await made.step()).toMatchObject({ critical: 1, superseded: 0 });
      await prisma.finding.update({ where: { id: late }, data: { status: 'new' } });
      made.clock.now = at0(5);
      expect(await made.step()).toMatchObject({ critical: 0, superseded: 0 });
      expect(
        (await noticesOf(prisma, tenantId)).find((row) => row.dedupeKey === `finding:${late}`)?.status,
      ).toBe('pending');
    });

    it('réplicas ao mesmo tempo na virada: um aviso por caso', async () => {
      const tenantId = await customer(prisma);
      for (let i = 0; i < 20; i += 1) {
        const id = await insertFinding(prisma, tenantId, {
          createdAt: at0(-1),
          updatedAt: at0(-1),
          severity: 'critical',
          ruleId: `1003${10 + i}`,
        });
        await alertNotice(tenantId, id, 'critical');
      }
      const first = noticeWorld(prisma, [tenantId], T0);
      await first.activate();
      await first.assign();
      const { regime } = first;
      const replicas = Array.from({ length: 4 }, () =>
        noticeWorld(prisma, [tenantId], T0, { page: 5, regime }),
      );
      const reports = await Promise.all(replicas.map((replica) => replica.check()));
      expect(reports.reduce((total, report) => total + report.opened, 0)).toBe(20);
      expect(await noticesOf(prisma, tenantId, { caseId: { not: null } })).toHaveLength(20);
      expect(await noticesOf(prisma, tenantId, { status: 'pending' })).toHaveLength(20);
    });

    it('vulnerabilidade: o crítico de antes da folga, ainda na fila, também dá lugar ao aviso imediato', async () => {
      const tenantId = await customer(prisma);
      const id = await insertVulnerability(prisma, tenantId, { createdAt: at0(-180), updatedAt: at0(-180) });
      await alertNotice(tenantId, id, 'critical', { createdAt: at0(-180) });
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      expect(await made.step()).toMatchObject({ critical: 1, marked: 0, superseded: 1 });
    });

    it.each([-5, -180])(
      'a severidade que subiu depois da virada, num alerta já avisado como alto, avisa o crítico (%i min)',
      async (minutes) => {
        const tenantId = await customer(prisma);
        const id = await insertFinding(prisma, tenantId, {
          createdAt: at0(minutes),
          updatedAt: at0(minutes),
        });
        await alertNotice(tenantId, id, 'high', { ...resolved });
        const made = noticeWorld(prisma, [tenantId], T0);
        await made.activate();
        expect(await made.step()).toMatchObject({ opened: 0, marked: 1 });
        made.clock.now = at0(5);
        await prisma.finding.update({ where: { id }, data: { severity: 'critical', updatedAt: at0(5) } });
        expect(await made.check()).toMatchObject({ opened: 1 });
        // E a que já tinha subido antes, sem outro aviso (como sempre), é do passado.
        const risen = await insertFinding(prisma, tenantId, {
          createdAt: at(-3 * HOUR_MS),
          updatedAt: at(-2 * HOUR_MS),
          severity: 'critical',
          ruleId: '100399',
        });
        await alertNotice(tenantId, risen, 'high', { ...resolved });
        expect(await made.step()).toMatchObject({ opened: 0, marked: 1 });
      },
    );

    it('o alerta médio de antes que sobe na origem antes de ter caso, sem linha nenhuma, não se perde', async () => {
      const tenantId = await customer(prisma);
      await insertFinding(prisma, tenantId, {
        createdAt: at(-2 * HOUR_MS),
        updatedAt: at0(3),
        severity: 'critical',
      });
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      made.clock.now = at0(5);
      expect(await made.step()).toMatchObject({ opened: 1, marked: 0 });
    });
  });

  describe('ligar (de shadow para on)', () => {
    it('os casos da medição já estão marcados; o que está na fila vira um aviso por caso; o que chega depois segue a regra', async () => {
      const tenantId = await customer(prisma);
      const alert = async (
        ruleId: string,
        minutes: number,
        notice: Partial<Prisma.NotificationUncheckedCreateInput> | null,
      ) => {
        const id = await insertFinding(prisma, tenantId, {
          createdAt: at0(minutes),
          updatedAt: at0(minutes),
          severity: 'critical',
          ruleId,
        });
        if (notice !== null)
          await alertNotice(tenantId, id, 'critical', { createdAt: at0(minutes), ...notice });
        return id;
      };
      // Um caso com tudo enviado; outro com um enviado e dois na fila.
      const treated = await alert('100310', -90, { ...resolved });
      await alert('100311', -90, { ...resolved });
      await alert('100311', -2, {});
      await alert('100311', -1, {});
      await assignAsShadow([tenantId], T0);
      expect((await casesOf(prisma, tenantId)).map((row) => row.noticedSeverity)).toEqual([
        'critical',
        'critical',
      ]);
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      made.clock.now = at0(1);
      expect(await made.check()).toMatchObject({ opened: 1, marked: 0, superseded: 2 });
      const [first, second] = await casesOf(prisma, tenantId);
      const withWaiting = [first, second].find((row) => row?.ruleIds.includes('100311'));
      expect(
        (await noticesOf(prisma, tenantId, { caseId: { not: null } })).map((row) => row.dedupeKey),
      ).toEqual([caseNoticeKey(withWaiting?.id ?? '', 'critical')]);
      expect(await made.check()).toMatchObject({ opened: 0, superseded: 0 });
      // Mais um crítico no caso avisado na medição: já avisado, pendente. Não avisa.
      made.clock.now = at0(10);
      await alert('100310', 10, null);
      expect(await made.step()).toMatchObject({ opened: 0 });
      // Tratado o que foi avisado na medição, o que chegou depois é onda.
      await prisma.finding.update({
        where: { id: treated },
        data: { status: 'resolved', triagedAt: at0(11) },
      });
      made.clock.now = at0(12);
      expect(await made.check()).toMatchObject({ opened: 1 });
    });

    it('um caso da medição inteiro desfeito (volta a pendente) não avisa de novo', async () => {
      const tenantId = await customer(prisma);
      const id = await insertFinding(prisma, tenantId, {
        createdAt: at(-3 * HOUR_MS),
        updatedAt: at(-3 * HOUR_MS),
        severity: 'critical',
      });
      await alertNotice(tenantId, id, 'critical', { ...resolved, createdAt: at(-3 * HOUR_MS) });
      await assignAsShadow([tenantId], T0);
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      await prisma.finding.update({ where: { id }, data: { status: 'resolved', triagedAt: at0(1) } });
      await made.check();
      await prisma.finding.update({ where: { id }, data: { status: 'new' } });
      made.clock.now = at0(5);
      expect(await made.check()).toMatchObject({ opened: 0, marked: 0 });
    });

    it('a subida na medição já avisou alerta por alerta: marca; a que está na fila vira o aviso do caso', async () => {
      const tenantId = await customer(prisma);
      const rise = async (ruleId: string, notice: Partial<Prisma.NotificationUncheckedCreateInput>) => {
        const id = await insertFinding(prisma, tenantId, {
          createdAt: at(-3 * HOUR_MS),
          updatedAt: at(-3 * HOUR_MS),
          severity: 'medium',
          ruleId,
        });
        return { id, notice };
      };
      const rows = [await rise('100310', { ...resolved }), await rise('100311', {})];
      await assignAsShadow([tenantId], T0);
      for (const { id, notice } of rows) {
        await prisma.finding.update({ where: { id }, data: { severity: 'critical', updatedAt: at0(-5) } });
        await alertNotice(tenantId, id, 'critical', { createdAt: at0(-5), ...notice });
      }
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.activate();
      expect(await made.check()).toMatchObject({ opened: 1, marked: 1, superseded: 1 });
    });
  });

  describe('voltar (de on para off ou shadow) e ligar de novo', () => {
    const REGIME = CASE_NOTICES_STATE;
    const on = (tenantIds: readonly string[], start: Date) =>
      noticeWorld(prisma, tenantIds, start, { name: REGIME });
    const handBack = (tenantIds: readonly string[], now: Date) =>
      new CaseNotices(prisma, { tenantIds, name: REGIME, now: () => now, workMs: 10 * MINUTE_MS }).handBack(
        now,
      );

    it('no nó que nunca ligou, nada acontece e nada é gravado', async () => {
      const tenantId = await customer(prisma);
      await insertFinding(prisma, tenantId, { createdAt: at0(-30), severity: 'critical' });
      expect(await handBack([tenantId], T0)).toBeNull();
      expect(await prisma.syncState.findMany({})).toEqual([]);
      expect(await noticesOf(prisma, tenantId)).toEqual([]);
    });

    it('o alerta sem caso avisa alerta por alerta; o caso ainda não avisado, uma vez; o já avisado, nada; e só uma vez', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-DAY_MS));
      await made.activate();
      made.clock.now = T0;
      const alert = (ruleId: string, severity: 'critical' | 'high' | 'medium' = 'critical', minutes = 0) =>
        insertFinding(prisma, tenantId, { createdAt: at0(minutes), ruleId, severity });
      await alert('100310');
      await made.step();
      await markSent(prisma, tenantId, T0);
      // O worker morreu: um caso sem aviso e alertas sem caso (um deles médio).
      await alert('100311');
      await alert('100311');
      await made.assign();
      const loose = [await alert('100312'), await alert('100313', 'high')];
      // O alto de vulnerabilidade sem caso também: com o aviso por alerta, ele avisa.
      loose.push(await insertVulnerability(prisma, tenantId, { createdAt: T0, severity: 'high' }));
      await alert('100314', 'medium');
      // Uma vulnerabilidade crítica com caso, e uma alta.
      const vulnerability = await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      await insertVulnerability(prisma, tenantId, { createdAt: T0, severity: 'high' });
      await prisma.finding.updateMany({ where: { id: { in: loose } }, data: { status: 'resolved' } });
      await made.assign();
      await prisma.finding.updateMany({ where: { id: { in: loose } }, data: { status: 'new' } });

      const now = at0(3);
      expect(await handBack([tenantId], now)).toEqual({
        handedBack: { alerts: 4, cases: 1 },
        failedTenants: 0,
        unfinishedTenants: 0,
      });
      const pending = await noticesOf(prisma, tenantId, { status: 'pending' });
      const unnoticed = (await casesOf(prisma, tenantId)).find((row) => row.ruleIds.includes('100311'));
      expect(pending.map((row) => row.dedupeKey).sort()).toEqual(
        [
          caseNoticeKey(unnoticed?.id ?? '', 'critical'),
          ...loose.map((id) => `finding:${id}`),
          `finding:${vulnerability}`,
        ].sort(),
      );
      expect((await prisma.syncState.findUniqueOrThrow({ where: { name: REGIME } })).cursorId).toBe('off');
      // Devolvido: nada mais, nem com alerta novo (o aviso por alerta é de quem grava).
      await alert('100320');
      expect(await handBack([tenantId], at0(4))).toBeNull();
      expect(await noticesOf(prisma, tenantId, { status: 'pending' })).toHaveLength(pending.length);
    });

    it('o alerta cujo aviso já está na fila (a atribuição atrasada) não ganha outro na devolução', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-DAY_MS));
      await made.activate();
      const id = await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'critical' });
      const vulnerability = await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      made.clock.now = at0(11);
      expect(await made.check()).toMatchObject({ lagging: 2 });
      await made.assign();
      expect(await handBack([tenantId], at0(12))).toMatchObject({ handedBack: { alerts: 0, cases: 0 } });
      expect((await keysOf(prisma, tenantId)).sort()).toEqual(
        [`finding:${id}`, `finding:${vulnerability}`].sort(),
      );
    });

    it.each(['off', 'shadow'] as const)(
      '%s: o agregado que estava na fila sai com todos os casos; o de um caso, como o do alerta dele',
      async (mode) => {
        const tenantId = await customer(prisma);
        const person = await member(prisma, tenantId);
        const made = on([tenantId], at(-DAY_MS));
        await made.activate();
        made.clock.now = T0;
        const packages = ['openssl', 'curl', 'zlib'];
        for (const caseGroup of packages)
          await insertVulnerability(prisma, tenantId, {
            caseGroup,
            createdAt: T0,
            title: `CVE-2026-0001 - ${caseGroup}`,
          });
        const alert = await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'high' });
        expect(await made.step()).toMatchObject({ critical: 1, opened: 1 });
        const mail = new MemoryMailTransport();
        const setup = caseNoticeSetup(mode, prisma, silent);
        const { caseMail } = setup.dispatcher;
        await plainDispatcher(prisma, mail, () => at0(1), { caseMail: caseMail ?? null }).runOnce();
        const texts = mail.to(person.email).map((message) => message.text);
        expect(texts).toHaveLength(2);
        const aggregate = texts.find((text) => text.includes('visao=vulnerabilidades')) ?? '';
        expect(aggregate).toMatch(/3 casos/);
        expect(aggregate.split('?caso=')).toHaveLength(packages.length + 1);
        // Sem a tela dos casos, o aviso do caso leva ao alerta.
        expect(texts.filter((text) => text.includes(`?alerta=${alert}`))).toHaveLength(1);
      },
    );

    it('o caso já avisado que cresceu não avisa na devolução', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-DAY_MS));
      await made.activate();
      made.clock.now = T0;
      await insertFinding(prisma, tenantId, { createdAt: T0, mitreTactics: ['Persistence'] });
      await made.step();
      made.clock.now = at0(5);
      await insertFinding(prisma, tenantId, { createdAt: at0(5), mitreTactics: ['Impact'] });
      await made.assign();
      expect(await handBack([tenantId], at0(6))).toMatchObject({ handedBack: { alerts: 0, cases: 0 } });
      expect(await keysOf(prisma, tenantId)).toHaveLength(1);
    });

    it('o que o aviso imediato já cobriu não volta alerta por alerta, e um aviso que já existe não prende a devolução', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-DAY_MS));
      await made.activate();
      made.clock.now = T0;
      for (let i = 0; i < 3; i += 1) await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      expect(await made.step()).toMatchObject({ critical: 1 });
      // Um crítico já avisado como alto, que subiu: a chave do aviso por alerta já está usada.
      const risen = await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      await alertNotice(tenantId, risen, 'high', { ...resolved });
      made.clock.now = at0(1);
      await made.assign();
      const oneByOne = new CaseNotices(prisma, {
        tenantIds: [tenantId],
        name: REGIME,
        now: () => at0(2),
        batch: 1,
      });
      expect(await oneByOne.handBack(at0(2))).toEqual({
        handedBack: { alerts: 0, cases: 0 },
        failedTenants: 0,
        unfinishedTenants: 0,
      });
      expect(await handBack([tenantId], at0(3))).toBeNull();
    });

    it('a devolução em lotes, e a que não coube no tempo continua na execução seguinte', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-DAY_MS));
      await made.activate();
      await prisma.finding.createMany({
        data: Array.from({ length: 55 }, () =>
          findingData(tenantId, { createdAt: T0, severity: 'critical' }),
        ),
      });
      let time = 0;
      const slow = new CaseNotices(prisma, {
        tenantIds: [tenantId],
        name: REGIME,
        now: () => at0(1),
        batch: 10,
        workMs: 25,
        elapsed: () => (time += 10),
      });
      const first = await slow.handBack(at0(1));
      expect(first).toMatchObject({ unfinishedTenants: 1 });
      expect((await prisma.syncState.findUniqueOrThrow({ where: { name: REGIME } })).cursorId).toBe('on');
      expect(await handBack([tenantId], at0(2))).toMatchObject({ unfinishedTenants: 0 });
      expect(await noticesOf(prisma, tenantId)).toHaveLength(55);
      expect(await handBack([tenantId], at0(3))).toBeNull();
    });

    it('on para shadow: a atribuição da medição roda antes da devolução, e o alerta no meio não se perde', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-DAY_MS));
      await made.activate();
      await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'critical' });
      // O shadow marca o caso como avisado, como sempre faz; o alerta é de quando o aviso era do caso.
      await assignAsShadow([tenantId], at0(1));
      const [row] = await casesOf(prisma, tenantId);
      expect(row?.noticedSeverity).toBe('critical');
      expect(await handBack([tenantId], at0(2))).toMatchObject({ handedBack: { alerts: 0, cases: 1 } });
      expect(await keysOf(prisma, tenantId)).toEqual([caseNoticeKey(row?.id ?? '', 'critical')]);
    });

    it('a versão anterior no meio: o que ficou calado avisa quando os casos voltam, e o que ela avisou não repete', async () => {
      const tenantId = await customer(prisma);
      const person = await member(prisma, tenantId);
      const mail = new MemoryMailTransport();
      const start = new Date(Date.now() - 5 * MINUTE_MS);
      const made = on([tenantId], start);
      await made.activate();
      // Morto com um crítico sem caso e sem aviso.
      await insertFinding(prisma, tenantId, {
        createdAt: new Date(start.getTime() + MINUTE_MS),
        severity: 'critical',
        ruleId: '100310',
      });
      // A versão anterior: grava e avisa alerta por alerta, sem saber dos casos.
      const store = new FindingStore(prisma);
      await store.persist(
        draft(tenantId, { severity: 'critical', ruleId: '100311', occurredAt: new Date().toISOString() }),
        null,
        new Date(),
      );
      await plainDispatcher(prisma, mail, () => new Date(Date.now() + MINUTE_MS)).runOnce();
      expect(mail.to(person.email)).toHaveLength(1);
      // De volta.
      made.clock.now = new Date(Date.now() + 2 * MINUTE_MS);
      await made.activate();
      expect(await made.step()).toMatchObject({ opened: 1, marked: 1, superseded: 0 });
      const silentCase = (await casesOf(prisma, tenantId)).find((row) => row.ruleIds.includes('100310'));
      expect(
        (await noticesOf(prisma, tenantId, { caseId: { not: null } })).map((row) => row.dedupeKey),
      ).toEqual([caseNoticeKey(silentCase?.id ?? '', 'critical')]);
    });

    it('a versão anterior em shadow marca o caso do alerta calado: de volta, ele avisa', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-DAY_MS));
      await made.activate();
      await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'critical' });
      await assignAsShadow([tenantId], at0(1));
      made.clock.now = at0(30);
      await made.activate();
      expect(await made.check()).toMatchObject({ opened: 1 });
    });

    it('ligar de novo depois da devolução: o começo é o de antes, o avisado em off não repete, e o novo avisa', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-10 * DAY_MS));
      await made.activate();
      expect(await handBack([tenantId], at(-5 * DAY_MS))).toMatchObject({
        handedBack: { alerts: 0, cases: 0 },
      });
      const off = await insertFinding(prisma, tenantId, {
        createdAt: at(-4 * DAY_MS),
        severity: 'critical',
        ruleId: '100310',
      });
      await alertNotice(tenantId, off, 'critical', { ...resolved, createdAt: at(-4 * DAY_MS) });
      made.clock.now = T0;
      await made.activate();
      const state = await prisma.syncState.findUniqueOrThrow({ where: { name: REGIME } });
      expect(state).toMatchObject({ cursorId: 'on', cursorTimestamp: at(-10 * DAY_MS) });
      await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'critical', ruleId: '100311' });
      expect(await made.step()).toMatchObject({ opened: 1, marked: 1 });
    });

    it('uma réplica ainda em on ao lado de uma em off: nada se perde nem se repete', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-DAY_MS));
      await made.activate();
      const alert = (ruleId: string, minutes: number) =>
        insertFinding(prisma, tenantId, { createdAt: at0(minutes), severity: 'critical', ruleId });
      const first = await alert('100310', 0);
      // A réplica em off devolve o que está solto; a em on volta a dizer que vale.
      expect(await handBack([tenantId], at0(1))).toMatchObject({ handedBack: { alerts: 1, cases: 0 } });
      made.clock.now = at0(2);
      expect(await made.step()).toMatchObject({ opened: 1, superseded: 1 });
      expect((await prisma.syncState.findUniqueOrThrow({ where: { name: REGIME } })).cursorId).toBe('on');
      const second = await alert('100311', 3);
      expect(await handBack([tenantId], at0(4))).toMatchObject({ handedBack: { alerts: 1, cases: 0 } });
      const rows = await noticesOf(prisma, tenantId);
      expect(rows.filter((row) => row.findingId === first && row.status === 'pending')).toHaveLength(1);
      expect(rows.filter((row) => row.findingId === second && row.status === 'pending')).toHaveLength(1);
    });

    it('a devolução de um cliente não toca no outro, e o erro de um não para os demais', async () => {
      const [a, b] = [await customer(prisma, 'Cliente Demo A'), await customer(prisma, 'Cliente Demo B')];
      const made = on([a, b], at(-DAY_MS));
      await made.activate();
      for (const tenantId of [a, b])
        await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'critical' });
      expect(await handBack([a], at0(1))).toMatchObject({ handedBack: { alerts: 1 } });
      expect(await noticesOf(prisma, a)).toHaveLength(1);
      expect(await noticesOf(prisma, b)).toEqual([]);
      await made.activate();
      const broken = new Proxy(prisma, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (property !== 'forTenant') return value;
          return (tenantId: string) => {
            if (tenantId === a) throw new Error('cliente com problema');
            return target.forTenant(tenantId);
          };
        },
      });
      await insertFinding(prisma, a, { createdAt: T0, severity: 'critical', ruleId: '100399' });
      const errors: object[] = [];
      const partial = await new CaseNotices(broken, {
        name: REGIME,
        tenantIds: [a, b],
        now: () => at0(2),
        logger: { warn: () => undefined, error: (fields) => void errors.push(fields) },
      }).handBack(at0(2));
      expect(partial).toMatchObject({ failedTenants: 1, handedBack: { alerts: 1 } });
      expect(errors).toEqual([expect.objectContaining({ tenantId: a, error: 'Error' })]);
      expect(await noticesOf(prisma, b)).toHaveLength(1);
      // Com falha, a devolução não fecha: a execução seguinte tenta de novo.
      expect((await prisma.syncState.findUniqueOrThrow({ where: { name: REGIME } })).cursorId).toBe('on');
    });

    it('a onda que a devolução avisou conta como aviso quando os casos voltam', async () => {
      const tenantId = await customer(prisma);
      const made = on([tenantId], at(-DAY_MS));
      await made.activate();
      made.clock.now = T0;
      const first = await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'critical' });
      await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'high' });
      await made.step();
      await markSent(prisma, tenantId, T0);
      await prisma.finding.update({ where: { id: first }, data: { status: 'resolved', triagedAt: at0(1) } });
      await insertFinding(prisma, tenantId, { createdAt: at0(2), severity: 'critical' });
      await made.assign();
      expect(await handBack([tenantId], at0(3))).toMatchObject({ handedBack: { alerts: 0, cases: 1 } });
      const [row] = await casesOf(prisma, tenantId);
      expect(await keysOf(prisma, tenantId)).toEqual([
        caseNoticeKey(row?.id ?? '', 'critical'),
        caseWaveKey(row?.id ?? '', 'critical', at0(3)),
      ]);
      made.clock.now = at0(10);
      expect(await made.check()).toMatchObject({ opened: 0 });
    });
  });
});
