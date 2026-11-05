import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { newUlid } from '../src/common/ulid.js';
import { DELETE_STEPS } from '../src/lifecycle/deletion-engine.js';
import { PURGE_RETRY } from '../src/lifecycle/deletion-steps.js';
import { EXPORT_LINK_SECONDS } from '../src/lifecycle/export.service.js';
import type { MemoryQueuedTask } from '../src/queue/memory-step-queue.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { stepTaskBody } from '../src/queue/step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import type { Tenant, TenantRecord, TenantState } from '../src/tenants/tenant.schema.js';
import { cancelTenant } from '../src/webhook/billing-rules.js';
import { MemoryMailSender, TestGoogleIdentity } from './support/access-fakes.js';
import { createApp } from './support/create-app.js';
import { FakeCloud } from './support/fake-cloud.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { FakeStripe, fakeStripeKey } from './support/fake-stripe.js';
import { LogCapture } from './support/log-capture.js';
import { RecordingDocumentStore } from './support/recording-document-store.js';
import { manifestFor, TEST_PACKAGE_SHA256, TestReleaseKey } from './support/release-fixtures.js';
import { demoTenant } from './support/tenant-store-contract.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const OWNER = 'responsavel@exemplo.example';
const EXPORTER = 'cp-exporter@projeto-exemplo.iam.gserviceaccount.com';
/** A conta do console do responsável (`cp-admin`), que chama as operações em nome de quem entrou no console. */
const CONSOLE = 'cp-admin@projeto-exemplo.iam.gserviceaccount.com';
const START = new Date('2026-11-05T12:00:00.000Z');
const RELEASE = 'node-v1.2.3';
const NODES = 'projeto-dos-nos-demo';
const ZONE = 'southamerica-east1-b';
const TFSTATE = 'projeto-dos-nos-demo-tfstate';
const RELEASES = 'projeto-exemplo-releases';
const FIREBASE = 'paineis-demo-1';
const SUPPORT = 'suporte@verax.example';
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SYSTEM = { actor: 'system' };
const BACKUP = 'postgres/verax-20261204T063000Z.dump';

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function at(days: number, extraMs = 0): Date {
  return new Date(START.getTime() + days * DAY_MS + extraMs);
}

/**
 * O ciclo de vida depois da venda (CP-11) pelo cp-worker inteiro: o `tick` com o relógio falso, os passos na fila
 * `lifecycle` entregues por `POST /internal/steps/<passo>`, o `delete-now` e o `export` do responsável, contra o servidor
 * falso de Cloudflare, Firebase, Compute, Storage, Cloud Run, Secret Manager e IAM, e a Stripe falsa. O Job do executor é
 * simulado pelo teste (o `entrypoint.sh` tem os próprios testes, em `infra/control-plane/terraform/tests`).
 */
