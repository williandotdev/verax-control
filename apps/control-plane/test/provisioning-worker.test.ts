import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { newUlid } from '../src/common/ulid.js';
import { WAITS } from '../src/provisioning/provisioning-steps.js';
import { ProvisioningStore } from '../src/provisioning/provisioning-store.js';
import type { MemoryQueuedTask } from '../src/queue/memory-step-queue.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { stepTaskBody } from '../src/queue/step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import type { TenantRecord } from '../src/tenants/tenant.schema.js';
import { MemoryMailSender, TestGoogleIdentity } from './support/access-fakes.js';
import { demoTenant } from './support/tenant-store-contract.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeCloud } from './support/fake-cloud.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { RecordingDocumentStore } from './support/recording-document-store.js';
import {
  manifestFor,
  panelBundle,
  panelUrl,
  sha256,
  TEST_PACKAGE_SHA256,
  TestReleaseKey,
} from './support/release-fixtures.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const OWNER = 'responsavel@exemplo.example';
const START = new Date('2026-11-05T12:00:00.000Z');
const RELEASE = 'node-v1.2.3';
const NEXT_RELEASE = 'node-v1.3.0';
const NODES = 'projeto-dos-nos-demo';
const ZONE = 'southamerica-east1-b';
const TFSTATE = 'projeto-dos-nos-demo-tfstate';
const RELEASES = 'projeto-exemplo-releases';
const SUPPORT = 'suporte@verax.example';
const HOUR_MS = 60 * MINUTE_MS;
/** O projeto do plano de controle (o das filas e do Job), onde fica o cofre da senha da caixa dos nós. */
const CONTROL_PLANE = 'projeto-exemplo-cp';
/** A conta do console do responsável (`cp-admin`), que chama as operações do responsável em nome de quem entrou nele. */
const CONSOLE_SA = 'cp-admin@projeto-exemplo.iam.gserviceaccount.com';
const NODE_MAIL_ENV = {
  SMTP_HOST_NODES: 'smtp.caixa-exemplo.example',
  SMTP_PORT_NODES: '587',
  SMTP_USER_NODES: 'avisos@verax.example',
  ADMIN_SA_EMAIL: CONSOLE_SA,
};
/** A senha fictícia da caixa dos nós (longa o bastante para a máscara do logger). */
const NODE_MAILBOX_VALUE = 'caixa-dos-nos-ficticia-1';

/**
 * O provisionamento (CP-07) pelo cp-worker inteiro: as tasks entregues por `POST /internal/steps/<passo>` com o token da
 * cp-invoker, os passos falando com o servidor falso (Cloudflare, Firebase, Compute, Storage, Cloud Run e Secret
 * Manager) e a fila em memória. A VM e o Job são simulados pelo teste entre uma entrega e outra.
 */
