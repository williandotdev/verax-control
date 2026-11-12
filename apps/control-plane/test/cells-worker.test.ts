import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CellTenantState, parseCellCommandJson } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { CellCommandPublisher, TenantNotInCellError } from '../src/cells/cell-command-publisher.js';
import type { CellCommandSink, CellPubsubMessage } from '../src/cells/cell-pubsub.js';
import { cellSchema } from '../src/cells/cell.schema.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { parseDocument } from '../src/firestore/document-store.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { type TenantRecord, tenantSchema } from '../src/tenants/tenant.schema.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
/** A conta de push de cada célula (`vxc-<célula>-push`, do ambiente da célula). */
const pushOf = (cellId: string) => `vxc-${cellId}-push@projeto-celulas.iam.gserviceaccount.com`;
const PUSH_SA = pushOf('celula-a');
const OWNER = 'responsavel@exemplo.example';
const START = new Date('2026-11-11T12:00:00.000Z');

const CELL_A = 'celula-a';
const CELL_B = 'celula-b';
const subscriptionOf = (cellId: string) => `projects/projeto-exemplo/subscriptions/cp-${cellId}-relatorios`;
const commandsTopicOf = (cellId: string) => `projects/projeto-celulas/topics/vxc-${cellId}-comandos`;

/** A publicação dos comandos em memória. */
class MemorySink implements CellCommandSink {
  readonly sent: { topic: string; message: CellPubsubMessage }[] = [];
  publish(topic: string, message: CellPubsubMessage): Promise<string> {
    this.sent.push({ topic, message });
    return Promise.resolve(String(this.sent.length));
  }
}

/**
 * O lado do plano de controle do canal da célula (CE-06), pelo app inteiro: a guarda `cell-push`, a assinatura que
 * prova a célula, a conferência de que todo cliente citado está na célula, a idempotência da entrega e o publicador dos
 * comandos. Um app por arquivo.
 */
