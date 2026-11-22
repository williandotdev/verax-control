import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessStore } from '../src/access/access-store.js';
import { DESTROY_BOOTSTRAP_STEP } from '../src/access/reveal.service.js';
import type { AccessRevealed } from '../src/admin/admin-tenants.schema.js';
import { HttpWorkerOwnerClient } from '../src/admin/worker-owner-client.js';
import { AuditService } from '../src/audit/audit.service.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import type { TenantRecord } from '../src/tenants/tenant.schema.js';
import { fakeTemporaryPassword, MemoryBootstrapSecrets, TestGoogleIdentity } from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { MemoryAdminSecrets, seedOwnerSession } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const START = new Date('2026-11-22T12:00:00.000Z');
const WORKER_URL = 'https://cp-worker-111111111111.southamerica-east1.run.app';
const OWNER = 'responsavel@verax.example';
const ADMIN_SA = 'cp-admin@projeto-exemplo.iam.gserviceaccount.com';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const PUBLIC_SA = 'cp-public@projeto-exemplo.iam.gserviceaccount.com';
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A senha inicial mostrada uma vez no console do responsável, pelo app inteiro e com os dois serviços de verdade: o
 * `cp-admin` (sessão do login próprio gravada no teste) chama o `cp-worker` por HTTP em 127.0.0.1 com o
 * `HttpWorkerOwnerClient` de produção, e o worker lê o cofre em memória. É a revelação única: depois dela, a página de
 * status e o link do e-mail do cliente recebem `already_revealed`. Nenhuma senha no log nem na auditoria.
 */
