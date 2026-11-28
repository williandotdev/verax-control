import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AWS_CONNECT_WINDOW_MS, awsOnboardingSchema, cloudAccountSchema, type Role } from '@verax/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AWS_CHECK_RETRY_WINDOW_MS,
  AwsCheck,
  awsConnectRetryDelayMs,
  ingestDayFor,
} from '../src/aws/aws-check.js';
import {
  type AwsCheckOutcome,
  type AwsCheckTarget,
  type AwsConnectionChecker,
  type AwsReaderFacts,
  UnavailableAwsConnectionChecker,
} from '../src/aws/aws-connection-check.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

// Valores fictícios: ID de conta de serviço inventado, IP de documentação (RFC 5737) e um audience de exemplo.
const SERVICE_ACCOUNT = '123456789012345678901';
const EGRESS = '203.0.113.10/32';
const AUDIENCE = 'https://aws.verax.example/reader';
const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const bucket = (prefix = 'trilha') => `${prefix}-${randomInt(1_000_000, 9_999_999)}`;
const MINUTE = 60_000;

/** A conferência falsa: uma resposta (ou exceção) por conta AWS, e cada chamada anotada. Sem resposta, conectada. */
class FakeAwsChecker implements AwsConnectionChecker {
  readonly calls: AwsCheckTarget[] = [];
  private readonly answers = new Map<string, (target: AwsCheckTarget) => Promise<AwsCheckOutcome>>();

  respond(
    awsAccountId: string,
    answer: AwsCheckOutcome | ((target: AwsCheckTarget) => Promise<AwsCheckOutcome>),
  ) {
    this.answers.set(awsAccountId, typeof answer === 'function' ? answer : () => Promise.resolve(answer));
  }

  callsFor(awsAccountId: string): AwsCheckTarget[] {
    return this.calls.filter((target) => target.accountId === awsAccountId);
  }

  check(target: AwsCheckTarget): Promise<AwsCheckOutcome> {
    this.calls.push(target);
    return this.answers.get(target.accountId)?.(target) ?? Promise.resolve({ ok: true });
  }
}

/** A conferência falsa que também lê as tags do papel: a resposta por conta AWS (sem resposta, o template v2 inteiro). */
class FakeTaggedChecker extends FakeAwsChecker {
  readonly factsCalls: string[] = [];
  private readonly facts = new Map<string, AwsReaderFacts | null>();

  tag(awsAccountId: string, facts: AwsReaderFacts | null) {
    this.facts.set(awsAccountId, facts);
  }

