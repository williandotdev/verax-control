import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { cloudAccountSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AWS_CHECK_RETRY_WINDOW_MS,
  AWS_DAILY_CHECK_INTERVAL_MS,
  AWS_RECHECK_INTERVAL_MS,
  AwsCheck,
  awsCheckRetryDelayMs,
} from '../src/aws/aws-check.js';
import type {
  AwsCheckOutcome,
  AwsCheckTarget,
  AwsConnectionChecker,
} from '../src/aws/aws-connection-check.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const MINUTE = 60_000;
const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const bucket = (prefix: string) => `${prefix}-${randomInt(1_000_000, 9_999_999)}`;

/**
 * A conferência falsa: cada chamada anotada (com o horário do relógio do teste) e a resposta programada por conta. Sem
 * resposta, conectada e sem aviso, com as diárias concluídas quando pedidas.
 */
class FakeAwsChecker implements AwsConnectionChecker {
  readonly calls: { target: AwsCheckTarget; at: number }[] = [];
  private readonly answers = new Map<
    string,
    (target: AwsCheckTarget) => AwsCheckOutcome | Promise<AwsCheckOutcome>
  >();

  constructor(private readonly clock: () => Date) {}

  respond(
    awsAccountId: string,
    answer: AwsCheckOutcome | ((target: AwsCheckTarget) => AwsCheckOutcome | Promise<AwsCheckOutcome>),
  ) {
    this.answers.set(awsAccountId, typeof answer === 'function' ? answer : () => answer);
  }

  callsFor(awsAccountId: string) {
    return this.calls.filter((call) => call.target.accountId === awsAccountId);
  }

  async check(target: AwsCheckTarget): Promise<AwsCheckOutcome> {
    this.calls.push({ target, at: this.clock().getTime() });
    const answer = this.answers.get(target.accountId);
    if (answer !== undefined) return answer(target);
    return { ok: true, warnings: [], ...(target.daily && { daily: { warnings: [] } }) };
  }
}