describe('cp-admin e cp-worker: a senha inicial mostrada uma vez no console', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const queue = new MemoryStepQueue();
  const secrets = new MemoryBootstrapSecrets();
  const google = new TestGoogleIdentity();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  const access = new AccessStore(documents, clock, audit);
  /** Todas as senhas do arquivo: nenhuma pode aparecer no log nem na auditoria. */
  const passwords = new Set<string>();
  let worker: NestExpressApplication;
  let admin: NestExpressApplication;
  let workerPort = 0;
  let ownerCookie = '';
  let slugSequence = 0;

  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return fetch(new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${workerPort}`), init);
  };

  beforeAll(async () => {
    worker = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      stepQueue: queue,
      bootstrapSecrets: secrets,
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
        NODES_PROJECT_ID: 'projeto-dos-nos-demo',
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
  });

  beforeEach(async () => {
    clock.set(START);
    queue.clear();
    ownerCookie = await seedOwnerSession(documents, clock, OWNER);
  });

  async function waitingTenant(hours = 72): Promise<{ tenant: TenantRecord; password: string }> {
    slugSequence += 1;
    const tenant = await tenantIn(tenants, `cliente-senha-${slugSequence}`, 'waiting_customer_connection');
    const password = fakeTemporaryPassword();
    passwords.add(password);
    secrets.put(tenant.slug, {
      email: tenant.adminEmail ?? '',
      password,
      expiresAt: new Date(clock.now().getTime() + hours * HOUR_MS),
    });
    return { tenant, password };
  }

  function revealAccess(tenantId: string, body: unknown, cookie: string | null = ownerCookie): request.Test {
    const test = request(admin.getHttpServer())
      .post(`/v1/admin/tenants/${tenantId}/reveal-access`)
      .set('Content-Type', 'application/json');
    return (cookie === null ? test : test.set('Cookie', cookie)).send(JSON.stringify(body));
  }

  function customerReveal(token: string, kind: 'cookie' | 'email_reveal'): request.Test {
    return request(worker.getHttpServer())
      .post('/internal/access/reveal')
      .set('Authorization', `Bearer ${google.token({ email: PUBLIC_SA, aud: WORKER_URL })}`)
      .send({ kind, token });
  }

  it('sem a sessão de um responsável, nada (e nada marcado)', async () => {
    const { tenant } = await waitingTenant();
    await revealAccess(tenant.id, { confirmSlug: tenant.slug }, null).expect(401);
    expect((await tenants.require(tenant.id)).access).toBeUndefined();
  });

  it('mostra uma vez, sem cache; a segunda é already_revealed, e o link do cliente deixa de funcionar', async () => {
    const { tenant, password } = await waitingTenant();
    const cookie = (await access.mint(tenant.id, 'cookie', 'system')).value;
    const link = (await access.mint(tenant.id, 'email_reveal', 'system')).value;

    const response = await revealAccess(tenant.id, { confirmSlug: tenant.slug }).expect(200);

    expect(response.body as AccessRevealed).toEqual({
      panelUrl: `https://${tenant.slug}.control.veraxsistemas.com.br`,
      adminEmail: tenant.adminEmail,
      password,
      passwordExpiresAt: new Date(START.getTime() + 72 * HOUR_MS).toISOString(),
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect((await tenants.require(tenant.id)).access?.passwordRevealedAt).toEqual(START);
    expect(queue.inQueue('lifecycle')).toEqual([
      expect.objectContaining({ step: DESTROY_BOOTSTRAP_STEP, tenantId: tenant.id }),
    ]);

    const again = await revealAccess(tenant.id, { confirmSlug: tenant.slug }).expect(409);
    expect(again.body).toMatchObject({ code: 'already_revealed' });
    expect(JSON.stringify(again.body)).not.toContain(password);
    expect((await customerReveal(cookie, 'cookie').expect(409)).body).toMatchObject({
      code: 'already_revealed',
    });
    expect((await customerReveal(link, 'email_reveal').expect(409)).body).toMatchObject({
      code: 'already_revealed',
    });

    const records = await audit.listForTenant(tenant.id);
    expect(records.filter((record) => record.action === 'access.revealed')).toEqual([
      expect.objectContaining({ actor: `owner:${OWNER}`, details: { via: 'owner' } }),
    ]);
    expect(records.filter((record) => record.action === 'tenant.console_request')).toEqual([
      expect.objectContaining({
        actor: `owner:${OWNER}`,
        details: { operation: 'reveal-access', outcome: 'ok' },
      }),
      expect.objectContaining({
        actor: `owner:${OWNER}`,
        details: { operation: 'reveal-access', outcome: 'already_revealed', status: 409 },
      }),
    ]);
  });

  it('o subdomínio digitado errado não chega ao worker: 400 confirmation_mismatch, nada marcado', async () => {
    const { tenant } = await waitingTenant();
    const reads = secrets.reads;
    const refused = await revealAccess(tenant.id, { confirmSlug: 'outro-cliente' }).expect(400);
    expect(refused.body).toMatchObject({ code: 'confirmation_mismatch' });
    await revealAccess(tenant.id, {}).expect(400);
    expect((await tenants.require(tenant.id)).access).toBeUndefined();
    expect(secrets.reads).toBe(reads);
    expect(queue.tasks).toEqual([]);
    expect(
      capture
        .entries()
        .some((entry) => entry['event'] === 'access_revealed' && entry['tenantId'] === tenant.id),
    ).toBe(false);
  });

  it('senha vencida: 410 password_expired, a marcação desfeita, e o cliente continua sem revelação', async () => {
    // Venceu há uma hora (o relógio fica parado: a sessão do console também tem prazo).
    const { tenant } = await waitingTenant(-1);
    const expired = await revealAccess(tenant.id, { confirmSlug: tenant.slug }).expect(410);
    expect(expired.body).toMatchObject({ code: 'password_expired' });
    expect((await tenants.require(tenant.id)).access?.passwordRevealedAt).toBeUndefined();
    expect(queue.tasks).toEqual([]);
  });

  it('cliente fora da espera: 409 reveal_not_available', async () => {
    slugSequence += 1;
    const provisioning = await tenantIn(tenants, `cliente-senha-${slugSequence}`, 'provisioning');
    const refused = await revealAccess(provisioning.id, { confirmSlug: provisioning.slug }).expect(409);
    expect(refused.body).toMatchObject({ code: 'reveal_not_available' });
  });

  it('log-capture: nenhuma senha no log nem na auditoria dos dois serviços', async () => {
    expect(passwords.size).toBeGreaterThanOrEqual(3);
    const audits = JSON.stringify(await documents.query(COLLECTIONS.auditLog));
    for (const value of passwords) {
      expect(capture.text).not.toContain(value);
      expect(audits).not.toContain(value);
    }
    expect(capture.text).toContain('access_revealed');
  });
});
