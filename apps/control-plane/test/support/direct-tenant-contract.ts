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
import { enrollmentHash } from '../../src/enrollment/enrollment.js';
import { EnrollmentService } from '../../src/enrollment/enrollment.service.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import { type ContractOutcome, ContractService } from '../../src/lifecycle/contract.service.js';
import { PricingTableStore } from '../../src/pricing/pricing-store.js';
import { QuoteStore } from '../../src/pricing/quote-store.js';
import { ProvisioningResumeService } from '../../src/provisioning/provisioning-resume.js';
import { ProvisioningStartService } from '../../src/provisioning/provisioning-start.js';
import { ProvisioningStore } from '../../src/provisioning/provisioning-store.js';
import { InstallationService } from '../../src/provisioning/installation.js';
import { releaseKeyFingerprint } from '../../src/provisioning/release-manifest.js';
import type { ProvisioningApis } from '../../src/provisioning/provisioning-settings.js';
import { MemoryStepQueue } from '../../src/queue/memory-step-queue.js';
import { TenantStore } from '../../src/tenants/tenant-store.js';
import { silentLogger } from './access-fakes.js';
import { tenantIn } from './access-store-contract.js';
import { type FakeClock, MINUTE_MS } from './fake-clock.js';
import { fictitiousPriceTable } from './pricing-fixtures.js';
import { seedPublishedTable } from './pricing-seed.js';
import { manifestFor, TestReleaseKey } from './release-fixtures.js';