describe('cp-worker: provisionamento (CP-07)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new RecordingDocumentStore();
  const queue = new MemoryStepQueue();
  const google = new TestGoogleIdentity();
  const cloud = new FakeCloud();
  const releaseKey = new TestReleaseKey();
  const probe = {
    api: true,
    panel: true,
    calls: 0,
    apiHealthy(): Promise<boolean> {
      this.calls += 1;
      return Promise.resolve(this.api);
    },
    panelServesHsts(): Promise<boolean> {
      return Promise.resolve(this.panel);
    },
  };
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  const runs = new ProvisioningStore(documents, clock);
  const mail = new MemoryMailSender();
  let app: NestExpressApplication;
  /**
   * O mesmo cp-worker depois de o responsável trocar `NODE_RELEASE` e implantar de novo: o mesmo Firestore, a mesma
   * fila e as mesmas APIs falsas. (O nestjs-pino guarda o logger do primeiro app: os logs deste vão para o `capture`.)
   */
  let appNext: NestExpressApplication;
  /**
   * O mesmo cp-worker com o e-mail dos nós configurado (`SMTP_*_NODES`), com páginas de 2 clientes na recópia da senha
   * (a varredura passa por várias páginas em toda chamada).
   */
  let appMail: NestExpressApplication;
  /** Idem, sem orçamento de tempo na recópia: cada chamada processa uma página e devolve o cursor da seguinte. */
  let appMailPaged: NestExpressApplication;
  let cursor = 0;
  let slugSequence = 0;

  async function workerApp(
    release: string,
    extraEnv: Record<string, string> = {},
    nodeMailSync: { pageSize?: number; budgetMs?: number } = {},
  ): Promise<NestExpressApplication> {
    const worker = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      stepQueue: queue,
      idTokenKeys: google,
      mailSender: mail,
      capture,
      provisioning: {
        apis: {
          googleEndpoints: cloud.endpoints,
          cloudflareBase: cloud.cloudflareBase,
          accessTokens: { token: () => Promise.resolve(cloud.googleToken) },
          probe,
          releaseKeys: releaseKey.keys,
        },
        nodeMailSync,
      },
      env: {
        LOG_LEVEL: 'debug',
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: OWNER,
        PUBLIC_SA_EMAIL: PUBLIC_SA,
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
        NODE_RELEASE: release,
        MAIL_FROM_NODES: 'nao-responda@verax.example',
        BOOTSTRAP_SUPPORT_EMAIL: SUPPORT,
        CLOUDFLARE_API_TOKEN: cloud.cloudflareToken,
        CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
        CLOUDFLARE_ZONE_ID: '1'.repeat(32),
        FIREBASE_PANEL_PROJECTS: 'paineis-demo-1,paineis-demo-2',
        // O e-mail "ambiente pronto" (o do cliente de contrato direto sai na hora): o envio é o dublê em memória.
        SITE_SUCCESS_URL: 'https://veraxsistemas.com.br/checkout/sucesso?cs={CHECKOUT_SESSION_ID}',
        SMTP_HOST: 'smtp.exemplo.example',
        SMTP_USER: 'nao-responda@verax.example',
        SMTP_PASSWORD: 'senha-smtp-de-teste',
        MAIL_FROM: 'Verax Control <nao-responda@verax.example>',
        ...extraEnv,
      },
    });
    await worker.listen(0, '127.0.0.1');
    return worker;
  }

  beforeAll(async () => {
    await cloud.start();
    app = await workerApp(RELEASE);
    appNext = await workerApp(NEXT_RELEASE);
    appMail = await workerApp(RELEASE, NODE_MAIL_ENV, { pageSize: 2 });
    appMailPaged = await workerApp(RELEASE, NODE_MAIL_ENV, { pageSize: 2, budgetMs: 0 });
  });

  afterAll(async () => {
    await app.close();
    await appNext.close();
    await appMail.close();
    await appMailPaged.close();
    await cloud.stop();
  });

  /** O release da versão no bucket: o manifesto assinado com a chave do teste e, por padrão, o bundle do painel. */
  function publishRelease(options: { panel?: boolean; release?: string } = {}): void {
    const release = options.release ?? RELEASE;
    const bundle = panelBundle();
    const manifest = manifestFor(
      release,
      options.panel === false ? {} : { panel: { url: panelUrl(release), sha256: sha256(bundle) } },
    );
    cloud.objects.set(`${RELEASES}/${release}/manifest.json`, manifest);
    cloud.objects.set(`${RELEASES}/${release}/manifest.json.sig`, releaseKey.sign(manifest));
    cloud.objects.set(`${RELEASES}/${release}/panel-abcdef0123456789abcdef0123456789abcdef01.tar.gz`, bundle);
  }

  beforeEach(() => {
    cloud.reset();
    cloud.newDomain = () => ({
      hostState: 'HOST_UNHOSTED',
      ownershipState: 'OWNERSHIP_MISSING',
      certState: 'CERT_PREPARING',
      desired: [],
    });
    publishRelease();
    queue.clear();
    mail.sent.length = 0;
    cursor = 0;
    clock.set(START);
    probe.api = true;
    probe.panel = true;
  });

  function bearer(email: string): string {
    return `Bearer ${google.token({ email, aud: WORKER_URL })}`;
  }

  /** Um cliente pago, como o webhook (CP-04) o deixa: em `provisioning` no `preflight`, com a task na fila. */
  async function paidTenant(): Promise<TenantRecord> {
    slugSequence += 1;
    const tenant = await tenantIn(tenants, `cliente-demo-${slugSequence}`, 'provisioning');
    const runId = newUlid(clock.now().getTime());
    const result = await tenants.change(tenant.id, () => ({
      reason: 'teste',
      audit: { actor: 'system' },
      mutate: (current) => ({ ...current, provisioning: { runId, step: 'preflight', attempts: 0 } }),
    }));
    await queue.enqueue({ queue: 'provisioning', step: 'preflight', tenantId: tenant.id, runId });
    return result.tenant;
  }

  async function deliver(
    task: MemoryQueuedTask,
    retryCount = 0,
    target: NestExpressApplication = app,
  ): Promise<{ status: number; outcome?: string }> {
    const response = await request(target.getHttpServer())
      .post(`/internal/steps/${task.step}`)
      .set('Authorization', bearer(INVOKER))
      .set('X-CloudTasks-TaskRetryCount', String(retryCount))
      .send(stepTaskBody(task));
    return { status: response.status, outcome: (response.body as { outcome?: string }).outcome };
  }

  type Hook = (task: MemoryQueuedTask) => void | Promise<void>;
  interface Delivered {
    step: string;
    poll?: number;
    status: number;
    outcome?: string;
  }

  /**
   * Entrega as tasks na ordem em que entraram na fila (andando o relógio até o agendamento de cada uma), com a VM e o Job
   * avançando pelo `hook`. `twice` entrega cada task duas vezes seguidas (a repetição do Cloud Tasks).
   */
  async function drain(
    hook: Hook = () => undefined,
    options: { twice?: boolean; limit?: number; target?: NestExpressApplication } = {},
  ): Promise<Delivered[]> {
    const delivered: Delivered[] = [];
    for (let count = 0; count < (options.limit ?? 300); count += 1) {
      const task = queue.tasks[cursor];
      if (task === undefined) break;
      cursor += 1;
      if (task.scheduleAt !== undefined && task.scheduleAt.getTime() > clock.now().getTime())
        clock.set(task.scheduleAt);
      await hook(task);
      const result = await deliver(task, 0, options.target);
      delivered.push({ step: task.step, poll: task.poll, ...result });
      if (options.twice === true) {
        const again = await deliver(task, 0, options.target);
        delivered.push({ step: task.step, poll: task.poll, ...again });
      }
    }
    return delivered;
  }

  /** A VM e o Job de um cliente que dá certo: o `apply` termina, a instalação grava `verax/ready` e o cofre. */
  function healthyNode(
    tenant: TenantRecord,
    options: { readyAfterPolls?: number; domainActiveAfterPolls?: number; installed?: string } = {},
  ): (task: MemoryQueuedTask) => void {
    const slug = tenant.slug;
    const instance = `${NODES}/${ZONE}/vx-${slug}`;
    return (task) => {
      const poll = task.poll ?? 0;
      if (task.step === 'terraform.wait' && poll >= 1) {
        for (const [name, execution] of cloud.executions) {
          if (execution.state !== 'running') continue;
          execution.state = 'succeeded';
          const runId = execution.env.find((entry) => entry.name === 'RUN_ID')?.value ?? '';
          cloud.objects.set(
            `${TFSTATE}/runs/${slug}/${runId}/${name}/outputs.json`,
            Buffer.from(JSON.stringify(outputsOf(slug))),
          );
        }
      }
      if (task.step === 'node.wait_ready' && poll >= (options.readyAfterPolls ?? 1)) {
        cloud.guestAttributes.set(
          instance,
          new Map([
            ['ready', options.installed ?? RELEASE],
            ['version', 'abc'],
          ]),
        );
        cloud.secretVersions.set(`${NODES}/vx-${slug}-admin-bootstrap`, [
          { payload: '{}', state: 'ENABLED' },
        ]);
      }
      if (task.step === 'panel.domain_wait') {
        for (const domain of cloud.domains.values()) {
          domain.desired = [
            {
              domainName: `${slug}.control.veraxsistemas.com.br`,
              type: 'A',
              rdata: '203.0.113.10',
              requiredAction: 'ADD',
            },
            {
              domainName: `${slug}.control.veraxsistemas.com.br.`,
              type: 'TXT',
              rdata: 'hosting-site=vxc',
              requiredAction: 'ADD',
            },
            // Um nome fora do domínio do painel: nunca vira registro na zona.
            {
              domainName: 'veraxsistemas.com.br',
              type: 'TXT',
              rdata: 'verificacao-de-outro',
              requiredAction: 'ADD',
            },
          ];
          if (poll >= (options.domainActiveAfterPolls ?? 2)) {
            domain.certState = 'CERT_ACTIVE';
            domain.hostState = 'HOST_ACTIVE';
          } else if (poll >= 1) {
            domain.certState = 'CERT_PROPAGATING';
          }
        }
      }
    };
  }

  function outputsOf(slug: string): Record<string, unknown> {
    return {
      name_prefix: `vx-${slug}`,
      instance_name: `vx-${slug}`,
      zone: ZONE,
      nat_ip: '203.0.113.40',
      service_account_email: `vx-${slug}@${NODES}.iam.gserviceaccount.com`,
      service_account_unique_id: '123456789012345678901',
      secrets: {
        'cloudflare-tunnel-token': `vx-${slug}-cloudflare-tunnel-token`,
        'admin-bootstrap': `vx-${slug}-admin-bootstrap`,
      },
      backups_bucket: `${NODES}-vx-${slug}-backups`,
    };
  }

  /** Nenhum token (o do Google, o do Cloudflare e o de cada túnel) no log nem em documento nenhum já gravado. */
  function expectNoSecretsStored(): void {
    const secrets = [
      cloud.googleToken,
      cloud.cloudflareToken,
      ...[...cloud.tunnels.values()].map((tunnel) => tunnel.token),
    ];
    for (const secret of secrets) {
      expect(capture.text).not.toContain(secret);
      expect(documents.text).not.toContain(secret);
    }
    expect(queue.tasks.map((task) => JSON.stringify(task)).join('')).not.toMatch(
      /ya29|tunnel-token-|cf-teste/,
    );
  }

  describe('do zero a waiting_customer_connection', () => {
    it('os passos em ordem: túnel, site, Job, cofre do túnel, VM pronta, saúde, certificado e a senha no cofre', async () => {
      const tenant = await paidTenant();
      const delivered = await drain(healthyNode(tenant));
      const slug = tenant.slug;

      expect(delivered.every((entry) => entry.status === 200)).toBe(true);
      expect([...new Set(delivered.map((entry) => entry.step))]).toEqual([
        'preflight',
        'cloudflare.tunnel',
        'firebase.site',
        'terraform.apply',
        'terraform.wait',
        'secrets.smtp_password',
        'secrets.tunnel_token',
        'node.wait_ready',
        'node.health',
        'panel.domain_wait',
        'access.ready',
      ]);
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('waiting_customer_connection');
      expect(final.lock).toBeUndefined();
      expect(final.provisioning?.lastError).toBeUndefined();
      expect(final.provisioning?.nodeVersion).toBe(RELEASE);
      expect(final.resources).toMatchObject({
        nodesProject: NODES,
        zone: ZONE,
        namePrefix: `vx-${slug}`,
        instanceName: `vx-${slug}`,
        natIp: '203.0.113.40',
        serviceAccountUniqueId: '123456789012345678901',
        backupsBucket: `${NODES}-vx-${slug}-backups`,
        firebaseProject: 'paineis-demo-1',
        panelDomainActive: true,
        tfstatePrefix: `tenants/${slug}`,
      });
      expect(final.resources?.subnetCidr).toMatch(/^10\.0\.[0-9]+\.0\/24$/);
      expect(final.resources?.siteId?.startsWith(`vxc-${slug}-`)).toBe(true);
      expect(final.resources?.siteId?.slice(-7)).toMatch(/^-[0-9a-f]{6}$/);
      expect(final.resources?.dnsRecordIds).toHaveLength(3);

      // Cloudflare: um túnel, o ingresso para a API do nó e o CNAME com proxy; os registros do painel sem proxy.
      const [tunnel] = [...cloud.tunnels.values()];
      expect(cloud.tunnels.size).toBe(1);
      expect(tunnel?.name).toBe(`vx-${slug}`);
      expect(final.resources?.tunnelId).toBe(tunnel?.id);
      const records = [...cloud.dns.values()]
        .map((r) => `${r.type} ${r.name} ${r.content} ${r.proxied}`)
        .sort();
      expect(records).toEqual(
        [
          `A ${slug}.control.veraxsistemas.com.br 203.0.113.10 false`,
          `CNAME api-${slug}.veraxsistemas.com.br ${tunnel?.id}.cfargotunnel.com true`,
          `TXT ${slug}.control.veraxsistemas.com.br hosting-site=vxc false`,
        ].sort(),
      );

      // Firebase: o site, o painel com a CSP do cliente e o domínio.
      const siteId = final.resources?.siteId ?? '';
      expect(cloud.sites.get('paineis-demo-1')?.has(siteId)).toBe(true);
      expect(cloud.latestRelease(siteId)?.labels).toEqual({
        'verax-release': 'node-v1-2-3',
        'verax-panel': expect.stringMatching(/^[0-9a-f]{16}$/) as string,
      });
      expect([...(cloud.latestRelease(siteId)?.files.keys() ?? [])].sort()).toEqual([
        '/assets/app-abc123.js',
        '/index.html',
      ]);
      expect(JSON.stringify(cloud.latestConfig(siteId))).toContain(
        `connect-src 'self' https://api-${slug}.veraxsistemas.com.br`,
      );
      expect(JSON.stringify(cloud.latestConfig(siteId))).not.toContain('{tenant}');
      expect(cloud.domains.has(`${siteId}/${slug}.control.veraxsistemas.com.br`)).toBe(true);

      // O Job: uma execução, com as variáveis do cliente e da versão conferida.
      expect(cloud.executions.size).toBe(1);
      const [execution] = [...cloud.executions.values()];
      const env = Object.fromEntries((execution?.env ?? []).map((entry) => [entry.name, entry.value]));
      expect(env).toMatchObject({
        EXECUTOR_ACTION: 'apply',
        RUN_KIND: 'provision',
        RUN_ID: tenant.provisioning?.runId,
        TENANT_SLUG: slug,
        PLAN: 'enterprise',
        PLAN_MAX_CLOUD_ACCOUNTS: '50',
        PLAN_MONTHLY_GIB: '58',
        PLAN_HISTORY_DAYS: '60',
        NODE_VERSION: RELEASE,
        NODE_PACKAGE_SHA256: TEST_PACKAGE_SHA256,
        WEB_ORIGIN: `https://${slug}.control.veraxsistemas.com.br`,
        API_ORIGIN: `https://api-${slug}.veraxsistemas.com.br`,
        MAIL_FROM: 'nao-responda@verax.example',
        BOOTSTRAP_ADMIN_EMAIL: tenant.adminEmail,
        BOOTSTRAP_TENANT_NAME: tenant.company.legalName,
        BOOTSTRAP_SUPPORT_EMAIL: SUPPORT,
        IMAGES_REPOSITORY: 'ghcr.io/williandotdev/verax-control',
        // Sem SMTP_HOST_NODES, o nó nasce sem e-mail: as três vazias, e nada no cofre da senha da caixa.
        SMTP_HOST: '',
        SMTP_PORT: '',
        SMTP_USER: '',
      });
      expect(cloud.secretVersions.has(`${NODES}/vx-${slug}-smtp-password`)).toBe(false);
      expect(cloud.count('GET', 'cp-nodes-smtp-password')).toBe(0);
      expect(final.resources?.nodeMailPasswordAt).toBeUndefined();
      expect(capture.text).toContain('node_mail_disabled');

      // O token do túnel foi para o cofre do nó, uma versão.
      expect(cloud.secretVersions.get(`${NODES}/vx-${slug}-cloudflare-tunnel-token`)).toEqual([
        { payload: tunnel?.token, state: 'ENABLED' },
      ]);

      // A execução e os passos ficam registrados, sem segredo.
      const run = await runs.getRun(tenant.provisioning?.runId ?? '');
      expect(run).toMatchObject({ tenantId: tenant.id, kind: 'provision', outcome: 'succeeded' });
      expect(run?.release).toMatchObject({ release: RELEASE, packageSha256: TEST_PACKAGE_SHA256 });
      expect(
        (await runs.getStep(tenant.provisioning?.runId ?? '', 'terraform.apply'))?.outputs?.execution,
      ).toMatch(/^cp-terraform-/);
      expect((await tenants.listTransitions(tenant.id)).map((transition) => transition.to)).toEqual([
        'pending',
        'provisioning',
        'waiting_customer_connection',
      ]);
      expect(queue.tasks.length).toBe(cursor);
      expectNoSecretsStored();
    });

    it('cada task entregue duas vezes: o mesmo fim, um túnel, um site, um Job e uma versão do token do túnel', async () => {
      const tenant = await paidTenant();
      const delivered = await drain(healthyNode(tenant), { twice: true });
      expect(delivered.every((entry) => entry.status === 200)).toBe(true);
      expect(delivered.filter((entry, index) => index % 2 === 1).map((entry) => entry.outcome)).toEqual(
        delivered
          .filter((_, index) => index % 2 === 1)
          .map(() => expect.stringMatching(/^(already_done|stale_poll|not_provisioning)$/) as string),
      );
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('waiting_customer_connection');
      expect(cloud.tunnels.size).toBe(1);
      expect(cloud.executions.size).toBe(1);
      expect(cloud.sites.get('paineis-demo-1')?.size).toBe(1);
      expect(cloud.releases.get(final.resources?.siteId ?? '')?.length).toBe(1);
      expect(cloud.secretVersions.get(`${NODES}/vx-${tenant.slug}-cloudflare-tunnel-token`)).toHaveLength(1);
      expect(cloud.dns.size).toBe(3);
      expectNoSecretsStored();
    });

    it('o que já existe é reconhecido: túnel com o nome, site deste projeto, domínio e registros (409 e "já existe")', async () => {
      const tenant = await paidTenant();
      // Um túnel, o CNAME e o domínio que sobraram de uma tentativa anterior (o Firestore não os conhecia).
      cloud.tunnels.set('11111111-2222-3333-4444-555555555555', {
        id: '11111111-2222-3333-4444-555555555555',
        name: `vx-${tenant.slug}`,
        token: 'tunnel-token-antigo-000000',
      });
      const delivered = await drain(healthyNode(tenant));
      expect(delivered.every((entry) => entry.status === 200)).toBe(true);
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('waiting_customer_connection');
      expect(final.resources?.tunnelId).toBe('11111111-2222-3333-4444-555555555555');
      expect(cloud.tunnels.size).toBe(1);
      expect(cloud.count('POST', '/cfd_tunnel')).toBe(0);
    });

    it('o id do site já é de outro projeto do Firebase (ids são globais): sorteia outro e segue', async () => {
      const tenant = await paidTenant();
      await drain(undefined, { limit: 2 });
      const reserved = (await tenants.require(tenant.id)).resources?.siteId ?? '';
      cloud.foreignSites.add(reserved);
      await drain(healthyNode(tenant));
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('waiting_customer_connection');
      expect(final.resources?.siteId).not.toBe(reserved);
      expect(cloud.sites.get('paineis-demo-1')?.has(final.resources?.siteId ?? '')).toBe(true);
    });

    it('o pool do Firebase: o primeiro projeto com menos de 36 sites', async () => {
      cloud.sites.set(
        'paineis-demo-1',
        new Set(Array.from({ length: 36 }, (_, index) => `site-cheio-${index}`)),
      );
      const tenant = await paidTenant();
      await drain(undefined, { limit: 1 });
      expect((await tenants.require(tenant.id)).resources?.firebaseProject).toBe('paineis-demo-2');
    });

    it('panel.domain_wait consulta até CERT_ACTIVE e HOST_ACTIVE, criando os registros que o Firebase passa a pedir', async () => {
      const tenant = await paidTenant();
      const delivered = await drain(healthyNode(tenant, { domainActiveAfterPolls: 5 }));
      const waits = delivered.filter((entry) => entry.step === 'panel.domain_wait');
      expect(waits.map((entry) => entry.outcome)).toEqual([
        'waiting',
        'waiting',
        'waiting',
        'waiting',
        'waiting',
        'done',
      ]);
      expect(waits.map((entry) => entry.poll)).toEqual([undefined, 1, 2, 3, 4, 5]);
      expect((await tenants.require(tenant.id)).state).toBe('waiting_customer_connection');
      // Um nome fora do domínio do painel nunca vira registro, e o aviso não leva o conteúdo.
      expect([...cloud.dns.values()].some((record) => record.name === 'veraxsistemas.com.br')).toBe(false);
      expect(capture.text).toContain('panel_dns_record_skipped');
      expect(capture.text).not.toContain('verificacao-de-outro');
    });

    it('uma consulta repetida (a mesma task entregue de novo depois) é ignorada e não abre outra cadeia', async () => {
      const tenant = await paidTenant();
      const delivered = await drain(healthyNode(tenant, { readyAfterPolls: 3 }), { limit: 9 });
      const firstWait = queue.tasks.find(
        (task) => task.step === 'node.wait_ready' && task.poll === undefined,
      );
      expect(firstWait).toBeDefined();
      expect(delivered.at(-1)?.step).toBe('node.wait_ready');
      const before = queue.tasks.length;
      expect(await deliver(firstWait as MemoryQueuedTask)).toEqual({ status: 200, outcome: 'stale_poll' });
      expect(queue.tasks.length).toBe(before);
    });
  });

  describe('falhas', () => {
    it('wait_ready com verax/error: provisioning_failed com o código, sem mais tasks, e o alerta', async () => {
      const tenant = await paidTenant();
      const delivered = await drain((task) => {
        healthyNode(tenant)(task);
        if (task.step === 'node.wait_ready' && (task.poll ?? 0) >= 1) {
          cloud.guestAttributes.set(
            `${NODES}/${ZONE}/vx-${tenant.slug}`,
            new Map([['error', 'install_failed']]),
          );
        }
      });
      expect(delivered.at(-1)).toMatchObject({ step: 'node.wait_ready', outcome: 'failed' });
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('provisioning_failed');
      expect(final.provisioning?.lastError?.code).toBe('node_error:install_failed');
      expect(final.provisioning?.step).toBe('node.wait_ready');
      expect(final.lock).toBeUndefined();
      expect(queue.tasks.length).toBe(cursor);
      const alert = capture
        .entries()
        .find((entry) => entry.event === 'provisioning_failed' && entry.tenantId === tenant.id);
      expect(alert).toMatchObject({ step: 'node.wait_ready', code: 'node_error:install_failed' });
    });

    it('um verax/ready da versão pedida vale mesmo com um verax/error antigo (o DELETE do boot não apagou)', async () => {
      const tenant = await paidTenant();
      await drain((task) => {
        healthyNode(tenant)(task);
        if (task.step === 'node.wait_ready' && (task.poll ?? 0) >= 1) {
          cloud.guestAttributes
            .get(`${NODES}/${ZONE}/vx-${tenant.slug}`)
            ?.set('error', 'tunnel_token_missing');
        }
      });
      expect((await tenants.require(tenant.id)).state).toBe('waiting_customer_connection');
    });

    it('a VM demora: depois de 40 min só avisa e continua; passa de 90 min, ready_timeout', async () => {
      const tenant = await paidTenant();
      const delivered = await drain((task) => {
        if (task.step !== 'node.wait_ready') healthyNode(tenant)(task);
      });
      const waits = delivered.filter((entry) => entry.step === 'node.wait_ready');
      expect(waits.at(-1)?.outcome).toBe('failed');
      expect(waits.length).toBeGreaterThanOrEqual(WAITS.nodeReady.limitMs / WAITS.nodeReady.everyMs);
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe('ready_timeout');
      expect(
        capture
          .entries()
          .filter((entry) => entry.event === 'node_ready_slow' && entry.tenantId === tenant.id),
      ).toHaveLength(1);
    });

    it('sem o bundle do painel no manifesto (CP-09): panel_bundle_missing antes de criar qualquer coisa no Firebase', async () => {
      publishRelease({ panel: false });
      const tenant = await paidTenant();
      const delivered = await drain();
      expect(delivered.at(-1)).toMatchObject({ step: 'firebase.site', outcome: 'failed' });
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('provisioning_failed');
      expect(final.provisioning?.lastError?.code).toBe('panel_bundle_missing');
      expect(cloud.count('POST', '/firebase/')).toBe(0);
      expect(cloud.executions.size).toBe(0);
    });

    it('bundle trocado no bucket (o SHA-256 não é o do manifesto assinado): nada é publicado', async () => {
      const tenant = await paidTenant();
      cloud.objects.set(
        `${RELEASES}/${RELEASE}/panel-abcdef0123456789abcdef0123456789abcdef01.tar.gz`,
        panelBundle([{ path: './dist/x.js', content: 'invasor' }]),
      );
      await drain();
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe(
        'panel_bundle_sha256_mismatch',
      );
      expect(cloud.count('POST', '/versions')).toBe(0);
    });

    it('manifesto assinado por outra chave: release_manifest_invalid no preflight, sem criar nada', async () => {
      const manifest = manifestFor(RELEASE);
      cloud.objects.set(`${RELEASES}/${RELEASE}/manifest.json`, manifest);
      cloud.objects.set(`${RELEASES}/${RELEASE}/manifest.json.sig`, new TestReleaseKey().sign(manifest));
      const tenant = await paidTenant();
      await drain();
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe(
        'release_manifest_invalid',
      );
      expect(cloud.tunnels.size).toBe(0);
    });

    it('Cloudflare recusa o token (403): definitivo, cloudflare_denied', async () => {
      const tenant = await paidTenant();
      cloud.failNext('/cfd_tunnel', 403);
      await drain();
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe('cloudflare_denied');
    });

    it('Cloudflare fora (503): a task responde 503 para a fila repetir; na última tentativa, retries_exhausted', async () => {
      const tenant = await paidTenant();
      await drain(undefined, { limit: 1 });
      const task = queue.tasks[cursor] as MemoryQueuedTask;
      expect(task.step).toBe('cloudflare.tunnel');
      cloud.failNext('/cfd_tunnel', 503, { times: 2 });
      expect((await deliver(task, 0)).status).toBe(503);
      expect((await tenants.require(tenant.id)).state).toBe('provisioning');
      expect((await runs.getStep(tenant.provisioning?.runId ?? '', 'cloudflare.tunnel'))?.errorCode).toBe(
        'cloudflare_503',
      );
      expect((await deliver(task, 7)).outcome).toBe('failed');
      const final = await tenants.require(tenant.id);
      expect(final.provisioning?.lastError?.code).toBe('retries_exhausted');
      expect(final.provisioning?.step).toBe('cloudflare.tunnel');
    });

    it('o executor recusa a troca da conta de serviço do nó (result.json): para de vez, sem repetir o apply', async () => {
      const tenant = await paidTenant();
      await drain((task) => {
        if (task.step === 'terraform.wait' && (task.poll ?? 0) >= 1) {
          for (const [name, execution] of cloud.executions) {
            execution.state = 'failed';
            const runId = execution.env.find((entry) => entry.name === 'RUN_ID')?.value ?? '';
            cloud.objects.set(
              `${TFSTATE}/runs/${tenant.slug}/${runId}/${name}/result.json`,
              Buffer.from(JSON.stringify({ schema: 1, status: 'refused', code: 'node_sa_replacement' })),
            );
          }
        }
      });
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe(
        'terraform_refused:node_sa_replacement',
      );
      expect(cloud.executions.size).toBe(1);
    });

    it('o apply falha (sem recusa): repete uma vez e, na segunda, terraform_failed', async () => {
      const tenant = await paidTenant();
      await drain((task) => {
        if (task.step === 'terraform.wait' && (task.poll ?? 0) >= 1) {
          for (const execution of cloud.executions.values()) execution.state = 'failed';
        }
      });
      expect(cloud.executions.size).toBe(2);
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe('terraform_failed');
    });

    it('o Job passa de 35 min sem terminar: conta como falha e repete uma vez', async () => {
      const tenant = await paidTenant();
      await drain();
      expect(cloud.executions.size).toBe(2);
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe('terraform_failed');
    });

    it('a saúde pelo túnel não responde em 10 tentativas: health_failed', async () => {
      const tenant = await paidTenant();
      probe.api = false;
      await drain(healthyNode(tenant));
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe('health_failed');
    });

    it('a senha não chega ao cofre: bootstrap_missing', async () => {
      const tenant = await paidTenant();
      await drain((task) => {
        healthyNode(tenant)(task);
        cloud.secretVersions.delete(`${NODES}/vx-${tenant.slug}-admin-bootstrap`);
      });
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe('bootstrap_missing');
    });

    it('o domínio não sai em 24 h: domain_timeout, com um aviso em 2 h', async () => {
      const tenant = await paidTenant();
      await drain(healthyNode(tenant, { domainActiveAfterPolls: 100_000 }), { limit: 2000 });
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe('domain_timeout');
      expect(
        capture
          .entries()
          .filter((entry) => entry.event === 'panel_domain_slow' && entry.tenantId === tenant.id),
      ).toHaveLength(1);
      expect(clock.now().getTime() - START.getTime()).toBeGreaterThanOrEqual(24 * HOUR_MS);
    });

    it('o que foi vendido e o nó não sabe criar (agentes do Wazuh): configuration_unsupported no preflight', async () => {
      const tenant = await paidTenant();
      await tenants.change(tenant.id, () => ({
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (current) => ({ ...current, limits: { ...current.limits, maxAgents: 5 } }),
      }));
      await drain();
      expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe(
        'configuration_unsupported',
      );
      expect(cloud.requests).toHaveLength(0);
    });

    it('razão social acima de 120 (cliente gravado antes do limite): tenant_name_invalid no preflight, sem cortar', async () => {
      const tenant = await paidTenant();
      // O checkout e o customer.updated recusam desde o limite; a leitura do cliente ainda aceita o que veio antes.
      const legalName = `Cliente Demo A ${'ã'.repeat(106)}`;
      expect(legalName).toHaveLength(121);
      await tenants.change(tenant.id, () => ({
        reason: 'teste',
        audit: { actor: 'system' },
        allowLegalNameChange: true,
        mutate: (current) => ({ ...current, company: { ...current.company, legalName } }),
      }));
      await drain();
      const failed = await tenants.require(tenant.id);
      expect(failed.state).toBe('provisioning_failed');
      expect(failed.provisioning?.lastError?.code).toBe('tenant_name_invalid');
      expect(failed.company.legalName).toBe(legalName);
      expect(cloud.requests).toHaveLength(0);
    });

    it('cliente suspenso no meio (disputa, CP-04): o passo seguinte não faz nada e não enfileira', async () => {
      const tenant = await paidTenant();
      await drain(undefined, { limit: 2 });
      await tenants.transition(tenant.id, { to: 'suspended', reason: 'teste', audit: { actor: 'system' } });
      const delivered = await drain();
      expect(delivered).toEqual([
        { step: 'firebase.site', poll: undefined, status: 200, outcome: 'not_provisioning' },
      ]);
      expect(queue.tasks.length).toBe(cursor);
    });
  });

  describe('a versão do nó presa no primeiro apply (revisão do PR #90)', () => {
    /** O responsável chama o `resume` no cp-worker indicado. */
    async function resume(tenantId: string, target: NestExpressApplication): Promise<void> {
      await request(target.getHttpServer())
        .post(`/internal/tenants/${tenantId}/resume`)
        .set('Authorization', bearer(OWNER))
        .expect(200);
    }

    function executionVersions(): (string | undefined)[] {
      return [...cloud.executions.values()].map(
        (execution) => execution.env.find((entry) => entry.name === 'NODE_VERSION')?.value,
      );
    }

    it('apply parcial (VM criada, sem saídas) → NODE_RELEASE muda → o resume mantém a versão presa e o nó fica pronto', async () => {
      publishRelease({ release: NEXT_RELEASE });
      const tenant = await paidTenant();
      // O Terraform cria a VM (ela instala a versão pedida) e falha depois: as duas execuções terminam sem saídas.
      await drain((task) => {
        if (task.step === 'terraform.wait' && (task.poll ?? 0) >= 1) {
          for (const execution of cloud.executions.values()) execution.state = 'failed';
        }
      });
      const failed = await tenants.require(tenant.id);
      expect(failed.provisioning?.lastError?.code).toBe('terraform_failed');
      expect(failed.resources?.instanceName).toBeUndefined();
      expect(failed.provisioning?.nodeVersion).toBe(RELEASE);
      expect(failed.provisioning?.nodeVersionPinnedAt).toBeInstanceOf(Date);

      // O responsável troca NODE_RELEASE, implanta de novo e retoma: o nó continua na versão que já tem.
      await resume(tenant.id, appNext);
      const delivered = await drain(healthyNode(tenant, { installed: RELEASE }), { target: appNext });
      expect(delivered.every((entry) => entry.status === 200)).toBe(true);
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('waiting_customer_connection');
      expect(final.provisioning?.nodeVersion).toBe(RELEASE);
      expect(final.provisioning?.nodeVersionPinnedAt).toEqual(failed.provisioning?.nodeVersionPinnedAt);
      expect(executionVersions()).toEqual([RELEASE, RELEASE, RELEASE]);
      expect((await runs.getRun(final.provisioning?.runId ?? ''))?.release?.release).toBe(RELEASE);
      expect(
        capture
          .entries()
          .find((entry) => entry.event === 'node_release_pinned' && entry.tenantId === tenant.id),
      ).toMatchObject({ nodeVersion: RELEASE, nodeRelease: NEXT_RELEASE });
    });

    it('sem nenhum apply começado (parou antes, no bundle do painel), o resume usa a versão nova', async () => {
      publishRelease({ panel: false });
      publishRelease({ release: NEXT_RELEASE });
      const tenant = await paidTenant();
      await drain();
      const failed = await tenants.require(tenant.id);
      expect(failed.provisioning?.lastError?.code).toBe('panel_bundle_missing');
      expect(failed.provisioning?.nodeVersionPinnedAt).toBeUndefined();
      expect(cloud.executions.size).toBe(0);

      await resume(tenant.id, appNext);
      await drain(healthyNode(tenant, { installed: NEXT_RELEASE }), { target: appNext });
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('waiting_customer_connection');
      expect(final.provisioning?.nodeVersion).toBe(NEXT_RELEASE);
      expect(final.provisioning?.nodeVersionPinnedAt).toBeInstanceOf(Date);
      expect(executionVersions()).toEqual([NEXT_RELEASE]);
    });
  });

  describe('e-mail dos nós (SMTP_*_NODES e cp-nodes-smtp-password)', () => {
    const vaultKey = `${CONTROL_PLANE}/cp-nodes-smtp-password`;

    function storeNodePassword(payload = NODE_MAILBOX_VALUE, state = 'ENABLED'): void {
      const versions = cloud.secretVersions.get(vaultKey) ?? [];
      versions.push({ payload, state });
      cloud.secretVersions.set(vaultKey, versions);
    }

    /** A senha da caixa não aparece no log, em documento nenhum do Firestore, na fila nem nas variáveis do Job. */
    function expectPasswordNowhere(password: string): void {
      expect(capture.text).not.toContain(password);
      expect(documents.text).not.toContain(password);
      expect(queue.tasks.map((task) => JSON.stringify(task)).join('')).not.toContain(password);
      for (const execution of cloud.executions.values()) {
        expect(JSON.stringify(execution.env)).not.toContain(password);
      }
    }

    it('configurado: o servidor, a porta e o usuário no Job; a senha copiada para o cofre do nó antes do token do túnel', async () => {
      storeNodePassword();
      const tenant = await paidTenant();
      const delivered = await drain(healthyNode(tenant), { target: appMail });
      const slug = tenant.slug;
      expect(delivered.every((entry) => entry.status === 200)).toBe(true);
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('waiting_customer_connection');

      const [execution] = [...cloud.executions.values()];
      const env = Object.fromEntries((execution?.env ?? []).map((entry) => [entry.name, entry.value]));
      expect(env).toMatchObject({
        SMTP_HOST: 'smtp.caixa-exemplo.example',
        SMTP_PORT: '587',
        SMTP_USER: 'avisos@verax.example',
      });
      expect(Object.keys(env).filter((name) => /PASSWORD/.test(name))).toEqual([]);

      // Uma versão no cofre do nó, com a senha como está no cofre do plano de controle; nada lido de volta.
      expect(cloud.secretVersions.get(`${NODES}/vx-${slug}-smtp-password`)).toEqual([
        { payload: NODE_MAILBOX_VALUE, state: 'ENABLED' },
      ]);
      expect(cloud.count('GET', `vx-${slug}-smtp-password`)).toBe(0);
      // A senha vai para o cofre do nó logo depois do apply, antes do token do túnel (a instalação a espera).
      const writes = cloud.requests
        .filter((entry) => entry.method === 'POST' && entry.path.endsWith(':addVersion'))
        .map((entry) => entry.path.split('/').at(-1));
      expect(writes).toEqual([
        `vx-${slug}-smtp-password:addVersion`,
        `vx-${slug}-cloudflare-tunnel-token:addVersion`,
      ]);
      expect(final.resources?.nodeMailPasswordAt).toBeInstanceOf(Date);
      expect((await runs.getRun(final.provisioning?.runId ?? ''))?.nodeMail).toEqual({
        host: 'smtp.caixa-exemplo.example',
        port: 587,
        user: 'avisos@verax.example',
      });
      expect(capture.text).toContain('node_smtp_password_copied');
      expectPasswordNowhere(NODE_MAILBOX_VALUE);
      expectNoSecretsStored();
    });

    it('a senha que termina numa quebra de linha (o echo de quem gravou) vai sem ela, como o start.sh a leria', async () => {
      storeNodePassword(`${NODE_MAILBOX_VALUE}\n`);
      const tenant = await paidTenant();
      await drain(healthyNode(tenant), { target: appMail });
      expect((await tenants.require(tenant.id)).state).toBe('waiting_customer_connection');
      expect(cloud.secretVersions.get(`${NODES}/vx-${tenant.slug}-smtp-password`)?.[0]?.payload).toBe(
        NODE_MAILBOX_VALUE,
      );
    });

    it('configurado sem a senha no cofre: smtp_password_missing no preflight, sem criar nada', async () => {
      const tenant = await paidTenant();
      await drain(undefined, { target: appMail });
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('provisioning_failed');
      expect(final.provisioning?.lastError?.code).toBe('smtp_password_missing');
      expect(final.provisioning?.step).toBe('preflight');
      expect(cloud.tunnels.size).toBe(0);
      expect(cloud.executions.size).toBe(0);
      expect(cloud.count('POST', '/sites')).toBe(0);
    });

    it.each([
      ['com aspa simples', "senha'ficticia-da-caixa"],
      ['com espaço', 'senha ficticia da caixa'],
      ['com quebra de linha no meio', 'senha\nficticia-da-caixa'],
    ])(
      'a senha %s (o start.sh não a aceitaria): smtp_password_invalid no preflight, sem a senha no log',
      async (_case, password) => {
        storeNodePassword(password);
        const tenant = await paidTenant();
        await drain(undefined, { target: appMail });
        const final = await tenants.require(tenant.id);
        expect(final.provisioning?.lastError?.code).toBe('smtp_password_invalid');
        expect(cloud.executions.size).toBe(0);
        expectPasswordNowhere(password);
      },
    );

    it('a última versão desativada entre o preflight e a cópia: smtp_password_missing, sem gravar no nó', async () => {
      storeNodePassword();
      const tenant = await paidTenant();
      await drain(
        (task) => {
          healthyNode(tenant)(task);
          if (task.step === 'secrets.smtp_password') storeNodePassword('versao-desativada-1', 'DISABLED');
        },
        { target: appMail },
      );
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('provisioning_failed');
      expect(final.provisioning?.lastError?.code).toBe('smtp_password_missing');
      expect(final.provisioning?.step).toBe('secrets.smtp_password');
      expect(cloud.secretVersions.has(`${NODES}/vx-${tenant.slug}-smtp-password`)).toBe(false);
    });

    it('o cofre do nó recusa a gravação (sem o secretVersionAdder): secretmanager_denied', async () => {
      storeNodePassword();
      const tenant = await paidTenant();
      cloud.failNext(`vx-${tenant.slug}-smtp-password:addVersion`, 403, {
        body: { error: { status: 'PERMISSION_DENIED' } },
      });
      await drain(healthyNode(tenant), { target: appMail });
      const final = await tenants.require(tenant.id);
      expect(final.provisioning?.lastError?.code).toBe('secretmanager_denied');
      expect(final.provisioning?.step).toBe('secrets.smtp_password');
      expectPasswordNowhere(NODE_MAILBOX_VALUE);
    });

    describe('recópia na troca da senha (POST /internal/nodes/smtp-password/sync)', () => {
      const path = '/internal/nodes/smtp-password/sync';
      interface SyncBody {
        updated: number;
        failed: string[];
        skipped: number;
        complete: boolean;
        next?: string;
      }

      it('só o responsável; a senha nova vai para o cofre de cada nó com e-mail, com a auditoria de quem pediu', async () => {
        storeNodePassword();
        const withMail = await paidTenant();
        await drain(healthyNode(withMail), { target: appMail });
        const withoutMail = await paidTenant();
        await drain(healthyNode(withoutMail));
        expect((await tenants.require(withoutMail.id)).resources?.nodeMailPasswordAt).toBeUndefined();
        const copiedAt = (await tenants.require(withMail.id)).resources?.nodeMailPasswordAt;

        const rotated = 'caixa-dos-nos-ficticia-2';
        storeNodePassword(rotated);
        clock.set(new Date(clock.now().getTime() + HOUR_MS));
        const server = appMail.getHttpServer();
        await request(server).post(path).set('Authorization', bearer(INVOKER)).expect(403);
        await request(server).post(path).set('Authorization', bearer(PUBLIC_SA)).expect(403);
        const response = await request(server).post(path).set('Authorization', bearer(OWNER)).expect(200);
        const body = response.body as SyncBody;
        expect(body.failed).toEqual([]);
        expect(body.updated).toBeGreaterThanOrEqual(1);
        expect(body.complete).toBe(true);
        expect(body.next).toBeUndefined();
        expect(JSON.stringify(response.body)).not.toContain(rotated);

        expect(cloud.secretVersions.get(`${NODES}/vx-${withMail.slug}-smtp-password`)?.at(-1)).toEqual({
          payload: rotated,
          state: 'ENABLED',
        });
        expect(cloud.secretVersions.has(`${NODES}/vx-${withoutMail.slug}-smtp-password`)).toBe(false);
        const after = (await tenants.require(withMail.id)).resources?.nodeMailPasswordAt;
        expect(after?.getTime()).toBeGreaterThan(copiedAt?.getTime() ?? Number.POSITIVE_INFINITY);
        const audit = documents.writes.find(
          (write) => write.startsWith('auditLog/') && write.includes('node_smtp_password_synced'),
        );
        expect(audit).toContain(`owner:${OWNER}`);
        expectPasswordNowhere(rotated);
        expectPasswordNowhere(NODE_MAILBOX_VALUE);
      });

      /** Clientes ativos com a senha já copiada (sem passar pelo provisionamento inteiro), com slugs desta rodada. */
      async function tenantsWithMail(count: number, prefix: string): Promise<TenantRecord[]> {
        const created: TenantRecord[] = [];
        for (let index = 0; index < count; index += 1) {
          const tenant = await tenantIn(tenants, `${prefix}-${index}`, 'active');
          const marked = await tenants.change(tenant.id, () => ({
            reason: 'teste',
            audit: { actor: 'system' },
            mutate: (current) => ({ ...current, resources: { nodeMailPasswordAt: clock.now() } }),
          }));
          created.push(marked.tenant);
        }
        return created;
      }

      function lastVersion(slug: string): string | undefined {
        return cloud.secretVersions.get(`${NODES}/vx-${slug}-smtp-password`)?.at(-1)?.payload;
      }

      it('mais de uma página (páginas de 2): uma chamada varre todas e só então responde complete', async () => {
        const withMail = await tenantsWithMail(5, 'pagina');
        const gone = await tenantIn(tenants, 'pagina-excluido', 'deleted');
        await tenants.change(gone.id, () => ({
          reason: 'teste',
          audit: { actor: 'system' },
          mutate: (current) => ({ ...current, resources: { nodeMailPasswordAt: clock.now() } }),
        }));
        const noMail = await tenantIn(tenants, 'pagina-sem-email', 'active');
        storeNodePassword('caixa-dos-nos-ficticia-3');
        const queriesBefore = documents.queries.length;

        const response = await request(appMail.getHttpServer())
          .post(path)
          .set('Authorization', bearer(OWNER))
          .expect(200);
        const body = response.body as SyncBody;
        expect(body).toMatchObject({ failed: [], complete: true });
        expect(body.next).toBeUndefined();
        expect(body.updated).toBeGreaterThanOrEqual(5);
        expect(body.skipped).toBeGreaterThanOrEqual(1);
        for (const tenant of withMail) expect(lastVersion(tenant.slug)).toBe('caixa-dos-nos-ficticia-3');
        expect(lastVersion(gone.slug)).toBeUndefined();
        expect(lastVersion(noMail.slug)).toBeUndefined();
        // Pelo menos 7 clientes em páginas de 2: quatro páginas ou mais, cada uma depois do slug da anterior.
        const pages = documents.queries
          .slice(queriesBefore)
          .filter((query) => query.startsWith('tenants?') && query.includes('"orderBy":{"field":"slug"}'));
        expect(pages.length).toBeGreaterThanOrEqual(4);
        expect(pages.slice(1).every((query) => query.includes('"field":"slug","op":">"'))).toBe(true);
      });

      it('sem orçamento de tempo: cada chamada faz uma página e devolve next; complete só na última', async () => {
        const withMail = await tenantsWithMail(5, 'cursor');
        storeNodePassword('caixa-dos-nos-ficticia-4');
        const server = appMailPaged.getHttpServer();
        const cursors: string[] = [];
        let body: SyncBody | undefined;
        let after: string | undefined;
        for (let call = 0; call < 200; call += 1) {
          const response = await request(server)
            .post(after === undefined ? path : `${path}?after=${after}`)
            .set('Authorization', bearer(OWNER))
            .expect(200);
          body = response.body as SyncBody;
          expect(body.failed).toEqual([]);
          if (body.next === undefined) break;
          // Uma chamada que para no meio nunca diz que terminou.
          expect(body.complete).toBe(false);
          cursors.push(body.next);
          after = body.next;
        }
        expect(body?.complete).toBe(true);
        expect(cursors.length).toBeGreaterThanOrEqual(2);
        expect([...cursors].sort()).toEqual(cursors);
        expect(new Set(cursors).size).toBe(cursors.length);
        for (const tenant of withMail) expect(lastVersion(tenant.slug)).toBe('caixa-dos-nos-ficticia-4');
        // Um cursor fora do formato é recusado antes de qualquer gravação.
        const writes = cloud.count('POST', ':addVersion');
        await request(server)
          .post(`${path}?after=Nao%20E%20Slug`)
          .set('Authorization', bearer(OWNER))
          .expect(400);
        expect(cloud.count('POST', ':addVersion')).toBe(writes);
      });

      it('um cofre que recusa entra na lista de falhas e não para os outros', async () => {
        storeNodePassword();
        const first = await paidTenant();
        await drain(healthyNode(first), { target: appMail });
        const second = await paidTenant();
        await drain(healthyNode(second), { target: appMail });
        cloud.failNext(`vx-${first.slug}-smtp-password:addVersion`, 403, {
          body: { error: { status: 'PERMISSION_DENIED' } },
        });
        const response = await request(appMail.getHttpServer())
          .post(path)
          .set('Authorization', bearer(OWNER))
          .expect(200);
        const body = response.body as SyncBody;
        expect(body.failed).toEqual([first.id]);
        // Com um cofre que recusou, a troca não está completa: a senha antiga ainda não pode ser revogada.
        expect(body.complete).toBe(false);
        expect(cloud.secretVersions.get(`${NODES}/vx-${second.slug}-smtp-password`)).toHaveLength(2);
        expect(capture.text).toContain('node_smtp_password_sync_failed');
      });

      it('pelo console do responsável: só com quem agiu, e esse alguém em OWNER_PRINCIPALS (a auditoria leva o nome)', async () => {
        storeNodePassword();
        const [tenant] = await tenantsWithMail(1, 'console');
        if (tenant === undefined) throw new Error('sem cliente');
        const server = appMail.getHttpServer();
        const writes = cloud.count('POST', ':addVersion');
        await request(server).post(path).set('Authorization', bearer(CONSOLE_SA)).send({}).expect(403);
        await request(server)
          .post(path)
          .set('Authorization', bearer(CONSOLE_SA))
          .send({ actor: 'outra-pessoa@verax.example' })
          .expect(403);
        await request(server)
          .post(path)
          .set('Authorization', bearer(CONSOLE_SA))
          .send({ actor: OWNER, extra: true })
          .expect(400);
        expect(cloud.count('POST', ':addVersion')).toBe(writes);
        const response = await request(server)
          .post(path)
          .set('Authorization', bearer(CONSOLE_SA))
          .send({ actor: OWNER })
          .expect(200);
        expect((response.body as SyncBody).complete).toBe(true);
        expect(lastVersion(tenant.slug)).toBe(NODE_MAILBOX_VALUE);
        const audit = documents.writes.filter(
          (write) => write.startsWith('auditLog/') && write.includes('node_smtp_password_synced'),
        );
        expect(audit.at(-1)).toContain(`owner:${OWNER}`);
      });

      it('sem o e-mail dos nós configurado: 409; sem a senha no cofre: 409, e nada é gravado', async () => {
        await request(app.getHttpServer()).post(path).set('Authorization', bearer(OWNER)).expect(409);
        const response = await request(appMail.getHttpServer())
          .post(path)
          .set('Authorization', bearer(OWNER))
          .expect(409);
        expect((response.body as { code?: string }).code).toBe('smtp_password_missing');
        expect(cloud.count('POST', ':addVersion')).toBe(0);
      });
    });
  });

  describe('resume do responsável', () => {
    it('só o responsável; volta a provisioning com outra execução, e as tasks da anterior viram stale_run', async () => {
      const tenant = await paidTenant();
      cloud.failNext('/cfd_tunnel', 403);
      await drain();
      const failed = await tenants.require(tenant.id);
      expect(failed.state).toBe('provisioning_failed');
      const server = app.getHttpServer();

      await request(server)
        .post(`/internal/tenants/${tenant.id}/resume`)
        .set('Authorization', bearer(INVOKER))
        .expect(403);
      await request(server)
        .post(`/internal/tenants/${tenant.id}/resume`)
        .set('Authorization', bearer(PUBLIC_SA))
        .expect(403);
      await request(server)
        .post('/internal/tenants/nao-e-ulid/resume')
        .set('Authorization', bearer(OWNER))
        .expect(404);
      const response = await request(server)
        .post(`/internal/tenants/${tenant.id}/resume`)
        .set('Authorization', bearer(OWNER))
        .expect(200);
      const { runId } = response.body as { runId: string };
      expect(runId).not.toBe(failed.provisioning?.runId);
      const resumed = await tenants.require(tenant.id);
      expect(resumed.state).toBe('provisioning');
      expect(resumed.provisioning).toMatchObject({ runId, step: 'preflight', attempts: 1 });

      // Uma task da execução anterior que ainda chegue não faz nada.
      const stale = {
        queue: 'provisioning' as const,
        step: 'cloudflare.tunnel',
        tenantId: tenant.id,
        runId: failed.provisioning?.runId ?? '',
        taskId: 'x',
      };
      expect(await deliver(stale)).toEqual({ status: 200, outcome: 'stale_run' });

      await drain(healthyNode(tenant));
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('waiting_customer_connection');
      expect((await runs.getRun(runId))?.kind).toBe('resume');
      const resumeAudit = documents.writes.find(
        (write) => write.startsWith('auditLog/') && write.includes('provisioning_resumed'),
      );
      expect(resumeAudit).toContain(`owner:${OWNER}`);

      // Fora de provisioning e provisioning_failed, não há o que retomar.
      await request(server)
        .post(`/internal/tenants/${tenant.id}/resume`)
        .set('Authorization', bearer(OWNER))
        .expect(409);
    });
  });
  describe('cliente de contrato direto (console do responsável)', () => {
    /** Um cliente criado pelo console: `billing.mode = contract`, sem Stripe nem aceite, esperando em `pending`. */
    async function contractTenant(): Promise<TenantRecord> {
      slugSequence += 1;
      const { consent: _consent, stripe: _stripe, ...base } = demoTenant(`contrato-${slugSequence}`);
      return tenants.create(
        { ...base, billing: { mode: 'contract' } },
        { reason: 'contract_created', audit: { actor: `owner:${OWNER}` } },
      );
    }

    it('os mesmos passos de um cliente pago e, pronto, o e-mail com o link de uso único na hora (sem esperar 48 h)', async () => {
      const tenant = await contractTenant();
      const started = await request(app.getHttpServer())
        .post(`/internal/tenants/${tenant.id}/provision`)
        .set('Authorization', bearer(OWNER))
        .send({ confirmSlug: tenant.slug })
        .expect(200);
      expect(started.body).toMatchObject({ step: 'preflight' });

      const delivered = await drain(healthyNode(tenant));
      expect(delivered.every((entry) => entry.status === 200)).toBe(true);
      expect([...new Set(delivered.map((entry) => entry.step))]).toEqual([
        'preflight',
        'cloudflare.tunnel',
        'firebase.site',
        'terraform.apply',
        'terraform.wait',
        'secrets.smtp_password',
        'secrets.tunnel_token',
        'node.wait_ready',
        'node.health',
        'panel.domain_wait',
        'access.ready',
        'access.reveal_email',
      ]);
      const final = await tenants.require(tenant.id);
      expect(final.state).toBe('waiting_customer_connection');
      expect(final.billing).toEqual({ mode: 'contract' });
      expect(final.access?.revealEmailSentAt).toEqual(clock.now());
      // O Job recebeu o mesmo pedido de um cliente pago: nada de modo de cobrança no Terraform.
      const [execution] = [...cloud.executions.values()];
      expect(execution?.env.map((entry) => entry.name)).not.toContain('BILLING_MODE');

      expect(mail.sent).toHaveLength(1);
      const [message] = mail.sent;
      expect(message?.to).toBe(tenant.adminEmail);
      expect(message?.text).toContain(`https://${tenant.slug}.control.veraxsistemas.com.br`);
      expect(message?.text).toMatch(
        /https:\/\/veraxsistemas\.com\.br\/checkout\/sucesso#acesso=[A-Za-z0-9_-]{43}/,
      );
      expect(`${message?.text}${message?.html}`.toLowerCase()).not.toMatch(/senha:|password/);
      expect(queue.inQueue('lifecycle').map((task) => task.taskId)).toEqual([
        `access_reveal_email-${tenant.id}`,
      ]);

      // Uma entrega repetida do último passo não manda outro e-mail.
      const lastStep = queue.tasks.find((task) => task.step === 'access.ready');
      expect(lastStep).toBeDefined();
      if (lastStep !== undefined)
        expect(await deliver(lastStep)).toEqual({ status: 200, outcome: 'not_provisioning' });
      await drain();
      expect(mail.sent).toHaveLength(1);
    });

    it('o e-mail na fila falhou na primeira entrega do último passo: a repetição dele o põe', async () => {
      const tenant = await contractTenant();
      await request(app.getHttpServer())
        .post(`/internal/tenants/${tenant.id}/provision`)
        .set('Authorization', bearer(OWNER))
        .send({ confirmSlug: tenant.slug })
        .expect(200);
      const hook = healthyNode(tenant);
      let failed = false;
      await drain(async (task) => {
        hook(task);
        if (task.step === 'access.ready' && (task.poll ?? 0) === 0 && !failed) {
          failed = true;
          queue.failNext(new Error('fila fora do ar'));
          const result = await deliver(task);
          expect(result.status).toBeGreaterThanOrEqual(500);
        }
      });
      expect((await tenants.require(tenant.id)).state).toBe('waiting_customer_connection');
      expect(failed).toBe(true);
      expect(mail.sent.map((message) => message.to)).toEqual([tenant.adminEmail]);
    });

    it('um cliente pago continua sem o e-mail na hora (o plano B é de 48 h, pelo tick)', async () => {
      const tenant = await paidTenant();
      await drain(healthyNode(tenant));
      expect((await tenants.require(tenant.id)).state).toBe('waiting_customer_connection');
      expect(queue.inQueue('lifecycle')).toHaveLength(0);
      expect(mail.sent).toHaveLength(0);
    });
  });
});
