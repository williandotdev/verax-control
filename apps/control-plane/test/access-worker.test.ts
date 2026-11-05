import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessStore, REVEAL_EMAIL_AFTER_MS } from '../src/access/access-store.js';
import { REVEAL_EMAIL_STEP, RevealEmailService } from '../src/access/reveal-email.service.js';
import { DESTROY_BOOTSTRAP_STEP } from '../src/access/reveal.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import type { TenantRecord } from '../src/tenants/tenant.schema.js';
import {
  fakeIdentityToken,
  fakeTemporaryPassword,
  MemoryBootstrapSecrets,
  MemoryMailSender,
  TestGoogleIdentity,
} from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const OWNER = 'responsavel@exemplo.example';
const START = new Date('2026-11-04T12:00:00.000Z');
const HOUR_MS = 60 * MINUTE_MS;

/**
 * O lado do cp-worker da revelação única e do plano B (CP-05), pelo app inteiro: a guarda das rotas internas (cada
 * rota só para quem deve chamá-la), a revelação com o segredo em memória (marca antes de ler, enfileira a destruição
 * antes de responder, desfaz quando nada foi mostrado), o passo que destrói as versões e o e-mail do plano B. Um app
 * por arquivo, no ar o arquivo todo.
 */
describe('cp-worker: revelação única, destruição e plano B (CP-05)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const queue = new MemoryStepQueue();
  const secrets = new MemoryBootstrapSecrets();
  const mail = new MemoryMailSender();
  const google = new TestGoogleIdentity();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  const access = new AccessStore(documents, clock, audit);
  /** Senhas, valores de cookie e links usados no arquivo: nenhum pode aparecer no log nem na auditoria. */
  const secretsSeen = new Set<string>();
  let app: NestExpressApplication;
  let slugSequence = 0;

  beforeAll(async () => {
    app = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      stepQueue: queue,
      bootstrapSecrets: secrets,
      mailSender: mail,
      idTokenKeys: google,
      capture,
      env: {
        LOG_LEVEL: 'debug',
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: OWNER,
        PUBLIC_SA_EMAIL: PUBLIC_SA,
        NODES_PROJECT_ID: 'projeto-dos-nos-demo',
        SITE_SUCCESS_URL: 'https://veraxsistemas.com.br/checkout/sucesso?cs={CHECKOUT_SESSION_ID}',
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clock.set(START);
    queue.clear();
  });

  /** O token assinado pelo "Google" do teste, como o das tasks e o do cp-public (prazos no relógio do sistema). */
  function bearer(email: string, options: { aud?: string; expired?: boolean } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = options.expired === true ? { iat: now - 7200, exp: now - 3600 } : {};
    return `Bearer ${google.token({ email, aud: options.aud ?? WORKER_URL, payload })}`;
  }

  /** O token como o Cloud Run o entrega no X-Serverless-Authorization: a assinatura removida depois de conferida. */
  function stripped(email: string): string {
    return `Bearer ${fakeIdentityToken({ email, aud: WORKER_URL, exp: Math.floor(clock.now().getTime() / 1000) + 3600 })}`;
  }

  async function waitingTenant(): Promise<{ tenant: TenantRecord; password: string; cookie: string }> {
    slugSequence += 1;
    const tenant = await tenantIn(tenants, `cliente-demo-w${slugSequence}`, 'waiting_customer_connection');
    const password = fakeTemporaryPassword();
    secrets.put(tenant.slug, {
      email: tenant.adminEmail ?? '',
      password,
      expiresAt: new Date(clock.now().getTime() + 72 * HOUR_MS),
    });
    const cookie = (await access.mint(tenant.id, 'cookie', 'system')).value;
    secretsSeen.add(password).add(cookie);
    return { tenant, password, cookie };
  }

  function reveal(body: unknown, caller = PUBLIC_SA): request.Test {
    return request(app.getHttpServer())
      .post('/internal/access/reveal')
      .set('Authorization', bearer(caller))
      .send(body as object);
  }

  function step(name: string, tenantId: string, caller = INVOKER): request.Test {
    return request(app.getHttpServer())
      .post(`/internal/steps/${name}`)
      .set('Authorization', bearer(caller))
      .send({ tenantId, runId: tenantId });
  }

  describe('guarda das rotas internas', () => {
    it('sem token, token de outro serviço ou vencido → 401; quem não é do grupo da rota → 403', async () => {
      const { tenant, cookie } = await waitingTenant();
      const server = app.getHttpServer();
      const body = { kind: 'cookie', token: cookie };

      await request(server).post('/internal/access/reveal').send(body).expect(401);
      await request(server)
        .post('/internal/access/reveal')
        .set('Authorization', bearer(PUBLIC_SA, { aud: 'https://outro-servico.run.app' }))
        .send(body)
        .expect(401);
      await request(server)
        .post('/internal/access/reveal')
        .set('Authorization', bearer(PUBLIC_SA, { expired: true }))
        .send(body)
        .expect(401);
      // A task (cp-invoker) e o responsável não pedem revelação; o cp-public não dispara passo.
      await reveal(body, INVOKER).expect(403);
      await reveal(body, OWNER).expect(403);
      await step(DESTROY_BOOTSTRAP_STEP, tenant.id, PUBLIC_SA).expect(403);
      await step(DESTROY_BOOTSTRAP_STEP, tenant.id, 'outra@projeto-exemplo.iam.gserviceaccount.com').expect(
        403,
      );

      expect((await tenants.require(tenant.id)).access).toBeUndefined();
      expect(secrets.reads).toBe(0);
      expect(queue.tasks).toEqual([]);
      const refused = capture.entries().filter((entry) => entry['event'] === 'worker_caller_refused');
      expect(refused.length).toBeGreaterThanOrEqual(7);
    });

    it('a identidade sai do cabeçalho que o Cloud Run conferiu: os dois juntos → 401; sem assinatura, só no X-Serverless-Authorization', async () => {
      const { tenant, cookie } = await waitingTenant();
      const server = app.getHttpServer();
      const body = { kind: 'cookie', token: cookie };

      // Uma task (cp-invoker, token verdadeiro no X-Serverless-Authorization, o que o Cloud Run confere) com um token
      // forjado do cp-public no Authorization: recusado, sem chegar ao e-mail de nenhum dos dois.
      const ambiguous = await request(server)
        .post('/internal/access/reveal')
        .set('X-Serverless-Authorization', stripped(INVOKER))
        .set('Authorization', stripped(PUBLIC_SA))
        .send(body)
        .expect(401);
      expect(ambiguous.body).toMatchObject({ code: 'unauthenticated' });
      // O token forjado sozinho no Authorization (sem assinatura, ou assinado por outra chave): recusado.
      await request(server)
        .post('/internal/access/reveal')
        .set('Authorization', stripped(PUBLIC_SA))
        .send(body)
        .expect(401);
      await request(server)
        .post('/internal/access/reveal')
        .set(
          'Authorization',
          `Bearer ${google.token({ email: PUBLIC_SA, aud: WORKER_URL, signer: TestGoogleIdentity.otherSigner() })}`,
        )
        .send(body)
        .expect(401);
      // O X-Serverless-Authorization sozinho vale pela identidade dele: a cp-invoker não revela; o cp-public, sim.
      await request(server)
        .post('/internal/access/reveal')
        .set('X-Serverless-Authorization', stripped(INVOKER))
        .send(body)
        .expect(403);
      expect((await tenants.require(tenant.id)).access).toBeUndefined();
      await request(server)
        .post('/internal/access/reveal')
        .set('X-Serverless-Authorization', stripped(PUBLIC_SA))
        .send(body)
        .expect(200);
      expect((await tenants.require(tenant.id)).access?.passwordRevealedAt).toEqual(START);

      const reasons = capture
        .entries()
        .filter((entry) => entry['event'] === 'worker_caller_refused')
        .map((entry) => entry['reason']);
      expect(reasons).toEqual(
        expect.arrayContaining(['ambiguous_credentials', 'signature_missing', 'invalid']),
      );
    });

    it('as rotas internas ficam fora do /v1, e as públicas não existem no worker', async () => {
      const { tenant, cookie } = await waitingTenant();
      await request(app.getHttpServer())
        .post('/v1/internal/access/reveal')
        .set('Authorization', bearer(PUBLIC_SA))
        .send({ kind: 'cookie', token: cookie })
        .expect(404);
      await request(app.getHttpServer()).get('/v1/public/status').expect(404);
      await request(app.getHttpServer()).post('/v1/public/status/claim').send({}).expect(404);
      await request(app.getHttpServer()).post('/v1/public/status/reveal').send({}).expect(404);
      expect((await tenants.require(tenant.id)).access).toBeUndefined();
    });

    it('o responsável chama um passo (o grupo das tasks); passo desconhecido → 404, corpo errado → 400', async () => {
      const { tenant } = await waitingTenant();
      const done = await step(DESTROY_BOOTSTRAP_STEP, tenant.id, OWNER).expect(200);
      expect(done.body).toEqual({ step: DESTROY_BOOTSTRAP_STEP, outcome: 'not_revealed' });
      await step('preflight', tenant.id).expect(404);
      await request(app.getHttpServer())
        .post(`/internal/steps/${DESTROY_BOOTSTRAP_STEP}`)
        .set('Authorization', bearer(INVOKER))
        .send({ tenantId: tenant.id })
        .expect(400);
    });
  });

  describe('revelação', () => {
    it('marca, lê, enfileira a destruição e devolve painel, login e senha; a segunda é 409 sem ler de novo', async () => {
      const { tenant, password, cookie } = await waitingTenant();
      const readsBefore = secrets.reads;

      const response = await reveal({ kind: 'cookie', token: cookie }).expect(200);

      expect(response.body).toEqual({
        panelUrl: `https://${tenant.slug}.control.veraxsistemas.com.br`,
        adminEmail: tenant.adminEmail,
        password,
        passwordExpiresAt: new Date(START.getTime() + 72 * HOUR_MS).toISOString(),
      });
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect((await tenants.require(tenant.id)).access?.passwordRevealedAt).toEqual(START);
      expect(queue.inQueue('lifecycle')).toEqual([
        expect.objectContaining({ step: DESTROY_BOOTSTRAP_STEP, tenantId: tenant.id, runId: tenant.id }),
      ]);
      expect(secrets.liveVersions(tenant.slug)).toBe(1);

      const second = await reveal({ kind: 'cookie', token: cookie }).expect(409);
      expect(second.body).toMatchObject({ code: 'already_revealed' });
      expect(secrets.reads).toBe(readsBefore + 1);

      const records = await audit.listForTenant(tenant.id);
      expect(records.filter((record) => record.action === 'access.revealed')).toHaveLength(1);
      expect(JSON.stringify(records)).not.toContain(password);
    });

    it('a destruição entra na fila mesmo se a resposta ao cp-public se perder no caminho', async () => {
      const { tenant, cookie } = await waitingTenant();
      const held = secrets.hold();
      const { port } = app.getHttpServer().address() as AddressInfo;
      const client = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/internal/access/reveal',
        headers: { authorization: bearer(PUBLIC_SA), 'content-type': 'application/json' },
      });
      client.on('error', () => undefined);
      client.end(JSON.stringify({ kind: 'cookie', token: cookie }));

      await held.reached;
      // O cp-public desiste (prazo, queda): a conexão cai antes de o worker responder.
      client.destroy();
      held.release();

      await vi.waitFor(() => expect(queue.inQueue('lifecycle')).toHaveLength(1));
      expect(queue.tasks[0]).toMatchObject({ step: DESTROY_BOOTSTRAP_STEP, tenantId: tenant.id });
      expect((await tenants.require(tenant.id)).access?.passwordRevealedAt).toEqual(START);

      // E a task destrói as versões, uma vez.
      const destroyed = await step(DESTROY_BOOTSTRAP_STEP, tenant.id).expect(200);
      expect(destroyed.body).toEqual({ step: DESTROY_BOOTSTRAP_STEP, outcome: 'destroyed' });
      expect(secrets.liveVersions(tenant.slug)).toBe(0);
      const again = await step(DESTROY_BOOTSTRAP_STEP, tenant.id).expect(200);
      expect(again.body).toEqual({ step: DESTROY_BOOTSTRAP_STEP, outcome: 'nothing_to_destroy' });
      const records = await audit.listForTenant(tenant.id);
      expect(records.filter((record) => record.action === 'access.bootstrap_destroyed')).toEqual([
        expect.objectContaining({ actor: 'system', details: { versions: 1 } }),
      ]);
    });

    it('nada mostrado, nada consumido: sem versão, falha do Secret Manager, senha vencida ou fila fora', async () => {
      const missing = await waitingTenant();
      secrets.versions.delete(missing.tenant.slug);
      expect((await reveal({ kind: 'cookie', token: missing.cookie }).expect(503)).body).toMatchObject({
        code: 'reveal_unavailable',
      });
      expect((await tenants.require(missing.tenant.id)).access?.passwordRevealedAt).toBeUndefined();

      const transient = await waitingTenant();
      secrets.failNextRead(Object.assign(new Error('UNAVAILABLE'), { code: 14 }));
      await reveal({ kind: 'cookie', token: transient.cookie }).expect(503);
      expect((await tenants.require(transient.tenant.id)).access?.passwordRevealedAt).toBeUndefined();
      // Tentar de novo funciona.
      await reveal({ kind: 'cookie', token: transient.cookie }).expect(200);
      queue.clear();

      const expired = await waitingTenant();
      clock.advance(73 * HOUR_MS);
      expect((await reveal({ kind: 'cookie', token: expired.cookie }).expect(410)).body).toMatchObject({
        code: 'password_expired',
      });
      expect((await tenants.require(expired.tenant.id)).access?.passwordRevealedAt).toBeUndefined();
      clock.set(START);

      const noQueue = await waitingTenant();
      queue.failNext(new Error('Cloud Tasks fora do ar'));
      await reveal({ kind: 'cookie', token: noQueue.cookie }).expect(503);
      expect((await tenants.require(noQueue.tenant.id)).access?.passwordRevealedAt).toBeUndefined();

      expect(queue.tasks).toEqual([]);
      const reverted = (await audit.listForTenant(missing.tenant.id)).at(-1);
      expect(reverted).toMatchObject({
        action: 'access.reveal_reverted',
        details: { reason: 'bootstrap_not_found' },
      });
      expect(capture.text).toContain('reveal_bootstrap_unavailable');
      expect(capture.text).toContain('reveal_password_expired');
      expect(capture.text).toContain('reveal_destroy_not_enqueued');
    });

    it('credencial desconhecida → 404; cliente fora da espera → 409; pedido malformado → 400', async () => {
      const { cookie } = await waitingTenant();
      expect((await reveal({ kind: 'cookie', token: 'x'.repeat(43) }).expect(404)).body).toMatchObject({
        code: 'not_found',
      });
      await reveal({ kind: 'email_reveal', token: cookie }).expect(404);
      await reveal({ kind: 'cookie', token: cookie, extra: 1 }).expect(400);
      await reveal({ kind: 'senha', token: cookie }).expect(400);

      slugSequence += 1;
      const provisioning = await tenantIn(tenants, `cliente-demo-w${slugSequence}`, 'provisioning');
      const early = (await access.mint(provisioning.id, 'cookie', 'system')).value;
      expect((await reveal({ kind: 'cookie', token: early }).expect(409)).body).toMatchObject({
        code: 'reveal_not_available',
      });
      expect(secrets.reads).toBeGreaterThan(0);
    });
  });

  describe('plano B por e-mail', () => {
    it('48 h sem revelação: o tick enfileira, o passo manda o link (sem a senha), e o link revela uma vez', async () => {
      const { tenant, password } = await waitingTenant();
      const reveals = app.get(RevealEmailService);

      expect(await reveals.dispatchDue()).toEqual({ due: 0, enqueued: 0 });
      clock.advance(REVEAL_EMAIL_AFTER_MS);
      const dispatched = await reveals.dispatchDue();
      expect(dispatched.enqueued).toBeGreaterThanOrEqual(1);
      expect(queue.inQueue('lifecycle')).toContainEqual(
        expect.objectContaining({ step: REVEAL_EMAIL_STEP, tenantId: tenant.id, runId: tenant.id }),
      );

      const sentBefore = mail.sent.length;
      const done = await step(REVEAL_EMAIL_STEP, tenant.id).expect(200);
      expect(done.body).toEqual({ step: REVEAL_EMAIL_STEP, outcome: 'sent' });
      const message = mail.sent.at(-1);
      expect(mail.sent).toHaveLength(sentBefore + 1);
      expect(message?.to).toBe(tenant.adminEmail);
      expect(`${message?.text}${message?.html}`).not.toContain(password);
      const link = /#acesso=([A-Za-z0-9_-]{43})/.exec(message?.text ?? '')?.[1];
      expect(link).toBeDefined();
      secretsSeen.add(link ?? '');
      expect(message?.text).toContain(`https://veraxsistemas.com.br/checkout/sucesso#acesso=${link}`);
      expect((await tenants.require(tenant.id)).access?.revealEmailSentAt).toEqual(clock.now());

      // De novo: nada sai.
      expect((await step(REVEAL_EMAIL_STEP, tenant.id).expect(200)).body).toMatchObject({
        outcome: 'already_sent',
      });
      expect(mail.sent).toHaveLength(sentBefore + 1);

      // O link revela sem cookie, uma vez.
      const revealed = await reveal({ kind: 'email_reveal', token: link }).expect(200);
      expect(revealed.body).toMatchObject({ password, adminEmail: tenant.adminEmail });
      await reveal({ kind: 'email_reveal', token: link }).expect(404);
    });

    it('falha do SMTP: nada marcado, a task repete e manda; fora do prazo ou já revelado, não manda', async () => {
      const { tenant } = await waitingTenant();
      clock.advance(REVEAL_EMAIL_AFTER_MS);
      mail.failNext(new Error('SMTP 421'));
      await step(REVEAL_EMAIL_STEP, tenant.id).expect(500);
      expect((await tenants.require(tenant.id)).access?.revealEmailSentAt).toBeUndefined();
      expect((await step(REVEAL_EMAIL_STEP, tenant.id).expect(200)).body).toMatchObject({ outcome: 'sent' });

      const late = await waitingTenant();
      clock.advance(25 * HOUR_MS);
      expect((await step(REVEAL_EMAIL_STEP, late.tenant.id).expect(200)).body).toMatchObject({
        outcome: 'window_closed',
      });

      clock.set(START);
      const shown = await waitingTenant();
      await reveal({ kind: 'cookie', token: shown.cookie }).expect(200);
      clock.advance(REVEAL_EMAIL_AFTER_MS);
      expect((await step(REVEAL_EMAIL_STEP, shown.tenant.id).expect(200)).body).toMatchObject({
        outcome: 'already_revealed',
      });
    });
  });

  it('log-capture: nenhuma senha, valor de cookie ou link no log nem na auditoria', async () => {
    expect(secretsSeen.size).toBeGreaterThan(5);
    const audits = JSON.stringify(await documents.query('auditLog'));
    for (const value of secretsSeen) {
      expect(capture.text).not.toContain(value);
      expect(audits).not.toContain(value);
    }
    expect(capture.text).not.toContain('SIGNATURE_REMOVED_BY_GOOGLE');
    expect(capture.text).toContain('access_revealed');
  });
});