describe('cp-worker: canal da célula (CE-06)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const google = new TestGoogleIdentity();
  const sink = new MemorySink();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  let app: NestExpressApplication;
  let publisher: CellCommandPublisher;
  let sequence = 0;

  beforeAll(async () => {
    app = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      idTokenKeys: google,
      cellCommandSink: sink,
      capture,
      env: {
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: OWNER,
        CELL_PUSH_SA_EMAILS: `${pushOf('celula-a')},${pushOf('celula-b')}`,
      },
    });
    await app.listen(0, '127.0.0.1');
    publisher = app.get(CellCommandPublisher);
    await documents.runTransaction((tx) => {
      for (const cellId of [CELL_A, CELL_B]) {
        tx.set(
          COLLECTIONS.cells,
          cellId,
          cellSchema.parse({
            state: 'open',
            region: 'southamerica-east1',
            project: 'projeto-celulas',
            natIps: ['203.0.113.10'],
            commandsTopic: commandsTopicOf(cellId),
            reportsSubscription: subscriptionOf(cellId),
            pushServiceAccount: pushOf(cellId),
            createdAt: START,
            updatedAt: START,
          }),
        );
      }
      return Promise.resolve();
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function bearer(email: string): string {
    return `Bearer ${google.token({ email, aud: WORKER_URL })}`;
  }

  /** Um cliente do plano de controle, posto numa célula (o `placement` que o CE-15 vai gravar na escolha). */
  async function cellTenant(cellId: string | null): Promise<TenantRecord> {
    sequence += 1;
    const tenant = await tenantIn(tenants, `cliente-demo-c${sequence}`, 'waiting_customer_connection');
    if (cellId === null) return tenant;
    await documents.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.tenants, tenant.id);
      const current = parseDocument(tenantSchema, COLLECTIONS.tenants, tenant.id, data ?? {});
      tx.set(
        COLLECTIONS.tenants,
        tenant.id,
        tenantSchema.parse({ ...current, placement: { kind: 'cell', cellId } }),
      );
    });
    return tenant;
  }

  async function tenantDoc(tenantId: string) {
    return parseDocument(
      tenantSchema,
      COLLECTIONS.tenants,
      tenantId,
      (await documents.get(COLLECTIONS.tenants, tenantId)) ?? {},
    );
  }

  function report(cellId: string, body: Record<string, unknown>) {
    return { v: 1, reportId: randomUUID(), cellId, emittedAt: clock.now().toISOString(), ...body };
  }

  /** A entrega push como o Pub/Sub a faz: o relatório em base64 e a assinatura de onde veio. */
  function deliver(path: string, value: unknown, subscription: string, caller = pushOf(path)): request.Test {
    return request(app.getHttpServer())
      .post(`/internal/cells/${path}/reports`)
      .set('Authorization', bearer(caller))
      .send({
        subscription,
        message: {
          data: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
          messageId: String(Math.floor(Math.random() * 1e12)),
          publishTime: clock.now().toISOString(),
        },
        deliveryAttempt: 1,
      });
  }

  /** O estado desejado de um cliente (o mesmo formato que a célula valida). */
  function stateFor(slug: string): CellTenantState {
    return {
      slug,
      name: 'Cliente Demo A',
      hosts: { api: `api-${slug}.example.com`, panel: `${slug}.control.example.com` },
      status: 'active',
      plan: {
        planId: 'plataforma',
        limits: { maxCloudAccounts: 10, maxUsers: 10, monthlyGib: null, historyDays: 90 },
        franchiseGbPerDay: 3,
      },
      franchiseSchedule: [{ from: '2026-11-01', gbPerDay: 3 }],
      billingPeriod: { start: '2026-11-01', end: '2026-11-30' },
      cloudIdentity: {
        saEmail: `vxt-${slug}@projeto-celulas.iam.gserviceaccount.com`,
        saUniqueId: '100000000000000000001',
      },
      gcpSources: [],
      natIps: ['203.0.113.10'],
      lastBilledCycle: null,
      unitPrices: null,
      firstAdmin: { email: 'admin@cliente-demo-a.example' },
    };
  }

  describe('a guarda da rota', () => {
    it('sem token 401; token das tasks ou do responsável 403; o da conta de push não serve nos passos', async () => {
      const server = app.getHttpServer();
      const tenant = await cellTenant(CELL_A);
      const body = report(CELL_A, {
        kind: 'tenant.status',
        tenantId: tenant.id,
        accountsConnected: 1,
        lastEventAt: null,
      });
      await request(server).post(`/internal/cells/${CELL_A}/reports`).send({}).expect(401);
      await deliver(CELL_A, body, subscriptionOf(CELL_A), INVOKER).expect(403);
      await deliver(CELL_A, body, subscriptionOf(CELL_A), OWNER).expect(403);
      await request(server)
        .post('/internal/steps/preflight')
        .set('Authorization', bearer(PUSH_SA))
        .send({ tenantId: tenant.id, runId: tenant.id })
        .expect(403);
      expect((await tenantDoc(tenant.id)).cell).toBeUndefined();
    });
  });

  describe('célula forjada', () => {
    it('a entrega de outra assinatura é recusada (403) sem ler o relatório; célula fora do registro, 404', async () => {
      const tenant = await cellTenant(CELL_A);
      const body = report(CELL_A, {
        kind: 'tenant.status',
        tenantId: tenant.id,
        accountsConnected: 3,
        lastEventAt: null,
      });
      // A célula B (comprometida) tenta falar pela rota da A: com a própria conta de push, ou citando a assinatura dela.
      const forged = await deliver(CELL_A, body, subscriptionOf(CELL_A), pushOf(CELL_B)).expect(403);
      expect(forged.body).toMatchObject({ code: 'push_account_mismatch' });
      const otherSubscription = await deliver(CELL_A, body, subscriptionOf(CELL_B), pushOf(CELL_A)).expect(
        403,
      );
      expect(otherSubscription.body).toMatchObject({ code: 'subscription_mismatch' });
      await deliver('celula-z', body, subscriptionOf('celula-z'), pushOf(CELL_A)).expect(404);
      await deliver('Celula_Invalida', body, subscriptionOf(CELL_A), pushOf(CELL_A)).expect(404);
      expect((await tenantDoc(tenant.id)).cell).toBeUndefined();
      expect(capture.text).toContain('subscription_mismatch');
    });

    it('o relatório que diz ser de outra célula é recusado e confirmado (200), sem efeito', async () => {
      const tenant = await cellTenant(CELL_A);
      const body = report(CELL_B, {
        kind: 'tenant.status',
        tenantId: tenant.id,
        accountsConnected: 3,
        lastEventAt: null,
      });
      const response = await deliver(CELL_A, body, subscriptionOf(CELL_A)).expect(200);
      expect(response.body).toEqual({ outcome: 'refused', code: 'cell_mismatch' });
      expect((await tenantDoc(tenant.id)).cell).toBeUndefined();
    });

    it('o relatório fora do contrato é recusado e confirmado, sem o conteúdo no log', async () => {
      const tenant = await cellTenant(CELL_A);
      const body = {
        ...report(CELL_A, {
          kind: 'tenant.status',
          tenantId: tenant.id,
          accountsConnected: 3,
          lastEventAt: null,
        }),
        segredo: 'valor-que-nao-pode-vazar',
      };
      const response = await deliver(CELL_A, body, subscriptionOf(CELL_A)).expect(200);
      expect(response.body).toEqual({ outcome: 'refused', code: 'invalid_report' });
      expect(capture.text).not.toContain('valor-que-nao-pode-vazar');
    });
  });

  describe('cliente de outra célula', () => {
    it('a célula A não fala do cliente da B, nem de quem não está em célula: recusado e auditado', async () => {
      const ofB = await cellTenant(CELL_B);
      const dedicated = await cellTenant(null);
      for (const tenant of [ofB, dedicated]) {
        const body = report(CELL_A, {
          kind: 'tenant.status',
          tenantId: tenant.id,
          accountsConnected: 9,
          lastEventAt: null,
        });
        const response = await deliver(CELL_A, body, subscriptionOf(CELL_A)).expect(200);
        expect(response.body).toEqual({ outcome: 'refused', code: 'foreign_tenant' });
        expect((await tenantDoc(tenant.id)).cell).toBeUndefined();
      }
      const ghost = report(CELL_A, {
        kind: 'tenant.applied',
        tenantId: '01JD0000000000000000000000',
        generation: 1,
      });
      expect((await deliver(CELL_A, ghost, subscriptionOf(CELL_A)).expect(200)).body).toEqual({
        outcome: 'refused',
        code: 'foreign_tenant',
      });
      const refusals = await audit.listByActionPrefix('cell.report_refused', 10);
      expect(
        refusals.filter((entry) => entry.details?.['code'] === 'foreign_tenant').length,
      ).toBeGreaterThanOrEqual(3);
      // A recusa não entra na trilha do cliente da outra célula.
      expect(
        (await audit.listForTenant(ofB.id)).some((entry) => entry.action === 'cell.report_refused'),
      ).toBe(false);
    });
  });

  describe('tenant.applied e tenant.status', () => {
    it('o publicador manda a geração seguinte ao tópico da célula do cliente, com a chave de ordenação', async () => {
      const tenant = await cellTenant(CELL_A);
      const first = await publisher.upsert(tenant.id, stateFor(tenant.slug), `owner:${OWNER}`);
      const second = await publisher.upsert(tenant.id, stateFor(tenant.slug), `owner:${OWNER}`);
      expect([first.generation, second.generation]).toEqual([1, 2]);
      const ours = sink.sent.filter((sent) => sent.message.orderingKey === tenant.id);
      expect(ours.map((sent) => sent.topic)).toEqual([commandsTopicOf(CELL_A), commandsTopicOf(CELL_A)]);
      const parsed = parseCellCommandJson(
        Buffer.from(ours[1]?.message.data ?? '', 'base64').toString('utf8'),
      );
      expect(parsed).toMatchObject({
        ok: true,
        value: { kind: 'tenant.upsert', cellId: CELL_A, tenantId: tenant.id, generation: 2 },
      });
      expect(ours[1]?.message.attributes).toEqual({ kind: 'tenant.upsert', v: '1' });
      expect((await tenantDoc(tenant.id)).cell?.desiredGeneration).toBe(2);
      const outsider = await cellTenant(null);
      await expect(publisher.upsert(outsider.id, stateFor(outsider.slug), 'system')).rejects.toBeInstanceOf(
        TenantNotInCellError,
      );
      const purge = await publisher.point(
        tenant.id,
        { kind: 'tenant.purge', purgeId: first.commandId, confirmSlug: tenant.slug },
        'system',
      );
      expect(purge.cellId).toBe(CELL_A);
      expect((await tenantDoc(tenant.id)).cell).toMatchObject({
        desiredGeneration: 2,
        lastCommandKind: 'tenant.purge',
      });
    });

    it('a geração aplicada sobe só até a mandada; a repetida e a mais velha não voltam nada', async () => {
      const tenant = await cellTenant(CELL_A);
      await publisher.upsert(tenant.id, stateFor(tenant.slug), 'system');
      await publisher.upsert(tenant.id, stateFor(tenant.slug), 'system');
      const applied2 = report(CELL_A, { kind: 'tenant.applied', tenantId: tenant.id, generation: 2 });
      expect((await deliver(CELL_A, applied2, subscriptionOf(CELL_A)).expect(200)).body).toEqual({
        outcome: 'applied',
      });
      expect((await tenantDoc(tenant.id)).cell).toMatchObject({ desiredGeneration: 2, appliedGeneration: 2 });
      // A mesma entrega de novo (o Pub/Sub repete): nada muda.
      expect((await deliver(CELL_A, applied2, subscriptionOf(CELL_A)).expect(200)).body).toEqual({
        outcome: 'duplicate',
      });
      const applied1 = report(CELL_A, { kind: 'tenant.applied', tenantId: tenant.id, generation: 1 });
      expect((await deliver(CELL_A, applied1, subscriptionOf(CELL_A)).expect(200)).body).toEqual({
        outcome: 'ignored',
      });
      const invented = report(CELL_A, { kind: 'tenant.applied', tenantId: tenant.id, generation: 7 });
      expect((await deliver(CELL_A, invented, subscriptionOf(CELL_A)).expect(200)).body).toEqual({
        outcome: 'refused',
        code: 'generation_unknown',
      });
      expect((await tenantDoc(tenant.id)).cell?.appliedGeneration).toBe(2);
    });

    it('o tenant.status mais novo vale; o mais velho que chega depois é ignorado', async () => {
      const tenant = await cellTenant(CELL_A);
      const newer = report(CELL_A, {
        kind: 'tenant.status',
        tenantId: tenant.id,
        accountsConnected: 2,
        lastEventAt: '2026-11-11T11:00:00.000Z',
      });
      const older = {
        ...report(CELL_A, {
          kind: 'tenant.status',
          tenantId: tenant.id,
          accountsConnected: 0,
          lastEventAt: null,
        }),
        emittedAt: '2026-11-11T11:55:00.000Z',
      };
      expect((await deliver(CELL_A, newer, subscriptionOf(CELL_A)).expect(200)).body).toEqual({
        outcome: 'applied',
      });
      expect((await deliver(CELL_A, older, subscriptionOf(CELL_A)).expect(200)).body).toEqual({
        outcome: 'ignored',
      });
      expect((await tenantDoc(tenant.id)).cell).toMatchObject({
        accountsConnected: 2,
        lastEventAt: new Date('2026-11-11T11:00:00.000Z'),
        statusReportedAt: START,
      });
    });

    it('os tipos ainda sem tratamento ficam guardados inteiros para os PRs seguintes', async () => {
      const tenant = await cellTenant(CELL_A);
      const usage = report(CELL_A, {
        kind: 'usage.daily',
        tenantId: tenant.id,
        day: '2026-11-10',
        final: false,
        sources: {
          aws: { bytes: 0, events: 0 },
          gcp: { bytes: 1000, events: 3 },
          cloudflare: { bytes: 0, events: 0 },
        },
      });
      expect((await deliver(CELL_A, usage, subscriptionOf(CELL_A)).expect(200)).body).toEqual({
        outcome: 'stored',
      });
      const stored = await documents.get(COLLECTIONS.cellReports, `${CELL_A}_${usage.reportId}`);
      expect(stored).toMatchObject({
        outcome: 'stored',
        kind: 'usage.daily',
        tenantId: tenant.id,
        report: usage,
      });
    });
  });
});