describe('aws-check sem pedido: a cada 15 min, as diárias e as tentativas espaçadas (fase 2, PR-V5)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Um relógio do teste, que só anda quando o teste manda. */
  function clockAt(start: Date) {
    let now = start;
    return {
      now: () => now,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }

  /** Uma conta AWS já verificada (com `ingestFrom`), num cliente novo por teste: os testes dividem o banco. */
  async function verifiedAccount(
    tenantId: string,
    data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {},
  ) {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: accountId(),
        regions: ['sa-east-1'],
        cloudtrailBucket: bucket('trilha'),
        connection: 'connected',
        ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
        ...data,
      },
    });
  }

  const rowOf = (id: string) =>
    prisma.cloudAccount.findUniqueOrThrow({
      where: { id },
      select: { connection: true, connectionError: true, checkRequestedAt: true },
    });
  const auditOf = (id: string) =>
    prisma.auditLog.findMany({
      where: { action: 'cloud_account.aws_check', resourceId: id },
      orderBy: { occurredAt: 'asc' },
    });

  it('confere de novo a cada 15 min, sem as diárias; sem mudança, nada é gravado nem auditado', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (aws-check periódico)');
    const account = await verifiedAccount(tenant);
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    const task = new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] });

    // Numa partida nova, a conta é conferida na primeira execução, com as diárias.
    expect(await task.recheck()).toEqual({
      accounts: 1,
      checked: 1,
      daily: 1,
      changed: 0,
      retrying: 0,
      stale: 0,
    });
    clock.advance(AWS_RECHECK_INTERVAL_MS - MINUTE);
    expect((await task.recheck()).checked).toBe(0);
    clock.advance(MINUTE);
    expect((await task.recheck()).checked).toBe(1);
    expect(checker.callsFor(account.accountId).map((call) => call.target.daily)).toEqual([true, false]);
    expect(checker.calls[0]?.target).toEqual({
      cloudAccountId: account.id,
      accountId: account.accountId,
      regions: ['sa-east-1'],
      buckets: { cloudtrail: account.cloudtrailBucket, guardduty: null, waf: null },
      daily: true,
    });
    expect(await rowOf(account.id)).toEqual({
      connection: 'connected',
      connectionError: null,
      checkRequestedAt: null,
    });
    expect(await auditOf(account.id)).toEqual([]);
  });

  it('as diárias uma vez por dia: o aviso deixa a conta conectada e fica até a diária seguinte', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (diárias)');
    const account = await verifiedAccount(tenant);
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    checker.respond(account.accountId, (target) =>
      target.daily
        ? { ok: true, warnings: [], daily: { warnings: ['guardduty_export_missing', 'excess_permissions'] } }
        : { ok: true, warnings: [] },
    );
    const task = new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] });

    expect(await task.recheck()).toMatchObject({ checked: 1, daily: 1, changed: 1 });
    // O de maior prioridade vai para a conta; a conexão continua "conectada" (a coleta não para).
    expect(await rowOf(account.id)).toMatchObject({
      connection: 'connected',
      connectionError: 'guardduty_export_missing',
    });
    const [entry] = await auditOf(account.id);
    expect(entry).toMatchObject({
      actorType: 'system',
      tenantId: tenant,
      outcome: 'success',
      before: { connection: 'connected', connectionError: null },
      after: {
        connection: 'connected',
        connectionError: 'guardduty_export_missing',
        ingestFrom: '2026-11-01',
      },
    });

    // As conferências de 15 em 15 min, sem as diárias, mantêm o aviso.
    for (let round = 0; round < 4; round += 1) {
      clock.advance(AWS_RECHECK_INTERVAL_MS);
      await task.recheck();
    }
    expect(await rowOf(account.id)).toMatchObject({ connectionError: 'guardduty_export_missing' });
    expect(await auditOf(account.id)).toHaveLength(1);

    // Um dia depois, as diárias de novo: o cliente corrigiu, e o aviso sai.
    checker.respond(account.accountId, (target) =>
      target.daily ? { ok: true, warnings: [], daily: { warnings: [] } } : { ok: true, warnings: [] },
    );
    clock.advance(AWS_DAILY_CHECK_INTERVAL_MS);
    expect(await task.recheck()).toMatchObject({ checked: 1, daily: 1, changed: 1 });
    expect(await rowOf(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
    const dailyCalls = checker.callsFor(account.accountId).filter((call) => call.target.daily);
    expect(dailyCalls).toHaveLength(2);
  });

  it('numa partida nova com a diária sem resultado (falha passageira), o aviso gravado fica', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (partida nova)');
    const account = await verifiedAccount(tenant, { connectionError: 'excess_permissions' });
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    // Sem `daily` no resultado: uma das diárias não pôde ser concluída.
    checker.respond(account.accountId, { ok: true, warnings: [] });
    const task = new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] });
    expect(await task.recheck()).toMatchObject({ checked: 1, daily: 0, changed: 0 });
    expect(await rowOf(account.id)).toMatchObject({ connectionError: 'excess_permissions' });
    // E a diária é tentada de novo na volta seguinte, não só no dia seguinte.
    clock.advance(AWS_RECHECK_INTERVAL_MS);
    await task.recheck();
    expect(checker.callsFor(account.accountId).map((call) => call.target.daily)).toEqual([true, true]);
  });

  it('o STS da região desligado é um aviso de toda conferência, acima dos avisos diários', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (STS da região)');
    const account = await verifiedAccount(tenant);
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    checker.respond(account.accountId, (target) => ({
      ok: true,
      warnings: ['region_disabled'],
      ...(target.daily && { daily: { warnings: ['trail_not_logging'] } }),
    }));
    const task = new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] });
    await task.recheck();
    expect(await rowOf(account.id)).toMatchObject({
      connection: 'connected',
      connectionError: 'region_disabled',
    });
    // Religado o STS da região, o aviso diário aparece.
    checker.respond(account.accountId, { ok: true, warnings: [] });
    clock.advance(AWS_RECHECK_INTERVAL_MS);
    await task.recheck();
    expect(await rowOf(account.id)).toMatchObject({
      connection: 'connected',
      connectionError: 'trail_not_logging',
    });
  });

  it('erro sem volta numa conta conectada: gravado na hora, com a fonte do bucket; corrigido, volta a conectada', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (erro de bucket)');
    const account = await verifiedAccount(tenant);
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    checker.respond(account.accountId, {
      ok: false,
      code: 'bucket_denied',
      retryable: false,
      source: 'cloudtrail',
    });
    const task = new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] });

    expect(await task.recheck()).toMatchObject({ checked: 1, changed: 1, failures: { bucket_denied: 1 } });
    expect(await rowOf(account.id)).toMatchObject({
      connection: 'error',
      connectionError: 'bucket_denied:cloudtrail',
    });
    // A conta com erro continua sendo conferida a cada 15 min; o mesmo erro não grava de novo.
    clock.advance(AWS_RECHECK_INTERVAL_MS);
    expect(await task.recheck()).toMatchObject({ checked: 1, changed: 0 });
    checker.respond(account.accountId, { ok: true, warnings: [] });
    clock.advance(AWS_RECHECK_INTERVAL_MS);
    expect(await task.recheck()).toMatchObject({ checked: 1, changed: 1 });
    expect(await rowOf(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
    expect((await auditOf(account.id)).map((entry) => entry.after)).toEqual([
      { connection: 'error', connectionError: 'bucket_denied:cloudtrail', ingestFrom: '2026-11-01' },
      { connection: 'connected', connectionError: null, ingestFrom: '2026-11-01' },
    ]);
  });

  it('erro que pode passar numa conta conectada: tentativas espaçadas por 10 min antes de virar erro', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (tropeço da AWS)');
    const account = await verifiedAccount(tenant);
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    checker.respond(account.accountId, { ok: false, code: 'aws_unavailable', retryable: true });
    const task = new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] });

    // A tarefa roda a cada 30 s; a conta só é conferida quando a próxima tentativa chega.
    const start = clock.now().getTime();
    while (clock.now().getTime() - start <= AWS_CHECK_RETRY_WINDOW_MS + 4 * MINUTE) {
      await task.recheck();
      clock.advance(30_000);
    }
    const attempts = checker.callsFor(account.accountId).map((call) => (call.at - start) / 1000);
    // 0 s, 30 s, 1 min 30, 3 min 30, 7 min 30 e 11 min 30: a última passa da janela e grava o erro.
    expect(attempts).toEqual([0, 30, 90, 210, 450, 690]);
    expect(await rowOf(account.id)).toMatchObject({
      connection: 'error',
      connectionError: 'aws_unavailable',
    });
    expect(await auditOf(account.id)).toHaveLength(1);

    // Já com erro, a próxima conferência é a dos 15 min, e o tropeço que passou devolve a conta.
    checker.respond(account.accountId, { ok: true, warnings: [] });
    clock.advance(AWS_RECHECK_INTERVAL_MS);
    await task.recheck();
    expect(await rowOf(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
  });

  it('o tropeço que passa dentro da janela não pisca o painel: nada é gravado', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (tropeço curto)');
    const account = await verifiedAccount(tenant);
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    checker.respond(account.accountId, { ok: false, code: 'idp_unavailable', retryable: true });
    const task = new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] });
    expect(await task.recheck()).toMatchObject({ checked: 1, retrying: 1, changed: 0 });
    checker.respond(account.accountId, { ok: true, warnings: [] });
    clock.advance(awsCheckRetryDelayMs(1));
    expect(await task.recheck()).toMatchObject({ checked: 1, retrying: 0, changed: 0 });
    expect(await rowOf(account.id)).toMatchObject({ connection: 'connected', connectionError: null });
    expect(await auditOf(account.id)).toEqual([]);
  });

  it('o "Verificar" com erro que pode passar: no máximo 6 tentativas na janela, espaçadas (eram até 20)', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (pedido espaçado)');
    const account = await verifiedAccount(tenant, {
      connection: 'waiting',
      ingestFrom: null,
      checkRequestedAt: new Date('2026-11-05T10:00:00.000Z'),
    });
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    checker.respond(account.accountId, { ok: false, code: 'trust_denied', retryable: true });
    const task = new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] });
    for (let tick = 0; tick <= 24; tick += 1) {
      await task.runOnce();
      await task.recheck();
      clock.advance(30_000);
    }
    expect(checker.callsFor(account.accountId)).toHaveLength(6);
    expect(checker.callsFor(account.accountId).every((call) => call.target.daily)).toBe(true);
    expect(await rowOf(account.id)).toEqual({
      connection: 'error',
      connectionError: 'trust_denied',
      checkRequestedAt: null,
    });
  });

  it('só as contas AWS ativas, já verificadas, sem pedido e conectadas ou com erro entram na conferência periódica', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (quem entra)');
    const included = [
      await verifiedAccount(tenant),
      await verifiedAccount(tenant, { connection: 'error', connectionError: 'trust_denied' }),
    ];
    const excluded = [
      // Nunca verificada: espera o "Verificar".
      await verifiedAccount(tenant, { connection: 'waiting', ingestFrom: null }),
      // Reativada (a conexão recomeçou em "aguardando"): também espera o "Verificar".
      await verifiedAccount(tenant, { connection: 'waiting' }),
      await verifiedAccount(tenant, { status: 'inactive' }),
      await verifiedAccount(tenant, {
        checkRequestedAt: new Date('2026-11-05T09:59:00.000Z'),
        connection: 'waiting',
      }),
      await prisma.cloudAccount.create({
        data: {
          tenantId: tenant,
          provider: 'gcp',
          accountId: `projeto-${randomInt(100_000, 999_999)}`,
          connection: 'connected',
        },
      }),
    ];
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    const report = await new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] }).recheck();
    expect(report).toMatchObject({ accounts: 2, checked: 2 });
    expect(checker.calls.map((call) => call.target.cloudAccountId).sort()).toEqual(
      included.map((account) => account.id).sort(),
    );
    for (const account of excluded)
      expect(checker.calls.map((call) => call.target.cloudAccountId)).not.toContain(account.id);
  });

  it('a conta que muda durante a conferência (pedido novo) fica como está: o resultado é descartado', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (corrida)');
    const account = await verifiedAccount(tenant);
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    const task = new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenant] });
    checker.respond(account.accountId, async () => {
      // O administrador clica em "Verificar" enquanto a conferência periódica fala com a AWS.
      await prisma.cloudAccount.update({
        where: { id: account.id },
        data: { connection: 'waiting', connectionError: null, checkRequestedAt: new Date() },
      });
      return { ok: false, code: 'bucket_missing', retryable: false, source: 'cloudtrail' };
    });
    expect(await task.recheck()).toMatchObject({ checked: 1, stale: 1, changed: 0 });
    expect(await rowOf(account.id)).toMatchObject({ connection: 'waiting', connectionError: null });
    expect(await auditOf(account.id)).toEqual([]);
  });

  it('A/B: cada resultado na conta e na trilha do próprio cliente; o aviso aparece na API só para o dono', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (A/B periódico)');
    const tenantB = await createTenant(app, 'Cliente Demo B (A/B periódico)');
    const ofA = await verifiedAccount(tenantA);
    const ofB = await verifiedAccount(tenantB);
    const clock = clockAt(new Date('2026-11-05T10:00:00.000Z'));
    const checker = new FakeAwsChecker(clock.now);
    checker.respond(ofA.accountId, (target) => ({
      ok: true,
      warnings: [],
      ...(target.daily && { daily: { warnings: ['excess_permissions'] } }),
    }));
    checker.respond(ofB.accountId, { ok: false, code: 'kms_denied', retryable: false, source: 'cloudtrail' });
    await new AwsCheck(prisma, checker, { now: clock.now, tenantIds: [tenantA, tenantB] }).recheck();

    expect(await rowOf(ofA.id)).toMatchObject({
      connection: 'connected',
      connectionError: 'excess_permissions',
    });
    expect(await rowOf(ofB.id)).toMatchObject({
      connection: 'error',
      connectionError: 'kms_denied:cloudtrail',
    });
    const entries = await prisma.auditLog.findMany({
      where: { action: 'cloud_account.aws_check', resourceId: { in: [ofA.id, ofB.id] } },
      select: { resourceId: true, tenantId: true },
    });
    expect(entries.map((entry) => [entry.resourceId, entry.tenantId]).sort()).toEqual(
      [
        [ofA.id, tenantA],
        [ofB.id, tenantB],
      ].sort(),
    );

    const adminA = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenantA });
    const read = await request(app.getHttpServer())
      .get(`/v1/cloud-accounts/${ofA.id}`)
      .set('Cookie', adminA.cookie)
      .expect(200);
    // A conta conectada com aviso: a API devolve o código (o painel mostra o que conferir).
    expect(cloudAccountSchema.parse(read.body)).toMatchObject({
      connection: 'connected',
      connectionError: 'excess_permissions',
    });
    await request(app.getHttpServer())
      .get(`/v1/cloud-accounts/${ofB.id}`)
      .set('Cookie', adminA.cookie)
      .expect(404);
    const list = await request(app.getHttpServer())
      .get('/v1/cloud-accounts?pageSize=100')
      .set('Cookie', adminA.cookie)
      .expect(200);
    expect(list.text).not.toContain(ofB.id);
    expect(list.text).not.toContain('kms_denied');
  });

  it('um código que não é aviso nunca aparece numa conta conectada', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (só avisos)');
    const account = await verifiedAccount(tenant, { connectionError: 'trust_denied' });
    const admin = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenant });
    const read = await request(app.getHttpServer())
      .get(`/v1/cloud-accounts/${account.id}`)
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(read.body).toMatchObject({ connection: 'connected', connectionError: null });
  });
});