describe('cp-worker: suspensão, reativação, cancelamento e exclusão (CP-11)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new RecordingDocumentStore();
  const queue = new MemoryStepQueue();
  const google = new TestGoogleIdentity();
  const cloud = new FakeCloud();
  const stripe = new FakeStripe();
  const mail = new MemoryMailSender();
  const releaseKey = new TestReleaseKey();
  const probe = {
    api: true,
    apiHealthy(): Promise<boolean> {
      return Promise.resolve(this.api);
    },
    panelServesHsts(): Promise<boolean> {
      return Promise.resolve(true);
    },
  };
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  let app: NestExpressApplication;
  /** O mesmo cp-worker sem a conta que assina a exportação. */
  let noExporter: NestExpressApplication;
  let cursor = 0;
  let sequence = 0;
  /** Como o Job do executor termina na próxima consulta: sucesso, ou falha com o código do `result.json`. */
  let executorOutcome: { state: 'succeeded' } | { state: 'failed'; code: string } = { state: 'succeeded' };

  async function workerApp(
    extra: Record<string, string>,
    stripeApi: Awaited<ReturnType<FakeStripe['start']>>,
  ): Promise<NestExpressApplication> {
    const worker = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      stepQueue: queue,
      idTokenKeys: google,
      capture,
      mailSender: mail,
      stripeApi,
      provisioning: {
        apis: {
          googleEndpoints: cloud.endpoints,
          cloudflareBase: cloud.cloudflareBase,
          accessTokens: { token: () => Promise.resolve(cloud.googleToken) },
          probe,
          releaseKeys: releaseKey.keys,
        },
      },
      env: {
        LOG_LEVEL: 'debug',
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: OWNER,
        ADMIN_SA_EMAIL: CONSOLE,
        PUBLIC_SA_EMAIL: PUBLIC_SA,
        STRIPE_SECRET_KEY: fakeStripeKey('test'),
        SITE_SUCCESS_URL: 'https://veraxsistemas.example/checkout/sucesso',
        PROVISIONING_ENABLED: 'true',
        NODES_PROJECT_ID: NODES,
        NODES_REGION: 'southamerica-east1',
        NODES_ZONE: ZONE,
        TFSTATE_BUCKET: TFSTATE,
        TERRAFORM_JOB_NAME: 'cp-terraform',
        TASKS_PROJECT_ID: 'projeto-exemplo-cp',
        TASKS_LOCATION: 'southamerica-east1',
        TASKS_QUEUE_PROVISIONING: 'provisioning',
        TASKS_QUEUE_LIFECYCLE: 'lifecycle',
        RELEASE_BUCKET: RELEASES,
        NODE_RELEASE: RELEASE,
        MAIL_FROM_NODES: 'nao-responda@verax.example',
        BOOTSTRAP_SUPPORT_EMAIL: SUPPORT,
        CLOUDFLARE_API_TOKEN: cloud.cloudflareToken,
        CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
        CLOUDFLARE_ZONE_ID: '1'.repeat(32),
        FIREBASE_PANEL_PROJECTS: `${FIREBASE},paineis-demo-2`,
        ...extra,
      },
    });
    await worker.listen(0, '127.0.0.1');
    return worker;
  }

  beforeAll(async () => {
    await cloud.start();
    const stripeApi = await stripe.start();
    app = await workerApp({ EXPORT_SIGNER_SA_EMAIL: EXPORTER }, stripeApi);
    noExporter = await workerApp({}, stripeApi);
  });

  afterAll(async () => {
    await app.close();
    await noExporter.close();
    await cloud.stop();
    await stripe.stop();
  });

  beforeEach(() => {
    // Cada teste com o Firestore, os logs e as APIs limpos: o `tick` varre todos os clientes.
    documents.inner.clear();
    documents.writes.length = 0;
    capture.lines.length = 0;
    stripe.reset();
    cloud.reset();
    const manifest = manifestFor(RELEASE);
    cloud.objects.set(`${RELEASES}/${RELEASE}/manifest.json`, manifest);
    cloud.objects.set(`${RELEASES}/${RELEASE}/manifest.json.sig`, releaseKey.sign(manifest));
    queue.clear();
    cursor = 0;
    clock.set(START);
    probe.api = true;
    mail.sent.length = 0;
    executorOutcome = { state: 'succeeded' };
  });

  function bearer(email: string): string {
    return `Bearer ${google.token({ email, aud: WORKER_URL })}`;
  }

  // --- O cliente e os recursos dele ----------------------------------------------------------------------------------

  interface Seeded {
    tenant: TenantRecord;
    tunnelId: string;
    dnsIds: string[];
    siteId: string;
    subscriptionId: string;
    instance: string;
    panelHost: string;
  }

  /**
   * Um cliente que o provisionamento (CP-07) deixou no ar, com os recursos dele no servidor falso: a VM, o túnel, os
   * registros de DNS (a API, o painel e o TXT do certificado), o site e o domínio, as duas versões da chave do cofre de
   * credenciais, um backup e a assinatura na Stripe.
   */
  async function provisioned(
    slug: string,
    state: 'active' | 'waiting_customer_connection' = 'active',
  ): Promise<Seeded> {
    sequence += 1;
    const customer = stripe.addCustomer();
    const subscription = stripe.addSubscription({
      customer: String(customer.id),
      items: [{ price: 'price_demo_1' }],
      periodEnd: at(30),
    });
    const base = demoTenant(slug);
    const created = await tenants.create(
      {
        ...base,
        consent: { ...base.consent!, checkoutSessionId: `cs_test_${slug.replaceAll('-', '')}${sequence}` },
        stripe: { customerId: String(customer.id), subscriptionId: String(subscription.id), livemode: false },
      },
      { reason: 'teste', audit: SYSTEM },
    );
    const runId = newUlid(clock.now().getTime());
    await tenants.transition(created.id, {
      to: 'provisioning',
      reason: 'teste',
      audit: SYSTEM,
      mutate: (t) => ({ ...t, provisioning: { runId, step: 'preflight', attempts: 0 } }),
    });
    await tenants.transition(created.id, {
      to: 'waiting_customer_connection',
      reason: 'teste',
      audit: SYSTEM,
    });
    if (state === 'active')
      await tenants.transition(created.id, { to: 'active', reason: 'teste', audit: SYSTEM });

    const tunnelId = `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;
    cloud.tunnels.set(tunnelId, { id: tunnelId, name: `vx-${slug}`, token: `tunnel-token-${hex(32)}` });
    const apiHost = `api-${slug}.veraxsistemas.com.br`;
    const panelHost = `${slug}.control.veraxsistemas.com.br`;
    const dnsIds: string[] = [];
    for (const [type, name, content, proxied] of [
      ['CNAME', apiHost, `${tunnelId}.cfargotunnel.com`, true],
      ['A', panelHost, '203.0.113.10', false],
      ['TXT', `_acme-challenge.${panelHost}`, 'verificacao', false],
    ] as const) {
      const id = hex(16);
      cloud.dns.set(id, { id, type, name, content, proxied });
      dnsIds.push(id);
    }
    const siteId = `vxc-${slug}-${hex(3)}`;
    const sites = cloud.sites.get(FIREBASE) ?? new Set<string>();
    sites.add(siteId);
    cloud.sites.set(FIREBASE, sites);
    cloud.domains.set(`${siteId}/${panelHost}`, {
      hostState: 'HOST_ACTIVE',
      ownershipState: 'OWNERSHIP_ACTIVE',
      certState: 'CERT_ACTIVE',
      desired: [],
    });
    const instance = `${NODES}/${ZONE}/vx-${slug}`;
    cloud.instances.set(instance, { status: 'RUNNING' });
    cloud.secretVersions.set(`${NODES}/vx-${slug}-credentials-key`, [
      { payload: `chave-velha-${slug}`, state: 'DISABLED' },
      { payload: `chave-atual-${slug}`, state: 'ENABLED' },
    ]);
    cloud.objects.set(`${NODES}-vx-${slug}-backups/${BACKUP}`, Buffer.from('PGDMP-backup-de-teste'));

    const result = await tenants.change(created.id, () => ({
      reason: 'teste',
      audit: SYSTEM,
      mutate: (t) => ({
        ...t,
        provisioning: {
          runId,
          step: 'access.ready',
          attempts: 0,
          nodeVersion: RELEASE,
          nodeVersionPinnedAt: clock.now(),
        },
        resources: {
          nodesProject: NODES,
          zone: ZONE,
          instanceName: `vx-${slug}`,
          namePrefix: `vx-${slug}`,
          subnetCidr: `10.0.${sequence}.0/24`,
          natIp: '203.0.113.40',
          tunnelId,
          dnsRecordIds: dnsIds,
          firebaseProject: FIREBASE,
          siteId,
          panelDomainActive: true,
          tfstatePrefix: `tenants/${slug}`,
          serviceAccountUniqueId: '123456789012345678901',
          backupsBucket: `${NODES}-vx-${slug}-backups`,
        },
      }),
    }));
    return {
      tenant: result.tenant,
      tunnelId,
      dnsIds,
      siteId,
      subscriptionId: String(subscription.id),
      instance,
      panelHost,
    };
  }

  /** Cancelado agora (como o `customer.subscription.deleted` do CP-04 deixa): os prazos contam deste instante. */
  async function cancel(tenantId: string): Promise<TenantRecord> {
    const now = clock.now();
    return (
      await tenants.change(tenantId, (current) => cancelTenant(current, { at: now, audit: SYSTEM }, 'teste'))
    ).tenant;
  }

  async function reload(tenantId: string): Promise<TenantRecord> {
    return tenants.require(tenantId);
  }

  // --- A fila, o tick e o responsável --------------------------------------------------------------------------------

  async function deliver(
    task: MemoryQueuedTask,
    retryCount = 0,
  ): Promise<{ status: number; outcome?: string }> {
    const response = await request(app.getHttpServer())
      .post(`/internal/steps/${task.step}`)
      .set('Authorization', bearer(INVOKER))
      .set('X-CloudTasks-TaskRetryCount', String(retryCount))
      .send(stepTaskBody(task));
    return { status: response.status, outcome: (response.body as { outcome?: string }).outcome };
  }

  interface Delivered {
    step: string;
    poll?: number;
    status: number;
    outcome?: string;
  }

  /** Simula o Job do executor: na consulta seguinte, toda execução em andamento termina como `executorOutcome`. */
  function executorHook(task: MemoryQueuedTask): void {
    const waiting = task.step === 'deletion.terraform_wait' || task.step === 'crypto.purge_wait';
    if (!waiting || (task.poll ?? 0) < 1) return;
    for (const [name, execution] of cloud.executions) {
      if (execution.state !== 'running') continue;
      const env = new Map(execution.env.map((entry) => [entry.name, entry.value]));
      const slug = env.get('TENANT_SLUG') ?? '';
      const runId = env.get('RUN_ID') ?? '';
      if (executorOutcome.state === 'failed') {
        execution.state = 'failed';
        cloud.objects.set(
          `${TFSTATE}/runs/${slug}/${runId}/${name}/result.json`,
          Buffer.from(JSON.stringify({ schema: 1, status: 'failed', code: executorOutcome.code })),
        );
        continue;
      }
      execution.state = 'succeeded';
      // O que o executor faz de verdade na Exclusão 1: a VM some do projeto dos nós.
      if (env.get('EXECUTOR_ACTION') === 'destroy') cloud.instances.delete(`${NODES}/${ZONE}/vx-${slug}`);
    }
  }

  /** Entrega as tasks na ordem, andando o relógio até o agendamento de cada uma. `twice`: cada uma duas vezes. */
  async function drain(options: { twice?: boolean; limit?: number } = {}): Promise<Delivered[]> {
    const delivered: Delivered[] = [];
    for (let count = 0; count < (options.limit ?? 300); count += 1) {
      const task = queue.tasks[cursor];
      if (task === undefined) break;
      cursor += 1;
      if (task.scheduleAt !== undefined && task.scheduleAt.getTime() > clock.now().getTime())
        clock.set(task.scheduleAt);
      executorHook(task);
      delivered.push({ step: task.step, poll: task.poll, ...(await deliver(task)) });
      if (options.twice === true)
        delivered.push({ step: task.step, poll: task.poll, ...(await deliver(task)) });
    }
    return delivered;
  }

  async function tick(when: Date, target: NestExpressApplication = app): Promise<Record<string, unknown>> {
    clock.set(when);
    const response = await request(target.getHttpServer())
      .post('/internal/tick')
      .set('Authorization', bearer(INVOKER))
      .send({});
    expect(response.status).toBe(200);
    return response.body as Record<string, unknown>;
  }

  function ownerCall(
    path: string,
    body: unknown,
    who = OWNER,
    target: NestExpressApplication = app,
  ): request.Test {
    return request(target.getHttpServer())
      .post(path)
      .set('Authorization', bearer(who))
      .send(body as object);
  }

  function pending(step: string, tenantId?: string): MemoryQueuedTask[] {
    return queue.tasks
      .slice(cursor)
      .filter((task) => task.step === step && (tenantId === undefined || task.tenantId === tenantId));
  }

  function credentialStates(slug: string): string[] {
    return (cloud.secretVersions.get(`${NODES}/vx-${slug}-credentials-key`) ?? []).map((v) => v.state);
  }

  function executionsOf(slug: string, action: string): { name: string; value: string }[][] {
    return [...cloud.executions.values()]
      .map((execution) => execution.env)
      .filter(
        (env) =>
          env.some((e) => e.name === 'TENANT_SLUG' && e.value === slug) &&
          env.some((e) => e.name === 'EXECUTOR_ACTION' && e.value === action),
      );
  }

  /** Nenhum token, link assinado, e-mail de cliente ou conteúdo de cofre no log nem em documento gravado. */
  function expectNothingSecretStored(extra: readonly string[] = []): void {
    const secrets = [
      cloud.googleToken,
      cloud.cloudflareToken,
      ...[...cloud.tunnels.values()].map((tunnel) => tunnel.token),
      'X-Goog-Signature',
      'chave-atual-',
      'chave-velha-',
      ...extra,
    ];
    for (const secret of secrets) {
      expect(capture.text).not.toContain(secret);
      expect(documents.text).not.toContain(secret);
    }
    expect(capture.text).not.toMatch(/admin@[a-z0-9-]+\.example/);
  }

  // --- D+7 e D+37 ----------------------------------------------------------------------------------------------------

  describe('inadimplência: D+7 suspende, D+37 cancela', () => {
    it('relógio falso em D+7 e D+37: carência vencida suspende e para a VM; 30 dias sem pagar cancelam na Stripe', async () => {
      const seeded = await provisioned('inad-a');
      const id = seeded.tenant.id;
      await tenants.transition(id, {
        to: 'past_due',
        reason: 'teste',
        audit: SYSTEM,
        mutate: (t) => ({
          ...t,
          billing: { pastDueSince: START, graceUntil: at(7), resumeState: 'active' },
        }),
      });

      await tick(at(7, -HOUR_MS));
      expect((await reload(id)).state).toBe('past_due');
      expect(pending('node.stop', id)).toHaveLength(0);

      const d7 = await tick(at(7));
      expect(d7).toMatchObject({ grace: 1 });
      let tenant = await reload(id);
      expect(tenant.state).toBe('suspended');
      expect(tenant.billing).toMatchObject({ suspendedReason: 'grace_expired', unpaidSince: at(7) });
      expect(pending('node.stop', id)).toHaveLength(1);
      await drain();
      expect(cloud.instances.get(seeded.instance)?.status).toBe('TERMINATED');
      tenant = await reload(id);
      expect(tenant.lifecycle?.nodeStoppedAt).toBeInstanceOf(Date);
      // Disco e snapshots ficam: só `instances.stop`, nada apagado.
      expect(cloud.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);

      await tick(at(37, -HOUR_MS));
      expect((await reload(id)).state).toBe('suspended');
      expect(stripe.calls('DELETE', `/v1/subscriptions/${seeded.subscriptionId}`)).toHaveLength(0);

      const d37 = await tick(at(37));
      expect(d37).toMatchObject({ unpaid: 1 });
      const cancels = stripe.calls('DELETE', `/v1/subscriptions/${seeded.subscriptionId}`);
      expect(cancels).toHaveLength(1);
      expect(cancels[0]?.headers['idempotency-key']).toBe(`cancel-unpaid-${id}`);
      tenant = await reload(id);
      expect(tenant.state).toBe('canceled');
      expect(tenant.lifecycle).toMatchObject({
        canceledAt: at(37),
        exportUntil: at(67),
        deleteAfter: at(67),
        cryptoDestroyAfter: at(134),
      });
      // A VM já estava parada: nenhum pedido novo.
      await tick(at(37, HOUR_MS));
      expect(pending('node.stop', id)).toHaveLength(0);
      expect(stripe.calls('DELETE', `/v1/subscriptions/${seeded.subscriptionId}`)).toHaveLength(1);
    });

    it('suspenso por fraude nunca é cancelado pelo relógio, nem com unpaidSince antigo', async () => {
      const seeded = await provisioned('fraude-a');
      await tenants.transition(seeded.tenant.id, {
        to: 'suspended',
        reason: 'teste',
        audit: SYSTEM,
        mutate: (t) => ({ ...t, billing: { suspendedReason: 'fraud_review', unpaidSince: START } }),
      });
      await tick(at(400));
      expect((await reload(seeded.tenant.id)).state).toBe('suspended');
      expect(stripe.calls('DELETE', `/v1/subscriptions/${seeded.subscriptionId}`)).toHaveLength(0);
    });
  });

  // --- Reativação e a VM ---------------------------------------------------------------------------------------------

  describe('reativação: node.start e /health', () => {
    it('um suspenso que voltou a pagar tem a VM ligada pelo tick, e nodeStoppedAt sai depois do /health', async () => {
      const seeded = await provisioned('reativa-a');
      const id = seeded.tenant.id;
      await tenants.transition(id, {
        to: 'suspended',
        reason: 'teste',
        audit: SYSTEM,
        mutate: (t) => ({
          ...t,
          billing: { suspendedReason: 'unpaid', unpaidSince: START, resumeState: 'active' },
        }),
      });
      await tick(at(0, HOUR_MS));
      await drain();
      expect(cloud.instances.get(seeded.instance)?.status).toBe('TERMINATED');
      // O `invoice.paid` (CP-04) devolve o cliente a `active`.
      await tenants.transition(id, {
        to: 'active',
        reason: 'invoice_paid',
        audit: SYSTEM,
        mutate: (t) => ({ ...t, billing: undefined }),
      });
      probe.api = false;
      await tick(at(0, 2 * HOUR_MS));
      expect(pending('node.start', id)).toHaveLength(1);
      await drain({ limit: 4 });
      expect(cloud.instances.get(seeded.instance)?.status).toBe('RUNNING');
      expect((await reload(id)).lifecycle?.nodeStoppedAt).toBeInstanceOf(Date);
      probe.api = true;
      await drain();
      expect((await reload(id)).lifecycle?.nodeStoppedAt).toBeUndefined();
    });

    it('um node.stop atrasado para um cliente ativo não faz nada', async () => {
      const seeded = await provisioned('atrasado-a');
      await queue.enqueue({
        queue: 'lifecycle',
        step: 'node.stop',
        tenantId: seeded.tenant.id,
        runId: newUlid(clock.now().getTime()),
      });
      const [result] = await drain();
      expect(result).toMatchObject({ status: 200, outcome: 'not_needed' });
      expect(cloud.count('POST', '/stop')).toBe(0);
      expect(cloud.instances.get(seeded.instance)?.status).toBe('RUNNING');
    });

    it('waiting_customer_connection vira active quando o nó vê a primeira conta conectada', async () => {
      const seeded = await provisioned('ativa-a', 'waiting_customer_connection');
      await tick(at(0, HOUR_MS));
      expect((await reload(seeded.tenant.id)).state).toBe('waiting_customer_connection');
      cloud.guestAttributes.set(seeded.instance, new Map([['accounts-connected', '2']]));
      const summary = await tick(at(0, 2 * HOUR_MS));
      expect(summary).toMatchObject({ activation: 1 });
      expect((await reload(seeded.tenant.id)).state).toBe('active');
    });

    it('o tick chama o plano B da revelação (CP-05) de quem espera há 48 h', async () => {
      const seeded = await provisioned('planob-a', 'waiting_customer_connection');
      await tick(at(2, HOUR_MS));
      expect(pending('access.reveal_email', seeded.tenant.id)).toHaveLength(1);
    });
  });

  // --- D+30 e D+97 ---------------------------------------------------------------------------------------------------

  describe('exclusão em dois tempos', () => {
    it('relógio falso em D+30 e D+97: Exclusão 1 apaga tudo menos a chave e o bucket; a chave só sai em D+97', async () => {
      const seeded = await provisioned('exclui-a');
      const id = seeded.tenant.id;
      await cancel(id);
      await tick(at(0, HOUR_MS));
      await drain();
      expect(cloud.instances.get(seeded.instance)?.status).toBe('TERMINATED');

      await tick(at(30, -HOUR_MS));
      expect((await reload(id)).state).toBe('canceled');
      expect(cloud.executions.size).toBe(0);

      const d30 = await tick(at(30));
      expect(d30).toMatchObject({ deletion: 1 });
      expect((await reload(id)).state).toBe('deleted');
      const delivered = await drain();
      expect(delivered.every((d) => d.status === 200)).toBe(true);
      expect(delivered.map((d) => d.step).filter((s, i, all) => all.indexOf(s) === i)).toEqual([
        ...DELETE_STEPS,
      ]);

      // O executor: destroy da exclusão, com as variáveis do cliente (a versão presa e o SHA-256 do manifesto).
      const [destroy] = executionsOf('exclui-a', 'destroy');
      const env = new Map((destroy ?? []).map((e) => [e.name, e.value]));
      expect(env.get('RUN_KIND')).toBe('delete');
      expect(env.get('NODE_VERSION')).toBe(RELEASE);
      expect(env.get('NODE_PACKAGE_SHA256')).toBe(TEST_PACKAGE_SHA256);
      expect(executionsOf('exclui-a', 'purge')).toHaveLength(0);
      // Cloudflare e Firebase: nada deste cliente sobra.
      expect(cloud.tunnels.has(seeded.tunnelId)).toBe(false);
      for (const dnsId of seeded.dnsIds) expect(cloud.dns.has(dnsId)).toBe(false);
      expect(cloud.sites.get(FIREBASE)?.has(seeded.siteId)).toBe(false);
      expect(cloud.domains.has(`${seeded.siteId}/${seeded.panelHost}`)).toBe(false);
      // A chave do cofre de credenciais fica até D+97.
      expect(credentialStates('exclui-a')).toEqual(['DISABLED', 'ENABLED']);
      expect(cloud.count('POST', 'credentials-key/versions')).toBe(0);
      // O registro de exclusão, e o cliente sem e-mail, acesso e recursos do nó.
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.to).toBe('admin@exclui-a.example');
      expect(mail.sent[0]?.subject).toContain('exclui-a');
      let tenant = await reload(id);
      expect(tenant.adminEmail).toBeUndefined();
      expect(tenant.access).toBeUndefined();
      expect(tenant.resources).toEqual({
        nodesProject: NODES,
        namePrefix: 'vx-exclui-a',
        backupsBucket: `${NODES}-vx-exclui-a-backups`,
        tfstatePrefix: 'tenants/exclui-a',
      });
      expect(tenant.lifecycle).toMatchObject({
        deletedAt: expect.any(Date) as Date,
        deletionRequestedBy: 'schedule',
        deletionRecordSentAt: expect.any(Date) as Date,
      });
      expect(tenant.lifecycle?.run).toBeUndefined();
      expect(tenant.lifecycle?.cryptoDestroyedAt).toBeUndefined();

      await tick(at(97, -HOUR_MS));
      expect(pending('crypto.destroy_key', id)).toHaveLength(0);
      expect(credentialStates('exclui-a')).toEqual(['DISABLED', 'ENABLED']);

      const d97 = await tick(at(97));
      expect(d97).toMatchObject({ crypto_destroy: 1 });
      await drain();
      expect(credentialStates('exclui-a')).toEqual(['DESTROYED', 'DESTROYED']);
      const [purge] = executionsOf('exclui-a', 'purge');
      expect(purge).toEqual([
        { name: 'EXECUTOR_ACTION', value: 'purge' },
        { name: 'RUN_KIND', value: 'crypto_destroy' },
        { name: 'RUN_ID', value: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as string },
        { name: 'TENANT_SLUG', value: 'exclui-a' },
      ]);
      tenant = await reload(id);
      expect(tenant.state).toBe('deleted');
      expect(tenant.resources).toBeUndefined();
      expect(tenant.provisioning).toBeUndefined();
      expect(tenant.billing).toBeUndefined();
      expect(tenant.stripe).toEqual({ livemode: false, customerId: seeded.tenant.stripe?.customerId });
      expect(tenant.company).toEqual(seeded.tenant.company);
      expect(tenant.lifecycle).toMatchObject({
        cryptoDestroyedAt: at(97),
        purgedAt: expect.any(Date) as Date,
        backupsBucketDeletedAt: expect.any(Date) as Date,
      });
      const actions = (await audit.listForTenant(id)).map((record) => record.action);
      expect(actions).toEqual(
        expect.arrayContaining(['tenant.deletion_completed', 'tenant.crypto_destroyed', 'tenant.purged']),
      );
      expectNothingSecretStored();
    });

    it('a exclusão duas vezes sem erro: cada task entregue duas vezes, o tick e o delete-now repetidos', async () => {
      const seeded = await provisioned('duas-a');
      const id = seeded.tenant.id;
      await cancel(id);
      await tick(at(30));
      await tick(at(30, MINUTE_MS));
      const first = await drain({ twice: true });
      expect(first.every((d) => d.status === 200)).toBe(true);
      expect(executionsOf('duas-a', 'destroy')).toHaveLength(1);
      expect(mail.sent).toHaveLength(1);
      const again = await ownerCall(`/internal/tenants/${id}/delete-now`, { confirmSlug: 'duas-a' }).expect(
        200,
      );
      expect(again.body).toMatchObject({ deletion: 'deleted' });
      await tick(at(97));
      await tick(at(97, MINUTE_MS));
      const second = await drain({ twice: true });
      expect(second.every((d) => d.status === 200)).toBe(true);
      expect(executionsOf('duas-a', 'purge')).toHaveLength(1);
      expect(credentialStates('duas-a')).toEqual(['DESTROYED', 'DESTROYED']);
      const done = await ownerCall(`/internal/tenants/${id}/delete-now`, { confirmSlug: 'duas-a' }).expect(
        200,
      );
      expect(done.body).toEqual({ deletion: 'purged' });
      await tick(at(200));
      expect(queue.tasks.slice(cursor)).toHaveLength(0);
    });

    it('uma exclusão que parou (Cloudflare recusou) avisa a Verax, e o delete-now recomeça e termina', async () => {
      const seeded = await provisioned('parou-a');
      const id = seeded.tenant.id;
      await cancel(id);
      await tick(at(30));
      cloud.failNext('/cfd_tunnel/', 403, { method: 'DELETE' });
      await drain();
      let tenant = await reload(id);
      expect(tenant.lifecycle?.run?.lastError?.code).toBe('cloudflare_denied');
      expect(capture.entries().some((e) => e.event === 'deletion_failed' && e.tenantId === id)).toBe(true);
      // O tick não recomeça uma execução parada.
      await tick(at(30, HOUR_MS));
      expect(pending('deletion.terraform', id)).toHaveLength(0);
      const restarted = await ownerCall(`/internal/tenants/${id}/delete-now`, {
        confirmSlug: 'parou-a',
      }).expect(200);
      expect(restarted.body).toMatchObject({ deletion: 'restarted', phase: 'delete' });
      await drain();
      tenant = await reload(id);
      expect(tenant.lifecycle?.deletedAt).toBeInstanceOf(Date);
      expect(cloud.tunnels.has(seeded.tunnelId)).toBe(false);
    });

    it('o bucket de backups ainda com objetos em D+97: a chave é destruída e o purge tenta de novo no dia seguinte', async () => {
      const seeded = await provisioned('bucket-a');
      const id = seeded.tenant.id;
      await cancel(id);
      await tick(at(30));
      await drain();
      await tick(at(97));
      executorOutcome = { state: 'failed', code: 'backups_bucket_not_empty' };
      // destroy_key, purge, a 1.ª consulta (em andamento) e a 2.ª (bucket com objetos: espera um dia).
      await drain({ limit: 4 });
      let tenant = await reload(id);
      expect(tenant.lifecycle?.cryptoDestroyedAt).toEqual(at(97));
      expect(tenant.lifecycle?.purgedAt).toBeUndefined();
      expect(credentialStates('bucket-a')).toEqual(['DESTROYED', 'DESTROYED']);
      executorOutcome = { state: 'succeeded' };
      await drain();
      tenant = await reload(id);
      expect(tenant.lifecycle?.purgedAt).toBeInstanceOf(Date);
      expect(clock.now().getTime()).toBeGreaterThanOrEqual(at(97).getTime() + PURGE_RETRY.everyMs);
      expect(executionsOf('bucket-a', 'purge')).toHaveLength(2);
    });

    it('cliente que nunca provisionou: excluído só no Firestore, sem nenhuma chamada externa', async () => {
      const base = demoTenant('nunca-a');
      const created = await tenants.create(
        { ...base, consent: { ...base.consent!, checkoutSessionId: 'cs_test_nunca_a' } },
        { reason: 'teste', audit: SYSTEM },
      );
      await cancel(created.id);
      // O CP-04 devolve o subdomínio de quem nunca provisionou; outro cliente pode tê-lo agora.
      await tenants.releaseSlug(created.id, 'nunca-a', 'teste', SYSTEM);
      await tick(at(30));
      await drain();
      await tick(at(97));
      await drain();
      const tenant = await reload(created.id);
      expect(tenant.lifecycle?.purgedAt).toBeInstanceOf(Date);
      expect(cloud.requests).toHaveLength(0);
      expect(cloud.executions.size).toBe(0);
    });
  });

  // --- Nunca um cliente em dia ---------------------------------------------------------------------------------------

  describe('um cliente em dia nunca é excluído', () => {
    const STATES: readonly TenantState[] = [
      'pending',
      'provisioning',
      'provisioning_failed',
      'waiting_customer_connection',
      'active',
      'past_due',
      'suspended',
    ];

    async function inState(slug: string, state: TenantState): Promise<TenantRecord> {
      const forge = (t: Tenant): Tenant => ({
        ...t,
        // Prazos de exclusão forjados no passado: o estado é que decide, não o prazo.
        lifecycle: { deleteAfter: START, cryptoDestroyAfter: START, exportUntil: at(1000) },
        ...(state === 'past_due'
          ? { billing: { pastDueSince: at(400), graceUntil: at(407), resumeState: 'active' as const } }
          : state === 'suspended'
            ? { billing: { suspendedReason: 'fraud_review' as const } }
            : {}),
      });
      if (state === 'pending' || state === 'provisioning' || state === 'provisioning_failed') {
        const base = demoTenant(slug);
        const created = await tenants.create(
          {
            ...base,
            consent: { ...base.consent!, checkoutSessionId: `cs_test_${slug.replaceAll('-', '')}` },
          },
          { reason: 'teste', audit: SYSTEM },
        );
        if (state !== 'pending') {
          await tenants.transition(created.id, { to: 'provisioning', reason: 'teste', audit: SYSTEM });
        }
        if (state === 'provisioning_failed') {
          await tenants.transition(created.id, { to: 'provisioning_failed', reason: 'teste', audit: SYSTEM });
        }
        return (await tenants.change(created.id, () => ({ reason: 'teste', audit: SYSTEM, mutate: forge })))
          .tenant;
      }
      const seeded = await provisioned(
        slug,
        state === 'waiting_customer_connection' ? 'waiting_customer_connection' : 'active',
      );
      const id = seeded.tenant.id;
      if (state === 'past_due' || state === 'suspended') {
        await tenants.transition(id, { to: state, reason: 'teste', audit: SYSTEM });
      }
      return (await tenants.change(id, () => ({ reason: 'teste', audit: SYSTEM, mutate: forge }))).tenant;
    }

    it('nem pelo tick (prazos forjados no passado, relógio em D+400), nem pelo delete-now, nem por task forjada', async () => {
      const list: TenantRecord[] = [];
      for (const [index, state] of STATES.entries()) list.push(await inState(`emdia-${index}`, state));
      clock.set(at(400));
      await tick(at(400));
      for (const tenant of list) {
        const current = await reload(tenant.id);
        expect(current.state).not.toBe('deleted');
        expect(current.state).not.toBe('canceled');
        const refused = await ownerCall(`/internal/tenants/${tenant.id}/delete-now`, {
          confirmSlug: tenant.slug,
        }).expect(409);
        expect(refused.body).toMatchObject({ code: 'not_canceled' });
        const forged = await deliver({
          queue: 'lifecycle',
          step: 'deletion.terraform',
          tenantId: tenant.id,
          runId: newUlid(clock.now().getTime()),
          taskId: 'forjada',
        });
        expect(forged).toMatchObject({ status: 200, outcome: 'not_deleting' });
      }
      expect(cloud.executions.size).toBe(0);
      expect(cloud.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
      expect(cloud.count('POST', ':destroy')).toBe(0);
      const refusals = (await audit.listForTenant(list[0]?.id ?? '')).filter(
        (record) => record.action === 'tenant.delete_now_refused',
      );
      expect(refusals[0]).toMatchObject({ actor: `owner:${OWNER}` });
    });
  });

  // --- delete-now ----------------------------------------------------------------------------------------------------

  describe('delete-now do responsável', () => {
    it('só o responsável, com o subdomínio de confirmação; auditado e idempotente', async () => {
      const seeded = await provisioned('agora-a');
      const id = seeded.tenant.id;
      await cancel(id);
      const path = `/internal/tenants/${id}/delete-now`;
      await ownerCall(path, { confirmSlug: 'agora-a' }, INVOKER).expect(403);
      await ownerCall(path, { confirmSlug: 'agora-a' }, PUBLIC_SA).expect(403);
      await request(app.getHttpServer()).post(path).send({ confirmSlug: 'agora-a' }).expect(401);
      await ownerCall(path, {}).expect(400);
      await ownerCall(path, { confirmSlug: 'agora-a', extra: true }).expect(400);
      const mismatch = await ownerCall(path, { confirmSlug: 'agora-b' }).expect(400);
      expect(mismatch.body).toMatchObject({ code: 'confirmation_mismatch' });
      expect((await reload(id)).state).toBe('canceled');
      await ownerCall('/internal/tenants/not-a-ulid/delete-now', { confirmSlug: 'agora-a' }).expect(404);
      await ownerCall(`/internal/tenants/${newUlid(Date.now())}/delete-now`, { confirmSlug: 'x' }).expect(
        404,
      );

      const started = await ownerCall(path, { confirmSlug: 'agora-a' }).expect(200);
      expect(started.body).toMatchObject({ deletion: 'started', phase: 'delete' });
      const tenant = await reload(id);
      expect(tenant.state).toBe('deleted');
      expect(tenant.lifecycle).toMatchObject({ deletionRequestedBy: 'owner', deleteAfter: START });
      // `cryptoDestroyAfter` continua contado do cancelamento.
      expect(tenant.lifecycle?.cryptoDestroyAfter).toEqual(at(97));
      const repeat = await ownerCall(path, { confirmSlug: 'agora-a' }).expect(200);
      expect(repeat.body).toEqual({ deletion: 'in_progress', phase: 'delete' });
      expect(pending('deletion.terraform', id)).toHaveLength(1);
      const records = await audit.listForTenant(id);
      expect(records.filter((r) => r.action === 'tenant.delete_now_requested')).toEqual([
        expect.objectContaining({ actor: `owner:${OWNER}` }),
      ]);
      expect(records.filter((r) => r.action === 'tenant.delete_now_refused')).toHaveLength(1);
      await drain();
      expect((await reload(id)).lifecycle?.deletedAt).toBeInstanceOf(Date);
    });

    it('A/B: excluir o cliente A não toca em nada do cliente B, nem com o subdomínio dele como prefixo', async () => {
      const a = await provisioned('acme');
      const b = await provisioned('acme-2');
      await cancel(a.tenant.id);
      // A confirmação com o subdomínio do outro cliente não exclui nada.
      await ownerCall(`/internal/tenants/${a.tenant.id}/delete-now`, { confirmSlug: 'acme-2' }).expect(400);
      await ownerCall(`/internal/tenants/${b.tenant.id}/delete-now`, { confirmSlug: 'acme-2' }).expect(409);
      await ownerCall(`/internal/tenants/${a.tenant.id}/delete-now`, { confirmSlug: 'acme' }).expect(200);
      await drain();
      await tick(at(97));
      await drain();
      expect(cloud.tunnels.has(a.tunnelId)).toBe(false);
      expect(cloud.tunnels.has(b.tunnelId)).toBe(true);
      for (const dnsId of b.dnsIds) expect(cloud.dns.has(dnsId)).toBe(true);
      expect(cloud.sites.get(FIREBASE)?.has(b.siteId)).toBe(true);
      expect(cloud.domains.has(`${b.siteId}/${b.panelHost}`)).toBe(true);
      expect(cloud.instances.get(b.instance)?.status).toBe('RUNNING');
      expect(credentialStates('acme-2')).toEqual(['DISABLED', 'ENABLED']);
      expect(credentialStates('acme')).toEqual(['DESTROYED', 'DESTROYED']);
      expect(executionsOf('acme-2', 'destroy')).toHaveLength(0);
      expect(executionsOf('acme-2', 'purge')).toHaveLength(0);
      const tenantB = await reload(b.tenant.id);
      expect(tenantB.state).toBe('active');
      expect(tenantB.adminEmail).toBe('admin@acme-2.example');
    });

    it('subdomínio tomado por outro cliente: a exclusão para sem tocar em nada `vx-<slug>`', async () => {
      const a = await provisioned('tomado-a');
      await cancel(a.tenant.id);
      // Forjado: o subdomínio solto e tomado por outro cliente (o CP-04 só solta o de quem nunca provisionou).
      await tenants.releaseSlug(a.tenant.id, 'tomado-a', 'teste', SYSTEM);
      const base = demoTenant('tomado-a');
      await tenants.create(
        { ...base, consent: { ...base.consent!, checkoutSessionId: 'cs_test_tomado_outro' } },
        { reason: 'teste', audit: SYSTEM },
      );
      await ownerCall(`/internal/tenants/${a.tenant.id}/delete-now`, { confirmSlug: 'tomado-a' }).expect(200);
      await drain();
      expect((await reload(a.tenant.id)).lifecycle?.run?.lastError?.code).toBe('slug_not_owned');
      expect(cloud.executions.size).toBe(0);
      expect(cloud.tunnels.has(a.tunnelId)).toBe(true);
      expect(cloud.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    });

    it('um registro de DNS gravado que não é deste cliente fica', async () => {
      const a = await provisioned('dns-a');
      const b = await provisioned('dns-b');
      await tenants.change(a.tenant.id, () => ({
        reason: 'teste',
        audit: SYSTEM,
        mutate: (t) => ({
          ...t,
          resources: {
            ...t.resources,
            dnsRecordIds: [...(t.resources?.dnsRecordIds ?? []), b.dnsIds[0] ?? ''],
          },
        }),
      }));
      await cancel(a.tenant.id);
      await ownerCall(`/internal/tenants/${a.tenant.id}/delete-now`, { confirmSlug: 'dns-a' }).expect(200);
      await drain();
      for (const dnsId of b.dnsIds) expect(cloud.dns.has(dnsId)).toBe(true);
      expect(capture.entries().some((e) => e.event === 'deletion_dns_record_skipped')).toBe(true);
    });
  });

  // --- contrato direto e o console ------------------------------------------------------------------------------------

  describe('contrato direto (sem a Stripe) e as operações pelo console', () => {
    /** Um cliente de contrato direto no ar: `billing.mode = contract`, sem assinatura na Stripe. */
    async function contract(slug: string): Promise<Seeded> {
      const seeded = await provisioned(slug);
      const result = await tenants.change(seeded.tenant.id, () => ({
        reason: 'teste',
        audit: SYSTEM,
        mutate: (t) => ({ ...t, stripe: undefined, billing: { mode: 'contract' as const } }),
      }));
      return { ...seeded, tenant: result.tenant };
    }

    function viaConsole(path: string, body: Record<string, unknown>): request.Test {
      return ownerCall(path, { ...body, actor: OWNER }, CONSOLE);
    }

    it('o relógio nunca suspende, cancela nem exclui um contrato direto, nem com prazos da Stripe forjados', async () => {
      const pastDue = await contract('contrato-a');
      await tenants.transition(pastDue.tenant.id, {
        to: 'past_due',
        reason: 'teste',
        audit: SYSTEM,
        mutate: (t) => ({ ...t, billing: { mode: 'contract', pastDueSince: START, graceUntil: at(7) } }),
      });
      const suspended = await contract('contrato-b');
      await tenants.transition(suspended.tenant.id, {
        to: 'suspended',
        reason: 'teste',
        audit: SYSTEM,
        mutate: (t) => ({
          ...t,
          billing: { mode: 'contract', suspendedReason: 'unpaid', unpaidSince: START },
        }),
      });
      const active = await contract('contrato-c');
      await tenants.change(active.tenant.id, () => ({
        reason: 'teste',
        audit: SYSTEM,
        mutate: (t) => ({ ...t, lifecycle: { deleteAfter: START, cryptoDestroyAfter: START } }),
      }));
      for (const day of [7, 37, 97, 400]) await tick(at(day));
      expect((await reload(pastDue.tenant.id)).state).toBe('past_due');
      expect((await reload(suspended.tenant.id)).state).toBe('suspended');
      expect((await reload(active.tenant.id)).state).toBe('active');
      expect(stripe.writes()).toHaveLength(0);
      expect(cloud.executions.size).toBe(0);
    });

    it('cancelar com data: o tick cancela na data marcada, e a exclusão segue D+30 e D+97 dela', async () => {
      const seeded = await contract('contrato-d');
      const id = seeded.tenant.id;
      const scheduled = await viaConsole(`/internal/tenants/${id}/cancel`, {
        confirmSlug: 'contrato-d',
        at: at(10).toISOString(),
      }).expect(200);
      expect(scheduled.body).toEqual({ result: 'scheduled', cancelAt: at(10).toISOString() });
      await tick(at(10, -HOUR_MS));
      expect((await reload(id)).state).toBe('active');
      const ended = await tick(at(10));
      expect(ended).toMatchObject({ contract_end: 1 });
      const canceled = await reload(id);
      expect(canceled.state).toBe('canceled');
      expect(canceled.lifecycle).toMatchObject({
        canceledAt: at(10),
        deleteAfter: at(40),
        cryptoDestroyAfter: at(107),
      });
      expect(canceled.lifecycle?.cancelScheduledFor).toBeUndefined();
      await drain();
      expect(cloud.instances.get(seeded.instance)?.status).toBe('TERMINATED');
      await tick(at(40));
      await drain();
      expect((await reload(id)).lifecycle?.deletedAt).toBeInstanceOf(Date);
      await tick(at(107));
      await drain();
      const purged = await reload(id);
      expect(purged.lifecycle?.purgedAt).toBeInstanceOf(Date);
      expect(purged.billing).toEqual({ mode: 'contract' });
      const records = await audit.listForTenant(id);
      expect(records.find((r) => r.action === 'tenant.contract_cancel_scheduled')).toMatchObject({
        actor: `owner:${OWNER}`,
      });
    });

    it('suspender e reativar pelo console: a VM para e liga; cancelar agora; recusas', async () => {
      const seeded = await contract('contrato-e');
      const id = seeded.tenant.id;
      const base = `/internal/tenants/${id}`;
      const suspended = await viaConsole(`${base}/suspend`, { confirmSlug: 'contrato-e' }).expect(200);
      expect(suspended.body).toEqual({ result: 'suspended', state: 'suspended' });
      expect((await reload(id)).billing).toMatchObject({ mode: 'contract', suspendedReason: 'owner' });
      await drain();
      expect(cloud.instances.get(seeded.instance)?.status).toBe('TERMINATED');
      await tick(at(400));
      expect((await reload(id)).state).toBe('suspended');
      const back = await viaConsole(`${base}/reactivate`, { confirmSlug: 'contrato-e' }).expect(200);
      expect(back.body).toEqual({ result: 'reactivated', state: 'active' });
      await drain();
      expect(cloud.instances.get(seeded.instance)?.status).toBe('RUNNING');
      expect((await reload(id)).lifecycle?.nodeStoppedAt).toBeUndefined();

      clock.set(at(401));
      // Uma data no passado encurtaria o prazo da exclusão; mais de 2 anos à frente é engano de digitação.
      await viaConsole(`${base}/cancel`, { confirmSlug: 'contrato-e', at: at(400).toISOString() }).expect(
        400,
      );
      await viaConsole(`${base}/cancel`, {
        confirmSlug: 'contrato-e',
        at: at(401 + 800).toISOString(),
      }).expect(400);
      await viaConsole(`${base}/cancel`, { confirmSlug: 'outro' }).expect(400);
      await viaConsole(`${base}/reactivate`, { confirmSlug: 'contrato-e' }).expect(409);
      expect((await reload(id)).state).toBe('active');
      const now = await viaConsole(`${base}/cancel`, { confirmSlug: 'contrato-e' }).expect(200);
      expect(now.body).toMatchObject({ result: 'canceled', deleteAfter: at(431).toISOString() });
      expect((await reload(id)).state).toBe('canceled');

      // Cliente da Stripe: cancelar, suspender e reativar são pela assinatura.
      const stripeTenant = await provisioned('assinante-a');
      for (const op of ['cancel', 'suspend', 'reactivate']) {
        const refused = await viaConsole(`/internal/tenants/${stripeTenant.tenant.id}/${op}`, {
          confirmSlug: 'assinante-a',
        }).expect(409);
        expect(refused.body).toMatchObject({ code: 'stripe_managed' });
      }
      expect((await reload(stripeTenant.tenant.id)).state).toBe('active');
    });

    it('o console só passa com quem agiu sendo um responsável; a cp-invoker e o cp-public nunca', async () => {
      const seeded = await contract('console-a');
      await cancel(seeded.tenant.id);
      const path = `/internal/tenants/${seeded.tenant.id}/delete-now`;
      await ownerCall(path, { confirmSlug: 'console-a' }, CONSOLE).expect(403);
      await ownerCall(path, { confirmSlug: 'console-a', actor: 'outra@exemplo.example' }, CONSOLE).expect(
        403,
      );
      await ownerCall(path, { confirmSlug: 'console-a', actor: OWNER }, INVOKER).expect(403);
      await ownerCall(path, { confirmSlug: 'console-a', actor: OWNER }, PUBLIC_SA).expect(403);
      // O tick não aceita a conta do console.
      await request(app.getHttpServer())
        .post('/internal/tick')
        .set('Authorization', bearer(CONSOLE))
        .expect(403);
      expect((await reload(seeded.tenant.id)).state).toBe('canceled');
      await viaConsole(path, { confirmSlug: 'console-a' }).expect(200);
      const records = await audit.listForTenant(seeded.tenant.id);
      expect(records.find((r) => r.action === 'tenant.delete_now_requested')).toMatchObject({
        actor: `owner:${OWNER}`,
      });
      // O resume (CP-07) também aceita o console com quem agiu.
      const failed = await provisioned('console-b');
      await tenants.transition(failed.tenant.id, { to: 'past_due', reason: 'teste', audit: SYSTEM });
      await ownerCall(`/internal/tenants/${failed.tenant.id}/resume`, {}, CONSOLE).expect(403);
      const notResumable = await viaConsole(`/internal/tenants/${failed.tenant.id}/resume`, {}).expect(409);
      expect(notResumable.body).toMatchObject({ code: 'not_resumable' });
    });
  });

  // --- export --------------------------------------------------------------------------------------------------------

  describe('export do responsável', () => {
    it('gera um link assinado de 24 h sem listar o bucket, conferido pela assinatura', async () => {
      const seeded = await provisioned('exporta-a');
      const id = seeded.tenant.id;
      await cancel(id);
      clock.set(at(10));
      const response = await ownerCall(`/internal/tenants/${id}/export`, { object: BACKUP }).expect(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      const body = response.body as { url: string; expiresAt: string; object: string };
      expect(body.object).toBe(BACKUP);
      expect(body.expiresAt).toBe(new Date(at(10).getTime() + EXPORT_LINK_SECONDS * 1000).toISOString());
      const url = new URL(body.url);
      expect(url.pathname).toBe(`/storage/${NODES}-vx-exporta-a-backups/${BACKUP}`);
      expect(url.searchParams.get('X-Goog-Expires')).toBe('86400');
      expect(url.searchParams.get('X-Goog-Credential')).toBe(
        `${EXPORTER}/20261115/auto/storage/goog4_request`,
      );
      // O link funciona (a assinatura confere com a chave da conta) e baixa o backup.
      const download = await fetch(body.url);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).toString()).toBe('PGDMP-backup-de-teste');
      expect(cloud.signedRequests).toEqual([
        { method: 'HEAD', path: url.pathname, valid: true },
        { method: 'GET', path: url.pathname, valid: true },
      ]);
      // Nenhuma listagem: nem a JSON (`/o?`), nem a XML (o bucket sem objeto).
      expect(cloud.requests.some((r) => /\/o(\?|$)/.test(r.path) || /backups\/?(\?|$)/.test(r.path))).toBe(
        false,
      );
      const record = (await audit.listForTenant(id)).find((r) => r.action === 'tenant.export_link_created');
      expect(record).toMatchObject({ actor: `owner:${OWNER}`, details: { object: BACKUP } });
      expect(JSON.stringify(record)).not.toContain('Signature');
      expectNothingSecretStored([url.searchParams.get('X-Goog-Signature') ?? 'sem-assinatura']);
    });

    it('recusa: fora da janela, cliente não cancelado, objeto fora do formato ou inexistente, sem a conta que assina', async () => {
      const active = await provisioned('exporta-b');
      await ownerCall(`/internal/tenants/${active.tenant.id}/export`, { object: BACKUP }).expect(409);
      const seeded = await provisioned('exporta-c');
      const id = seeded.tenant.id;
      await cancel(id);
      const path = `/internal/tenants/${id}/export`;
      await ownerCall(path, { object: BACKUP }, INVOKER).expect(403);
      await ownerCall(path, { object: 'postgres/' }).expect(400);
      await ownerCall(path, { object: '../outro/verax.dump' }).expect(400);
      await ownerCall(path, { object: 'postgres/verax-20261204T063000Z.dump?x=1' }).expect(400);
      await ownerCall(path, { object: 'postgres/verax-20261203T063000Z.dump' }).expect(404);
      await ownerCall(path, { object: BACKUP }, OWNER, noExporter).expect(503);
      clock.set(at(30, 1));
      await ownerCall(path, { object: BACKUP }).expect(409);
      // Só o backup inexistente chegou a ser assinado (o HEAD que o conferiu).
      expect(cloud.count('POST', ':signBlob')).toBe(1);
    });
  });
});