const RELEASES = 'projeto-exemplo-releases';
const RELEASE = 'node-v1.2.3';

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
    private readonly installations: InstallationService,
    private readonly enrollments: EnrollmentService,
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
      customer_hosted: 409,
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

  async installation(tenantId: string, actor: string): Promise<OwnerCallResult> {
    if (!this.reached('installation', tenantId, actor)) return refused(0, 'worker_unreachable');
    const outcome = await this.installations.details(tenantId);
    if (outcome.ok) return ok(JSON.parse(JSON.stringify(outcome.details)) as Record<string, unknown>);
    const status = {
      not_found: 404,
      not_customer_hosted: 409,
      not_allowed: 409,
      release_unconfigured: 503,
      release_manifest_missing: 503,
      release_manifest_invalid: 502,
      release_unavailable: 503,
    } as const;
    return refused(status[outcome.reason], outcome.reason);
  }

  async enrollmentCode(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult> {
    if (!this.reached('enrollment-code', tenantId, actor)) return refused(0, 'worker_unreachable');
    const outcome = await this.enrollments.issueCode(tenantId, confirmSlug, `owner:${actor}`);
    if (outcome.issued) {
      return ok({
        code: outcome.code,
        expiresAt: outcome.expiresAt.toISOString(),
        reinstall: outcome.reinstall,
        ...(outcome.run === undefined ? {} : { runId: outcome.run.runId, step: outcome.run.step }),
      });
    }
    const status = {
      not_found: 404,
      confirmation_mismatch: 400,
      not_customer_hosted: 409,
      not_allowed: 409,
    } as const;
    return refused(status[outcome.reason], outcome.reason);
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

/**
 * O pedido de cadastro que o console manda, com a chave nova e a configuração mínima da tabela fictícia (porte P): a
 * Plataforma na infraestrutura da Verax e, no cliente (onde a Plataforma não existe), o Dedicado.
 */
function directRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const slug = typeof overrides['slug'] === 'string' ? overrides['slug'] : 'cliente-direto-a';
  const customer = overrides['hosting'] === 'customer';
  return {
    idempotencyKey: newUlid(),
    companyName: 'Cliente Demo A Ltda',
    cnpj: '11.222.333/0001-81',
    adminEmail: 'admin@cliente-demo-a.example',
    slug,
    hosting: 'verax',
    configuration: customer ? { plan: 'dedicado', gbDay: 3 } : { plan: 'plataforma', gbDay: 2 },
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
    /** O bucket de releases do cp-worker (objeto → conteúdo) e a chave de release dos testes. */
    let releases: Map<string, Buffer>;
    let releaseKey: TestReleaseKey;
    let workerConfig: AppConfig;

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
      releases = new Map();
      releaseKey = new TestReleaseKey();
      const manifest = manifestFor(RELEASE);
      releases.set(`${RELEASE}/manifest.json`, manifest);
      releases.set(`${RELEASE}/manifest.json.sig`, releaseKey.sign(manifest));
      // Uma cópia sem o congelamento do loadConfig: um teste tira a versão do nó.
      workerConfig = {
        ...loadConfig({ ROLE: 'worker', NODE_ENV: 'test', RELEASE_BUCKET: RELEASES, NODE_RELEASE: RELEASE }),
      };
      // Só o bucket de releases: qualquer outra API da nuvem quebraria o teste (nada deve ser chamado).
      const apis = {
        storage: {
          read: (bucket: string, object: string): Promise<Buffer | undefined> =>
            Promise.resolve(bucket === RELEASES ? releases.get(object) : undefined),
        },
        get releaseKeys() {
          return releaseKey.keys;
        },
      } as unknown as ProvisioningApis;
      worker = new InProcessWorker(
        new ProvisioningStartService(tenants, queue, h.clock, silentLogger()),
        new ProvisioningResumeService(tenants, queue, h.clock, silentLogger()),
        new ContractService(tenants, audit, queue, h.clock, silentLogger()),
        new InstallationService(tenants, apis, workerConfig, silentLogger()),
        new EnrollmentService(tenants, audit, apis, queue, workerConfig, h.clock, silentLogger()),
      );
      limits = {
        creations: new TokenBucketLimiter(DIRECT_TENANT_CREATIONS, h.clock),
        operations: new TokenBucketLimiter(TENANT_OPERATIONS, h.clock),
      };
      config = loadConfig({
        ROLE: 'admin',
        NODE_ENV: 'test',
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
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
        configuration: { plan: 'plataforma', mode: 'managed', gbDay: 2, size: 'P' },
        limits: { maxCloudAccounts: 50, monthlyGib: 58, maxAgents: 0, maxUsers: 10 },
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
      // Tudo auditado com o e-mail do responsável da sessão, nunca com a conta do console.
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

    // --- Os valores do contrato: a referência da tabela e o negociado por fora (FICTÍCIOS) ---------------------------

    it('a cotação traz a referência do contrato: o mensal e o preço de um GB/dia a mais, nos dois lugares', async () => {
      expect(
        await service.preview({ hosting: 'verax', configuration: { plan: 'plataforma', gbDay: 3 } }),
      ).toMatchObject({
        contactUs: false,
        quote: { monthlyTotal: 130_000 },
        reference: { monthlyTotal: 130_000, additionalGbDayAmount: 30_000 },
      });
      const verax = await service.preview({ hosting: 'verax', configuration: { plan: 'vciso', gbDay: 4 } });
      const customer = await service.preview({
        hosting: 'customer',
        configuration: { plan: 'vciso', gbDay: 4 },
      });
      if (verax.contactUs || customer.contactUs) throw new Error('sob consulta');
      // No cliente, calculado exatamente como na infraestrutura da Verax.
      expect(customer.reference).toEqual(verax.reference);
      expect(customer.reference).toEqual({ monthlyTotal: 400_000, additionalGbDayAmount: 50_000 });
    });

    it('sem negociação: o contratado é a referência da tabela, no cliente, na auditoria e no detalhe', async () => {
      const created = await service.create(directRequest(), OWNER);
      const reference = { monthlyTotal: 100_000, additionalGbDayAmount: 30_000 };
      expect((await tenants.require(created.id)).contractPricing).toEqual({
        reference,
        contracted: reference,
      });
      expect((await audit.listForTenant(created.id))[0]?.details).toMatchObject({
        contractPricing: { reference, contracted: reference },
      });
      expect((await service.detail(created.id)).contractPricing).toEqual({
        reference,
        contracted: reference,
      });
    });

    it('negociado por fora: grava o contratado ao lado da referência, audita os dois e o detalhe mostra', async () => {
      const contracted = { monthlyTotal: 120_000, additionalGbDayAmount: 40_000 };
      const request = directRequest({
        hosting: 'customer',
        slug: 'cliente-negocia',
        configuration: { plan: 'dedicado', gbDay: 3 },
        contracted,
      });
      const created = await service.create(request, OWNER);
      const reference = { monthlyTotal: 150_000, additionalGbDayAmount: 50_000 };
      const tenant = await tenants.require(created.id);
      // A referência da tabela continua em `pricing` (a cotação gravada) e em `contractPricing.reference`.
      expect(tenant.pricing).toMatchObject({ monthlyTotal: 150_000, setupTotal: 0 });
      expect(tenant.contractPricing).toEqual({ reference, contracted });
      const createAudit = (await audit.listForTenant(created.id))[0];
      expect(createAudit).toMatchObject({
        actor: `owner:${OWNER.email}`,
        action: 'tenant.create',
        details: { contractPricing: { reference, contracted } },
      });
      expect((await service.detail(created.id)).contractPricing).toEqual({ reference, contracted });

      // O mesmo envio de novo é o mesmo cliente; com outro valor negociado (ou sem ele) é outro cadastro (409).
      expect(await service.create(request, OWNER)).toMatchObject({ id: created.id, replayed: true });
      for (const other of [{ ...contracted, monthlyTotal: 120_001 }, undefined]) {
        const { contracted: _contracted, ...withoutValues } = request;
        await expectApiError(
          service.create(other === undefined ? withoutValues : { ...request, contracted: other }, OWNER),
          409,
          'idempotency_conflict',
        );
      }
      expect((await tenants.require(created.id)).contractPricing).toEqual({ reference, contracted });
    });

    it('a repetição sem os valores bate com o cadastro que gravou a referência (o envio de antes do campo)', async () => {
      const request = directRequest();
      const created = await service.create(request, OWNER);
      const reference = { monthlyTotal: 100_000, additionalGbDayAmount: 30_000 };
      // Explicitamente a referência: é o mesmo pedido.
      expect(await service.create({ ...request, contracted: reference }, OWNER)).toMatchObject({
        id: created.id,
        replayed: true,
      });
    });

    it('valores fora dos limites, fracionados ou com campo a mais: 400 no campo, nada gravado, recusa auditada', async () => {
      const invalid: unknown[] = [
        { monthlyTotal: 0, additionalGbDayAmount: 30_000 },
        { monthlyTotal: -1, additionalGbDayAmount: 30_000 },
        { monthlyTotal: 100_000.5, additionalGbDayAmount: 30_000 },
        { monthlyTotal: 100_000_001, additionalGbDayAmount: 30_000 },
        { monthlyTotal: 100_000, additionalGbDayAmount: -1 },
        { monthlyTotal: 100_000, additionalGbDayAmount: 100_000_001 },
        { monthlyTotal: 100_000 },
        { monthlyTotal: 100_000, additionalGbDayAmount: 30_000, setupTotal: 0 },
        '100000',
      ];
      for (const contracted of invalid) {
        const request = directRequest({ contracted });
        const error = await expectApiError(service.create(request, OWNER), 400, 'invalid_request');
        expect(JSON.stringify(error.details)).toContain('contracted');
        expect(await tenants.get(String(request['idempotencyKey']))).toBeUndefined();
      }
      expect(await tenants.getSlug('cliente-direto-a')).toBeUndefined();
      expect((await auditActions()).filter((entry) => entry.action === 'tenant.create_refused')).toHaveLength(
        invalid.length,
      );
      // Os limites aceitos: o mensal a partir de 1 centavo e o GB/dia adicional sem custo (0).
      const created = await service.create(
        directRequest({ contracted: { monthlyTotal: 1, additionalGbDayAmount: 0 } }),
        OWNER,
      );
      expect((await tenants.require(created.id)).contractPricing?.contracted).toEqual({
        monthlyTotal: 1,
        additionalGbDayAmount: 0,
      });
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
        // Outra configuração (3 GB/dia em vez dos 2 incluídos, ou outro plano): outro contrato, não a repetição deste.
        { ...request, configuration: { plan: 'plataforma', gbDay: 3 } },
        { ...request, configuration: { plan: 'dedicado', gbDay: 3 } },
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
        enrollmentCode: false,
        // O aditivo é só do contrato direto.
        amend: false,
        amendHosting: false,
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
      // Cada operação foi do responsável da sessão.
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

    it('o detalhe traz a linha do tempo dos passos na ordem, com o andamento de cada um', async () => {
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
        ['secrets.smtp_password', 'pending', 0, undefined],
        ['secrets.tunnel_token', 'pending', 0, undefined],
        ['node.wait_ready', 'pending', 0, undefined],
        ['node.health', 'pending', 0, undefined],
        ['panel.domain_wait', 'pending', 0, undefined],
        ['access.ready', 'pending', 0, undefined],
      ]);
      expect(detail.transitions.map((transition) => transition.to)).toEqual(['pending', 'provisioning']);
      await expectApiError(service.detail(newUlid()), 404, 'tenant_not_found');
    });

    // --- O ambiente na infraestrutura do cliente (decisão de 06/11/2026) -------------------------------------------

    it('no cliente: nasce esperando a instalação, com a cotação da licença, sem pedir nada ao worker nem pôr task', async () => {
      const request = directRequest({ hosting: 'customer', slug: 'cliente-proprio' });
      const created = await service.create(request, OWNER);

      expect(created).toEqual({
        id: request['idempotencyKey'],
        slug: 'cliente-proprio',
        replayed: false,
        hosting: 'customer',
      });
      const tenant = await tenants.require(created.id);
      expect(tenant).toMatchObject({
        state: 'waiting_customer_install',
        hosting: 'customer',
        billing: { mode: 'contract' },
        // O Dedicado no cliente (FICTÍCIO): o mesmo preço por GB/dia da Verax, o porte pelo volume, sem implantação.
        configuration: { plan: 'dedicado', mode: 'self_hosted', gbDay: 3, size: 'P' },
        pricing: { priceTableVersion: 'teste-v1', monthlyTotal: 150_000, setupTotal: 0 },
      });
      expect(tenant.provisioning).toBeUndefined();
      expect(tenant.resources).toBeUndefined();
      // Nada na fila, nenhuma chamada ao cp-worker: nenhum passo do provisionamento, nenhum Terraform.
      expect(queue.tasks).toEqual([]);
      expect(worker.calls).toEqual([]);
      expect(await tenants.listTransitions(created.id)).toMatchObject([
        { from: null, to: 'waiting_customer_install', reason: 'contract_created_customer_hosted' },
      ]);
      expect(await auditActions()).toEqual([
        { actor: `owner:${OWNER.email}`, action: 'tenant.create', tenantId: created.id },
      ]);

      const detail = await service.detail(created.id);
      expect(detail).toMatchObject({ hosting: 'customer', state: 'waiting_customer_install', timeline: [] });
      expect(detail.urls).toBeUndefined();
      expect(detail.actions).toEqual({
        start: false,
        resume: false,
        cancel: true,
        suspend: false,
        reactivate: false,
        deleteNow: false,
        export: false,
        // O código de instalação da VM do cliente começa o provisionamento reduzido.
        enrollmentCode: true,
        // Nada instalado ainda: o aditivo pode mudar até onde o ambiente roda.
        amend: true,
        amendHosting: true,
      });
      expect((await service.list()).tenants[0]).toMatchObject({ id: created.id, hosting: 'customer' });

      // O mesmo envio de novo: o mesmo cliente, sem worker; trocar o lugar com a mesma chave é outro cadastro (409).
      expect(await service.create(request, OWNER)).toEqual({ ...created, replayed: true });
      await expectApiError(
        service.create({ ...request, hosting: 'verax' }, OWNER),
        409,
        'idempotency_conflict',
      );
      expect(worker.calls).toEqual([]);
      expect(queue.tasks).toEqual([]);
    });

    it('no cliente: o mesmo preço por GB/dia; o porte não impede; a Plataforma não existe lá', async () => {
      const configuration = { plan: 'dedicado', gbDay: 8 };
      const customer = await service.preview({ hosting: 'customer', configuration });
      expect(customer).toMatchObject({
        contactUs: false,
        quote: { configuration: { plan: 'dedicado', mode: 'self_hosted', gbDay: 8, size: 'M' } },
        problems: [],
      });
      // Na Verax, o mesmo volume pede o porte M: o provisionamento ainda não cria. O preço é o mesmo.
      const verax = await service.preview({ hosting: 'verax', configuration });
      expect(verax).toMatchObject({
        quote: { configuration: { mode: 'managed', size: 'M' } },
        problems: ['size'],
      });
      if (customer.contactUs || verax.contactUs) throw new Error('sob consulta');
      expect(customer.quote.lineItems).toEqual(verax.quote.lineItems);
      // A Plataforma é a célula da Verax: no cliente, sob consulta, e o cadastro é recusado com o motivo no plano.
      const plataforma = { plan: 'plataforma', gbDay: 2 };
      expect(await service.preview({ hosting: 'customer', configuration: plataforma })).toMatchObject({
        contactUs: true,
        reason: 'mode_unavailable',
      });
      const refusedRequest = directRequest({
        hosting: 'customer',
        slug: 'cliente-celula',
        configuration: plataforma,
      });
      const refused = await expectApiError(
        service.create(refusedRequest, OWNER),
        422,
        'configuration_contact_us',
      );
      expect(refused.details).toMatchObject({
        reason: 'mode_unavailable',
        issues: [
          {
            path: 'configuration.plan',
            message:
              'O SIEM Cloud roda só na célula da Verax: no ambiente do cliente, escolha o SIEM Dedicado ou o SIEM + vCISO.',
          },
        ],
      });
      expect(await tenants.get(String(refusedRequest['idempotencyKey']))).toBeUndefined();
      expect(await tenants.getSlug('cliente-celula')).toBeUndefined();
      // O lugar é obrigatório, e o modo não vem na configuração (sai do lugar).
      await expectApiError(service.preview({ configuration }), 400, 'invalid_request');
      await expectApiError(
        service.preview({ hosting: 'customer', configuration: { ...configuration, mode: 'self_hosted' } }),
        400,
        'invalid_request',
      );
      const created = await service.create(
        directRequest({ hosting: 'customer', slug: 'cliente-porte-m', configuration }),
        OWNER,
      );
      expect((await tenants.require(created.id)).configuration).toMatchObject({ size: 'M', gbDay: 8 });
    });

    it('no cliente: o worker recusa provisionar, retomar e suspender, e nada vai à fila nem muda', async () => {
      const created = await service.create(
        directRequest({ hosting: 'customer', slug: 'cliente-sem-no' }),
        OWNER,
      );
      const confirm = { confirmSlug: 'cliente-sem-no' };
      await expectApiError(service.act('start', created.id, confirm, OWNER), 409, 'customer_hosted');
      await expectApiError(service.act('resume', created.id, confirm, OWNER), 409, 'customer_hosted');
      await expectApiError(service.act('suspend', created.id, confirm, OWNER), 409, 'not_allowed');
      expect((await tenants.require(created.id)).state).toBe('waiting_customer_install');
      expect(queue.tasks).toEqual([]);
    });

    it('no cliente: cancelar só registra o fim do contrato, sem exportação nem pedido de parar VM', async () => {
      const created = await service.create(
        directRequest({ hosting: 'customer', slug: 'cliente-fim' }),
        OWNER,
      );
      const confirm = { confirmSlug: 'cliente-fim' };
      const end = new Date(h.clock.now().getTime() + 30 * DAY_MS);
      expect(await service.act('cancel', created.id, { ...confirm, at: end.toISOString() }, OWNER)).toEqual({
        action: 'cancel',
        result: 'scheduled',
        cancelAt: end.toISOString(),
      });

      const now = await service.act('cancel', created.id, confirm, OWNER);
      expect(now).toMatchObject({ action: 'cancel', result: 'canceled' });
      const tenant = await tenants.require(created.id);
      expect(tenant.state).toBe('canceled');
      expect(tenant.lifecycle?.canceledAt).toEqual(h.clock.now());
      // Sem janela de exportação: os dados nunca estiveram na Verax. O prazo só apaga o cadastro aqui.
      expect(tenant.lifecycle?.exportUntil).toBeUndefined();
      expect(tenant.lifecycle?.deleteAfter).toBeInstanceOf(Date);
      // Nenhum node.stop (a VM é do cliente) e nenhuma outra task.
      expect(queue.tasks).toEqual([]);
      expect((await service.detail(created.id)).actions).toMatchObject({ deleteNow: true, export: false });
    });

    it('instalação no cliente: a versão conferida, os endereços do release, o guia e o node.conf do contrato', async () => {
      const created = await service.create(
        directRequest({
          hosting: 'customer',
          slug: 'cliente-instala',
          configuration: { plan: 'vciso', gbDay: 4 },
        }),
        OWNER,
      );
      const installation = await service.installation(created.id, OWNER);
      const github = 'https://github.com/williandotdev/verax-control';
      expect(installation).toEqual({
        release: RELEASE,
        commit: 'abcdef0123456789abcdef0123456789abcdef01',
        releasedAt: '2026-11-05T12:00:00Z',
        releaseUrl: `${github}/releases/tag/${RELEASE}`,
        manifestUrl: `${github}/releases/download/${RELEASE}/manifest.json`,
        signatureUrl: `${github}/releases/download/${RELEASE}/manifest.json.sig`,
        guideUrl: `${github}/blob/main/docs/runbooks/instalacao-no-cliente.md`,
        package: {
          url: `${github}/releases/download/${RELEASE}/verax-node.tar.gz`,
          sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        images: {
          api: `ghcr.io/williandotdev/verax-control/api@sha256:${'1'.repeat(64)}`,
          migrate: `ghcr.io/williandotdev/verax-control/migrate@sha256:${'2'.repeat(64)}`,
        },
        thirdPartyImages: [`postgres:18-alpine@sha256:${'3'.repeat(64)}`],
        // A chave que fechou a assinatura (a dos testes) e a impressão digital dela, para conferir fora do GitHub.
        releaseKey: { name: 'release-teste', sha256: releaseKeyFingerprint(releaseKey.publicPem) },
        // O porte do contrato, para o console sugerir o perfil da VM.
        size: 'P',
        nodeConf: [
          { name: 'PLAN', value: 'enterprise' },
          { name: 'PLAN_MAX_CLOUD_ACCOUNTS', value: '100' },
          { name: 'PLAN_MONTHLY_GIB', value: '116' },
          { name: 'PLAN_HISTORY_DAYS', value: '60' },
          { name: 'PLAN_MAX_USERS', value: '10' },
          { name: 'WAZUH_AGENTS', value: 'false' },
        ],
      });
      expect(worker.calls).toEqual([{ operation: 'installation', tenantId: created.id, actor: OWNER.email }]);
      // Só leitura: nada gravado, nada na fila.
      expect(queue.tasks).toEqual([]);
      expect((await tenants.require(created.id)).state).toBe('waiting_customer_install');
    });

    it('código de instalação: o primeiro começa o provisionamento reduzido; o código só na resposta, o hash no cliente', async () => {
      const created = await service.create(
        directRequest({
          hosting: 'customer',
          slug: 'cliente-vm-a',
          configuration: { plan: 'vciso', gbDay: 4 },
        }),
        OWNER,
      );
      expect((await service.detail(created.id)).actions).toMatchObject({
        enrollmentCode: true,
        resume: false,
      });
      const issued = await service.enrollmentCode(created.id, { confirmSlug: 'cliente-vm-a' }, OWNER);
      expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(issued).toMatchObject({ reinstall: false, step: 'preflight' });
      expect(new Date(issued.expiresAt).getTime()).toBe(h.clock.now().getTime() + 7 * DAY_MS);
      const tenant = await tenants.require(created.id);
      expect(tenant.state).toBe('provisioning');
      expect(tenant.provisioning).toMatchObject({ runId: issued.runId, step: 'preflight', attempts: 0 });
      expect(tenant.enrollment).toEqual({
        codeHash: enrollmentHash(issued.code),
        codeExpiresAt: new Date(issued.expiresAt),
        codeCreatedAt: h.clock.now(),
        codeCreatedBy: `owner:${OWNER.email}`,
      });
      expect(queue.tasks.map((task) => [task.queue, task.step, task.runId])).toEqual([
        ['provisioning', 'preflight', issued.runId],
      ]);
      // O código nunca vai ao Firestore nem à auditoria: só o hash.
      const everything = JSON.stringify([
        ...(await h.documents.query(COLLECTIONS.auditLog, {})).map((doc) => doc.data),
        ...(await h.documents.query(COLLECTIONS.tenants, {})).map((doc) => doc.data),
      ]);
      expect(everything).not.toContain(issued.code);
      expect(await auditActions()).toEqual(
        expect.arrayContaining([
          { actor: `owner:${OWNER.email}`, action: 'tenant.enrollment_code_issued', tenantId: created.id },
          { actor: `owner:${OWNER.email}`, action: 'tenant.console_request', tenantId: created.id },
        ]),
      );
      // O detalhe: a sequência reduzida e os endereços da Verax (o painel e a API pelo túnel).
      const detail = await service.detail(created.id);
      expect(detail.timeline.map((step) => step.name)).toEqual([
        'preflight',
        'cloudflare.tunnel',
        'firebase.site',
        'enrollment.wait',
        'node.health',
        'panel.domain_wait',
        'access.ready',
      ]);
      expect(detail.urls).toEqual({
        panelUrl: 'https://cliente-vm-a.control.veraxsistemas.com.br',
        apiUrl: 'https://api-cliente-vm-a.veraxsistemas.com.br',
      });

      // Outro código: o anterior deixa de valer; a mesma execução segue (nenhuma task nova).
      const again = await service.enrollmentCode(created.id, { confirmSlug: 'cliente-vm-a' }, OWNER);
      expect(again.code).not.toBe(issued.code);
      expect(again).toMatchObject({ reinstall: false, runId: issued.runId });
      expect((await tenants.require(created.id)).enrollment?.codeHash).toBe(enrollmentHash(again.code));
      expect(queue.tasks).toHaveLength(1);
    });

    it('código de instalação: só na VM do cliente, com o subdomínio certo, e não depois de cancelado', async () => {
      const verax = await service.create(directRequest({ slug: 'cliente-gerido' }), OWNER);
      await expectApiError(
        service.enrollmentCode(verax.id, { confirmSlug: 'cliente-gerido' }, OWNER),
        409,
        'not_customer_hosted',
      );
      const created = await service.create(
        directRequest({ hosting: 'customer', slug: 'cliente-vm-b' }),
        OWNER,
      );
      await expectApiError(
        service.enrollmentCode(created.id, { confirmSlug: 'outro' }, OWNER),
        400,
        'confirmation_mismatch',
      );
      await expectApiError(service.enrollmentCode(created.id, {}, OWNER), 400, 'invalid_request');
      await expectApiError(
        service.enrollmentCode(newUlid(), { confirmSlug: 'x' }, OWNER),
        404,
        'tenant_not_found',
      );
      worker.down = true;
      await expectApiError(
        service.enrollmentCode(created.id, { confirmSlug: 'cliente-vm-b' }, OWNER),
        503,
        'worker_unavailable',
      );
      worker.down = false;
      await service.act('cancel', created.id, { confirmSlug: 'cliente-vm-b' }, OWNER);
      await expectApiError(
        service.enrollmentCode(created.id, { confirmSlug: 'cliente-vm-b' }, OWNER),
        409,
        'not_allowed',
      );
      expect((await tenants.require(created.id)).enrollment).toBeUndefined();
      expect(queue.tasks.filter((task) => task.queue === 'provisioning')).toEqual([
        expect.objectContaining({ step: 'preflight', tenantId: verax.id }),
      ]);
    });

    it('instalação no cliente: só para o ambiente no cliente; versão ausente, assinatura de outra chave e worker fora', async () => {
      const verax = await service.create(directRequest({ slug: 'cliente-na-verax' }), OWNER);
      await expectApiError(service.installation(verax.id, OWNER), 409, 'not_customer_hosted');
      await expectApiError(service.installation(newUlid(), OWNER), 404, 'tenant_not_found');
      const created = await service.create(
        directRequest({ hosting: 'customer', slug: 'cliente-versao' }),
        OWNER,
      );

      // A assinatura de outra chave (o manifesto trocado no bucket): recusado, nada chega à tela.
      const manifest = releases.get(`${RELEASE}/manifest.json`) ?? Buffer.alloc(0);
      releases.set(`${RELEASE}/manifest.json.sig`, new TestReleaseKey().sign(manifest));
      await expectApiError(service.installation(created.id, OWNER), 502, 'release_manifest_invalid');
      releases.delete(`${RELEASE}/manifest.json`);
      await expectApiError(service.installation(created.id, OWNER), 503, 'release_manifest_missing');

      Object.assign(workerConfig, { NODE_RELEASE: undefined });
      await expectApiError(service.installation(created.id, OWNER), 503, 'release_unconfigured');
      worker.down = true;
      await expectApiError(service.installation(created.id, OWNER), 503, 'worker_unavailable');
      await expectApiError(build(null).installation(created.id, OWNER), 503, 'worker_unconfigured');
    });

    // --- O aditivo do contrato direto (decisão do responsável de 19/11/2026; valores FICTÍCIOS) ---------------------

    it('aditivo no cliente antes da instalação: vai para a Verax, volta a pending sem o registro da VM, e o "Iniciar provisionamento" começa dali', async () => {
      const created = await service.create(
        directRequest({ hosting: 'customer', slug: 'cliente-adt-a' }),
        OWNER,
      );
      const confirmSlug = 'cliente-adt-a';
      const contracted = { monthlyTotal: 380_000, additionalGbDayAmount: 45_000 };
      const result = await service.amend(
        created.id,
        {
          hosting: 'verax',
          configuration: { plan: 'vciso', gbDay: 4 },
          contracted,
          contractedSetup: 0,
          note: 'Cliente Demo A passou para o vCISO na Verax',
          confirmSlug,
        },
        OWNER,
      );
      const startsAt = h.clock.now();
      expect(result.amendmentId).toMatch(/^[0-9A-Z]{26}$/);
      expect(result).toMatchObject({
        state: 'pending',
        hosting: 'verax',
        hostingChanged: true,
        nodeLimitsPending: false,
        // A vigência recomeça no aditivo, com a duração do plano novo (60 meses no vCISO).
        contractTerm: { months: 60, startsAt, endsAt: new Date('2031-11-04T12:00:00.000Z') },
      });
      const tenant = await tenants.require(created.id);
      expect(tenant.hosting).toBeUndefined();
      expect(tenant.enrollment).toBeUndefined();
      expect(tenant.provisioning).toBeUndefined();
      expect(tenant).toMatchObject({
        state: 'pending',
        configuration: { plan: 'vciso', mode: 'managed', gbDay: 4, size: 'P' },
        pricing: { priceTableVersion: 'teste-v1', monthlyTotal: 400_000, setupTotal: 500_000 },
        contractPricing: {
          reference: { monthlyTotal: 400_000, additionalGbDayAmount: 50_000 },
          contracted,
          setup: { reference: 500_000, contracted: 0 },
        },
      });
      expect((await tenants.listTransitions(created.id)).at(-1)).toMatchObject({
        from: 'waiting_customer_install',
        to: 'pending',
        reason: 'contract_amended_to_verax',
      });
      // Nada pedido ao cp-worker, nada na fila: só o Firestore mudou.
      expect(worker.calls).toEqual([]);
      expect(queue.tasks).toEqual([]);
      const amendAudit = (await audit.listForTenant(created.id)).find(
        (entry) => entry.action === 'tenant.contract_amended',
      );
      expect(amendAudit).toMatchObject({
        actor: `owner:${OWNER.email}`,
        requestId: OWNER.requestId,
        details: {
          from: 'waiting_customer_install',
          to: 'pending',
          before: {
            hosting: 'customer',
            configuration: { plan: 'dedicado', mode: 'self_hosted', gbDay: 3 },
          },
          after: { hosting: 'verax', configuration: { plan: 'vciso', mode: 'managed', gbDay: 4 } },
          note: 'Cliente Demo A passou para o vCISO na Verax',
        },
      });
      const detail = await service.detail(created.id);
      expect(detail.contractTerm).toEqual(result.contractTerm);
      expect(detail.actions).toMatchObject({
        start: true,
        enrollmentCode: false,
        amend: true,
        amendHosting: true,
      });
      expect(detail.amendments).toEqual([
        expect.objectContaining({
          id: result.amendmentId,
          at: startsAt,
          by: OWNER.email,
          note: 'Cliente Demo A passou para o vCISO na Verax',
          stateBefore: 'waiting_customer_install',
          stateAfter: 'pending',
          nodeLimitsPending: false,
        }),
      ]);
      expect(detail.amendments[0]?.before.hosting).toBe('customer');
      expect(detail.amendments[0]?.after).toMatchObject({
        hosting: 'verax',
        contractTerm: result.contractTerm,
      });

      // O "Iniciar provisionamento" de sempre: depois dele, onde roda trava; o plano e o volume ainda mudam.
      const started = await service.act('start', created.id, { confirmSlug }, OWNER);
      expect(started).toMatchObject({ action: 'start', step: 'preflight' });
      expect((await service.detail(created.id)).actions).toMatchObject({ amend: true, amendHosting: false });
      const locked = await expectApiError(
        service.amend(
          created.id,
          { hosting: 'customer', configuration: { plan: 'vciso', gbDay: 4 }, confirmSlug },
          OWNER,
        ),
        409,
        'hosting_locked',
      );
      expect(JSON.stringify(locked.details)).toContain('hosting');
      h.clock.advance(DAY_MS);
      const inPlace = await service.amend(
        created.id,
        { hosting: 'verax', configuration: { plan: 'dedicado', gbDay: 5 }, confirmSlug },
        OWNER,
      );
      expect(inPlace).toMatchObject({
        state: 'provisioning',
        hosting: 'verax',
        hostingChanged: false,
        // A execução ainda não chegou ao Terraform: o nó vai nascer com os limites novos.
        nodeLimitsPending: false,
        contractTerm: { months: 12, endsAt: new Date('2027-11-05T12:00:00.000Z') },
      });
      const after = await tenants.require(created.id);
      expect(after).toMatchObject({
        state: 'provisioning',
        configuration: { plan: 'dedicado', gbDay: 5, size: 'P' },
        // Sem negociação no pedido: o contratado é a referência; o Dedicado não tem implantação.
        contractPricing: {
          reference: { monthlyTotal: 250_000, additionalGbDayAmount: 50_000 },
          contracted: { monthlyTotal: 250_000, additionalGbDayAmount: 50_000 },
        },
      });
      expect(after.contractPricing?.setup).toBeUndefined();
      expect((await tenants.listAmendments(created.id)).map((entry) => entry.stateAfter)).toEqual([
        'pending',
        'provisioning',
      ]);
    });

    it('aditivo na Verax antes do provisionamento: vai para o cliente e espera a instalação; depois do código, onde roda trava', async () => {
      worker.down = true;
      const created = await service.create(directRequest({ slug: 'cliente-adt-b' }), OWNER);
      worker.down = false;
      expect((await tenants.require(created.id)).state).toBe('pending');
      const confirmSlug = 'cliente-adt-b';
      // No cliente, o porte não impede (a VM é dele): 8 GB/dia pede o porte M.
      const result = await service.amend(
        created.id,
        { hosting: 'customer', configuration: { plan: 'dedicado', gbDay: 8 }, confirmSlug },
        OWNER,
      );
      expect(result).toMatchObject({
        state: 'waiting_customer_install',
        hosting: 'customer',
        hostingChanged: true,
        contractTerm: { months: 12, endsAt: new Date('2027-11-04T12:00:00.000Z') },
      });
      expect(await tenants.require(created.id)).toMatchObject({
        hosting: 'customer',
        state: 'waiting_customer_install',
        configuration: { plan: 'dedicado', mode: 'self_hosted', gbDay: 8, size: 'M' },
      });
      expect((await tenants.listTransitions(created.id)).at(-1)).toMatchObject({
        from: 'pending',
        to: 'waiting_customer_install',
        reason: 'contract_amended_to_customer',
      });
      expect((await service.detail(created.id)).actions).toMatchObject({
        start: false,
        enrollmentCode: true,
      });

      // O primeiro código começa o provisionamento reduzido (túnel e site na Verax): onde roda não muda mais.
      await service.enrollmentCode(created.id, { confirmSlug }, OWNER);
      expect((await service.detail(created.id)).actions.amendHosting).toBe(false);
      await expectApiError(
        service.amend(
          created.id,
          { hosting: 'verax', configuration: { plan: 'dedicado', gbDay: 5 }, confirmSlug },
          OWNER,
        ),
        409,
        'hosting_locked',
      );
      expect((await tenants.require(created.id)).hosting).toBe('customer');
      expect(
        (await audit.listForTenant(created.id)).filter((entry) => entry.action === 'tenant.amend_refused'),
      ).toEqual([expect.objectContaining({ details: { code: 'hosting_locked', state: 'provisioning' } })]);

      // Antes do registro da VM, o nó vai nascer com os limites novos; depois do `claim`, eles ficam pendentes no nó.
      const before = await service.amend(
        created.id,
        { hosting: 'customer', configuration: { plan: 'dedicado', gbDay: 10 }, confirmSlug },
        OWNER,
      );
      expect(before).toMatchObject({
        hostingChanged: false,
        nodeLimitsPending: false,
        state: 'provisioning',
      });
      await tenants.change(created.id, () => ({
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (tenant) =>
          tenant.enrollment === undefined
            ? tenant
            : { ...tenant, enrollment: { ...tenant.enrollment, claimedAt: h.clock.now() } },
      }));
      const after = await service.amend(
        created.id,
        { hosting: 'customer', configuration: { plan: 'vciso', gbDay: 12 }, confirmSlug },
        OWNER,
      );
      expect(after).toMatchObject({ nodeLimitsPending: true, contractTerm: { months: 60 } });
      expect((await service.detail(created.id)).amendments.map((entry) => entry.nodeLimitsPending)).toEqual([
        false,
        false,
        true,
      ]);
      // O que a instalação manda ao cliente já sai do contrato novo.
      expect((await service.installation(created.id, OWNER)).size).toBe('G');
    });

    it('aditivo com o ambiente rodando: só o contrato muda, os limites ficam pendentes no nó, e as regras do cadastro valem', async () => {
      const created = await service.create(directRequest({ slug: 'cliente-adt-c' }), OWNER);
      await tenants.change(created.id, () => ({
        to: 'waiting_customer_connection',
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (tenant) => ({
          ...tenant,
          provisioning: { ...(tenant.provisioning ?? { attempts: 0 }), nodeVersionPinnedAt: h.clock.now() },
        }),
      }));
      await tenants.change(created.id, () => ({ to: 'active', reason: 'teste', audit: { actor: 'system' } }));
      const confirmSlug = 'cliente-adt-c';
      const amend = (body: Record<string, unknown>): Promise<unknown> =>
        service.amend(created.id, { hosting: 'verax', confirmSlug, ...body }, OWNER);

      // As recusas: nada gravado.
      await expectApiError(
        amend({ configuration: { plan: 'plataforma', gbDay: 2 } }),
        400,
        'invalid_request',
      );
      const tooBig = await expectApiError(
        amend({ configuration: { plan: 'dedicado', gbDay: 8 } }),
        422,
        'configuration_unsupported',
      );
      expect(JSON.stringify(tooBig.details)).toContain('configuration.gbDay');
      await expectApiError(
        amend({ configuration: { plan: 'dedicado', gbDay: 16 } }),
        422,
        'configuration_contact_us',
      );
      const setup = await expectApiError(
        amend({ configuration: { plan: 'dedicado', gbDay: 5 }, contractedSetup: 0 }),
        400,
        'invalid_request',
      );
      expect(JSON.stringify(setup.details)).toContain('contractedSetup');
      await expectApiError(
        amend({ configuration: { plan: 'dedicado', gbDay: 5 }, confirmSlug: 'outro' }),
        400,
        'confirmation_mismatch',
      );
      await expectApiError(
        amend({ hosting: 'customer', configuration: { plan: 'dedicado', gbDay: 5 } }),
        409,
        'hosting_locked',
      );
      await expectApiError(
        amend({ configuration: { plan: 'dedicado', gbDay: 5 }, note: 'linha 1\nlinha 2' }),
        400,
        'invalid_request',
      );
      await expectApiError(
        service.amend(
          newUlid(),
          { hosting: 'verax', confirmSlug, configuration: { plan: 'dedicado', gbDay: 5 } },
          OWNER,
        ),
        404,
        'tenant_not_found',
      );
      expect(await tenants.listAmendments(created.id)).toEqual([]);
      expect((await tenants.require(created.id)).configuration).toMatchObject({
        plan: 'plataforma',
        gbDay: 2,
      });

      // O aditivo com o nó instalado: o estado fica, o contrato muda, os limites novos ficam pendentes no nó.
      const result = await amend({ configuration: { plan: 'dedicado', gbDay: 5 } });
      expect(result).toMatchObject({ state: 'active', hostingChanged: false, nodeLimitsPending: true });
      expect((await tenants.require(created.id)).limits).toMatchObject({
        maxCloudAccounts: 100,
        monthlyGib: 145,
      });
      expect((await tenants.listTransitions(created.id)).map((entry) => entry.to)).toEqual([
        'pending',
        'provisioning',
        'waiting_customer_connection',
        'active',
      ]);
      // O mesmo aditivo de novo não muda nada (o clique duplo): 409, sem outro registro.
      await expectApiError(amend({ configuration: { plan: 'dedicado', gbDay: 5 } }), 409, 'no_change');
      // Só os valores mudam (uma renegociação): vale, e os limites não mudam (nada pendente).
      expect(
        await amend({
          configuration: { plan: 'dedicado', gbDay: 5 },
          contracted: { monthlyTotal: 240_000, additionalGbDayAmount: 50_000 },
        }),
      ).toMatchObject({ nodeLimitsPending: false });
      expect(await tenants.listAmendments(created.id)).toHaveLength(2);
    });

    it('aditivo: só do contrato direto, e nunca depois do fim do contrato', async () => {
      const paid = await tenantIn(tenants, 'cliente-pago-f', 'active');
      await expectApiError(
        service.amend(
          paid.id,
          { hosting: 'verax', configuration: { plan: 'dedicado', gbDay: 3 }, confirmSlug: 'cliente-pago-f' },
          OWNER,
        ),
        409,
        'stripe_managed',
      );
      const created = await service.create(directRequest({ slug: 'cliente-adt-d' }), OWNER);
      await service.act('cancel', created.id, { confirmSlug: 'cliente-adt-d' }, OWNER);
      expect((await service.detail(created.id)).actions).toMatchObject({ amend: false, amendHosting: false });
      await expectApiError(
        service.amend(
          created.id,
          { hosting: 'verax', configuration: { plan: 'dedicado', gbDay: 3 }, confirmSlug: 'cliente-adt-d' },
          OWNER,
        ),
        409,
        'not_allowed',
      );
      expect(await tenants.listAmendments(created.id)).toEqual([]);
    });
  });
}
