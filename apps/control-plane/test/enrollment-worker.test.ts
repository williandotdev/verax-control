import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessStore } from '../src/access/access-store.js';
import { AuditService } from '../src/audit/audit.service.js';
import { newUlid } from '../src/common/ulid.js';
import { enrollmentHash } from '../src/enrollment/enrollment.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { WAITS } from '../src/provisioning/provisioning-steps.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { type StepTask, stepTaskBody } from '../src/queue/step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import type { TenantRecord } from '../src/tenants/tenant.schema.js';
import { MemoryMailSender, TestGoogleIdentity } from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeCloud } from './support/fake-cloud.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { RecordingDocumentStore } from './support/recording-document-store.js';
import { demoTenant } from './support/tenant-store-contract.js';
import { manifestFor, panelBundle, panelUrl, sha256, TestReleaseKey } from './support/release-fixtures.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const OWNER = 'responsavel@exemplo.example';
const START = new Date('2026-11-18T12:00:00.000Z');
const RELEASE = 'node-v1.2.3';
const NODES = 'projeto-dos-nos-demo';
const RELEASES = 'projeto-exemplo-releases';
const SUPPORT = 'suporte@verax.example';
const CONTROL_PLANE = 'projeto-exemplo-cp';
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A senha fictícia da caixa dos nós (longa o bastante para a máscara do logger). */
const NODE_MAILBOX_VALUE = 'caixa-dos-nos-ficticia-2';
/** A senha temporária fictícia do primeiro admin que a VM manda no `report ready`. */
const ADMIN_PASSWORD = `Temporaria-${randomBytes(8).toString('hex')}`;
const HOST = { cpus: 4, memoryMb: 16_384, diskGb: 200, os: 'Debian 12', arch: 'x86_64' };

/**
 * O ambiente na VM do cliente pelo cp-worker inteiro (contrato de 18/11/2026): o código de instalação do responsável, o
 * provisionamento reduzido (túnel, site, espera do registro, saúde, domínio e acesso) pelas tasks, e o `claim` e o
 * `report` da VM como o cp-public os repassa (o token da conta dele). As APIs da nuvem são o servidor falso.
 */
