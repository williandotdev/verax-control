import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  DirectTenantCreated,
  TenantActionResult,
  TenantDetail,
  TenantInstallation,
  TenantList,
} from '../src/admin/admin-tenants.schema.js';
import { HttpWorkerOwnerClient } from '../src/admin/worker-owner-client.js';
import { AuditService } from '../src/audit/audit.service.js';
import { newUlid } from '../src/common/ulid.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { MemoryAdminSecrets, seedOwnerSession } from './support/admin-auth.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { FakeCloud } from './support/fake-cloud.js';
import { LogCapture } from './support/log-capture.js';
import { fictitiousPriceTable } from './support/pricing-fixtures.js';
import { seedPublishedTable } from './support/pricing-seed.js';
import { manifestFor, TestReleaseKey } from './support/release-fixtures.js';

const START = new Date('2026-11-05T12:00:00.000Z');
const WORKER_URL = 'https://cp-worker-111111111111.southamerica-east1.run.app';
const OWNER = 'responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';
const ADMIN_SA = 'cp-admin@projeto-exemplo.iam.gserviceaccount.com';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const DAY_MS = 24 * 60 * MINUTE_MS;
const RELEASES = 'projeto-exemplo-releases';
const RELEASE = 'node-v1.2.3';

interface WorkerCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Os clientes no console do responsável pelo app inteiro, com os dois serviços de verdade: o `cp-admin` (sessão do
 * login próprio gravada no teste, `support/admin-auth.ts`) chama o `cp-worker` (o "Google" de teste, `access-fakes.ts`) por HTTP em 127.0.0.1, com o
 * `HttpWorkerOwnerClient` de produção (CP-11) e um token da conta do cp-admin. O mesmo Firestore em memória e a mesma
 * fila nos dois. Nada fala com o Google. Tabela de preços FICTÍCIA.
 */
