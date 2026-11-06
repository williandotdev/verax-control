import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  DirectTenantCreated,
  TenantActionResult,
  TenantDetail,
  TenantList,
} from '../src/admin/admin-tenants.schema.js';
import { IAP_JWT_HEADER } from '../src/admin/iap-verifier.js';
import { HttpWorkerOwnerClient } from '../src/admin/worker-owner-client.js';
import { AuditService } from '../src/audit/audit.service.js';
import { newUlid } from '../src/common/ulid.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { TestIap } from './support/iap-test-keys.js';
import { LogCapture } from './support/log-capture.js';
import { fictitiousPriceTable } from './support/pricing-fixtures.js';
import { seedPublishedTable } from './support/pricing-seed.js';

const START = new Date('2026-11-05T12:00:00.000Z');
const AUDIENCE = '/projects/111111111111/locations/southamerica-east1/services/cp-admin';
const WORKER_URL = 'https://cp-worker-111111111111.southamerica-east1.run.app';
const OWNER = 'responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';
const ADMIN_SA = 'cp-admin@projeto-exemplo.iam.gserviceaccount.com';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const DAY_MS = 24 * 60 * MINUTE_MS;

interface WorkerCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Os clientes no console do responsável pelo app inteiro, com os dois serviços de verdade: o `cp-admin` (IAP de teste,
 * `iap-test-keys.ts`) chama o `cp-worker` (o "Google" de teste, `access-fakes.ts`) por HTTP em 127.0.0.1, com o
 * `HttpWorkerOwnerClient` de produção (CP-11) e um token da conta do cp-admin. O mesmo Firestore em memória e a mesma
 * fila nos dois. Nada fala com o Google. Tabela de preços FICTÍCIA.
 */