describe('cp-worker: registro da VM do cliente e provisionamento reduzido', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new RecordingDocumentStore();
  const queue = new MemoryStepQueue();
  const google = new TestGoogleIdentity();
  const cloud = new FakeCloud();
  const releaseKey = new TestReleaseKey();
  const probe = {
    apiHealthy: (): Promise<boolean> => Promise.resolve(true),
    panelServesHsts: (): Promise<boolean> => Promise.resolve(true),
  };
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  const mail = new MemoryMailSender();
  let app: NestExpressApplication;
  /** O mesmo cp-worker com o e-mail dos nós configurado (`SMTP_*_NODES`). */
  let appMail: NestExpressApplication;
  let cursor = 0;
  let slugSequence = 0;

  async function workerApp(extraEnv: Record<string, string> = {}): Promise<NestExpressApplication> {
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
        NODES_ZONE: 'southamerica-east1-b',
        TFSTATE_BUCKET: `${NODES}-tfstate`,
        TERRAFORM_JOB_NAME: 'cp-terraform',
        TASKS_PROJECT_ID: CONTROL_PLANE,
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
        FIREBASE_PANEL_PROJECTS: 'paineis-demo-1',
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
    app = await workerApp();
    appMail = await workerApp({
      SMTP_HOST_NODES: 'smtp.caixa-exemplo.example',
      SMTP_PORT_NODES: '587',
      SMTP_USER_NODES: 'avisos@verax.example',
    });
  });

  afterAll(async () => {
    await app.close();
    await appMail.close();
    await cloud.stop();
  });

  beforeEach(() => {
    cloud.reset();
    const bundle = panelBundle();
    const manifest = manifestFor(RELEASE, { panel: { url: panelUrl(RELEASE), sha256: sha256(bundle) } });
    cloud.objects.set(`${RELEASES}/${RELEASE}/manifest.json`, manifest);
    cloud.objects.set(`${RELEASES}/${RELEASE}/manifest.json.sig`, releaseKey.sign(manifest));
    cloud.objects.set(`${RELEASES}/${RELEASE}/panel-abcdef0123456789abcdef0123456789abcdef01.tar.gz`, bundle);
    queue.clear();
    mail.sent.length = 0;
    cursor = 0;
    clock.set(START);
  });

  function bearer(email: string): string {
    return `Bearer ${google.token({ email, aud: WORKER_URL })}`;
  }

  /** Um contrato direto com o ambiente na VM do cliente, como o console o cria: esperando a instalação. */
  async function customerTenant(): Promise<TenantRecord> {
    slugSequence += 1;
    const seed = demoTenant(`cliente-vm-${slugSequence}`);
    return tenants.create(
      {
        ...seed,
        consent: undefined,
        stripe: undefined,
        billing: { mode: 'contract' },
        hosting: 'customer',
        configuration: { ...seed.configuration, mode: 'self_hosted' },
      },
      {
        reason: 'contract_created_customer_hosted',
        audit: { actor: 'system' },
        initialState: 'waiting_customer_install',
      },
    );
  }

  async function issueCode(
    tenant: TenantRecord,
    target: NestExpressApplication = app,
  ): Promise<{ code: string; expiresAt: string; reinstall: boolean; runId?: string; step?: string }> {
    const response = await request(target.getHttpServer())
      .post(`/internal/tenants/${tenant.id}/enrollment-code`)
      .set('Authorization', bearer(OWNER))
      .send({ confirmSlug: tenant.slug });
    expect(response.status).toBe(200);
    return response.body as {
      code: string;
      expiresAt: string;
      reinstall: boolean;
      runId?: string;
      step?: string;
    };
  }

  function claim(
    code: string,
    overrides: Record<string, unknown> = {},
    target: NestExpressApplication = app,
  ): request.Test {
    return request(target.getHttpServer())
      .post('/internal/node-enrollment/claim')
      .set('Authorization', bearer(PUBLIC_SA))
      .send({ code, release: RELEASE, host: HOST, ...overrides });
  }

  function report(nodeKey: string, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/internal/node-enrollment/report')
      .set('Authorization', bearer(PUBLIC_SA))
      .send({ nodeKey, report: body });
  }

  async function deliver(task: StepTask): Promise<{ status: number; outcome?: string }> {
    const response = await request(app.getHttpServer())
      .post(`/internal/steps/${task.step}`)
      .set('Authorization', bearer(INVOKER))
      .set('X-CloudTasks-TaskRetryCount', '0')
      .send(stepTaskBody(task));
    return { status: response.status, outcome: (response.body as { outcome?: string }).outcome };
  }

  interface Delivered {
    step: string;
    poll?: number;
    status: number;
    outcome?: string;
  }

  /** Entrega as tasks na ordem (andando o relógio até o agendamento de cada uma), até `limit` entregas. */
  async function drain(limit = 100): Promise<Delivered[]> {
    const delivered: Delivered[] = [];
    for (let count = 0; count < limit; count += 1) {
      const task = queue.tasks[cursor];
      if (task === undefined) break;
      cursor += 1;
      if (task.scheduleAt !== undefined && task.scheduleAt.getTime() > clock.now().getTime()) {
        clock.set(task.scheduleAt);
      }
      // O certificado do domínio do painel sai na primeira consulta.
      for (const domain of cloud.domains.values()) {
        domain.certState = 'CERT_ACTIVE';
        domain.hostState = 'HOST_ACTIVE';
      }
      delivered.push({ step: task.step, poll: task.poll, ...(await deliver(task)) });
    }
    return delivered;
  }

  /** Os passos entregues, sem repetir as consultas de um passo que espera. */
  function stepsOf(delivered: Delivered[]): string[] {
    return delivered.map((entry) => entry.step).filter((step, index, all) => all[index - 1] !== step);
  }

  it('o primeiro código começa a sequência reduzida; a VM registra, fica pronta e o cliente espera a conexão', async () => {
    const tenant = await customerTenant();
    const issued = await issueCode(tenant);
    expect(issued).toMatchObject({ reinstall: false, step: 'preflight' });
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await tenants.require(tenant.id)).state).toBe('provisioning');

    // Até a espera do registro: o túnel e o site da Verax, sem Terraform, sem faixa de rede, sem cofre de nó.
    const first = await drain(4);
    expect(first.map((entry) => [entry.step, entry.outcome])).toEqual([
      ['preflight', 'done'],
      ['cloudflare.tunnel', 'done'],
      ['firebase.site', 'done'],
      ['enrollment.wait', 'waiting'],
    ]);
    let current = await tenants.require(tenant.id);
    expect(current.provisioning?.step).toBe('enrollment.wait');
    expect(current.resources).toMatchObject({ nodesProject: NODES, namePrefix: `vx-${tenant.slug}` });
    expect(current.resources?.subnetCidr).toBeUndefined();
    expect(current.resources?.tunnelId).toBeDefined();
    expect(cloud.executions.size).toBe(0);

    // O claim: o contrato, os endereços da Verax, o token do túnel lido na hora e a chave do nó, uma vez.
    const claimed = await claim(issued.code);
    expect(claimed.status).toBe(200);
    const tunnel = [...cloud.tunnels.values()][0];
    expect(claimed.body).toEqual({
      tenantId: tenant.id,
      slug: tenant.slug,
      apiOrigin: `https://api-${tenant.slug}.veraxsistemas.com.br`,
      webOrigin: `https://${tenant.slug}.control.veraxsistemas.com.br`,
      release: RELEASE,
      size: 'P',
      nodeConf: expect.arrayContaining([{ name: 'PLAN', value: 'enterprise' }]) as unknown,
      tenantName: tenant.company.legalName,
      adminEmail: tenant.adminEmail,
      supportEmail: SUPPORT,
      // Sem `SMTP_HOST_NODES`: o nó sobe sem e-mail, como o gerenciado.
      mail: null,
      tunnelToken: tunnel?.token,
      nodeKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
    });
    const nodeKey = (claimed.body as { nodeKey: string }).nodeKey;
    current = await tenants.require(tenant.id);
    expect(current.enrollment).toMatchObject({
      codeHash: enrollmentHash(issued.code),
      claimedAt: clock.now(),
      nodeKeyHash: enrollmentHash(nodeKey),
    });
    // Uso único: o mesmo código de novo é o 404 genérico.
    const again = await claim(issued.code);
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ code: 'not_found' });

    // Uma chave qualquer não reporta; a certa grava a senha no cofre (criado agora, na região dos nós) e marca pronto.
    expect((await report('A'.repeat(43), { status: 'error', code: 'x' })).status).toBe(401);
    const ready = await report(nodeKey, {
      status: 'ready',
      version: RELEASE,
      adminBootstrapPassword: ADMIN_PASSWORD,
    });
    expect(ready.status).toBe(204);
    const secretKey = `${NODES}/vx-${tenant.slug}-admin-bootstrap`;
    expect(cloud.createdSecrets.get(secretKey)).toEqual({
      location: 'southamerica-east1',
      labels: { purpose: 'admin_bootstrap' },
    });
    const versions = cloud.secretVersions.get(secretKey) ?? [];
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]?.payload ?? '{}')).toEqual({
      email: tenant.adminEmail,
      password: ADMIN_PASSWORD,
      expiresAt: new Date(clock.now().getTime() + 72 * 60 * MINUTE_MS).toISOString(),
    });
    expect((await tenants.require(tenant.id)).enrollment).toMatchObject({
      readyAt: clock.now(),
      readyVersion: RELEASE,
    });
    // Idempotente: o mesmo pronto de novo não grava outra versão.
    expect(
      (await report(nodeKey, { status: 'ready', version: RELEASE, adminBootstrapPassword: ADMIN_PASSWORD }))
        .status,
    ).toBe(204);
    expect(cloud.secretVersions.get(secretKey)).toHaveLength(1);

    // O resto da sequência: a espera solta, a saúde, o domínio e o acesso.
    const rest = await drain();
    expect(stepsOf(rest)).toEqual([
      'enrollment.wait',
      'node.health',
      'panel.domain_wait',
      'access.ready',
      'access.reveal_email',
    ]);
    const done = await tenants.require(tenant.id);
    expect(done.state).toBe('waiting_customer_connection');
    expect(
      stepsOf([...first, ...rest]).some(
        (step) => step.startsWith('terraform.') || step.startsWith('secrets.'),
      ),
    ).toBe(false);
    expect(cloud.executions.size).toBe(0);
    // O e-mail "ambiente pronto" do contrato direto, como no gerenciado.
    expect(mail.sent).toHaveLength(1);

    // Nenhum segredo no log nem no Firestore (só os hashes).
    for (const secret of [issued.code, nodeKey, tunnel?.token ?? 'x', ADMIN_PASSWORD]) {
      expect(capture.text).not.toContain(secret);
      expect(documents.text).not.toContain(secret);
    }
    const actions = (await documents.query(COLLECTIONS.auditLog, {})).map((doc) => doc.data['action']);
    expect(actions).toEqual(
      expect.arrayContaining([
        'tenant.enrollment_code_issued',
        'tenant.enrollment_claimed',
        'tenant.enrollment_ready',
      ]),
    );
  });

  it('um aditivo gravado entre a leitura do código e o registro: a VM recebe os limites novos, não os da leitura', async () => {
    const tenant = await customerTenant();
    const issued = await issueCode(tenant);
    await drain(4);
    const monthlyGib = tenant.limits.monthlyGib + 100;
    // O aditivo (só o Firestore) entra depois de o claim achar o cliente pelo hash e antes da transação do registro.
    documents.afterQuery = {
      matches: (collection, query) =>
        collection === 'tenants' && JSON.stringify(query ?? {}).includes('enrollment.codeHash'),
      run: async () => {
        await tenants.change(tenant.id, () => ({
          reason: 'contract_amended',
          audit: { actor: 'system' },
          mutate: (current) => ({ ...current, limits: { ...current.limits, monthlyGib } }),
        }));
      },
    };
    const claimed = await claim(issued.code);
    expect(claimed.status).toBe(200);
    expect(documents.afterQuery).toBeUndefined();
    expect((claimed.body as { nodeConf: { name: string; value: string }[] }).nodeConf).toContainEqual({
      name: 'PLAN_MONTHLY_GIB',
      value: String(monthlyGib),
    });
    expect((await tenants.require(tenant.id)).enrollment?.claimedAt).toEqual(clock.now());
  });

  it('com o e-mail dos nós: a senha da caixa vai no claim (a mesma do secrets.smtp_password)', async () => {
    cloud.secretVersions.set(`${CONTROL_PLANE}/cp-nodes-smtp-password`, [
      { payload: `${NODE_MAILBOX_VALUE}\n`, state: 'ENABLED' },
    ]);
    const tenant = await customerTenant();
    const issued = await issueCode(tenant, appMail);
    // O claim antes do passo do túnel: o túnel nasce aqui, com o mesmo nome que o passo vai achar.
    const claimed = await claim(issued.code, {}, appMail);
    expect(claimed.status).toBe(200);
    expect((claimed.body as { mail: unknown }).mail).toEqual({
      host: 'smtp.caixa-exemplo.example',
      port: 587,
      user: 'avisos@verax.example',
      from: 'nao-responda@verax.example',
      password: NODE_MAILBOX_VALUE,
    });
    expect([...cloud.tunnels.values()].map((t) => t.name)).toEqual([`vx-${tenant.slug}`]);
    expect(capture.text).not.toContain(NODE_MAILBOX_VALUE);
  });

  it('código vencido, versão diferente e Cloudflare fora: o código continua (ou some) sem gastar o registro', async () => {
    const tenant = await customerTenant();
    const issued = await issueCode(tenant);
    await drain(3);
    // Outra versão: 409, e o código continua valendo.
    const mismatch = await claim(issued.code, { release: 'node-v9.9.9' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ code: 'release_mismatch' });
    // O Cloudflare fora: 503, e o código continua valendo.
    cloud.failNext('/token', 500, { times: 10 });
    expect((await claim(issued.code)).status).toBe(503);
    cloud.clearFailures();
    expect((await tenants.require(tenant.id)).enrollment?.claimedAt).toBeUndefined();
    // Vencido (7 dias): o mesmo 404 de um código desconhecido.
    clock.set(new Date(new Date(issued.expiresAt).getTime()));
    const expired = await claim(issued.code);
    expect(expired.status).toBe(404);
    expect(expired.body).toMatchObject({ code: 'not_found' });
    const unknown = await claim('B'.repeat(43));
    expect(unknown.status).toBe(404);
    const { requestId: _a, ...unknownBody } = unknown.body as Record<string, unknown>;
    const { requestId: _b, ...expiredBody } = expired.body as Record<string, unknown>;
    expect(unknownBody).toEqual(expiredBody);
    // Fora do formato: 400, sem consultar nada.
    expect((await claim('curto')).status).toBe(400);
    expect((await claim(issued.code, { extra: true })).status).toBe(400);
  });

  it('report error para com node_error; o código novo é reinstalação: revoga a chave e recomeça a execução', async () => {
    const tenant = await customerTenant();
    const issued = await issueCode(tenant);
    await drain(4);
    const nodeKey = ((await claim(issued.code)).body as { nodeKey: string }).nodeKey;
    expect((await report(nodeKey, { status: 'error', code: 'docker_install_failed' })).status).toBe(204);
    const failed = await drain(1);
    expect(failed).toEqual([{ step: 'enrollment.wait', poll: 1, status: 200, outcome: 'failed' }]);
    const stopped = await tenants.require(tenant.id);
    expect(stopped.state).toBe('provisioning_failed');
    expect(stopped.provisioning?.lastError?.code).toBe('node_error:docker_install_failed');

    const reinstall = await issueCode(tenant);
    expect(reinstall.reinstall).toBe(true);
    expect(reinstall.runId).not.toBe(issued.runId);
    const restarted = await tenants.require(tenant.id);
    expect(restarted.state).toBe('provisioning');
    expect(restarted.provisioning).toMatchObject({ runId: reinstall.runId, step: 'preflight', attempts: 1 });
    expect(restarted.provisioning?.lastError).toBeUndefined();
    expect(restarted.enrollment?.nodeKeyHash).toBeUndefined();
    expect(restarted.enrollment?.lastError).toBeUndefined();
    // A chave antiga não vale mais, e o código antigo também não.
    expect((await report(nodeKey, { status: 'error', code: 'x' })).status).toBe(401);
    expect((await claim(issued.code)).status).toBe(404);
    expect((await claim(reinstall.code)).status).toBe(200);
  });

  /** A VM registra e fica pronta com `password`; devolve a chave do nó. */
  async function installVm(code: string, password: string): Promise<string> {
    const claimed = await claim(code);
    expect(claimed.status).toBe(200);
    const nodeKey = (claimed.body as { nodeKey: string }).nodeKey;
    const ready = await report(nodeKey, {
      status: 'ready',
      version: RELEASE,
      adminBootstrapPassword: password,
    });
    expect(ready.status).toBe(204);
    return nodeKey;
  }

  /** O link de uso único do último e-mail "ambiente pronto". */
  function lastRevealLink(): string {
    const text = mail.sent.at(-1)?.text ?? '';
    const match = /#acesso=([A-Za-z0-9_-]{43})/.exec(text);
    expect(match).not.toBeNull();
    return match?.[1] ?? '';
  }

  it('a fila falhou ao pôr o preflight: o código seguinte garante a task da execução gravada', async () => {
    const tenant = await customerTenant();
    queue.failNext(new Error('fila indisponível'));
    const failed = await request(app.getHttpServer())
      .post(`/internal/tenants/${tenant.id}/enrollment-code`)
      .set('Authorization', bearer(OWNER))
      .send({ confirmSlug: tenant.slug });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const stalled = await tenants.require(tenant.id);
    expect(stalled.state).toBe('provisioning');
    expect(stalled.provisioning?.step).toBe('preflight');
    expect(queue.tasks).toEqual([]);
    // O código seguinte não muda o estado de novo, mas põe a task da execução que ficou gravada.
    const again = await issueCode(tenant);
    expect(again).toMatchObject({ runId: stalled.provisioning?.runId, step: 'preflight' });
    expect(queue.tasks.map((task) => [task.step, task.runId])).toEqual([
      ['preflight', stalled.provisioning?.runId],
    ]);
    // Repetir não põe outra (o id da task é o mesmo).
    await issueCode(tenant);
    expect(queue.tasks).toHaveLength(1);
    expect((await drain(1))[0]).toMatchObject({ step: 'preflight', outcome: 'done' });
  });

  it('reinstalação depois da senha revelada: revelação nova, de uso único, com o e-mail de novo', async () => {
    const tenant = await customerTenant();
    const first = await issueCode(tenant);
    await drain(4);
    const firstPassword = `Temporaria-${'a'.repeat(16)}`;
    const oldKey = await installVm(first.code, firstPassword);
    await drain();
    expect((await tenants.require(tenant.id)).state).toBe('waiting_customer_connection');
    expect(mail.sent).toHaveLength(1);
    // O cliente viu a senha (a revelação marcada) e o ambiente ficou ativo.
    const access = new AccessStore(documents, clock, audit);
    await access.claimReveal(lastRevealLink(), 'email_reveal');
    await tenants.transition(tenant.id, { to: 'active', reason: 'teste', audit: { actor: 'system' } });

    // Reinstalar: um código novo revoga a chave antiga; a VM nova registra e manda outra senha.
    clock.set(new Date(clock.now().getTime() + 5 * DAY_MS));
    const reinstall = await issueCode(tenant);
    expect(reinstall).toMatchObject({ reinstall: true });
    expect(reinstall.runId).toBeUndefined();
    expect((await report(oldKey, { status: 'error', code: 'x' })).status).toBe(401);
    const newPassword = `Temporaria-${'b'.repeat(16)}`;
    const newKey = await installVm(reinstall.code, newPassword);
    const reissued = await tenants.require(tenant.id);
    expect(reissued.state).toBe('waiting_customer_connection');
    expect(reissued.access).toEqual({ reissuedAt: clock.now() });
    const versions = cloud.secretVersions.get(`${NODES}/vx-${tenant.slug}-admin-bootstrap`) ?? [];
    expect(JSON.parse(versions.at(-1)?.payload ?? '{}')).toMatchObject({ password: newPassword });

    // O e-mail "ambiente pronto" sai de novo (fila `lifecycle`, outra execução), com um link novo de uso único.
    const sent = await drain();
    expect(sent.map((entry) => [entry.step, entry.outcome])).toEqual([['access.reveal_email', 'sent']]);
    expect(mail.sent).toHaveLength(2);
    const link = lastRevealLink();
    await expect(access.claimReveal(link, 'email_reveal')).resolves.toMatchObject({ kind: 'email_reveal' });
    // Uso único: o mesmo link não serve de novo.
    await expect(access.claimReveal(link, 'email_reveal')).rejects.toBeInstanceOf(Error);
    // Um `ready` repetido não abre outro ciclo, nem grava outra versão, nem manda outro e-mail.
    expect(
      (await report(newKey, { status: 'ready', version: RELEASE, adminBootstrapPassword: newPassword }))
        .status,
    ).toBe(204);
    expect(cloud.secretVersions.get(`${NODES}/vx-${tenant.slug}-admin-bootstrap`)).toHaveLength(
      versions.length,
    );
    expect(await drain()).toEqual([]);
    const revealed = await tenants.require(tenant.id);
    expect(revealed.access?.passwordRevealedAt).toBeInstanceOf(Date);
    const records = (await documents.query(COLLECTIONS.auditLog, {})).map((doc) => doc.data);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'tenant.enrollment_ready',
          details: expect.objectContaining({ reissued: true }) as unknown,
        }),
      ]),
    );
  });

  it('reinstalação ainda esperando a conexão, dias depois: a janela do e-mail conta da reinstalação', async () => {
    const tenant = await customerTenant();
    const first = await issueCode(tenant);
    await drain(4);
    await installVm(first.code, `Temporaria-${'d'.repeat(16)}`);
    await drain();
    expect(mail.sent).toHaveLength(1);
    // Sem revelar nada, 10 dias depois (a janela de 72 h do primeiro e-mail já fechou).
    clock.set(new Date(clock.now().getTime() + 10 * DAY_MS));
    const reinstall = await issueCode(tenant);
    expect(reinstall.reinstall).toBe(true);
    await installVm(reinstall.code, `Temporaria-${'e'.repeat(16)}`);
    const current = await tenants.require(tenant.id);
    expect(current.state).toBe('waiting_customer_connection');
    expect(current.access).toEqual({ reissuedAt: clock.now() });
    expect((await drain()).map((entry) => [entry.step, entry.outcome])).toEqual([
      ['access.reveal_email', 'sent'],
    ]);
    expect(mail.sent).toHaveLength(2);
  });

  it('a exclusão de um cliente da VM própria apaga o túnel, o site e o cofre da senha, mesmo sem revelação', async () => {
    const tenant = await customerTenant();
    const issued = await issueCode(tenant);
    await drain(4);
    await installVm(issued.code, `Temporaria-${'c'.repeat(16)}`);
    await drain();
    const secretKey = `${NODES}/vx-${tenant.slug}-admin-bootstrap`;
    expect(cloud.createdSecrets.has(secretKey)).toBe(true);
    expect((await tenants.require(tenant.id)).access?.passwordRevealedAt).toBeUndefined();
    for (const operation of ['cancel', 'delete-now']) {
      const response = await request(app.getHttpServer())
        .post(`/internal/tenants/${tenant.id}/${operation}`)
        .set('Authorization', bearer(OWNER))
        .send({ confirmSlug: tenant.slug });
      expect(response.status, operation).toBe(200);
    }
    const deletion = await drain();
    expect(stepsOf(deletion)).toEqual(
      expect.arrayContaining([
        'deletion.cloudflare',
        'deletion.firebase',
        'deletion.bootstrap_secret',
        'deletion.record',
      ]),
    );
    expect(deletion.every((entry) => entry.status === 200)).toBe(true);
    expect((await tenants.require(tenant.id)).state).toBe('deleted');
    expect(cloud.createdSecrets.has(secretKey)).toBe(false);
    expect(cloud.secretVersions.has(secretKey)).toBe(false);
    expect(cloud.tunnels.size).toBe(0);
    expect(cloud.count('DELETE', `/secrets/vx-${tenant.slug}-admin-bootstrap`)).toBe(1);
    expect(cloud.executions.size).toBe(0);
    const actions = (await documents.query(COLLECTIONS.auditLog, {})).map((doc) => doc.data['action']);
    expect(actions).toContain('access.bootstrap_deleted');
  });

  it('a espera do registro avisa em 3 dias e para com enrollment_timeout em 30', async () => {
    const tenant = await customerTenant();
    await issueCode(tenant);
    await drain(4);
    clock.set(new Date(START.getTime() + 3 * DAY_MS + MINUTE_MS));
    expect(await drain(1)).toEqual([{ step: 'enrollment.wait', poll: 1, status: 200, outcome: 'waiting' }]);
    expect(capture.text).toContain('enrollment_slow');
    clock.set(new Date(START.getTime() + WAITS.enrollment.limitMs + MINUTE_MS));
    expect(await drain(1)).toEqual([{ step: 'enrollment.wait', poll: 2, status: 200, outcome: 'failed' }]);
    expect((await tenants.require(tenant.id)).provisioning?.lastError?.code).toBe('enrollment_timeout');
  });

  it('cada sequência no seu lugar; quem chama cada rota; o código só no ambiente do cliente', async () => {
    const customer = await customerTenant();
    const issued = await issueCode(customer);
    const runId = issued.runId ?? '';
    // Um passo do gerenciado num cliente da VM própria, e a espera do registro num gerenciado: nada roda.
    const terraform = await deliver({
      queue: 'provisioning',
      step: 'terraform.apply',
      tenantId: customer.id,
      runId,
    });
    expect(terraform.outcome).toBe('not_in_sequence');
    slugSequence += 1;
    const managed = await tenantIn(tenants, `gerido-${slugSequence}`, 'provisioning');
    const managedRun = newUlid(clock.now().getTime());
    await tenants.change(managed.id, () => ({
      reason: 'teste',
      audit: { actor: 'system' },
      mutate: (t) => ({ ...t, provisioning: { runId: managedRun, step: 'preflight', attempts: 0 } }),
    }));
    const wait = await deliver({
      queue: 'provisioning',
      step: 'enrollment.wait',
      tenantId: managed.id,
      runId: managedRun,
    });
    expect(wait.outcome).toBe('not_in_sequence');
    // O código de um gerenciado: 409.
    const refused = await request(app.getHttpServer())
      .post(`/internal/tenants/${managed.id}/enrollment-code`)
      .set('Authorization', bearer(OWNER))
      .send({ confirmSlug: managed.slug });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'not_customer_hosted' });
    // O cp-public não gera código; o responsável e as tasks não fazem claim.
    const fromPublic = await request(app.getHttpServer())
      .post(`/internal/tenants/${customer.id}/enrollment-code`)
      .set('Authorization', bearer(PUBLIC_SA))
      .send({ confirmSlug: customer.slug });
    expect(fromPublic.status).toBe(403);
    for (const email of [OWNER, INVOKER]) {
      const response = await request(app.getHttpServer())
        .post('/internal/node-enrollment/claim')
        .set('Authorization', bearer(email))
        .send({ code: issued.code, release: RELEASE, host: HOST });
      expect(response.status).toBe(403);
    }
    expect((await tenants.require(customer.id)).enrollment?.claimedAt).toBeUndefined();
  });
});
