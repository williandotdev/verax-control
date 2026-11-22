import type { PinoLogger } from 'nestjs-pino';
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
import {
  AccessStore,
  AlreadyRevealedError,
  REVEAL_EMAIL_AFTER_MS,
  RevealConfirmationMismatchError,
} from './access-store.js';
import { RevealEmailService, REVEAL_EMAIL_STEP } from './reveal-email.service.js';
import {
  DESTROY_BOOTSTRAP_STEP,
  PasswordExpiredError,
  RevealService,
  RevealUnavailableError,
} from './reveal.service.js';

const HOUR_MS = 60 * MINUTE_MS;

const FULL_ENV = {
  NODES_PROJECT_ID: 'projeto-dos-nos-demo',
  SITE_SUCCESS_URL: 'https://veraxsistemas.com.br/checkout/sucesso?cs={CHECKOUT_SESSION_ID}',
};

/** Um logger que guarda o que recebeu (o objeto e a mensagem de cada chamada), para conferir o que vai ao log. */
function recordingLogger(): { logger: PinoLogger; entries: unknown[][] } {
  const entries: unknown[][] = [];
  const record = (...args: unknown[]): void => {
    entries.push(args);
  };
  const logger = {
    trace: record,
    debug: record,
    info: record,
    warn: record,
    error: record,
    fatal: record,
  } as unknown as PinoLogger;
  return { logger, entries };
}

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
  const log = recordingLogger();
  return {
    log,
    documents,
    clock,
    tenants,
    access,
    secrets,
    queue,
    mail,
    reveals: new RevealService(access, secrets, queue, config, clock, log.logger),
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

describe('RevealService.revealForOwner (a revelação pelo console do responsável)', () => {
  const ACTOR = 'owner:responsavel@exemplo.example';

  async function waitingWithPassword(h: ReturnType<typeof harness>, hours = 72) {
    const tenant = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
    const password = fakeTemporaryPassword();
    h.secrets.put(tenant.slug, {
      email: tenant.adminEmail ?? '',
      password,
      expiresAt: new Date(h.clock.now().getTime() + hours * HOUR_MS),
    });
    return { tenant, password };
  }

  it('marca, lê, enfileira a destruição e devolve o acesso; o log diz via owner e nunca a senha', async () => {
    const h = harness();
    const { tenant, password } = await waitingWithPassword(h);

    const revealed = await h.reveals.revealForOwner(tenant.id, tenant.slug, ACTOR, {
      requestId: 'req-demo-1',
    });

    expect(revealed).toEqual({
      panelUrl: `https://${tenant.slug}.control.veraxsistemas.com.br`,
      adminEmail: tenant.adminEmail,
      password,
      passwordExpiresAt: new Date(h.clock.now().getTime() + 72 * HOUR_MS),
    });
    expect((await h.tenants.require(tenant.id)).access?.passwordRevealedAt).toEqual(h.clock.now());
    expect(h.queue.tasks).toEqual([
      expect.objectContaining({ queue: 'lifecycle', step: DESTROY_BOOTSTRAP_STEP, tenantId: tenant.id }),
    ]);
    const events = h.log.entries.map((args) => args[0]);
    expect(events).toContainEqual({ event: 'access_revealed', tenantId: tenant.id, via: 'owner' });
    expect(JSON.stringify(h.log.entries)).not.toContain(password);
    const audits = JSON.stringify(await h.documents.query('auditLog'));
    expect(audits).not.toContain(password);
  });

  it('depois dela, a página de status do cliente recebe já revelada (e o responsável também)', async () => {
    const h = harness();
    const { tenant } = await waitingWithPassword(h);
    const cookie = await h.access.mint(tenant.id, 'cookie', 'system');

    await h.reveals.revealForOwner(tenant.id, tenant.slug, ACTOR);

    await expect(h.reveals.reveal('cookie', cookie.value)).rejects.toBeInstanceOf(AlreadyRevealedError);
    await expect(h.reveals.revealForOwner(tenant.id, tenant.slug, ACTOR)).rejects.toBeInstanceOf(
      AlreadyRevealedError,
    );
    expect(h.secrets.reads).toBe(1);
  });

  it('subdomínio errado: nada marcado, nada lido; senha vencida: a marcação é desfeita', async () => {
    const h = harness();
    const { tenant } = await waitingWithPassword(h, 1);

    await expect(h.reveals.revealForOwner(tenant.id, 'outro-cliente', ACTOR)).rejects.toBeInstanceOf(
      RevealConfirmationMismatchError,
    );
    expect((await h.tenants.require(tenant.id)).access).toBeUndefined();
    expect(h.secrets.reads).toBe(0);

    h.clock.advance(2 * HOUR_MS);
    await expect(h.reveals.revealForOwner(tenant.id, tenant.slug, ACTOR)).rejects.toBeInstanceOf(
      PasswordExpiredError,
    );
    expect((await h.tenants.require(tenant.id)).access?.passwordRevealedAt).toBeUndefined();
    expect(h.queue.tasks).toEqual([]);
    expect(h.log.entries.map((args) => args[0])).toContainEqual({
      event: 'reveal_password_expired',
      tenantId: tenant.id,
      via: 'owner',
    });
  });

  it('sem NODES_PROJECT_ID recusa antes de marcar', async () => {
    const h = harness({});
    const tenant = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
    await expect(h.reveals.revealForOwner(tenant.id, tenant.slug, ACTOR)).rejects.toBeInstanceOf(
      RevealUnavailableError,
    );
    expect((await h.tenants.require(tenant.id)).access).toBeUndefined();
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