  readerFacts(target: AwsCheckTarget): Promise<AwsReaderFacts | null> {
    this.factsCalls.push(target.accountId);
    const answer = this.facts.get(target.accountId);
    return Promise.resolve(
      answer !== undefined
        ? answer
        : { templateVersion: 3, capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'] },
    );
  }
}

describe('Conectar AWS: papel de leitura sem chave, "Verificar" e a tarefa aws-check (fase 2, PR-V3)', () => {
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
  const get = (session: TestSession, path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', session.cookie);
  const write = (session: TestSession, method: 'post' | 'patch' | 'delete', path: string) => {
    const agent = request(app.getHttpServer());
    return agent[method](path)
      .set('Cookie', session.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken);
  };
  const verify = (session: TestSession, id: string) =>
    write(session, 'post', `/v1/cloud-accounts/${id}/aws/verify`);
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  const rowOf = (id: string) =>
    prisma.cloudAccount.findUniqueOrThrow({
      where: { id },
      select: {
        connection: true,
        connectionError: true,
        checkRequestedAt: true,
        ingestFrom: true,
        meteredFrom: true,
        status: true,
      },
    });

  async function awsAccount(session: TestSession, buckets: object = {}) {
    const created = await write(session, 'post', '/v1/cloud-accounts')
      .send({ provider: 'aws', accountId: accountId(), regions: ['sa-east-1', 'us-east-1'], buckets })
      .expect(201);
    return cloudAccountSchema.parse(created.body);
  }

  /** Pede o "Verificar" e devolve o horário gravado do pedido. */
  async function requested(session: TestSession, id: string): Promise<Date> {
    await verify(session, id).expect(202);
    const { checkRequestedAt } = await rowOf(id);
    if (checkRequestedAt === null) throw new Error('o pedido não foi gravado');
    return checkRequestedAt;
  }

  beforeAll(async () => {
    app = await createApp({
      nodeEgressIps: EGRESS,
      awsReader: { serviceAccountId: SERVICE_ACCOUNT, audience: AUDIENCE },
    });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (Conectar AWS)');
    tenantB = await createTenant(app, 'Cliente Demo B (Conectar AWS)');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    sessions.set('admin_cliente', adminA);
    sessions.set('analista_cliente', await sessionFor(tenantA, 'analista_cliente'));
    sessions.set('leitura', await sessionFor(tenantA, 'leitura'));
    const verax = await sessionFor(null, 'admin_verax');
    await write(verax, 'post', '/v1/session/tenant').send({ tenantId: tenantA }).expect(200);
    sessions.set('admin_verax', verax);
  });

  // A tarefa varre os pedidos pendentes de todos os clientes: cada teste começa sem nenhum. Nenhum outro arquivo de
  // teste pede "Verificar".
  afterEach(async () => {
    await prisma.cloudAccount.updateMany({
      where: { checkRequestedAt: { not: null } },
      data: { checkRequestedAt: null },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('a conta AWS no painel', () => {
    it('mostra os três valores da pilha (o ID da conta de serviço, o audience e o IP do nó) e o papel derivado do ID', async () => {
      const account = await awsAccount(adminA, { cloudtrail: bucket() });
      expect(account).toMatchObject({
        readerRoleArn: `arn:aws:iam::${account.accountId}:role/verax/verax-control-reader`,
        nodeServiceAccountId: SERVICE_ACCOUNT,
        webIdentityAudience: AUDIENCE,
        egressIps: [EGRESS],
        connection: 'waiting',
        checkRequestedAt: null,
        ingestFrom: null,
      });
      // Quem só lê vê o mesmo: nenhum dos valores é segredo.
      const seen = await get(
        sessions.get('leitura') as TestSession,
        `/v1/cloud-accounts/${account.id}`,
      ).expect(200);
      expect(cloudAccountSchema.parse(seen.body)).toMatchObject({
        readerRoleArn: account.readerRoleArn,
        nodeServiceAccountId: SERVICE_ACCOUNT,
        webIdentityAudience: AUDIENCE,
        egressIps: [EGRESS],
      });
    });

    it('nenhum ExternalId sai em resposta nenhuma, nem o que sobrou no banco de antes da migration', async () => {
      const account = await awsAccount(adminA);
      // Um valor que tivesse escapado da limpeza da migration (a coluna fica, sem uso, para a volta de versão).
      const leftover = 'externo-de-antes-0123456789abcdefghijklmnopqrstu';
      await prisma.cloudAccount.update({ where: { id: account.id }, data: { externalId: leftover } });
      const responses = [
        await get(adminA, '/v1/cloud-accounts?pageSize=100').expect(200),
        await get(adminA, `/v1/cloud-accounts/${account.id}`).expect(200),
        await get(sessions.get('leitura') as TestSession, `/v1/cloud-accounts/${account.id}`).expect(200),
        await write(adminA, 'patch', `/v1/cloud-accounts/${account.id}`)
          .send({ regions: ['sa-east-1'] })
          .expect(200),
        await verify(adminA, account.id).expect(202),
      ];
      for (const response of responses) {
        expect(response.text).not.toContain(leftover);
        expect(response.text).not.toMatch(/externalId/i);
      }
      const trail = await prisma.auditLog.findMany({ where: { resourceId: account.id } });
      expect(JSON.stringify(trail)).not.toContain(leftover);
    });
  });

  describe('"Verificar"', () => {
    it('grava o pedido e volta a conexão para "aguardando", sem erro (202); pedir de novo não renova; auditado', async () => {
      const account = await awsAccount(adminA);
      await prisma.cloudAccount.update({
        where: { id: account.id },
        data: { connection: 'error', connectionError: 'trust_denied' },
      });
      const first = await verify(adminA, account.id).expect(202);
      const pending = cloudAccountSchema.parse(first.body);
      expect(pending).toMatchObject({ connection: 'waiting', connectionError: null });
      expect(pending.checkRequestedAt).not.toBeNull();
      expect((await rowOf(account.id)).checkRequestedAt?.toISOString()).toBe(pending.checkRequestedAt);

      // O pedido pendente vale: clicar de novo não o adia nem gera outra entrada no papel do cliente.
      const again = await verify(adminA, account.id).expect(202);
      expect(cloudAccountSchema.parse(again.body).checkRequestedAt).toBe(pending.checkRequestedAt);

      const entry = await entryOf(first);
      expect(entry).toMatchObject({
        action: 'cloud_account.aws_verify',
        outcome: 'success',
        tenantId: tenantA,
        resourceType: 'cloud_account',
        resourceId: account.id,
        before: { connection: 'error', connectionError: 'trust_denied', checkRequestedAt: null },
        after: { connection: 'waiting', connectionError: null, checkRequestedAt: pending.checkRequestedAt },
      });
    });

    it('recusa conta de outro provedor e conta inativa (400), sem gravar o pedido', async () => {
      const gcp = cloudAccountSchema.parse(
        (
          await write(adminA, 'post', '/v1/cloud-accounts')
            .send({ provider: 'gcp', accountId: `vx-${randomInt(1_000_000, 9_999_999)}-aws` })
            .expect(201)
        ).body,
      );
      expect((await verify(adminA, gcp.id).expect(400)).body).toMatchObject({
        message: 'Só uma conta AWS é verificada assim.',
      });
      const inactive = await awsAccount(adminA);
      await write(adminA, 'delete', `/v1/cloud-accounts/${inactive.id}`).expect(204);
      expect((await verify(adminA, inactive.id).expect(400)).body).toMatchObject({
        message: 'Reative o monitoramento antes de verificar a conta.',
      });
      expect((await rowOf(gcp.id)).checkRequestedAt).toBeNull();
      expect((await rowOf(inactive.id)).checkRequestedAt).toBeNull();
    });

    it('A/B: a conta de B dá 404 para A, sem tocar nela; a tentativa entra na trilha de A', async () => {
      const ofB = await awsAccount(adminB);
      const response = await verify(adminA, ofB.id).expect(404);
      expect(await rowOf(ofB.id)).toMatchObject({ connection: 'waiting', checkRequestedAt: null });
      const attempt = await entryOf(response);
      expect(attempt).toMatchObject({
        action: 'cloud_account.aws_verify',
        outcome: 'failure',
        tenantId: tenantA,
      });
      // B lê a própria conta como estava.
      expect((await get(adminB, `/v1/cloud-accounts/${ofB.id}`).expect(200)).body).toMatchObject({
        checkRequestedAt: null,
      });
      await get(adminA, `/v1/cloud-accounts/${ofB.id}`).expect(404);
    });

    it('papéis: admin_cliente e admin_verax (com o cliente selecionado) pedem; analista e leitura, 403, sem gravar', async () => {
      const expected: Record<Role, number> = {
        admin_verax: 202,
        admin_cliente: 202,
        analista_cliente: 403,
        leitura: 403,
      };
      for (const [role, status] of Object.entries(expected) as [Role, number][]) {
        const account = await awsAccount(adminA);
        await verify(sessions.get(role) as TestSession, account.id).expect(status);
        expect((await rowOf(account.id)).checkRequestedAt === null).toBe(status === 403);
      }
    });

    it('desativar a conta tira o pedido pendente; reativada, ela pede de novo', async () => {
      const account = await awsAccount(adminA);
      await requested(adminA, account.id);
      await write(adminA, 'patch', `/v1/cloud-accounts/${account.id}`)
        .send({ status: 'inactive' })
        .expect(200);
      expect(await rowOf(account.id)).toMatchObject({ checkRequestedAt: null, connection: 'waiting' });
      await write(adminA, 'patch', `/v1/cloud-accounts/${account.id}`).send({ status: 'active' }).expect(200);
      expect((await rowOf(account.id)).checkRequestedAt).toBeNull();
    });

    it('outra lista de buckets descarta o pedido pendente (era da lista antiga); a mesma lista o mantém', async () => {
      const account = await awsAccount(adminA, { cloudtrail: bucket() });
      const asked = await requested(adminA, account.id);
      await write(adminA, 'patch', `/v1/cloud-accounts/${account.id}`)
        .send({ buckets: { cloudtrail: account.buckets.cloudtrail } })
        .expect(200);
      expect((await rowOf(account.id)).checkRequestedAt).toEqual(asked);
      const changed = await write(adminA, 'patch', `/v1/cloud-accounts/${account.id}`)
        .send({ buckets: { waf: `aws-waf-logs-${randomInt(1_000_000, 9_999_999)}` } })
        .expect(200);
      expect(changed.body).toMatchObject({ connection: 'waiting', checkRequestedAt: null });
      // A tarefa não confere mais esta conta: o cliente atualiza a pilha e pede de novo.
      const checker = new FakeAwsChecker();
      await new AwsCheck(prisma, checker).runOnce();
      expect(checker.callsFor(account.accountId)).toEqual([]);
      expect(await rowOf(account.id)).toMatchObject({ connection: 'waiting', checkRequestedAt: null });
    });
  });

  describe('a tarefa aws-check do worker', () => {
    it('conectada: grava a conexão e o dia de início da coleta (uma vez só), com auditoria na trilha do cliente', async () => {
      const trail = bucket();
      const waf = `aws-waf-logs-${randomInt(1_000_000, 9_999_999)}`;
      const account = await awsAccount(adminA, { cloudtrail: trail, guardduty: trail, waf });
      const requestedAt = await requested(adminA, account.id);
      const checker = new FakeAwsChecker();
      const now = new Date(requestedAt.getTime() + MINUTE);

      const report = await new AwsCheck(prisma, checker, { now: () => now }).runOnce();
      expect(report).toEqual({ pending: 1, connected: 1, failed: 0, retrying: 0, stale: 0 });
      // A conferência recebe a conta cadastrada e o bucket de cada fonte (o pedido confere também as diárias); nada de
      // ExternalId nem de chave.
      expect(checker.callsFor(account.accountId)).toEqual([
        {
          cloudAccountId: account.id,
          accountId: account.accountId,
          regions: ['sa-east-1', 'us-east-1'],
          buckets: { cloudtrail: trail, guardduty: trail, waf },
          daily: true,
        },
      ]);
      expect(await rowOf(account.id)).toMatchObject({
        connection: 'connected',
        connectionError: null,
        checkRequestedAt: null,
        ingestFrom: ingestDayFor(now),
        // O volume medido na origem (CE-09) conta a partir do instante da primeira verificação.
        meteredFrom: now,
      });
      const read = cloudAccountSchema.parse(
        (await get(adminA, `/v1/cloud-accounts/${account.id}`).expect(200)).body,
      );
      expect(read).toMatchObject({ connection: 'connected', checkRequestedAt: null });
      expect(read.ingestFrom).toBe(ingestDayFor(now).toISOString().slice(0, 10));

      const audit = await prisma.auditLog.findMany({
        where: { action: 'cloud_account.aws_check', resourceId: account.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorType: 'system',
        tenantId: tenantA,
        outcome: 'success',
        resourceType: 'cloud_account',
        before: { connection: 'waiting', connectionError: null },
        after: { connection: 'connected', connectionError: null, ingestFrom: read.ingestFrom },
      });

      // Três dias depois, outra verificação bem-sucedida: o início da coleta não muda.
      const second = await requested(adminA, account.id);
      const later = new Date(second.getTime() + 3 * 24 * 60 * MINUTE);
      await new AwsCheck(prisma, checker, { now: () => later }).runOnce();
      expect(await rowOf(account.id)).toMatchObject({
        connection: 'connected',
        ingestFrom: ingestDayFor(now),
        meteredFrom: now,
      });
    });

    it('erro: o código vai para a conta; o que pode passar espera a janela de 10 min, e depois dela vira erro', async () => {
      const retry = await awsAccount(adminA);
      const final = await awsAccount(adminA);
      const requestedAt = await requested(adminA, retry.id);
      await requested(adminA, final.id);
      const checker = new FakeAwsChecker();
      checker.respond(retry.accountId, { ok: false, code: 'trust_denied', retryable: true });
      checker.respond(final.accountId, { ok: false, code: 'account_mismatch', retryable: false });

      const soon = new Date(requestedAt.getTime() + 2 * MINUTE);
      expect(await new AwsCheck(prisma, checker, { now: () => soon }).runOnce()).toEqual({
        pending: 2,
        connected: 0,
        failed: 1,
        retrying: 1,
        stale: 0,
        failures: { account_mismatch: 1 },
      });
      expect(await rowOf(final.id)).toMatchObject({
        connection: 'error',
        connectionError: 'account_mismatch',
        checkRequestedAt: null,
        ingestFrom: null,
      });
      // Dentro da janela, o pedido continua pendente e a conta, aguardando (o papel pode levar segundos para valer).
      expect(await rowOf(retry.id)).toMatchObject({ connection: 'waiting', checkRequestedAt: requestedAt });

      const late = new Date(requestedAt.getTime() + AWS_CHECK_RETRY_WINDOW_MS + MINUTE);
      expect(await new AwsCheck(prisma, checker, { now: () => late }).runOnce()).toMatchObject({
        pending: 1,
        failed: 1,
        failures: { trust_denied: 1 },
      });
      expect(await rowOf(retry.id)).toMatchObject({
        connection: 'error',
        connectionError: 'trust_denied',
        checkRequestedAt: null,
      });
      const read = await get(adminA, `/v1/cloud-accounts/${retry.id}`).expect(200);
      expect(read.body).toMatchObject({ connection: 'error', connectionError: 'trust_denied' });
    });

    it('uma exceção da conferência conta como erro que pode passar (check_unavailable), e não para as outras contas', async () => {
      const broken = await awsAccount(adminA);
      const fine = await awsAccount(adminA);
      const requestedAt = await requested(adminA, broken.id);
      await requested(adminA, fine.id);
      const checker = new FakeAwsChecker();
      checker.respond(broken.accountId, () => Promise.reject(new Error('falha inesperada')));
      const soon = new Date(requestedAt.getTime() + MINUTE);
      expect(await new AwsCheck(prisma, checker, { now: () => soon }).runOnce()).toMatchObject({
        connected: 1,
        retrying: 1,
      });
      expect(await rowOf(fine.id)).toMatchObject({ connection: 'connected' });
      const late = new Date(requestedAt.getTime() + AWS_CHECK_RETRY_WINDOW_MS + MINUTE);
      await new AwsCheck(prisma, checker, { now: () => late }).runOnce();
      expect(await rowOf(broken.id)).toMatchObject({
        connection: 'error',
        connectionError: 'check_unavailable',
      });
    });

    it('o resultado só vale para o pedido conferido: a conta desativada no meio fica como está, sem auditoria', async () => {
      const account = await awsAccount(adminA);
      await requested(adminA, account.id);
      const checker = new FakeAwsChecker();
      checker.respond(account.accountId, async () => {
        // Enquanto a AWS responde, um administrador desativa a conta.
        await write(adminA, 'delete', `/v1/cloud-accounts/${account.id}`).expect(204);
        return { ok: true };
      });
      expect(await new AwsCheck(prisma, checker).runOnce()).toMatchObject({
        pending: 1,
        connected: 0,
        stale: 1,
      });
      expect(await rowOf(account.id)).toMatchObject({
        status: 'inactive',
        connection: 'waiting',
        checkRequestedAt: null,
        ingestFrom: null,
      });
      expect(
        await prisma.auditLog.count({ where: { action: 'cloud_account.aws_check', resourceId: account.id } }),
      ).toBe(0);
    });

    it('A/B: cada resultado na conta e na trilha do próprio cliente; A não vê nada da conta de B', async () => {
      const ofA = await awsAccount(adminA);
      const ofB = await awsAccount(adminB);
      await requested(adminA, ofA.id);
      await requested(adminB, ofB.id);
      const checker = new FakeAwsChecker();
      checker.respond(ofB.accountId, { ok: false, code: 'bucket_denied', retryable: false });
      await new AwsCheck(prisma, checker).runOnce();

      expect(await rowOf(ofA.id)).toMatchObject({ connection: 'connected' });
      expect(await rowOf(ofB.id)).toMatchObject({ connection: 'error', connectionError: 'bucket_denied' });
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
      const listA = await get(adminA, '/v1/cloud-accounts?pageSize=100').expect(200);
      expect(listA.text).not.toContain(ofB.id);
      expect(listA.text).not.toContain(ofB.accountId);
      await get(adminA, `/v1/cloud-accounts/${ofB.id}`).expect(404);
    });

    it('sem pedido pendente, nada é conferido; o lote vai do pedido mais antigo ao mais novo', async () => {
      const checker = new FakeAwsChecker();
      expect(await new AwsCheck(prisma, checker).runOnce()).toEqual({
        pending: 0,
        connected: 0,
        failed: 0,
        retrying: 0,
        stale: 0,
      });
      expect(checker.calls).toEqual([]);
      const older = await awsAccount(adminA);
      const newer = await awsAccount(adminA);
      await requested(adminA, older.id);
      await requested(adminA, newer.id);
      await new AwsCheck(prisma, checker, { batch: 1 }).runOnce();
      expect(checker.calls.map((target) => target.accountId)).toEqual([older.accountId]);
      expect((await rowOf(newer.id)).checkRequestedAt).not.toBeNull();
    });

    it('sem o ID da conta de serviço do nó, a conferência responde check_unavailable na hora, sem tentar de novo', async () => {
      const account = await awsAccount(adminA);
      await requested(adminA, account.id);
      expect(await new AwsCheck(prisma, new UnavailableAwsConnectionChecker()).runOnce()).toMatchObject({
        failed: 1,
        failures: { check_unavailable: 1 },
      });
      expect(await rowOf(account.id)).toMatchObject({
        connection: 'error',
        connectionError: 'check_unavailable',
        checkRequestedAt: null,
        ingestFrom: null,
      });
    });

    it('o sinal do agendador interrompe a execução antes da próxima conta', async () => {
      const account = await awsAccount(adminA);
      await requested(adminA, account.id);
      const controller = new AbortController();
      controller.abort(new DOMException('o worker está parando', 'AbortError'));
      const checker = new FakeAwsChecker();
      await expect(new AwsCheck(prisma, checker).runOnce(controller.signal)).rejects.toThrow();
      expect(checker.calls).toEqual([]);
      expect((await rowOf(account.id)).checkRequestedAt).not.toBeNull();
    });
  });

  describe('"Conectar com AWS" (onboarding self-service)', () => {
    const connect = (session: TestSession, id: string) =>
      write(session, 'post', `/v1/cloud-accounts/${id}/aws/connect`);
    const onboardingOf = async (session: TestSession, id: string) =>
      awsOnboardingSchema.parse(
        (await get(session, `/v1/cloud-accounts/${id}/aws/onboarding`).expect(200)).body,
      );
    const connectRow = (id: string) =>
      prisma.cloudAccount.findUniqueOrThrow({
        where: { id },
        select: {
          connection: true,
          connectionError: true,
          checkRequestedAt: true,
          awsConnectRequestedAt: true,
          ingestFrom: true,
          awsTemplateVersion: true,
          awsCapabilities: true,
          awsCapabilitiesCheckedAt: true,
          awsChosenCapabilities: true,
        },
      });
    const runsOf = (id: string) =>
      prisma.awsDiscoveryRun.findMany({ where: { cloudAccountId: id }, orderBy: { requestedAt: 'asc' } });

    /** Clica em "Conectar" e devolve o horário gravado do pedido. */
    async function connected(session: TestSession, id: string): Promise<Date> {
      await connect(session, id).expect(202);
      const { checkRequestedAt } = await connectRow(id);
      if (checkRequestedAt === null) throw new Error('o pedido não foi gravado');
      return checkRequestedAt;
    }

    it('antes do "Conectar": não iniciada, com a entrada no papel por pedir', async () => {
      const account = await awsAccount(adminA);
      const onboarding = await onboardingOf(adminA, account.id);
      expect(onboarding).toMatchObject({
        cloudAccountId: account.id,
        state: 'not_started',
        credentialMode: 'role',
        // Nenhuma escolha gravada ainda; e este nó descobre as fontes sozinho.
        connect: { requestedAt: null, waitingUntil: null, capabilities: null },
        template: { version: null, capabilities: [], outdated: false, checkedAt: null },
        discovery: { run: null, lastCompletedAt: null, regions: [] },
        discoveryAvailable: true,
        infrastructure: null,
        sources: [],
      });
      expect(onboarding.checks[0]).toEqual({
        id: 'assume_role',
        status: 'pending',
        code: 'not_requested',
        checkedAt: null,
      });
      // Quem só lê também vê o estado.
      expect((await onboardingOf(sessions.get('leitura') as TestSession, account.id)).state).toBe(
        'not_started',
      );
    });

    it('grava o pedido do "Conectar" e o da verificação com o mesmo horário (202); pedir de novo não renova; auditado', async () => {
      const account = await awsAccount(adminA);
      const first = await connect(adminA, account.id).expect(202);
      const onboarding = awsOnboardingSchema.parse(first.body);
      const row = await connectRow(account.id);
      expect(row).toMatchObject({ connection: 'waiting', connectionError: null });
      expect(row.checkRequestedAt).not.toBeNull();
      expect(row.awsConnectRequestedAt).toEqual(row.checkRequestedAt);
      const requestedAt = row.checkRequestedAt as Date;
      // O nó espera o papel por 60 min; enquanto isso, o estado diz que a pilha ainda não foi vista.
      expect(onboarding).toMatchObject({
        state: 'awaiting_authorization',
        connect: {
          requestedAt: requestedAt.toISOString(),
          waitingUntil: new Date(requestedAt.getTime() + AWS_CONNECT_WINDOW_MS).toISOString(),
        },
      });
      expect(onboarding.checks.slice(0, 2)).toEqual([
        { id: 'assume_role', status: 'pending', code: 'awaiting_stack', checkedAt: null },
        { id: 'identity', status: 'pending', code: null, checkedAt: null },
      ]);

      // Clicar de novo não adia o fim da janela.
      const again = awsOnboardingSchema.parse((await connect(adminA, account.id).expect(202)).body);
      expect(again.connect).toEqual(onboarding.connect);
      expect((await connectRow(account.id)).checkRequestedAt).toEqual(requestedAt);

      expect(await entryOf(first)).toMatchObject({
        action: 'cloud_account.aws_connect',
        outcome: 'success',
        tenantId: tenantA,
        resourceType: 'cloud_account',
        resourceId: account.id,
        before: { connection: 'waiting', checkRequestedAt: null, awsConnectRequestedAt: null },
        after: {
          connection: 'waiting',
          connectionError: null,
          checkRequestedAt: requestedAt.toISOString(),
          awsConnectRequestedAt: requestedAt.toISOString(),
        },
      });
    });

    it('a escolha das autorizações vai no "Conectar", fica gravada e volta na leitura (a tela recarregada a devolve)', async () => {
      const account = await awsAccount(adminA);
      // Em qualquer ordem no pedido; guardada e devolvida na ordem do catálogo.
      const first = await connect(adminA, account.id)
        .send({ capabilities: ['log-groups', 'service-logs'] })
        .expect(202);
      expect(awsOnboardingSchema.parse(first.body).connect.capabilities).toEqual([
        'service-logs',
        'log-groups',
      ]);
      expect((await connectRow(account.id)).awsChosenCapabilities).toBe('service-logs log-groups');
      // Outra leitura (a tela recarregada, ou quem só lê) traz a mesma escolha, e não as três de volta.
      for (const session of [adminA, sessions.get('leitura') as TestSession]) {
        expect((await onboardingOf(session, account.id)).connect.capabilities).toEqual([
          'service-logs',
          'log-groups',
        ]);
      }
      // É só a escolha: o que o papel pode ler continua vindo das tags dele, ainda não lidas.
      expect((await connectRow(account.id)).awsCapabilities).toEqual([]);
      expect((await onboardingOf(adminA, account.id)).template.capabilities).toEqual([]);
      expect(await entryOf(first)).toMatchObject({
        action: 'cloud_account.aws_connect',
        outcome: 'success',
        before: { chosenCapabilities: null },
        after: { chosenCapabilities: ['service-logs', 'log-groups'] },
      });

      // Nenhuma das três também é uma escolha (só a descoberta), diferente de "nunca escolheu".
      const none = await awsAccount(adminA);
      const empty = await connect(adminA, none.id).send({ capabilities: [] }).expect(202);
      expect(awsOnboardingSchema.parse(empty.body).connect.capabilities).toEqual([]);
      expect((await connectRow(none.id)).awsChosenCapabilities).toBe('');
    });

    it('no pedido ainda pendente, a escolha nova é gravada sem renovar a janela; sem corpo, a escolha fica', async () => {
      const account = await awsAccount(adminA);
      const requestedAt = await (async () => {
        await connect(adminA, account.id)
          .send({ capabilities: ['findings'] })
          .expect(202);
        return (await connectRow(account.id)).checkRequestedAt as Date;
      })();
      await new Promise((resolve) => setTimeout(resolve, 5));

      // O cliente mudou as caixas enquanto esperava a pilha e baixou o arquivo de novo.
      const changed = await connect(adminA, account.id)
        .send({ capabilities: ['findings', 'service-logs'] })
        .expect(202);
      const onboarding = awsOnboardingSchema.parse(changed.body);
      expect(onboarding.connect).toEqual({
        requestedAt: requestedAt.toISOString(),
        waitingUntil: new Date(requestedAt.getTime() + AWS_CONNECT_WINDOW_MS).toISOString(),
        capabilities: ['service-logs', 'findings'],
      });
      expect(await connectRow(account.id)).toMatchObject({
        checkRequestedAt: requestedAt,
        awsConnectRequestedAt: requestedAt,
        awsChosenCapabilities: 'service-logs findings',
      });
      expect(await entryOf(changed)).toMatchObject({
        before: { checkRequestedAt: requestedAt.toISOString(), chosenCapabilities: ['findings'] },
        after: {
          checkRequestedAt: requestedAt.toISOString(),
          chosenCapabilities: ['service-logs', 'findings'],
        },
      });

      // Sem corpo (o "Conectar de novo" das conferências), com o corpo vazio ou sem o campo: a escolha fica.
      await connect(adminA, account.id).expect(202);
      await connect(adminA, account.id).send({}).expect(202);
      expect((await connectRow(account.id)).awsChosenCapabilities).toBe('service-logs findings');
      // E num "Conectar" novo (a janela fechou e o cliente tenta de novo), também.
      await prisma.cloudAccount.update({
        where: { id: account.id },
        data: { connection: 'error', connectionError: 'authorization_timeout', checkRequestedAt: null },
      });
      const again = awsOnboardingSchema.parse((await connect(adminA, account.id).expect(202)).body);
      expect(again).toMatchObject({
        state: 'awaiting_authorization',
        connect: { capabilities: ['service-logs', 'findings'] },
      });
    });

    /**
     * Dois pedidos da mesma conta com o primeiro ainda no caminho: é o cliente mudando as caixas em seguida. A linha
     * da conta fica presa por uma transação do teste; o primeiro pedido para nela, e só então o segundo sai. Solta a
     * linha, os dois terminam. Cada passo espera o pedido entrar na fila da linha (ou 2 s: sem a trava da conta, o
     * pedido que não grava nada nem entra na fila, e responde com a leitura de antes).
     */
    async function nearlyTogether(
      id: string,
      first: () => request.Test,
      second: () => request.Test,
    ): Promise<[request.Response, request.Response]> {
      let sent: [Promise<request.Response>, Promise<request.Response>] | undefined;
      await prisma.$transaction(
        async (tx) => {
          const holder = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          const pid = holder[0]?.pid ?? 0;
          await tx.$queryRaw`SELECT 1 FROM "CloudAccount" WHERE "id" = ${id}::uuid FOR UPDATE`;
          // Quantas sessões esperam por esta, direto ou atrás de outra que espera.
          const queued = async (count: number) => {
            for (let attempt = 0; attempt < 40; attempt += 1) {
              const rows = await tx.$queryRaw<{ count: number }[]>`
                WITH RECURSIVE blocked(pid) AS (
                  SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
                  UNION
                  SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
                )
                SELECT count(*)::int AS count FROM blocked`;
              if ((rows[0]?.count ?? 0) >= count) return;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          };
          const one = first().then((response) => response);
          await queued(1);
          const two = second().then((response) => response);
          await queued(2);
          sent = [one, two];
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      if (sent === undefined) throw new Error('os pedidos não saíram');
      return Promise.all(sent);
    }
    const ALL_THREE = ['service-logs', 'findings', 'log-groups'];
    const WITHOUT_GROUPS = ['service-logs', 'findings'];

    it('"Conectar": desligar e ligar de volta em seguida grava as duas escolhas, uma depois da outra, e vale a última', async () => {
      const account = await awsAccount(adminA);
      await connect(adminA, account.id).send({ capabilities: ALL_THREE }).expect(202);
      const requestedAt = (await connectRow(account.id)).checkRequestedAt as Date;

      // O primeiro pedido desliga os grupos de logs; o segundo, com o primeiro ainda no caminho, liga de volta.
      const [off, on] = await nearlyTogether(
        account.id,
        () => connect(adminA, account.id).send({ capabilities: WITHOUT_GROUPS }),
        () => connect(adminA, account.id).send({ capabilities: ALL_THREE }),
      );
      expect([off.status, on.status]).toEqual([202, 202]);
      // A resposta de cada um traz o que ficou gravado depois dele.
      expect(awsOnboardingSchema.parse(off.body).connect.capabilities).toEqual(WITHOUT_GROUPS);
      expect(awsOnboardingSchema.parse(on.body).connect.capabilities).toEqual(ALL_THREE);
      // Vale a do último pedido: a de antes dele não fica gravada por cima.
      expect(await connectRow(account.id)).toMatchObject({
        awsChosenCapabilities: 'service-logs findings log-groups',
        checkRequestedAt: requestedAt,
        awsConnectRequestedAt: requestedAt,
      });
      expect((await onboardingOf(adminA, account.id)).connect.capabilities).toEqual(ALL_THREE);
      // A trilha conta a ordem em que foram gravadas: o antes do segundo é o que o primeiro deixou.
      expect(await entryOf(off)).toMatchObject({
        before: { chosenCapabilities: ALL_THREE },
        after: { chosenCapabilities: WITHOUT_GROUPS },
      });
      expect(await entryOf(on)).toMatchObject({
        before: { chosenCapabilities: WITHOUT_GROUPS },
        after: { chosenCapabilities: ALL_THREE },
      });
    });

    it('"Verificar" com a escolha: desligar e ligar de volta em seguida também termina na última', async () => {
      const account = await awsAccount(adminA);
      await connect(adminA, account.id).send({ capabilities: ALL_THREE }).expect(202);

      const [off, on] = await nearlyTogether(
        account.id,
        () => verify(adminA, account.id).send({ capabilities: WITHOUT_GROUPS }),
        () => verify(adminA, account.id).send({ capabilities: ALL_THREE }),
      );
      expect([off.status, on.status]).toEqual([202, 202]);
      expect((await connectRow(account.id)).awsChosenCapabilities).toBe('service-logs findings log-groups');
      expect((await onboardingOf(adminA, account.id)).connect.capabilities).toEqual(ALL_THREE);
      expect(await entryOf(off)).toMatchObject({
        before: { chosenCapabilities: ALL_THREE },
        after: { chosenCapabilities: WITHOUT_GROUPS },
      });
      expect(await entryOf(on)).toMatchObject({
        before: { chosenCapabilities: WITHOUT_GROUPS },
        after: { chosenCapabilities: ALL_THREE },
      });
    });

    it('dois "Conectar" ao mesmo tempo com escolhas diferentes: fica a de um dos dois, inteira, e a mesma de novo não muda nada', async () => {
      const account = await awsAccount(adminA);
      await connect(adminA, account.id).send({ capabilities: ALL_THREE }).expect(202);
      const one = ['findings'];
      const other = ['service-logs', 'log-groups'];

      const responses = await Promise.all([
        connect(adminA, account.id)
          .send({ capabilities: one })
          .then((response) => response),
        connect(adminA, account.id)
          .send({ capabilities: other })
          .then((response) => response),
      ]);
      expect(responses.map((response) => response.status)).toEqual([202, 202]);
      // Cada resposta traz a escolha do próprio pedido: é o que estava gravado quando ele terminou.
      expect(awsOnboardingSchema.parse(responses[0].body).connect.capabilities).toEqual(one);
      expect(awsOnboardingSchema.parse(responses[1].body).connect.capabilities).toEqual(other);
      // Ficou a de um dos dois, nunca uma mistura.
      const stored = (await connectRow(account.id)).awsChosenCapabilities;
      expect(['findings', 'service-logs log-groups']).toContain(stored);
      // Um rodou depois do outro: um partiu da escolha original, e o outro, do que o primeiro deixou.
      const entries = await Promise.all(responses.map((response) => entryOf(response)));
      const befores = entries.map(
        (entry) => (entry.before as { chosenCapabilities: string[] }).chosenCapabilities,
      );
      const last = stored === 'findings' ? 0 : 1;
      expect(befores[1 - last]).toEqual(ALL_THREE);
      expect(befores[last]).toEqual(last === 0 ? other : one);

      // O mesmo pedido de novo: o valor fica, a resposta o traz, e a trilha não mostra mudança.
      const final = stored === 'findings' ? one : other;
      const again = await connect(adminA, account.id).send({ capabilities: final }).expect(202);
      expect(awsOnboardingSchema.parse(again.body).connect.capabilities).toEqual(final);
      expect((await connectRow(account.id)).awsChosenCapabilities).toBe(stored);
      const entry = await entryOf(again);
      expect(entry.before).toEqual(entry.after);
    });

    it('o corpo do "Conectar" é estrito: a descoberta, um nome de fora, a repetição e campo a mais dão 400, sem gravar', async () => {
      const account = await awsAccount(adminA);
      for (const body of [
        { capabilities: ['discovery'] },
        { capabilities: ['discovery', 'findings'] },
        { capabilities: ['findings', 'findings'] },
        { capabilities: ['resposta'] },
        { capabilities: 'findings' },
        { capabilities: null },
        { capabilities: ['findings'], templateVersion: 3 },
        { awsCapabilities: ['findings'] },
      ]) {
        await connect(adminA, account.id).send(body).expect(400);
      }
      expect(await connectRow(account.id)).toMatchObject({
        checkRequestedAt: null,
        awsConnectRequestedAt: null,
        awsChosenCapabilities: null,
      });
    });

    it('A não grava a escolha na conta de B (404), e quem não administra não a grava (403)', async () => {
      const ofB = await awsAccount(adminB);
      await connect(adminB, ofB.id)
        .send({ capabilities: ['findings'] })
        .expect(202);
      await connect(adminA, ofB.id).send({ capabilities: [] }).expect(404);
      await verify(adminA, ofB.id).send({ capabilities: [] }).expect(404);
      expect((await connectRow(ofB.id)).awsChosenCapabilities).toBe('findings');
      // A leitura de A não alcança a escolha de B.
      await get(adminA, `/v1/cloud-accounts/${ofB.id}/aws/onboarding`).expect(404);

      const account = await awsAccount(adminA);
      for (const role of ['analista_cliente', 'leitura'] as const) {
        await connect(sessions.get(role) as TestSession, account.id)
          .send({ capabilities: [] })
          .expect(403);
        await verify(sessions.get(role) as TestSession, account.id)
          .send({ capabilities: [] })
          .expect(403);
      }
      expect((await connectRow(account.id)).awsChosenCapabilities).toBeNull();
    });

    it('o "Verificar" depois de atualizar a pilha leva a escolha nova: gravada com o antes e o depois, mesmo com um pedido pendente', async () => {
      const account = await awsAccount(adminA);
      await connect(adminA, account.id)
        .send({ capabilities: ['service-logs'] })
        .expect(202);
      const checker = new FakeTaggedChecker();
      await new AwsCheck(prisma, checker, { onboarding: true }).runOnce();
      expect(await connectRow(account.id)).toMatchObject({ connection: 'connected', checkRequestedAt: null });

      // O cliente ligou os achados em "Atualize a pilha" e clicou em "Verificar de novo".
      const updated = await verify(adminA, account.id)
        .send({ capabilities: ['service-logs', 'findings'] })
        .expect(202);
      expect(cloudAccountSchema.parse(updated.body)).toMatchObject({ connection: 'waiting' });
      const pendingAt = (await connectRow(account.id)).checkRequestedAt as Date;
      expect((await connectRow(account.id)).awsChosenCapabilities).toBe('service-logs findings');
      expect((await onboardingOf(adminA, account.id)).connect.capabilities).toEqual([
        'service-logs',
        'findings',
      ]);
      expect(await entryOf(updated)).toMatchObject({
        action: 'cloud_account.aws_verify',
        outcome: 'success',
        before: { connection: 'connected', chosenCapabilities: ['service-logs'] },
        after: { connection: 'waiting', chosenCapabilities: ['service-logs', 'findings'] },
      });

      // Com o pedido pendente, só a escolha muda: o pedido não é renovado.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await verify(adminA, account.id).send({ capabilities: [] }).expect(202);
      expect(await connectRow(account.id)).toMatchObject({
        checkRequestedAt: pendingAt,
        awsChosenCapabilities: '',
      });
      // O "Verificar" de sempre, sem corpo, não toca na escolha e não a põe na trilha.
      const plain = await verify(adminA, account.id).expect(202);
      expect((await connectRow(account.id)).awsChosenCapabilities).toBe('');
      const entry = await entryOf(plain);
      expect(entry.before).not.toHaveProperty('chosenCapabilities');
      expect(entry.after).not.toHaveProperty('chosenCapabilities');
      // Estrito como o do "Conectar".
      await verify(adminA, account.id)
        .send({ capabilities: ['discovery'] })
        .expect(400);
      await verify(adminA, account.id).send({ capabilities: [], extra: true }).expect(400);
      expect((await connectRow(account.id)).awsChosenCapabilities).toBe('');
    });

    it('um "Verificar" pendente vira o pedido do "Conectar" (a janela conta do clique)', async () => {
      const account = await awsAccount(adminA);
      const verifyAt = await requested(adminA, account.id);
      expect((await onboardingOf(adminA, account.id)).checks[0]).toMatchObject({
        status: 'pending',
        code: 'verifying',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const connectAt = await connected(adminA, account.id);
      expect(connectAt.getTime()).toBeGreaterThan(verifyAt.getTime());
      expect((await connectRow(account.id)).awsConnectRequestedAt).toEqual(connectAt);
    });

    it('recusa conta de outro provedor e conta inativa (400); A não conecta a conta de B (404); só administradores', async () => {
      const gcp = cloudAccountSchema.parse(
        (
          await write(adminA, 'post', '/v1/cloud-accounts')
            .send({ provider: 'gcp', accountId: `vx-${randomInt(1_000_000, 9_999_999)}-con` })
            .expect(201)
        ).body,
      );
      await connect(adminA, gcp.id).expect(400);
      await get(adminA, `/v1/cloud-accounts/${gcp.id}/aws/onboarding`).expect(400);
      const inactive = await awsAccount(adminA);
      await write(adminA, 'delete', `/v1/cloud-accounts/${inactive.id}`).expect(204);
      expect((await connect(adminA, inactive.id).expect(400)).body).toMatchObject({
        message: 'Reative o monitoramento antes de conectar a conta.',
      });
      expect((await connectRow(inactive.id)).awsConnectRequestedAt).toBeNull();

      const ofB = await awsAccount(adminB);
      const denied = await connect(adminA, ofB.id).expect(404);
      await get(adminA, `/v1/cloud-accounts/${ofB.id}/aws/onboarding`).expect(404);
      expect(await connectRow(ofB.id)).toMatchObject({ checkRequestedAt: null, awsConnectRequestedAt: null });
      expect(await entryOf(denied)).toMatchObject({
        action: 'cloud_account.aws_connect',
        outcome: 'failure',
        tenantId: tenantA,
      });

      const expected: Record<Role, number> = {
        admin_verax: 202,
        admin_cliente: 202,
        analista_cliente: 403,
        leitura: 403,
      };
      for (const [role, status] of Object.entries(expected) as [Role, number][]) {
        const account = await awsAccount(adminA);
        await connect(sessions.get(role) as TestSession, account.id).expect(status);
        expect((await connectRow(account.id)).awsConnectRequestedAt === null).toBe(status === 403);
      }
    });

    it('a conta que a Verax cadastrou pelo console também é conectada pelo cliente', async () => {
      const account = await awsAccount(adminA);
      await prisma.cloudAccount.update({
        where: { id: account.id },
        data: { origin: 'control_plane', controlPlaneRevision: 1 },
      });
      // O cadastro continua do console; conectar, verificar e autorizar fontes são do cliente.
      await write(adminA, 'patch', `/v1/cloud-accounts/${account.id}`)
        .send({ regions: ['us-east-1'] })
        .expect(409);
      await connect(adminA, account.id).expect(202);
      expect((await connectRow(account.id)).awsConnectRequestedAt).not.toBeNull();
    });

    it('dentro da janela, a entrada recusada não é o erro da conta: tenta a 20 s, 40 s e depois a cada 60 s', async () => {
      expect([1, 2, 3, 4, 10].map(awsConnectRetryDelayMs)).toEqual([20_000, 40_000, 60_000, 60_000, 60_000]);
      const account = await awsAccount(adminA);
      const requestedAt = await connected(adminA, account.id);
      const checker = new FakeTaggedChecker();
      checker.respond(account.accountId, { ok: false, code: 'trust_denied', retryable: true });
      let now = requestedAt.getTime();
      const task = new AwsCheck(prisma, checker, { now: () => new Date(now) });
      const attemptsAt: number[] = [];
      // A tarefa roda a cada 10 s neste teste: a tentativa sai na primeira execução depois da hora marcada.
      for (let elapsed = 0; elapsed <= 200_000; elapsed += 10_000) {
        now = requestedAt.getTime() + elapsed;
        const before = checker.callsFor(account.accountId).length;
        const report = await task.runOnce();
        expect(report).toMatchObject({ pending: 1, retrying: 1, failed: 0, connected: 0 });
        if (checker.callsFor(account.accountId).length > before) attemptsAt.push(elapsed / 1000);
      }
      expect(attemptsAt).toEqual([0, 20, 60, 120, 180]);
      // Muito além dos 10 min do "Verificar", a conta continua aguardando, sem erro.
      now = requestedAt.getTime() + 45 * MINUTE;
      expect(await task.runOnce()).toMatchObject({ retrying: 1, failed: 0 });
      expect(await connectRow(account.id)).toMatchObject({
        connection: 'waiting',
        connectionError: null,
        checkRequestedAt: requestedAt,
      });
      expect((await onboardingOf(adminA, account.id)).state).toBe('awaiting_authorization');
      expect(
        await prisma.auditLog.count({ where: { action: 'cloud_account.aws_check', resourceId: account.id } }),
      ).toBe(0);
    });

    it('a janela fecha sem o papel: authorization_timeout; "tentar de novo" abre outra janela', async () => {
      const denied = await awsAccount(adminA);
      const token = await awsAccount(adminA);
      const requestedAt = await connected(adminA, denied.id);
      await connected(adminA, token.id);
      const checker = new FakeTaggedChecker();
      checker.respond(denied.accountId, { ok: false, code: 'trust_denied', retryable: true });
      // O token recusado também só diz, dentro da janela, que o papel ainda não está lá.
      checker.respond(token.accountId, { ok: false, code: 'token_invalid', retryable: false });
      const almost = new Date(requestedAt.getTime() + AWS_CONNECT_WINDOW_MS - MINUTE);
      expect(await new AwsCheck(prisma, checker, { now: () => almost }).runOnce()).toMatchObject({
        pending: 2,
        retrying: 2,
        failed: 0,
      });
      const late = new Date(requestedAt.getTime() + AWS_CONNECT_WINDOW_MS + MINUTE);
      expect(await new AwsCheck(prisma, checker, { now: () => late }).runOnce()).toEqual({
        pending: 2,
        connected: 0,
        failed: 2,
        retrying: 0,
        stale: 0,
        failures: { authorization_timeout: 2 },
      });
      for (const account of [denied, token]) {
        expect(await connectRow(account.id)).toMatchObject({
          connection: 'error',
          connectionError: 'authorization_timeout',
          checkRequestedAt: null,
          ingestFrom: null,
        });
        const onboarding = await onboardingOf(adminA, account.id);
        expect(onboarding).toMatchObject({ state: 'authorization_timeout', connect: { waitingUntil: null } });
        expect(onboarding.checks[0]).toMatchObject({ status: 'failed', code: 'authorization_timeout' });
        // A conta cloud mostra o código (o painel antigo o exibe como tipo do erro).
        expect((await get(adminA, `/v1/cloud-accounts/${account.id}`).expect(200)).body).toMatchObject({
          connection: 'error',
          connectionError: 'authorization_timeout',
        });
      }
      const audit = await prisma.auditLog.findMany({
        where: { action: 'cloud_account.aws_check', resourceId: denied.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorType: 'system',
        tenantId: tenantA,
        after: { connection: 'error', connectionError: 'authorization_timeout' },
      });
      expect(await runsOf(denied.id)).toEqual([]);

      // "Tentar de novo": outro clique, outra janela, e o papel agora existe.
      const again = await connected(adminA, denied.id);
      expect(again.getTime()).toBeGreaterThan(requestedAt.getTime());
      expect((await onboardingOf(adminA, denied.id)).state).toBe('awaiting_authorization');
      checker.respond(denied.accountId, { ok: true });
      await new AwsCheck(prisma, checker, { now: () => new Date(again.getTime() + MINUTE) }).runOnce();
      expect(await connectRow(denied.id)).toMatchObject({ connection: 'connected', connectionError: null });
    });

    it('um erro que não é a falta do papel é gravado na hora, mesmo na janela; a AWS fora espera a janela e sai com o próprio código', async () => {
      const mismatch = await awsAccount(adminA);
      const unavailable = await awsAccount(adminA);
      const requestedAt = await connected(adminA, mismatch.id);
      await connected(adminA, unavailable.id);
      const checker = new FakeTaggedChecker();
      checker.respond(mismatch.accountId, { ok: false, code: 'account_mismatch', retryable: false });
      checker.respond(unavailable.accountId, { ok: false, code: 'aws_unavailable', retryable: true });
      const soon = new Date(requestedAt.getTime() + MINUTE);
      expect(await new AwsCheck(prisma, checker, { now: () => soon }).runOnce()).toMatchObject({
        failed: 1,
        retrying: 1,
        failures: { account_mismatch: 1 },
      });
      expect(await connectRow(mismatch.id)).toMatchObject({
        connection: 'error',
        connectionError: 'account_mismatch',
      });
      expect((await onboardingOf(adminA, mismatch.id)).state).toBe('disconnected');
      const late = new Date(requestedAt.getTime() + AWS_CONNECT_WINDOW_MS + MINUTE);
      expect(await new AwsCheck(prisma, checker, { now: () => late }).runOnce()).toMatchObject({
        failed: 1,
        failures: { aws_unavailable: 1 },
      });
      expect(await connectRow(unavailable.id)).toMatchObject({
        connection: 'error',
        connectionError: 'aws_unavailable',
      });
    });

    it('o "Verificar" comum continua com a janela de 10 min e o erro da entrada recusada', async () => {
      const account = await awsAccount(adminA);
      // Um "Conectar" antigo não muda o pedido de agora.
      await prisma.cloudAccount.update({
        where: { id: account.id },
        data: { awsConnectRequestedAt: new Date('2026-11-01T00:00:00.000Z') },
      });
      const requestedAt = await requested(adminA, account.id);
      const checker = new FakeTaggedChecker();
      checker.respond(account.accountId, { ok: false, code: 'trust_denied', retryable: true });
      const late = new Date(requestedAt.getTime() + AWS_CHECK_RETRY_WINDOW_MS + MINUTE);
      expect(await new AwsCheck(prisma, checker, { now: () => late }).runOnce()).toMatchObject({
        failed: 1,
        failures: { trust_denied: 1 },
      });
      expect(await connectRow(account.id)).toMatchObject({
        connection: 'error',
        connectionError: 'trust_denied',
      });
    });

    it('a primeira entrada no papel: grava as tags, pede a descoberta e dá o início da coleta às fontes dos buckets', async () => {
      const trail = bucket();
      const account = await awsAccount(adminA, { cloudtrail: trail });
      const requestedAt = await connected(adminA, account.id);
      const checker = new FakeTaggedChecker();
      checker.tag(account.accountId, { templateVersion: 3, capabilities: ['discovery', 'findings'] });
      const now = new Date(requestedAt.getTime() + 3 * MINUTE);
      expect(await new AwsCheck(prisma, checker, { now: () => now }).runOnce()).toEqual({
        pending: 1,
        connected: 1,
        failed: 0,
        retrying: 0,
        stale: 0,
      });
      expect(checker.factsCalls).toEqual([account.accountId]);
      expect(await connectRow(account.id)).toMatchObject({
        connection: 'connected',
        checkRequestedAt: null,
        // O horário do clique fica: é o histórico de quando o cliente conectou.
        awsConnectRequestedAt: requestedAt,
        ingestFrom: ingestDayFor(now),
        awsTemplateVersion: 3,
        awsCapabilities: ['discovery', 'findings'],
        awsCapabilitiesCheckedAt: now,
      });
      const runs = await runsOf(account.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        tenantId: tenantA,
        trigger: 'connect',
        status: 'pending',
        requestedAt: now,
        requestedBy: null,
      });
      // A fonte do bucket cadastrado ganha a data de início da coleta junto com a conta.
      const legacy = await prisma.awsSource.findMany({ where: { cloudAccountId: account.id } });
      expect(legacy).toHaveLength(1);
      expect(legacy[0]).toMatchObject({
        kind: 'cloudtrail',
        origin: 'legacy',
        name: trail,
        state: 'authorized',
        collectFrom: ingestDayFor(now),
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'cloud_account.aws_check', resourceId: account.id },
      });
      expect(audit.after).toMatchObject({
        connection: 'connected',
        awsTemplateVersion: 3,
        awsCapabilities: ['discovery', 'findings'],
        discoveryRequested: true,
      });

      const onboarding = await onboardingOf(adminA, account.id);
      expect(onboarding).toMatchObject({
        state: 'discovering',
        connect: { requestedAt: requestedAt.toISOString(), waitingUntil: null },
        template: {
          version: 3,
          capabilities: ['discovery', 'findings'],
          outdated: false,
          checkedAt: now.toISOString(),
        },
        discovery: { run: { trigger: 'connect', status: 'pending' }, lastCompletedAt: null },
      });
      expect(Object.fromEntries(onboarding.checks.map((check) => [check.id, check.status]))).toMatchObject({
        assume_role: 'ok',
        identity: 'ok',
        template: 'ok',
        discovery: 'pending',
      });
      // A linha do bucket cadastrado aparece autorizada, com a permissão que a conferência provou.
      expect(onboarding.sources).toHaveLength(1);
      expect(onboarding.sources[0]).toMatchObject({
        origin: 'legacy',
        state: 'authorized',
        stateCode: 'awaiting_collector',
        permission: 'granted',
        collectFrom: ingestDayFor(now).toISOString().slice(0, 10),
      });
    });

    it('o papel de template anterior (sem tags): v1, desatualizado, e a descoberta é pedida do mesmo jeito', async () => {
      const account = await awsAccount(adminA);
      const requestedAt = await connected(adminA, account.id);
      const checker = new FakeTaggedChecker();
      checker.tag(account.accountId, { templateVersion: 1, capabilities: ['discovery'] });
      await new AwsCheck(prisma, checker, { now: () => new Date(requestedAt.getTime() + MINUTE) }).runOnce();
      const onboarding = await onboardingOf(adminA, account.id);
      expect(onboarding.template).toMatchObject({ version: 1, capabilities: ['discovery'], outdated: true });
      expect(onboarding.checks.find((check) => check.id === 'template')).toMatchObject({
        status: 'failed',
        code: 'template_outdated',
      });
      expect(await runsOf(account.id)).toHaveLength(1);
    });

    it('verificar de novo sem mudança não pede outra descoberta; com as tags mudadas, pede', async () => {
      const account = await awsAccount(adminA);
      const first = await requested(adminA, account.id);
      const checker = new FakeTaggedChecker();
      // A primeira verificação bem-sucedida pede a descoberta, mesmo sem o "Conectar".
      await new AwsCheck(prisma, checker, { now: () => new Date(first.getTime() + MINUTE) }).runOnce();
      expect((await runsOf(account.id)).map((run) => run.trigger)).toEqual(['connect']);
      await prisma.awsDiscoveryRun.updateMany({
        where: { cloudAccountId: account.id },
        data: { status: 'succeeded', startedAt: first, finishedAt: first },
      });

      const second = await requested(adminA, account.id);
      await new AwsCheck(prisma, checker, { now: () => new Date(second.getTime() + MINUTE) }).runOnce();
      expect(await runsOf(account.id)).toHaveLength(1);

      // O cliente desligou uma capacidade na pilha: o que o papel pode ler mudou.
      checker.tag(account.accountId, { templateVersion: 3, capabilities: ['discovery', 'service-logs'] });
      const third = await requested(adminA, account.id);
      await new AwsCheck(prisma, checker, { now: () => new Date(third.getTime() + MINUTE) }).runOnce();
      expect(await runsOf(account.id)).toHaveLength(2);
      expect((await connectRow(account.id)).awsCapabilities).toEqual(['discovery', 'service-logs']);

      // Com uma descoberta ainda pendente, um "Conectar" bem-sucedido não cria outra.
      const fourth = await connected(adminA, account.id);
      await new AwsCheck(prisma, checker, { now: () => new Date(fourth.getTime() + MINUTE) }).runOnce();
      expect(await runsOf(account.id)).toHaveLength(2);
    });

    it('as tags que não puderam ser lidas agora deixam o que estava gravado; sem leitura das tags, nada é gravado', async () => {
      const account = await awsAccount(adminA);
      await prisma.cloudAccount.update({
        where: { id: account.id },
        data: {
          ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
          awsTemplateVersion: 3,
          awsCapabilities: ['discovery', 'findings'],
          awsCapabilitiesCheckedAt: new Date('2026-11-10T00:00:00.000Z'),
        },
      });
      const first = await requested(adminA, account.id);
      const checker = new FakeTaggedChecker();
      checker.tag(account.accountId, null);
      await new AwsCheck(prisma, checker, { now: () => new Date(first.getTime() + MINUTE) }).runOnce();
      expect(await connectRow(account.id)).toMatchObject({
        connection: 'connected',
        awsTemplateVersion: 3,
        awsCapabilities: ['discovery', 'findings'],
        awsCapabilitiesCheckedAt: new Date('2026-11-10T00:00:00.000Z'),
      });
      expect(await runsOf(account.id)).toEqual([]);
      // A conferência que não lê tags (o nó sem a identidade, os testes antigos) não mexe nelas.
      const second = await requested(adminA, account.id);
      await new AwsCheck(prisma, new FakeAwsChecker(), {
        now: () => new Date(second.getTime() + MINUTE),
      }).runOnce();
      expect((await connectRow(account.id)).awsCapabilitiesCheckedAt).toEqual(
        new Date('2026-11-10T00:00:00.000Z'),
      );
    });

    it('na célula compartilhada (onboarding desligado), a conferência segue como antes: sem tags e sem descoberta', async () => {
      const account = await awsAccount(adminA);
      const requestedAt = await connected(adminA, account.id);
      const checker = new FakeTaggedChecker();
      await new AwsCheck(prisma, checker, {
        now: () => new Date(requestedAt.getTime() + MINUTE),
        onboarding: false,
      }).runOnce();
      expect(checker.factsCalls).toEqual([]);
      expect(await connectRow(account.id)).toMatchObject({
        connection: 'connected',
        awsTemplateVersion: null,
        awsCapabilities: [],
        awsCapabilitiesCheckedAt: null,
      });
      expect(await runsOf(account.id)).toEqual([]);
    });

    it('revogação: com o papel removido, a conta fica desconectada, e as fontes continuam lá', async () => {
      const account = await awsAccount(adminA);
      const requestedAt = await connected(adminA, account.id);
      const checker = new FakeTaggedChecker();
      const clock = { now: new Date(requestedAt.getTime() + MINUTE) };
      const task = new AwsCheck(prisma, checker, { now: () => clock.now, tenantIds: [tenantA] });
      await task.runOnce();
      // A descoberta terminou e o cliente autorizou uma fonte.
      await prisma.awsDiscoveryRun.updateMany({
        where: { cloudAccountId: account.id },
        data: { status: 'succeeded', startedAt: clock.now, finishedAt: clock.now },
      });
      const source = await prisma.awsSource.create({
        data: {
          tenantId: tenantA,
          cloudAccountId: account.id,
          kind: 'guardduty',
          region: 'sa-east-1',
          resourceId: 'det1',
          name: 'GuardDuty',
          method: 'api',
          availability: 'available',
          permission: 'granted',
          authorizedAt: clock.now,
          authorizedBy: 'usuario-de-teste',
          collectFrom: new Date('2026-11-22T00:00:00.000Z'),
          state: 'authorized',
          stateCode: 'awaiting_collector',
        },
      });
      expect((await onboardingOf(adminA, account.id)).state).toBe('configuring');

      // O cliente apaga a pilha: a conferência periódica passa a ser recusada e, depois da janela, grava o erro.
      checker.respond(account.accountId, { ok: false, code: 'trust_denied', retryable: true });
      for (const minutes of [20, 21, 23, 27, 31, 35]) {
        clock.now = new Date(requestedAt.getTime() + minutes * MINUTE);
        await task.recheck();
      }
      expect(await connectRow(account.id)).toMatchObject({
        connection: 'error',
        connectionError: 'trust_denied',
      });
      const onboarding = await onboardingOf(adminA, account.id);
      expect(onboarding.state).toBe('disconnected');
      expect(onboarding.checks[0]).toMatchObject({
        id: 'assume_role',
        status: 'failed',
        code: 'trust_denied',
      });
      // A fonte e a autorização dela ficam: reconectada a conta, a coleta volta sem autorizar de novo.
      expect(
        onboarding.sources.map((item) => [item.id, item.state, item.authorization.authorizedBy]),
      ).toEqual([[source.id, 'authorized', 'usuario-de-teste']]);
      expect(await prisma.awsSource.findUniqueOrThrow({ where: { id: source.id } })).toEqual(source);
    });
  });
});
