import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AdminTenantLimits,
  AdminTenantsService,
  DIRECT_TENANT_CREATIONS,
  TENANT_OPERATIONS,
} from '../../src/admin/admin-tenants.service.js';
import type { OwnerCallResult, WorkerOwnerClient } from '../../src/admin/worker-owner-client.js';
import { AuditService } from '../../src/audit/audit.service.js';
import type { AppConfig } from '../../src/common/config/config.module.js';
import { loadConfig } from '../../src/common/config/load-config.js';
import { ApiError } from '../../src/common/http/api-error.js';
import { TokenBucketLimiter } from '../../src/common/http/rate-limiter.js';
import { newUlid } from '../../src/common/ulid.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import { type ContractOutcome, ContractService } from '../../src/lifecycle/contract.service.js';
import { PricingTableStore } from '../../src/pricing/pricing-store.js';
import { QuoteStore } from '../../src/pricing/quote-store.js';
import { ProvisioningResumeService } from '../../src/provisioning/provisioning-resume.js';
import { ProvisioningStartService } from '../../src/provisioning/provisioning-start.js';
import { ProvisioningStore } from '../../src/provisioning/provisioning-store.js';
import { MemoryStepQueue } from '../../src/queue/memory-step-queue.js';
import { TenantStore } from '../../src/tenants/tenant-store.js';
import { silentLogger } from './access-fakes.js';
import { tenantIn } from './access-store-contract.js';
import { type FakeClock, MINUTE_MS } from './fake-clock.js';
import { fictitiousPriceTable } from './pricing-fixtures.js';
import { seedPublishedTable } from './pricing-seed.js';

export interface DirectTenantHarness {
  documents: DocumentStore;
  clock: FakeClock;
}

const OWNER = { email: 'responsavel@verax.example', requestId: 'req-console-0001' };
const OTHER_OWNER = { email: 'socia@verax.example' };
const DAY_MS = 24 * 60 * MINUTE_MS;

function ok(body: Record<string, unknown>): OwnerCallResult {
  return { ok: true, status: 200, body };
}

function refused(status: number, code: string): OwnerCallResult {
  return { ok: false, status, code };
}

/** O que a rota do worker responderia para o desfecho de uma operação de contrato (`lifecycle.controller.ts`). */
function contractResult(outcome: ContractOutcome): OwnerCallResult {
  switch (outcome.kind) {
    case 'canceled':
      return ok({
        result: 'canceled',
        deleteAfter: outcome.deleteAfter?.toISOString(),
        cryptoDestroyAfter: outcome.cryptoDestroyAfter?.toISOString(),
      });
    case 'scheduled':
      return ok({ result: 'scheduled', cancelAt: outcome.cancelAt.toISOString() });
    case 'suspended':
    case 'reactivated':
      return ok({ result: outcome.kind, state: outcome.state });
    case 'not_found':
      return refused(404, 'not_found');
    case 'confirmation_mismatch':
      return refused(400, 'confirmation_mismatch');
    case 'not_contract':
      return refused(409, 'stripe_managed');
    case 'invalid_date':
      return refused(400, 'invalid_date');
    case 'not_allowed':
      return refused(409, 'not_allowed');
  }
}

/**
 * O cp-worker sem HTTP: as mesmas operações que as rotas `/internal/tenants/:id/...` chamam, com o ator que
 * `ownerActorOf` tiraria do `actor` (o par rota + cliente HTTP é testado em `test/admin-tenants.test.ts`). A exclusão e
 * a exportação (com as APIs da nuvem) ficam no teste do CP-11; aqui respondem como o worker responderia a um cliente
 * que não está cancelado. Pode ficar fora do ar (`down`), como o worker que não responde.
 */
class InProcessWorker implements WorkerOwnerClient {
  down = false;
  calls: { operation: string; tenantId: string; actor: string }[] = [];

  constructor(
    private readonly starts: ProvisioningStartService,
    private readonly resumes: ProvisioningResumeService,
    private readonly contracts: ContractService,
  ) {}

  private reached(operation: string, tenantId: string, actor: string): boolean {
    this.calls.push({ operation, tenantId, actor });
    return !this.down;
  }