describe('cp-admin e cp-worker: cliente de contrato direto e as operações do responsável pelo console', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const queue = new MemoryStepQueue();
  const google = new TestGoogleIdentity();
  const iap = new TestIap();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  /** O que o console mandou ao worker (para provar que o JWT do IAP nunca sai do cp-admin). */
  const workerCalls: WorkerCall[] = [];
  /** O worker fora do ar (rede) ou atrás da entrada do Cloud Run (o 404 em HTML de `INGRESS_TRAFFIC_INTERNAL_ONLY`). */
  const network = { down: false, ingressBlocked: false };
  let worker: NestExpressApplication;
  let admin: NestExpressApplication;
  let workerPort = 0;
  let slugSequence = 0;

  function ownerToken(email = OWNER): string {
    return iap.token({ audience: AUDIENCE, email });
  }

  function bearer(email: string): string {
    return `Bearer ${google.token({ email, aud: WORKER_URL })}`;
  }

  function send(path: string, body: unknown, token: string | null = ownerToken()): request.Test {
    const test = request(admin.getHttpServer()).post(path).set('Content-Type', 'application/json');
    return (token === null ? test : test.set(IAP_JWT_HEADER, token)).send(JSON.stringify(body));
  }

  function read(path: string, token: string | null = ownerToken()): request.Test {
    const test = request(admin.getHttpServer()).get(path);
    return token === null ? test : test.set(IAP_JWT_HEADER, token);
  }

  function internal(path: string, caller: string, body: unknown): request.Test {
    return request(worker.getHttpServer())
      .post(path)
      .set('Authorization', bearer(caller))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  }

  function nextSlug(): string {
    slugSequence += 1;
    return `direto-${slugSequence}`;
  }

  function directRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const slug = typeof overrides['slug'] === 'string' ? overrides['slug'] : nextSlug();
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

  /** O `fetch` do cliente: a URL do worker (https, a de produção) vai ao worker local, e o pedido fica guardado. */
  const localFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === 'string' ? init.body : 'null';
    workerCalls.push({ url: url.toString(), headers, body: JSON.parse(raw) });
    if (network.down) throw new TypeError('fetch failed');
    if (network.ingressBlocked) {
      return new Response('<html><body>Error: Page not found</body></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    }
    return fetch(new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${workerPort}`), init);
  };

  beforeAll(async () => {
    worker = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      stepQueue: queue,
      idTokenKeys: google,
      capture,
      env: {
        LOG_LEVEL: 'debug',
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: OWNER,
        PUBLIC_SA_EMAIL: PUBLIC_SA,
        ADMIN_SA_EMAIL: ADMIN_SA,
      },
    });
    await worker.listen(0, '127.0.0.1');
    workerPort = (worker.getHttpServer().address() as AddressInfo).port;
    admin = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      clock,
      documentStore: documents,
      capture,
      iapKeySource: iap,
      workerOwnerClient: new HttpWorkerOwnerClient(
        WORKER_URL,
        { get: (audience: string) => Promise.resolve(google.token({ email: ADMIN_SA, aud: audience })) },
        localFetch,
      ),
      env: { LOG_LEVEL: 'debug', IAP_AUDIENCE: AUDIENCE, OWNER_PRINCIPALS: OWNER, WORKER_URL },
    });
    await admin.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await admin.close();
    await worker.close();
  });

  /** Cada teste numa hora própria: o limite de cadastros por responsável (5 por hora) não passa de um teste ao outro. */
  let round = 0;

  beforeEach(async () => {
    round += 1;
    clock.set(new Date(START.getTime() + round * 2 * 60 * MINUTE_MS));
    documents.clear();
    queue.clear();
    workerCalls.length = 0;
    network.down = false;
    network.ingressBlocked = false;
    await seedPublishedTable(documents, fictitiousPriceTable(), {
      effectiveFrom: new Date(START.getTime() - MINUTE_MS),
    });
  });

  /** Um contrato direto criado pelo console (o worker põe em provisioning). */
  async function created(): Promise<{ id: string; slug: string }> {
    const body = directRequest();
    const response = (await send('/v1/admin/tenants', body).expect(201)).body as DirectTenantCreated;
    return { id: response.id, slug: String(body['slug']) };
  }

  describe('acesso', () => {
    it('as rotas dos clientes exigem o JWT do IAP de um responsável; escrita só em JSON e da mesma origem', async () => {
      await read('/v1/admin/tenants', null).expect(401);
      await read('/v1/admin/tenants', ownerToken(STRANGER)).expect(403);
      await read(`/v1/admin/tenants/${newUlid()}`, ownerToken(STRANGER)).expect(403);
      await send('/v1/admin/tenants/preview', { configuration: {} }, ownerToken(STRANGER)).expect(403);
      const body = directRequest();
      await send('/v1/admin/tenants', body, null).expect(401);
      await send('/v1/admin/tenants', body, ownerToken(STRANGER)).expect(403);
      for (const action of ['start', 'resume', 'cancel', 'suspend', 'reactivate', 'delete-now', 'export']) {
        await send(
          `/v1/admin/tenants/${newUlid()}/${action}`,
          { confirmSlug: 'x' },
          ownerToken(STRANGER),
        ).expect(403);
      }
      await request(admin.getHttpServer())
        .post('/v1/admin/tenants')
        .set(IAP_JWT_HEADER, ownerToken())
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify(body))
        .expect(415);
      await request(admin.getHttpServer())
        .post('/v1/admin/tenants')
        .set(IAP_JWT_HEADER, ownerToken())
        .set('Content-Type', 'application/json')
        .set('Sec-Fetch-Site', 'cross-site')
        .send(JSON.stringify(body))
        .expect(403);
      expect(await tenants.get(String(body['idempotencyKey']))).toBeUndefined();
      expect(workerCalls).toHaveLength(0);
    });

    it('as rotas do console não existem no worker, e as do worker não existem no console', async () => {
      await request(worker.getHttpServer())
        .get('/v1/admin/tenants')
        .set(IAP_JWT_HEADER, ownerToken())
        .expect(404);
      await request(admin.getHttpServer())
        .post(`/internal/tenants/${newUlid()}/provision`)
        .set(IAP_JWT_HEADER, ownerToken())
        .set('Content-Type', 'application/json')
        .send('{}')
        .expect(404);
    });
  });

  describe('cadastro e linha do tempo', () => {
    it('o console cria o cliente e o worker o põe em provisioning, com o token da conta do cp-admin e o responsável no corpo', async () => {
      const body = directRequest();
      const response = await send('/v1/admin/tenants', body).expect(201);
      const result = response.body as DirectTenantCreated;
      expect(result).toMatchObject({
        id: body['idempotencyKey'],
        replayed: false,
        provisioning: { started: true, step: 'preflight' },
      });

      // O pedido ao worker: o token da conta do console (aud = WORKER_URL), o responsável no corpo, nunca o JWT do IAP.
      expect(workerCalls).toHaveLength(1);
      const call = workerCalls[0];
      expect(call?.url).toBe(`${WORKER_URL}/internal/tenants/${result.id}/provision`);
      expect(call?.body).toEqual({ confirmSlug: body['slug'], actor: OWNER });
      expect(Object.keys(call?.headers ?? {})).not.toContain(IAP_JWT_HEADER);
      const sentToken = (call?.headers['authorization'] ?? '').replace('Bearer ', '');
      const claims = JSON.parse(Buffer.from(sentToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
        email?: string;
        aud?: string;
      };
      expect(claims).toMatchObject({ email: ADMIN_SA, aud: WORKER_URL });

      const tenant = await tenants.require(result.id);
      expect(tenant).toMatchObject({ state: 'provisioning', billing: { mode: 'contract' } });
      expect(queue.tasks.map((task) => task.step)).toEqual(['preflight']);
      // A transição feita no worker vai à auditoria com o responsável, não com a conta do console.
      const transition = (await audit.listForTenant(result.id)).find(
        (entry) => entry.action === 'tenant.transition' && entry.details?.['to'] === 'provisioning',
      );
      expect(transition?.actor).toBe(`owner:${OWNER}`);

      const list = (await read('/v1/admin/tenants').expect(200)).body as TenantList;
      expect(list.tenants.map((item) => [item.id, item.billingMode, item.state, item.step])).toEqual([
        [result.id, 'contract', 'provisioning', 'preflight'],
      ]);
      const detail = (await read(`/v1/admin/tenants/${result.id}`).expect(200)).body as TenantDetail;
      expect(detail).toMatchObject({
        slug: body['slug'],
        billingMode: 'contract',
        company: { cnpj: '11222333000181' },
        actions: { start: false, resume: true, cancel: true, suspend: false, deleteNow: false },
        lifecycle: {},
      });
      expect(detail.timeline).toHaveLength(11);
      expect(detail.timeline[0]).toEqual({ name: 'preflight', status: 'pending', attempts: 0 });
      await read('/v1/admin/tenants/nao-e-ulid').expect(404);
      // Nada do cadastro (nem o e-mail do admin, nem o CNPJ, nem a razão social) no log.
      expect(capture.text).not.toContain('admin@cliente-demo-a.example');
      expect(capture.text).not.toContain('11222333000181');
      expect(capture.text).not.toContain('Cliente Demo A Ltda');
    });

    it('cada campo é conferido de novo na API, com o problema no caminho do campo', async () => {
      const invalid = await send(
        '/v1/admin/tenants',
        directRequest({
          cnpj: '11.222.333/0001-82',
          adminEmail: 'sem-arroba',
          slug: 'X',
          configuration: {
            mode: 'managed',
            cloudAccounts: -1,
            monthlyGib: 10,
            agents: 0,
            historyDays: 30,
            support: 'standard',
          },
        }),
      ).expect(400);
      const paths = (invalid.body as { details: { issues: { path: string }[] } }).details.issues.map(
        (issue) => issue.path,
      );
      expect(paths).toEqual(
        expect.arrayContaining(['cnpj', 'adminEmail', 'slug', 'configuration.cloudAccounts']),
      );
      await send('/v1/admin/tenants', { ...directRequest(), extra: true }).expect(400);
      const mismatch = await send(
        '/v1/admin/tenants',
        directRequest({ confirmSlug: 'outro-cliente' }),
      ).expect(400);
      expect(mismatch.body).toMatchObject({
        code: 'confirmation_mismatch',
        details: { issues: [{ path: 'confirmSlug' }] },
      });
      const unsupported = await send(
        '/v1/admin/tenants',
        directRequest({
          configuration: {
            mode: 'self_hosted',
            cloudAccounts: 2,
            monthlyGib: 10,
            agents: 10,
            historyDays: 30,
            support: 'standard',
          },
        }),
      ).expect(422);
      expect(unsupported.body).toMatchObject({
        code: 'configuration_unsupported',
        details: { problems: ['mode', 'agents'] },
      });
      const above = await send(
        '/v1/admin/tenants',
        directRequest({
          configuration: {
            mode: 'managed',
            cloudAccounts: 500,
            monthlyGib: 10,
            agents: 0,
            historyDays: 30,
            support: 'standard',
          },
        }),
      ).expect(422);
      expect(above.body).toMatchObject({
        code: 'configuration_contact_us',
        details: { reason: 'cloud_accounts_above_max' },
      });
      const sizeM = await send(
        '/v1/admin/tenants',
        directRequest({
          configuration: {
            mode: 'managed',
            cloudAccounts: 8,
            monthlyGib: 10,
            agents: 0,
            historyDays: 30,
            support: 'standard',
          },
        }),
      ).expect(422);
      expect(sizeM.body).toMatchObject({ details: { problems: ['size'] } });
      expect(workerCalls).toHaveLength(0);
      expect((await documents.query(COLLECTIONS.tenants)).length).toBe(0);
      const refused = (await documents.query(COLLECTIONS.auditLog)).filter(
        (doc) => doc.data['action'] === 'tenant.create_refused',
      );
      expect(refused.length).toBe(6);
      expect(refused.every((doc) => doc.data['actor'] === `owner:${OWNER}`)).toBe(true);
    });

    it('a cotação de referência pela tabela vigente, com o que o provisionamento ainda não cria', async () => {
      const ok = await send('/v1/admin/tenants/preview', {
        configuration: {
          mode: 'managed',
          cloudAccounts: 3,
          monthlyGib: 10,
          agents: 0,
          historyDays: 30,
          support: 'standard',
        },
      }).expect(200);
      expect(ok.body).toMatchObject({
        priceTableVersion: 'teste-v1',
        contactUs: false,
        quote: { configuration: { size: 'P', cloudAccounts: 3 }, monthlyTotal: 103_000 },
        problems: [],
      });
      const agents = await send('/v1/admin/tenants/preview', {
        configuration: {
          mode: 'managed',
          cloudAccounts: 2,
          monthlyGib: 10,
          agents: 5,
          historyDays: 30,
          support: 'standard',
        },
      }).expect(200);
      expect(agents.body).toMatchObject({ contactUs: false, problems: ['agents'] });
      await send('/v1/admin/tenants/preview', { configuration: { mode: 'managed' } }).expect(400);
    });

    it('sem tabela de preços vigente, nada de cadastro (409)', async () => {
      documents.clear();
      const response = await send('/v1/admin/tenants', directRequest()).expect(409);
      expect(response.body).toMatchObject({ code: 'pricing_table_missing' });
    });
  });

  describe('o worker fora do alcance do console', () => {
    it('worker fora do ar: o cliente fica em pending; o "Iniciar provisionamento" responde 503 até o worker voltar', async () => {
      network.down = true;
      const body = directRequest();
      const result = (await send('/v1/admin/tenants', body).expect(201)).body as DirectTenantCreated;
      expect(result.provisioning).toEqual({ started: false, failure: 'worker_unavailable' });
      expect((await tenants.require(result.id)).state).toBe('pending');

      // A entrada do Cloud Run recusando (só de dentro do projeto): o mesmo 503, nunca "cliente inexistente".
      network.down = false;
      network.ingressBlocked = true;
      const blocked = await send(`/v1/admin/tenants/${result.id}/start`, {
        confirmSlug: body['slug'],
      }).expect(503);
      expect(blocked.body).toMatchObject({ code: 'worker_unavailable' });

      network.ingressBlocked = false;
      const started = await send(`/v1/admin/tenants/${result.id}/start`, {
        confirmSlug: body['slug'],
      }).expect(200);
      expect(started.body).toMatchObject({ action: 'start', step: 'preflight' });
      expect((await tenants.require(result.id)).state).toBe('provisioning');

      // O mesmo envio repetido (a resposta perdida): o mesmo cliente, sem outro.
      const replay = (await send('/v1/admin/tenants', body).expect(201)).body as DirectTenantCreated;
      expect(replay).toMatchObject({ id: result.id, replayed: true, provisioning: { started: true } });
      expect((await documents.query(COLLECTIONS.tenants)).length).toBe(1);
    });
  });

  describe('as operações do responsável pelo console (CP-07 e CP-11)', () => {
    it('retomar: o worker recebe o pedido em nome do responsável', async () => {
      const tenant = await created();
      await tenants.transition(tenant.id, {
        to: 'provisioning_failed',
        reason: 'teste',
        audit: { actor: 'system' },
      });
      await send(`/v1/admin/tenants/${tenant.id}/resume`, { confirmSlug: 'errado' }).expect(400);
      const resumed = await send(`/v1/admin/tenants/${tenant.id}/resume`, {
        confirmSlug: tenant.slug,
      }).expect(200);
      expect(resumed.body).toMatchObject({ action: 'resume', step: 'preflight' });
      expect(workerCalls.at(-1)).toMatchObject({
        url: `${WORKER_URL}/internal/tenants/${tenant.id}/resume`,
        body: { actor: OWNER },
      });
      const resumeAudit = (await audit.listForTenant(tenant.id)).find(
        (entry) => entry.details?.['reason'] === 'provisioning_resumed',
      );
      expect(resumeAudit?.actor).toBe(`owner:${OWNER}`);
      await send(`/v1/admin/tenants/${tenant.id}/resume`, { confirmSlug: tenant.slug, extra: 1 }).expect(400);
    });

    it('suspender, reativar e cancelar com data e agora; depois, apagar agora e exportar', async () => {
      const tenant = await created();
      await tenants.transition(tenant.id, {
        to: 'waiting_customer_connection',
        reason: 'teste',
        audit: { actor: 'system' },
      });
      const confirm = { confirmSlug: tenant.slug };
      const suspend = await send(`/v1/admin/tenants/${tenant.id}/suspend`, confirm).expect(200);
      expect(suspend.body).toEqual({ action: 'suspend', state: 'suspended' });
      const reactivate = await send(`/v1/admin/tenants/${tenant.id}/reactivate`, confirm).expect(200);
      expect(reactivate.body).toEqual({ action: 'reactivate', state: 'waiting_customer_connection' });

      const end = new Date(clock.now().getTime() + 60 * DAY_MS).toISOString();
      const scheduled = await send(`/v1/admin/tenants/${tenant.id}/cancel`, { ...confirm, at: end }).expect(
        200,
      );
      expect(scheduled.body).toEqual({ action: 'cancel', result: 'scheduled', cancelAt: end });
      const past = await send(`/v1/admin/tenants/${tenant.id}/cancel`, {
        ...confirm,
        at: new Date(clock.now().getTime() - DAY_MS).toISOString(),
      }).expect(400);
      expect(past.body).toMatchObject({ code: 'invalid_date', details: { issues: [{ path: 'at' }] } });
      const canceled = (await send(`/v1/admin/tenants/${tenant.id}/cancel`, confirm).expect(200))
        .body as TenantActionResult;
      expect(canceled).toMatchObject({ action: 'cancel', result: 'canceled' });
      const detail = (await read(`/v1/admin/tenants/${tenant.id}`).expect(200)).body as TenantDetail;
      expect(detail.state).toBe('canceled');
      expect(detail.actions).toMatchObject({ cancel: false, suspend: false, deleteNow: true, export: true });
      expect(detail.lifecycle.exportUntil).toBeDefined();

      // A exportação sem a conta que assina: o código do worker, que o console explica.
      const exported = await send(`/v1/admin/tenants/${tenant.id}/export`, {
        ...confirm,
        object: 'postgres/verax-20261105T030000Z.dump',
      }).expect(503);
      expect(exported.body).toMatchObject({ code: 'export_unavailable' });
      const deleted = await send(`/v1/admin/tenants/${tenant.id}/delete-now`, confirm).expect(200);
      expect(deleted.body).toMatchObject({ action: 'delete-now' });

      // Tudo pedido em nome do responsável, auditado com o desfecho.
      expect(
        workerCalls.every(
          (call) => (call.body as { actor?: string }).actor === OWNER && !(IAP_JWT_HEADER in call.headers),
        ),
      ).toBe(true);
      const requests = (await audit.listForTenant(tenant.id))
        .filter((entry) => entry.action === 'tenant.console_request')
        .map((entry) => [entry.details?.['operation'], entry.details?.['outcome']]);
      expect(requests).toEqual([
        ['start', 'ok'],
        ['suspend', 'ok'],
        ['reactivate', 'ok'],
        ['cancel', 'ok'],
        ['cancel', 'invalid_date'],
        ['cancel', 'ok'],
        ['export', 'export_unavailable'],
        ['delete-now', 'ok'],
      ]);
    });

    it('um cliente da Stripe: o console não inicia, não cancela nem suspende (409 stripe_managed do worker)', async () => {
      const paid = await tenantIn(tenants, 'pago-boleto', 'pending');
      const start = await send(`/v1/admin/tenants/${paid.id}/start`, { confirmSlug: 'pago-boleto' }).expect(
        409,
      );
      expect(start.body).toMatchObject({ code: 'stripe_managed' });
      const cancel = await send(`/v1/admin/tenants/${paid.id}/cancel`, { confirmSlug: 'pago-boleto' }).expect(
        409,
      );
      expect(cancel.body).toMatchObject({ code: 'stripe_managed' });
      expect((await tenants.require(paid.id)).state).toBe('pending');
      expect(queue.tasks).toHaveLength(0);
    });
  });

  describe('a guarda do worker', () => {
    async function pendingContract(): Promise<{ id: string; slug: string }> {
      network.down = true;
      const body = directRequest();
      const result = (await send('/v1/admin/tenants', body).expect(201)).body as DirectTenantCreated;
      network.down = false;
      return { id: result.id, slug: String(body['slug']) };
    }

    it('a conta do console só vale nas operações do responsável, e sempre com um responsável em actor', async () => {
      const tenant = await pendingContract();
      // Nem os passos, nem a revelação, nem o tick.
      await internal('/internal/steps/preflight', ADMIN_SA, { tenantId: tenant.id, runId: tenant.id }).expect(
        403,
      );
      await internal('/internal/access/reveal', ADMIN_SA, { kind: 'cookie', token: 'x'.repeat(43) }).expect(
        403,
      );
      await internal('/internal/tick', ADMIN_SA, {}).expect(403);
      // Sem quem agiu, ou com alguém de fora.
      const path = `/internal/tenants/${tenant.id}/provision`;
      await internal(path, ADMIN_SA, { confirmSlug: tenant.slug }).expect(403);
      await internal(path, ADMIN_SA, { confirmSlug: tenant.slug, actor: STRANGER }).expect(403);
      await internal(path, ADMIN_SA, { confirmSlug: tenant.slug, actor: 'nao-e-email' }).expect(400);
      expect((await tenants.require(tenant.id)).state).toBe('pending');
      await internal(path, ADMIN_SA, { confirmSlug: 'outro', actor: OWNER }).expect(400);
      await internal(path, ADMIN_SA, { confirmSlug: tenant.slug, actor: OWNER }).expect(200);
      expect((await tenants.require(tenant.id)).state).toBe('provisioning');
      const started = (await audit.listForTenant(tenant.id)).find(
        (entry) => entry.details?.['reason'] === 'contract_provisioning_started',
      );
      expect(started?.actor).toBe(`owner:${OWNER}`);
    });

    it('o início do provisionamento recusa as tasks, o cp-public e o JWT do IAP; o responsável direto age como ele mesmo', async () => {
      const tenant = await pendingContract();
      const path = `/internal/tenants/${tenant.id}/provision`;
      for (const caller of [INVOKER, PUBLIC_SA]) {
        await internal(path, caller, { confirmSlug: tenant.slug }).expect(403);
      }
      // O JWT do IAP (outro emissor, outro algoritmo) nunca vale no worker, nem repassado.
      await request(worker.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${ownerToken()}`)
        .send({ confirmSlug: tenant.slug })
        .expect(401);
      await request(worker.getHttpServer())
        .post(path)
        .set(IAP_JWT_HEADER, ownerToken())
        .send({ confirmSlug: tenant.slug })
        .expect(401);
      await internal(path, OWNER, { confirmSlug: tenant.slug, outro: 1 }).expect(400);
      expect((await tenants.require(tenant.id)).state).toBe('pending');
      // O responsável direto: o `actor` do corpo não muda o ator (é o e-mail do token).
      await internal(path, OWNER, { confirmSlug: tenant.slug, actor: STRANGER }).expect(200);
      const started = (await audit.listForTenant(tenant.id)).find(
        (entry) => entry.details?.['reason'] === 'contract_provisioning_started',
      );
      expect(started?.actor).toBe(`owner:${OWNER}`);
      // De novo: já em provisioning no preflight, só garante a task.
      await internal(path, OWNER, { confirmSlug: tenant.slug }).expect(200);
      expect(queue.tasks.filter((task) => task.tenantId === tenant.id)).toHaveLength(1);
      await internal('/internal/tenants/nao-e-ulid/provision', OWNER, { confirmSlug: 'x' }).expect(404);
      await internal(`/internal/tenants/${newUlid()}/provision`, OWNER, { confirmSlug: 'x' }).expect(404);
    });

    it('um cliente da Stripe esperando o boleto nunca começa pela rota do responsável', async () => {
      const paid = await tenantIn(tenants, 'pago-boleto', 'pending');
      const response = await internal(`/internal/tenants/${paid.id}/provision`, OWNER, {
        confirmSlug: 'pago-boleto',
      }).expect(409);
      expect(response.body).toMatchObject({ code: 'stripe_managed' });
      expect((await tenants.require(paid.id)).state).toBe('pending');
      expect(queue.tasks).toHaveLength(0);
    });
  });
});