describe('cp-admin e cp-worker: cliente de contrato direto e as operações do responsável pelo console', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const queue = new MemoryStepQueue();
  const google = new TestGoogleIdentity();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  /** As APIs da nuvem (só o bucket de releases pode ser lido nestes testes) e a chave de release dos testes. */
  const cloud = new FakeCloud();
  const releaseKey = new TestReleaseKey();
  /** O que o console mandou ao worker (para provar que o cookie da sessão nunca sai do cp-admin). */
  const workerCalls: WorkerCall[] = [];
  /** O worker fora do ar (rede) ou atrás da entrada do Cloud Run (o 404 em HTML de `INGRESS_TRAFFIC_INTERNAL_ONLY`). */
  const network = { down: false, ingressBlocked: false };
  let worker: NestExpressApplication;
  let admin: NestExpressApplication;
  let workerPort = 0;
  let slugSequence = 0;

  /** Os cookies das sessões do responsável e de quem não está em OWNER_PRINCIPALS (gravadas a cada teste). */
  let ownerCookie = '';
  let strangerCookie = '';

  function ownerToken(email = OWNER): string {
    return email === STRANGER ? strangerCookie : ownerCookie;
  }

  function bearer(email: string): string {
    return `Bearer ${google.token({ email, aud: WORKER_URL })}`;
  }

  function send(path: string, body: unknown, token: string | null = ownerToken()): request.Test {
    const test = request(admin.getHttpServer()).post(path).set('Content-Type', 'application/json');
    return (token === null ? test : test.set('Cookie', token)).send(JSON.stringify(body));
  }

  function read(path: string, token: string | null = ownerToken()): request.Test {
    const test = request(admin.getHttpServer()).get(path);
    return token === null ? test : test.set('Cookie', token);
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
      hosting: 'verax',
      configuration: {
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
    await cloud.start();
    worker = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      stepQueue: queue,
      idTokenKeys: google,
      capture,
      provisioning: {
        apis: {
          googleEndpoints: cloud.endpoints,
          cloudflareBase: cloud.cloudflareBase,
          accessTokens: { token: () => Promise.resolve(cloud.googleToken) },
          releaseKeys: releaseKey.keys,
        },
      },
      env: {
        RELEASE_BUCKET: RELEASES,
        NODE_RELEASE: RELEASE,
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
      adminSecrets: new MemoryAdminSecrets(),
      workerOwnerClient: new HttpWorkerOwnerClient(
        WORKER_URL,
        { get: (audience: string) => Promise.resolve(google.token({ email: ADMIN_SA, aud: audience })) },
        localFetch,
      ),
      env: {
        LOG_LEVEL: 'debug',
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
        OWNER_PRINCIPALS: OWNER,
        WORKER_URL,
      },
    });
    await admin.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await admin.close();
    await worker.close();
    await cloud.stop();
  });

  /** Cada teste numa hora própria: o limite de cadastros por responsável (5 por hora) não passa de um teste ao outro. */
  let round = 0;

  beforeEach(async () => {
    round += 1;
    clock.set(new Date(START.getTime() + round * 2 * 60 * MINUTE_MS));
    documents.clear();
    queue.clear();
    workerCalls.length = 0;
    cloud.requests.length = 0;
    cloud.objects.clear();
    network.down = false;
    network.ingressBlocked = false;
    await seedPublishedTable(documents, fictitiousPriceTable(), {
      effectiveFrom: new Date(START.getTime() - MINUTE_MS),
    });
    ownerCookie = await seedOwnerSession(documents, clock, OWNER);
    strangerCookie = await seedOwnerSession(documents, clock, STRANGER);
  });

  /** Um contrato direto criado pelo console (o worker põe em provisioning). */
  async function created(): Promise<{ id: string; slug: string }> {
    const body = directRequest();
    const response = (await send('/v1/admin/tenants', body).expect(201)).body as DirectTenantCreated;
    return { id: response.id, slug: String(body['slug']) };
  }

  describe('acesso', () => {
    it('as rotas dos clientes exigem a sessão de um responsável; escrita só em JSON e da mesma origem', async () => {
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
        .set('Cookie', ownerToken())
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify(body))
        .expect(415);
      await request(admin.getHttpServer())
        .post('/v1/admin/tenants')
        .set('Cookie', ownerToken())
        .set('Content-Type', 'application/json')
        .set('Sec-Fetch-Site', 'cross-site')
        .send(JSON.stringify(body))
        .expect(403);
      expect(await tenants.get(String(body['idempotencyKey']))).toBeUndefined();
      expect(workerCalls).toHaveLength(0);
    });

    it('as rotas do console não existem no worker, e as do worker não existem no console', async () => {
      await request(worker.getHttpServer()).get('/v1/admin/tenants').set('Cookie', ownerToken()).expect(404);
      await request(admin.getHttpServer())
        .post(`/internal/tenants/${newUlid()}/provision`)
        .set('Cookie', ownerToken())
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

      // O pedido ao worker: o token da conta do console (aud = WORKER_URL), o responsável no corpo, nunca o cookie.
      expect(workerCalls).toHaveLength(1);
      const call = workerCalls[0];
      expect(call?.url).toBe(`${WORKER_URL}/internal/tenants/${result.id}/provision`);
      expect(call?.body).toEqual({ confirmSlug: body['slug'], actor: OWNER });
      expect(Object.keys(call?.headers ?? {})).not.toContain('cookie');
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
        details: { problems: ['agents'] },
      });
      // O lugar é obrigatório, e o modo da tabela sai dele: nunca vem na configuração.
      const { hosting: _hosting, ...withoutHosting } = directRequest();
      const missing = await send('/v1/admin/tenants', withoutHosting).expect(400);
      expect(missing.body).toMatchObject({ details: { issues: [{ path: 'hosting' }] } });
      await send(
        '/v1/admin/tenants',
        directRequest({
          configuration: {
            mode: 'managed',
            cloudAccounts: 2,
            monthlyGib: 10,
            agents: 0,
            historyDays: 30,
            support: 'standard',
          },
        }),
      ).expect(400);
      const above = await send(
        '/v1/admin/tenants',
        directRequest({
          configuration: {
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
      expect(refused.length).toBe(8);
      expect(refused.every((doc) => doc.data['actor'] === `owner:${OWNER}`)).toBe(true);
    });

    it('a cotação de referência pela tabela vigente, com o que o provisionamento ainda não cria', async () => {
      const ok = await send('/v1/admin/tenants/preview', {
        hosting: 'verax',
        configuration: {
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
        hosting: 'verax',
        configuration: {
          cloudAccounts: 2,
          monthlyGib: 10,
          agents: 5,
          historyDays: 30,
          support: 'standard',
        },
      }).expect(200);
      expect(agents.body).toMatchObject({ contactUs: false, problems: ['agents'] });
      await send('/v1/admin/tenants/preview', { hosting: 'verax', configuration: {} }).expect(400);
      // No cliente, a cotação é a da licença; agentes nas instâncias ainda não (o guia não liga a entrada deles).
      const customer = await send('/v1/admin/tenants/preview', {
        hosting: 'customer',
        configuration: { cloudAccounts: 2, monthlyGib: 10, agents: 5, historyDays: 30, support: 'standard' },
      }).expect(200);
      expect(customer.body).toMatchObject({
        quote: {
          configuration: { mode: 'self_hosted', agents: 10 },
          monthlyTotal: 60_000,
          setupTotal: 100_000,
        },
        problems: ['agents'],
      });
      const withAgents = directRequest({
        hosting: 'customer',
        configuration: { cloudAccounts: 2, monthlyGib: 10, agents: 5, historyDays: 30, support: 'standard' },
      });
      const refused = await send('/v1/admin/tenants', withAgents).expect(422);
      expect(refused.body).toMatchObject({
        code: 'configuration_unsupported',
        message: 'Esta configuração ainda não pode ser instalada na infraestrutura do cliente.',
        details: { problems: ['agents'], issues: [{ path: 'configuration.agents' }] },
      });
      expect(await tenants.get(String(withAgents['idempotencyKey']))).toBeUndefined();
      expect(workerCalls).toHaveLength(0);
    });

    it('sem tabela de preços vigente, nada de cadastro (409)', async () => {
      documents.clear();
      ownerCookie = await seedOwnerSession(documents, clock, OWNER);
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
          (call) => (call.body as { actor?: string }).actor === OWNER && !('cookie' in call.headers),
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

  describe('contrato direto com o ambiente na infraestrutura do cliente', () => {
    function customerRequest(): Record<string, unknown> {
      return directRequest({ hosting: 'customer' });
    }

    function publishRelease(): void {
      const manifest = manifestFor(RELEASE);
      cloud.objects.set(`${RELEASES}/${RELEASE}/manifest.json`, manifest);
      cloud.objects.set(`${RELEASES}/${RELEASE}/manifest.json.sig`, releaseKey.sign(manifest));
    }

    it('o cadastro não chama o worker; o detalhe não tem passos nem endereços da Verax; iniciar e retomar são recusados', async () => {
      const body = customerRequest();
      const result = (await send('/v1/admin/tenants', body).expect(201)).body as DirectTenantCreated;
      expect(result).toEqual({
        id: body['idempotencyKey'],
        slug: body['slug'],
        replayed: false,
        hosting: 'customer',
      });
      expect(workerCalls).toHaveLength(0);
      expect(queue.tasks).toHaveLength(0);

      const detail = (await read(`/v1/admin/tenants/${result.id}`).expect(200)).body as TenantDetail;
      expect(detail).toMatchObject({
        hosting: 'customer',
        state: 'waiting_customer_install',
        configuration: { mode: 'self_hosted' },
        timeline: [],
        actions: { start: false, resume: false, suspend: false, cancel: true, export: false },
      });
      expect(detail.urls).toBeUndefined();
      const list = (await read('/v1/admin/tenants').expect(200)).body as TenantList;
      expect(list.tenants.map((item) => [item.hosting, item.state])).toEqual([
        ['customer', 'waiting_customer_install'],
      ]);

      // O worker recusa por conta própria, mesmo pedido pelo console (409 customer_hosted), e nada vai à fila.
      const confirm = { confirmSlug: body['slug'] };
      for (const action of ['start', 'resume']) {
        const refused = await send(`/v1/admin/tenants/${result.id}/${action}`, confirm).expect(409);
        expect(refused.body).toMatchObject({ code: 'customer_hosted' });
      }
      const direct = await internal(`/internal/tenants/${result.id}/provision`, OWNER, confirm).expect(409);
      expect(direct.body).toMatchObject({ code: 'customer_hosted' });
      expect((await tenants.require(result.id)).state).toBe('waiting_customer_install');
      expect(queue.tasks).toHaveLength(0);

      // Cancelar só registra o fim do contrato: nenhum pedido de parar VM, nenhuma chamada à nuvem.
      const canceled = await send(`/v1/admin/tenants/${result.id}/cancel`, confirm).expect(200);
      expect(canceled.body).toMatchObject({ action: 'cancel', result: 'canceled' });
      expect((await tenants.require(result.id)).lifecycle?.exportUntil).toBeUndefined();
      expect(queue.tasks).toHaveLength(0);
      expect(cloud.requests).toEqual([]);
    });

    it('a instalação: o worker lê e confere o manifesto do bucket de releases, e o console devolve o guia e o node.conf', async () => {
      publishRelease();
      const body = customerRequest();
      const { id } = (await send('/v1/admin/tenants', body).expect(201)).body as DirectTenantCreated;
      const response = await read(`/v1/admin/tenants/${id}/installation`).expect(200);
      const installation = response.body as TenantInstallation;
      const github = 'https://github.com/williandotdev/verax-control';
      expect(installation).toMatchObject({
        release: RELEASE,
        manifestUrl: `${github}/releases/download/${RELEASE}/manifest.json`,
        signatureUrl: `${github}/releases/download/${RELEASE}/manifest.json.sig`,
        guideUrl: `${github}/blob/main/docs/runbooks/instalacao-no-cliente.md`,
        images: { api: `ghcr.io/williandotdev/verax-control/api@sha256:${'1'.repeat(64)}` },
      });
      expect(installation.nodeConf[0]).toEqual({ name: 'PLAN', value: 'enterprise' });
      expect(response.headers['cache-control']).toBe('private, no-store');
      // O pedido ao worker: a rota de leitura, com o responsável no corpo e o token da conta do console.
      expect(workerCalls.map((call) => [call.url, call.body])).toEqual([
        [`${WORKER_URL}/internal/tenants/${id}/installation`, { actor: OWNER }],
      ]);
      // Só o bucket de releases foi lido: nada no projeto dos nós, no Cloudflare nem no Firebase.
      expect(cloud.requests.length).toBeGreaterThan(0);
      expect(cloud.requests.every((call) => call.method === 'GET' && call.path.includes(RELEASES))).toBe(
        true,
      );

      // A assinatura de outra chave: recusado, e o console diz o código.
      const manifest = manifestFor(RELEASE);
      cloud.objects.set(`${RELEASES}/${RELEASE}/manifest.json.sig`, new TestReleaseKey().sign(manifest));
      const tampered = await read(`/v1/admin/tenants/${id}/installation`).expect(502);
      expect(tampered.body).toMatchObject({ code: 'release_manifest_invalid' });
    });

    it('a rota da instalação no worker: só o responsável (ou o console com ele em actor), e só para o ambiente no cliente', async () => {
      publishRelease();
      const { id } = (await send('/v1/admin/tenants', customerRequest()).expect(201))
        .body as DirectTenantCreated;
      const path = `/internal/tenants/${id}/installation`;
      for (const caller of [INVOKER, PUBLIC_SA]) await internal(path, caller, {}).expect(403);
      await internal(path, ADMIN_SA, {}).expect(403);
      await internal(path, ADMIN_SA, { actor: STRANGER }).expect(403);
      await internal(path, OWNER, { outro: 1 }).expect(400);
      await internal(path, ADMIN_SA, { actor: OWNER }).expect(200);
      await internal(`/internal/tenants/${newUlid()}/installation`, OWNER, {}).expect(404);
      const verax = await created();
      const refused = await internal(`/internal/tenants/${verax.id}/installation`, OWNER, {}).expect(409);
      expect(refused.body).toMatchObject({ code: 'not_customer_hosted' });
      const fromConsole = await read(`/v1/admin/tenants/${verax.id}/installation`).expect(409);
      expect(fromConsole.body).toMatchObject({ code: 'not_customer_hosted' });
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

    it('o início do provisionamento recusa as tasks, o cp-public e a sessão do console; o responsável direto age como ele mesmo', async () => {
      const tenant = await pendingContract();
      const path = `/internal/tenants/${tenant.id}/provision`;
      for (const caller of [INVOKER, PUBLIC_SA]) {
        await internal(path, caller, { confirmSlug: tenant.slug }).expect(403);
      }
      // A sessão do console (o cookie ou o id dele como token) nunca vale no worker, nem repassada.
      await request(worker.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${ownerToken().split('=')[1] ?? ''}`)
        .send({ confirmSlug: tenant.slug })
        .expect(401);
      await request(worker.getHttpServer())
        .post(path)
        .set('Cookie', ownerToken())
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
