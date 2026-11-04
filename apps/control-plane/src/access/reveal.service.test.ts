import { describe, expect, it } from 'vitest';
import {
  fakeTemporaryPassword,
  MemoryBootstrapSecrets,
  MemoryMailSender,
  silentLogger,
} from '../../test/support/access-fakes.js';
import { tenantIn } from '../../test/support/access-store-contract.js';
import { FakeClock, MINUTE_MS } from '../../test/support/fake-clock.js';
import { AuditService } from '../audit/audit.service.js';
import { loadConfig } from '../common/config/load-config.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';
import { MemoryStepQueue } from '../queue/memory-step-queue.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { AccessStore, REVEAL_EMAIL_AFTER_MS } from './access-store.js';
import { RevealEmailService, REVEAL_EMAIL_STEP } from './reveal-email.service.js';
import { RevealService, RevealUnavailableError } from './reveal.service.js';

const HOUR_MS = 60 * MINUTE_MS;

const FULL_ENV = {
  NODES_PROJECT_ID: 'projeto-dos-nos-demo',
  SITE_SUCCESS_URL: 'https://veraxsistemas.com.br/checkout/sucesso?cs={CHECKOUT_SESSION_ID}',
};

function harness(env: Record<string, string> = FULL_ENV) {
  const documents = new MemoryDocumentStore();
  const clock = new FakeClock();
  const audit = new AuditService(documents, clock);
  const tenants = new TenantStore(documents, clock, audit);
  const access = new AccessStore(documents, clock, audit);
  const secrets = new MemoryBootstrapSecrets();
  const queue = new MemoryStepQueue();
  const mail = new MemoryMailSender();
  const config = loadConfig({ ROLE: 'worker', NODE_ENV: 'test', ...env });
  return {
    documents,
    clock,
    tenants,
    access,
    secrets,
    queue,
    mail,
    reveals: new RevealService(access, secrets, queue, config, clock, silentLogger()),
    emails: new RevealEmailService(access, tenants, mail, queue, config, clock, silentLogger()),
  };
}

describe('RevealService', () => {
  it('sem NODES_PROJECT_ID recusa antes de marcar', async () => {
    const h = harness({});
    const tenant = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
    const cookie = await h.access.mint(tenant.id, 'cookie', 'system');

    await expect(h.reveals.reveal('cookie', cookie.value)).rejects.toBeInstanceOf(RevealUnavailableError);
    expect((await h.tenants.require(tenant.id)).access).toBeUndefined();
    expect(h.secrets.reads).toBe(0);
  });

  it('se nem o desfazer funcionar, a revelação continua indisponível (e o erro original não vaza)', async () => {
    const h = harness();
    const tenant = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
    const cookie = await h.access.mint(tenant.id, 'cookie', 'system');
    h.secrets.failNextRead(new Error('UNAVAILABLE'));
    h.access.revertReveal = () => Promise.reject(new Error('Firestore fora'));

    await expect(h.reveals.reveal('cookie', cookie.value)).rejects.toBeInstanceOf(RevealUnavailableError);
    // Marcada e não desfeita: o responsável é avisado pelo log (`reveal_revert_failed`).
    expect((await h.tenants.require(tenant.id)).access?.passwordRevealedAt).toBeDefined();
  });

  it('o login do segredo é o que volta, mesmo diferente do cadastro', async () => {
    const h = harness();
    const tenant = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
    const password = fakeTemporaryPassword();
    h.secrets.put(tenant.slug, {
      email: 'outro-login@cliente-demo-a.example',
      password,
      expiresAt: new Date(h.clock.now().getTime() + 72 * HOUR_MS),
    });
    const cookie = await h.access.mint(tenant.id, 'cookie', 'system');
    const revealed = await h.reveals.reveal('cookie', cookie.value);
    expect(revealed).toMatchObject({ adminEmail: 'outro-login@cliente-demo-a.example', password });
  });
});

describe('RevealEmailService.dispatchDue (o gatilho do tick do CP-11)', () => {
  it('enfileira um passo por cliente no prazo, uma vez por execução do Cloud Tasks', async () => {
    const h = harness();
    const due = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
    await tenantIn(h.tenants, 'cliente-demo-b', 'active');

    expect(await h.emails.dispatchDue()).toEqual({ due: 0, enqueued: 0 });
    h.clock.advance(REVEAL_EMAIL_AFTER_MS);
    expect(await h.emails.dispatchDue()).toEqual({ due: 1, enqueued: 1 });
    expect(await h.emails.dispatchDue()).toEqual({ due: 1, enqueued: 0 });
    expect(h.queue.tasks).toEqual([
      expect.objectContaining({
        queue: 'lifecycle',
        step: REVEAL_EMAIL_STEP,
        tenantId: due.id,
        runId: due.id,
      }),
    ]);
  });

  it('sem a página de status (SITE_SUCCESS_URL) o passo falha (a task repete) sem mandar nada', async () => {
    const h = harness({ NODES_PROJECT_ID: FULL_ENV.NODES_PROJECT_ID });
    const tenant = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
    h.clock.advance(REVEAL_EMAIL_AFTER_MS);
    await expect(h.emails.send(tenant.id)).rejects.toThrow('e-mail sem configuração');
    expect(h.mail.sent).toEqual([]);
  });
});