  async provision(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult> {
    if (!this.reached('provision', tenantId, actor)) return refused(0, 'worker_unreachable');
    const outcome = await this.starts.start(tenantId, confirmSlug, `owner:${actor}`);
    if (outcome.started) return ok({ runId: outcome.runId, step: outcome.step });
    const codes = {
      not_found: 404,
      confirmation_mismatch: 400,
      not_contract: 409,
      not_allowed: 409,
    } as const;
    return refused(
      codes[outcome.reason],
      outcome.reason === 'not_contract' ? 'stripe_managed' : outcome.reason,
    );
  }

  async resume(tenantId: string, actor: string): Promise<OwnerCallResult> {
    if (!this.reached('resume', tenantId, actor)) return refused(0, 'worker_unreachable');
    const outcome = await this.resumes.resume(tenantId, `owner:${actor}`);
    if (outcome.resumed) return ok({ runId: outcome.runId, step: outcome.step });
    return refused(outcome.reason === 'not_found' ? 404 : 409, outcome.reason);
  }

  async cancel(tenantId: string, confirmSlug: string, actor: string, at?: Date): Promise<OwnerCallResult> {
    if (!this.reached('cancel', tenantId, actor)) return refused(0, 'worker_unreachable');
    return contractResult(await this.contracts.cancel(tenantId, confirmSlug, at, `owner:${actor}`));
  }

  async suspend(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult> {
    if (!this.reached('suspend', tenantId, actor)) return refused(0, 'worker_unreachable');
    return contractResult(await this.contracts.suspend(tenantId, confirmSlug, `owner:${actor}`));
  }

  async reactivate(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult> {
    if (!this.reached('reactivate', tenantId, actor)) return refused(0, 'worker_unreachable');
    return contractResult(await this.contracts.reactivate(tenantId, confirmSlug, `owner:${actor}`));
  }

  deleteNow(tenantId: string, _confirmSlug: string, actor: string): Promise<OwnerCallResult> {
    this.reached('delete-now', tenantId, actor);
    return Promise.resolve(refused(409, 'not_canceled'));
  }

  exportLink(tenantId: string, _object: string, actor: string): Promise<OwnerCallResult> {
    this.reached('export', tenantId, actor);
    return Promise.resolve(refused(409, 'not_canceled'));
  }
}

/** O pedido de cadastro que o console manda, com a chave nova e a configuração mínima da tabela fictícia (porte P). */
function directRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const slug = typeof overrides['slug'] === 'string' ? overrides['slug'] : 'cliente-direto-a';
  return {
    idempotencyKey: newUlid(),
    companyName: 'Cliente Demo A Ltda',
    cnpj: '11.222.333/0001-81',
    adminEmail: 'admin@cliente-demo-a.example',
    slug,
    configuration: {
      mode: 'managed',
      cloudAccounts: 2,
      monthlyGib: 10,
      agents: 0,
      historyDays: 30,
      support: 'standard',
    },
    confirmSlug: slug,
    ...overrides,
  };
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  const api = error as ApiError;
  expect(api.getStatus()).toBe(status);
  expect(api.code).toBe(code);
  return api;
}

/**
 * O cadastro de um cliente de contrato direto pelo console e as operações do responsável sobre um `DocumentStore`:
 * rodado contra o dublê em memória (`src/admin/admin-tenants.service.test.ts`) e contra o emulador oficial do
 * Firestore (`test/firestore-emulator-tenants.test.ts`). A tabela de preços é a FICTÍCIA dos testes.
 */
export function describeDirectTenantContract(
  name: string,
  factory: () => Promise<DirectTenantHarness>,
): void {
  describe(`cliente de contrato direto pelo console (${name})`, () => {
    let h: DirectTenantHarness;
    let tenants: TenantStore;
    let audit: AuditService;
    let runs: ProvisioningStore;
    let queue: MemoryStepQueue;
    let worker: InProcessWorker;
    let limits: AdminTenantLimits;
    let service: AdminTenantsService;
    let config: AppConfig;

    async function auditActions(): Promise<{ actor: string; action: string; tenantId?: string }[]> {
      const docs = await h.documents.query(COLLECTIONS.auditLog, { orderBy: { field: 'at' } });
      return docs.map(({ data }) => ({
        actor: String(data['actor']),
        action: String(data['action']),
        ...(typeof data['tenantId'] === 'string' ? { tenantId: data['tenantId'] } : {}),
      }));
    }

    function build(client: WorkerOwnerClient | null): AdminTenantsService {
      return new AdminTenantsService(
        tenants,
        runs,
        new PricingTableStore(h.documents, h.clock, audit),
        new QuoteStore(h.documents, h.clock),
        audit,
        client,
        limits,
        config,
        h.clock,
        silentLogger(),
      );
    }

    beforeEach(async () => {
      h = await factory();
      audit = new AuditService(h.documents, h.clock);
      tenants = new TenantStore(h.documents, h.clock, audit);
      runs = new ProvisioningStore(h.documents, h.clock);
      queue = new MemoryStepQueue();
      worker = new InProcessWorker(
        new ProvisioningStartService(tenants, queue, h.clock, silentLogger()),
        new ProvisioningResumeService(tenants, queue, h.clock, silentLogger()),
        new ContractService(tenants, audit, queue, h.clock, silentLogger()),
      );
      limits = {
        creations: new TokenBucketLimiter(DIRECT_TENANT_CREATIONS, h.clock),
        operations: new TokenBucketLimiter(TENANT_OPERATIONS, h.clock),
      };
      config = loadConfig({
        ROLE: 'admin',
        NODE_ENV: 'test',
        IAP_AUDIENCE: '/projects/111111111111/locations/southamerica-east1/services/cp-admin',
        OWNER_PRINCIPALS: `${OWNER.email},${OTHER_OWNER.email}`,
      });
      service = build(worker);
      await seedPublishedTable(h.documents, fictitiousPriceTable(), {
        effectiveFrom: new Date(h.clock.now().getTime() - MINUTE_MS),
      });
    });

    it('cria em pending com billing.mode contract, sem Stripe nem aceite, e o worker põe em provisioning no preflight', async () => {
      const request = directRequest();
      const created = await service.create(request, OWNER);

      expect(created).toMatchObject({
        id: request['idempotencyKey'],
        slug: 'cliente-direto-a',
        replayed: false,
        provisioning: { started: true, step: 'preflight' },
      });
      const tenant = await tenants.require(created.id);
      expect(tenant).toMatchObject({
        slug: 'cliente-direto-a',
        state: 'provisioning',
        billing: { mode: 'contract' },
        company: { legalName: 'Cliente Demo A Ltda', cnpj: '11222333000181' },
        adminEmail: 'admin@cliente-demo-a.example',
        configuration: { mode: 'managed', size: 'P', cloudAccounts: 2 },
        limits: { maxCloudAccounts: 2, maxAgents: 0, maxUsers: 10 },
        pricing: { priceTableVersion: 'teste-v1', monthlyTotal: 100_000, setupTotal: 0 },
        provisioning: { step: 'preflight', attempts: 0 },
      });
      expect(tenant.stripe).toBeUndefined();
      expect(tenant.consent).toBeUndefined();
      expect((await tenants.getSlug('cliente-direto-a'))?.state).toBe('taken');
      // A cotação de referência fica gravada como a de um cliente pago (24 h).
      const quote = await new QuoteStore(h.documents, h.clock).getValid(tenant.pricing.quoteId);
      expect(quote?.monthlyTotal).toBe(100_000);
      // O preflight da execução nova na fila, como o webhook faria com um pagamento.
      expect(queue.tasks.map((task) => [task.queue, task.step, task.runId])).toEqual([
        ['provisioning', 'preflight', tenant.provisioning?.runId],
      ]);
      expect(await tenants.listTransitions(created.id)).toMatchObject([
        { from: null, to: 'pending', reason: 'contract_created' },
        { from: 'pending', to: 'provisioning', reason: 'contract_provisioning_started' },
      ]);
      // Tudo auditado com o e-mail do responsável que o IAP confirmou, nunca com a conta do console.
      expect(await auditActions()).toEqual([
        { actor: `owner:${OWNER.email}`, action: 'tenant.create', tenantId: created.id },
        { actor: `owner:${OWNER.email}`, action: 'tenant.transition', tenantId: created.id },
        { actor: `owner:${OWNER.email}`, action: 'tenant.console_request', tenantId: created.id },
      ]);
      const createAudit = (await audit.listForTenant(created.id))[0];
      expect(createAudit?.details).toMatchObject({
        slug: 'cliente-direto-a',
        billingMode: 'contract',
        size: 'P',
      });
      expect(createAudit?.requestId).toBe(OWNER.requestId);
      expect(worker.calls).toEqual([{ operation: 'provision', tenantId: created.id, actor: OWNER.email }]);
    });

    it('idempotente: o mesmo envio de novo devolve o mesmo cliente, sem outro cadastro nem outra task', async () => {
      const request = directRequest();
      const first = await service.create(request, OWNER);
      h.clock.advance(MINUTE_MS);
      const again = await service.create(request, OWNER);

      expect(again).toMatchObject({
        id: first.id,
        replayed: true,
        provisioning: { started: true, step: 'preflight' },
      });
      const { tenants: all } = await tenants.listRecent(10);
      expect(all.map((tenant) => tenant.id)).toEqual([first.id]);
      expect(queue.tasks).toHaveLength(1);
      expect((await auditActions()).filter((entry) => entry.action === 'tenant.create')).toHaveLength(1);
    });

    it('dois envios da mesma chave ao mesmo tempo (clique duplo) criam um cliente só', async () => {
      const request = directRequest();
      const results = await Promise.all([service.create(request, OWNER), service.create(request, OWNER)]);

      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      const { tenants: all } = await tenants.listRecent(10);
      expect(all).toHaveLength(1);
      expect(all[0]?.state).toBe('provisioning');
      expect(queue.tasks).toHaveLength(1);
    });

    it('a mesma chave com outro pedido é recusada (409), e nada muda', async () => {
      const request = directRequest();
      const created = await service.create(request, OWNER);
      const original = await tenants.require(created.id);
      const changed: Record<string, unknown>[] = [
        { ...request, cnpj: '22.333.444/0001-81' },
        { ...request, companyName: 'Outro Nome Demo Ltda' },
        { ...request, adminEmail: 'outro@cliente-demo-a.example' },
        // Outra configuração (3 contas em vez das 2 incluídas): outro contrato, não a repetição deste.
        {
          ...request,
          configuration: { ...(request['configuration'] as Record<string, unknown>), cloudAccounts: 3 },
        },
        {
          ...request,
          configuration: { ...(request['configuration'] as Record<string, unknown>), support: 'priority' },
        },
      ];
      for (const body of changed) {
        await expectApiError(service.create(body, OWNER), 409, 'idempotency_conflict');
      }
      // O cliente gravado continua o do primeiro pedido.
      expect(await tenants.require(created.id)).toEqual(original);
      // A chave de um cliente da Stripe (o id dele) também não vira cadastro de contrato.
      const paid = await tenantIn(tenants, 'cliente-pago-b', 'pending');
      await expectApiError(
        service.create(directRequest({ idempotencyKey: paid.id, slug: 'cliente-pago-b' }), OWNER),
        409,
        'idempotency_conflict',
      );
      expect((await tenants.require(paid.id)).state).toBe('pending');
      expect((await auditActions()).filter((entry) => entry.action === 'tenant.create_refused')).toHaveLength(
        6,
      );
    });

    it('o mesmo envio de novo com o cliente parado no preflight (a fila falhou) pede o provision de novo e põe a task', async () => {
      const request = directRequest();
      // O worker muda o estado para `provisioning` e falha ao enfileirar o `preflight`.
      queue.failNext(new Error('fila fora do ar'));
      const first = await service.create(request, OWNER);
      expect(first.provisioning).toEqual({ started: false, failure: 'worker_unavailable' });
      const stuck = await tenants.require(first.id);
      expect(stuck).toMatchObject({ state: 'provisioning', provisioning: { step: 'preflight' } });
      expect(queue.tasks).toHaveLength(0);

      const again = await service.create(request, OWNER);
      expect(again).toMatchObject({
        id: first.id,
        replayed: true,
        provisioning: { started: true, runId: stuck.provisioning?.runId, step: 'preflight' },
      });
      expect(queue.tasks.map((task) => [task.step, task.runId])).toEqual([
        ['preflight', stuck.provisioning?.runId],
      ]);
      expect(worker.calls.map((call) => call.operation)).toEqual(['provision', 'provision']);
      // Depois do preflight, a repetição só devolve a execução, sem pedir nada ao worker.
      await tenants.change(first.id, () => ({
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (tenant) => ({
          ...tenant,
          provisioning: { ...(tenant.provisioning ?? { attempts: 0 }), step: 'cloudflare.tunnel' },
        }),
      }));
      expect((await service.create(request, OWNER)).provisioning).toMatchObject({
        started: true,
        step: 'cloudflare.tunnel',
      });
      expect(worker.calls).toHaveLength(2);
    });

    it('subdomínio de outro cliente, reservado ou da lista da Verax: 409, nada gravado', async () => {
      await tenantIn(tenants, 'cliente-pago-c', 'active');
      for (const slug of ['cliente-pago-c', 'admin', 'verax']) {
        const request = directRequest({ slug });
        await expectApiError(service.create(request, OWNER), 409, 'slug_unavailable');
        expect(await tenants.get(String(request['idempotencyKey']))).toBeUndefined();
      }
      expect(queue.tasks).toHaveLength(0);
      expect(worker.calls).toHaveLength(0);
    });

    it('sem o cp-worker: o cliente fica em pending, e o "Iniciar provisionamento" depois o põe em provisioning', async () => {
      worker.down = true;
      const created = await service.create(directRequest(), OWNER);
      expect(created.provisioning).toEqual({ started: false, failure: 'worker_unavailable' });
      expect((await tenants.require(created.id)).state).toBe('pending');
      expect((await service.detail(created.id)).actions).toMatchObject({
        start: true,
        resume: false,
        cancel: true,
      });

      worker.down = false;
      await expectApiError(
        service.act('start', created.id, { confirmSlug: 'outro' }, OWNER),
        400,
        'confirmation_mismatch',
      );
      const started = await service.act('start', created.id, { confirmSlug: 'cliente-direto-a' }, OWNER);
      expect(started).toMatchObject({ action: 'start', step: 'preflight' });
      expect((await tenants.require(created.id)).state).toBe('provisioning');
      // Iniciar de novo, já em provisioning no preflight: só garante a task (a mesma).
      await service.act('start', created.id, { confirmSlug: 'cliente-direto-a' }, OWNER);
      expect(queue.tasks).toHaveLength(1);
      const outcomes = (await audit.listForTenant(created.id))
        .filter((entry) => entry.action.startsWith('tenant.console_request'))
        .map((entry) => [entry.action, entry.details?.['outcome'] ?? entry.details?.['code']]);
      expect(outcomes).toEqual([
        ['tenant.console_request', 'worker_unavailable'],
        ['tenant.console_request_refused', 'confirmation_mismatch'],
        ['tenant.console_request', 'ok'],
        ['tenant.console_request', 'ok'],
      ]);
    });

    it('sem WORKER_URL no console: o cadastro fica em pending e as operações respondem 503 worker_unconfigured', async () => {
      const offline = build(null);
      const created = await offline.create(directRequest(), OWNER);
      expect(created.provisioning).toEqual({ started: false, failure: 'worker_unconfigured' });
      await expectApiError(
        offline.act('start', created.id, { confirmSlug: 'cliente-direto-a' }, OWNER),
        503,
        'worker_unconfigured',
      );
    });

    it('um cliente da Stripe nunca começa, nem é cancelado ou suspenso pelo console (409 stripe_managed)', async () => {
      const paid = await tenantIn(tenants, 'cliente-pago-d', 'pending');
      await expectApiError(
        service.act('start', paid.id, { confirmSlug: 'cliente-pago-d' }, OWNER),
        409,
        'stripe_managed',
      );
      expect((await tenants.require(paid.id)).state).toBe('pending');
      const active = await tenantIn(tenants, 'cliente-pago-e', 'active');
      for (const action of ['cancel', 'suspend'] as const) {
        await expectApiError(
          service.act(action, active.id, { confirmSlug: 'cliente-pago-e' }, OWNER),
          409,
          'stripe_managed',
        );
      }
      expect((await service.detail(active.id)).actions).toEqual({
        start: false,
        resume: false,
        cancel: false,
        suspend: false,
        reactivate: false,
        deleteNow: false,
        export: false,
      });
    });

    it('retomar: só parado no provisionamento, com a confirmação; uma execução nova do preflight', async () => {
      const created = await service.create(directRequest(), OWNER);
      await tenants.change(created.id, () => ({
        to: 'provisioning_failed',
        reason: 'provisioning_failed:cloudflare_denied',
        audit: { actor: 'system' },
        mutate: (tenant) => ({
          ...tenant,
          provisioning: {
            ...(tenant.provisioning ?? { attempts: 0 }),
            lastError: { code: 'cloudflare_denied', at: h.clock.now() },
          },
        }),
      }));
      expect((await service.detail(created.id)).actions).toMatchObject({ start: false, resume: true });
      const firstRun = (await tenants.require(created.id)).provisioning?.runId;

      const resumed = await service.act('resume', created.id, { confirmSlug: 'cliente-direto-a' }, OWNER);
      expect(resumed.action).toBe('resume');
      const runId = 'runId' in resumed ? resumed.runId : undefined;
      expect(runId).not.toBe(firstRun);
      const tenant = await tenants.require(created.id);
      expect(tenant).toMatchObject({ state: 'provisioning', provisioning: { runId, attempts: 1 } });
      const resumeTransition = (await audit.listForTenant(created.id)).find(
        (entry) =>
          entry.action === 'tenant.transition' && entry.details?.['reason'] === 'provisioning_resumed',
      );
      expect(resumeTransition?.actor).toBe(`owner:${OWNER.email}`);

      const active = await tenantIn(tenants, 'cliente-pago-f', 'active');
      await expectApiError(
        service.act('resume', active.id, { confirmSlug: 'cliente-pago-f' }, OWNER),
        409,
        'not_resumable',
      );
      await expectApiError(
        service.act('resume', newUlid(), { confirmSlug: 'x' }, OWNER),
        404,
        'tenant_not_found',
      );
      await expectApiError(
        service.act('resume', 'nao-e-ulid', { confirmSlug: 'x' }, OWNER),
        404,
        'tenant_not_found',
      );
      await expectApiError(
        service.act('resume', active.id, { confirmSlug: 'x', outro: 1 }, OWNER),
        400,
        'invalid_request',
      );
    });

    it('contrato direto: suspender, reativar e cancelar com data (o fim do contrato) e agora, pelo console', async () => {
      const created = await service.create(directRequest(), OWNER);
      await tenants.change(created.id, () => ({
        to: 'waiting_customer_connection',
        reason: 'teste',
        audit: { actor: 'system' },
      }));
      await tenants.change(created.id, () => ({ to: 'active', reason: 'teste', audit: { actor: 'system' } }));
      const confirm = { confirmSlug: 'cliente-direto-a' };

      expect(await service.act('suspend', created.id, confirm, OWNER)).toEqual({
        action: 'suspend',
        state: 'suspended',
      });
      expect((await service.detail(created.id)).actions).toMatchObject({
        suspend: false,
        reactivate: true,
        cancel: true,
      });
      expect(await service.act('reactivate', created.id, confirm, OWNER)).toEqual({
        action: 'reactivate',
        state: 'active',
      });

      const end = new Date(h.clock.now().getTime() + 30 * DAY_MS);
      expect(await service.act('cancel', created.id, { ...confirm, at: end.toISOString() }, OWNER)).toEqual({
        action: 'cancel',
        result: 'scheduled',
        cancelAt: end.toISOString(),
      });
      expect((await service.detail(created.id)).lifecycle.cancelScheduledFor).toEqual(end);
      await expectApiError(
        service.act(
          'cancel',
          created.id,
          { ...confirm, at: new Date(h.clock.now().getTime() - DAY_MS).toISOString() },
          OWNER,
        ),
        400,
        'invalid_date',
      );
      const now = await service.act('cancel', created.id, confirm, OWNER);
      expect(now).toMatchObject({ action: 'cancel', result: 'canceled' });
      const detail = await service.detail(created.id);
      expect(detail.state).toBe('canceled');
      expect(detail.lifecycle.deleteAfter).toBeInstanceOf(Date);
      expect(detail.actions).toMatchObject({ cancel: false, deleteNow: true, export: true });
      // Cada operação foi do responsável que o IAP confirmou.
      expect(
        worker.calls
          .filter((call) => call.operation !== 'provision')
          .every((call) => call.actor === OWNER.email),
      ).toBe(true);
    });

    it('limite de cadastros por responsável: o sexto na mesma hora é 429; a repetição de um envio não conta', async () => {
      const first = directRequest({ slug: 'cliente-limite-0' });
      await service.create(first, OTHER_OWNER);
      await service.create(first, OTHER_OWNER);
      for (let index = 1; index < 5; index += 1) {
        await service.create(directRequest({ slug: `cliente-limite-${index}` }), OTHER_OWNER);
      }
      await expectApiError(
        service.create(directRequest({ slug: 'cliente-limite-9' }), OTHER_OWNER),
        429,
        'rate_limited',
      );
      // O balde é de cada responsável.
      await service.create(directRequest({ slug: 'cliente-limite-8' }), OWNER);
      // Uma hora depois, volta.
      h.clock.advance(60 * MINUTE_MS);
      await service.create(directRequest({ slug: 'cliente-limite-9' }), OTHER_OWNER);
    });

    it('a lista traz os mais novos primeiro, com o modo de cobrança, e conta (sem quebrar) um documento fora do formato', async () => {
      const paid = await tenantIn(tenants, 'cliente-pago-g', 'active');
      h.clock.advance(MINUTE_MS);
      const created = await service.create(directRequest(), OWNER);
      await h.documents.runTransaction((tx) => {
        tx.set(COLLECTIONS.tenants, newUlid(), { slug: 'quebrado', createdAt: h.clock.now() });
        return Promise.resolve();
      });

      const list = await service.list();
      expect(list.unreadable).toBe(1);
      expect(list.tenants.map((item) => [item.id, item.billingMode, item.state])).toEqual([
        [created.id, 'contract', 'provisioning'],
        [paid.id, 'stripe', 'active'],
      ]);
      expect(list.tenants[0]).toMatchObject({
        companyName: 'Cliente Demo A Ltda',
        size: 'P',
        step: 'preflight',
      });
    });

    it('o detalhe traz a linha do tempo dos dez passos na ordem, com o andamento de cada um', async () => {
      const created = await service.create(directRequest(), OWNER);
      const runId = (await tenants.require(created.id)).provisioning?.runId ?? '';
      await runs.ensureRun(runId, created.id, 'provision');
      await runs.updateStep(runId, 'preflight', (_current, at) => ({
        ...runs.newStep(at),
        status: 'done',
        attempts: 1,
        finishedAt: at,
      }));
      await runs.updateStep(runId, 'cloudflare.tunnel', (_current, at) => ({
        ...runs.newStep(at),
        status: 'running',
        attempts: 3,
        errorCode: 'cloudflare_503',
      }));

      const detail = await service.detail(created.id);
      expect(detail).toMatchObject({
        id: created.id,
        billingMode: 'contract',
        state: 'provisioning',
        urls: {
          panelUrl: 'https://cliente-direto-a.control.veraxsistemas.com.br',
          apiUrl: 'https://api-cliente-direto-a.veraxsistemas.com.br',
        },
        run: { runId, kind: 'provision' },
        actions: { start: false, resume: true },
        lifecycle: {},
      });
      expect(detail.timeline.map((step) => [step.name, step.status, step.attempts, step.errorCode])).toEqual([
        ['preflight', 'done', 1, undefined],
        ['cloudflare.tunnel', 'running', 3, 'cloudflare_503'],
        ['firebase.site', 'pending', 0, undefined],
        ['terraform.apply', 'pending', 0, undefined],
        ['terraform.wait', 'pending', 0, undefined],
        ['secrets.tunnel_token', 'pending', 0, undefined],
        ['node.wait_ready', 'pending', 0, undefined],
        ['node.health', 'pending', 0, undefined],
        ['panel.domain_wait', 'pending', 0, undefined],
        ['access.ready', 'pending', 0, undefined],
      ]);
      expect(detail.transitions.map((transition) => transition.to)).toEqual(['pending', 'provisioning']);
      await expectApiError(service.detail(newUlid()), 404, 'tenant_not_found');
    });
  });
}
