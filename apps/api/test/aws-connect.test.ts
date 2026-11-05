import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { cloudAccountSchema, type Role } from '@verax/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AWS_CHECK_RETRY_WINDOW_MS, AwsCheck, ingestDayFor } from '../src/aws/aws-check.js';
import {
  type AwsCheckOutcome,
  type AwsCheckTarget,
  type AwsConnectionChecker,
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
      // A conferência recebe a conta cadastrada e os buckets sem repetir; nada de ExternalId nem de chave.
      expect(checker.callsFor(account.accountId)).toEqual([
        {
          cloudAccountId: account.id,
          accountId: account.accountId,
          regions: ['sa-east-1', 'us-east-1'],
          buckets: [trail, waf],
        },
      ]);
      expect(await rowOf(account.id)).toMatchObject({
        connection: 'connected',
        connectionError: null,
        checkRequestedAt: null,
        ingestFrom: ingestDayFor(now),
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

    it('a conferência deste PR (antes do PR-V5) responde check_unavailable na hora, sem tentar de novo', async () => {
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
});
