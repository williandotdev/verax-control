import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { newUlid } from '../src/common/ulid.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { ProvisioningStore } from '../src/provisioning/provisioning-store.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const OWNER = 'responsavel@exemplo.example';

/**
 * Sem o projeto dos nós (o padrão até a primeira venda: `PROVISIONING_ENABLED=false`), o `preflight` para o cliente em
 * `provisioning_failed` com `provisioning_disabled` e não enfileira nada: sem laço de repetição, e o responsável
 * retoma (`resume`) quando ligar. Nenhuma API externa é chamada (nem há endereço para isso).
 */
describe('cp-worker sem a configuração do provisionamento', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(new Date('2026-11-05T12:00:00.000Z'));
  const documents = new MemoryDocumentStore();
  const queue = new MemoryStepQueue();
  const google = new TestGoogleIdentity();
  const tenants = new TenantStore(documents, clock, new AuditService(documents, clock));
  let app: NestExpressApplication;
  let fetchCalls = 0;

  beforeAll(async () => {
    app = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      stepQueue: queue,
      idTokenKeys: google,
      capture,
      provisioning: {
        apis: {
          fetchFn: () => {
            fetchCalls += 1;
            return Promise.reject(new Error('nenhuma chamada externa sem configuração'));
          },
          accessTokens: { token: () => Promise.reject(new Error('sem token')) },
        },
      },
      env: {
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: OWNER,
        // O que o Terraform já dá ao worker antes do projeto dos nós; falta o resto do grupo.
        TFSTATE_BUCKET: 'projeto-dos-nos-demo-tfstate',
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('a partida avisa, só pelos nomes, que o provisionamento está desligado', () => {
    const warning = capture
      .entries()
      .find((entry) => entry.event === 'provisioning_unconfigured' && entry.tenantId === undefined);
    expect(warning?.missing).toEqual(['PROVISIONING_ENABLED']);
    expect(capture.text).not.toContain('projeto-dos-nos-demo-tfstate');
  });

  it('preflight → provisioning_failed com provisioning_disabled, sem task nova nem chamada externa', async () => {
    const tenant = await tenantIn(tenants, 'cliente-demo-a', 'provisioning');
    const runId = newUlid(clock.now().getTime());
    await tenants.change(tenant.id, () => ({
      reason: 'teste',
      audit: { actor: 'system' },
      mutate: (current) => ({ ...current, provisioning: { runId, step: 'preflight', attempts: 0 } }),
    }));
    const response = await request(app.getHttpServer())
      .post('/internal/steps/preflight')
      .set('Authorization', `Bearer ${google.token({ email: INVOKER, aud: WORKER_URL })}`)
      .send({ tenantId: tenant.id, runId })
      .expect(200);
    expect(response.body).toEqual({ step: 'preflight', outcome: 'failed' });
    const final = await tenants.require(tenant.id);
    expect(final.state).toBe('provisioning_failed');
    expect(final.provisioning).toMatchObject({
      runId,
      step: 'preflight',
      lastError: { code: 'provisioning_disabled' },
    });
    expect(final.lock).toBeUndefined();
    expect(queue.tasks).toHaveLength(0);
    expect(fetchCalls).toBe(0);
    expect(await new ProvisioningStore(documents, clock).getRun(runId)).toBeUndefined();
    expect(capture.entries().find((entry) => entry.event === 'provisioning_failed')).toMatchObject({
      tenantId: tenant.id,
      step: 'preflight',
      code: 'provisioning_disabled',
    });

    // A mesma task de novo (o Cloud Tasks repete uma entrega): nada muda e nada é enfileirado.
    await request(app.getHttpServer())
      .post('/internal/steps/preflight')
      .set('Authorization', `Bearer ${google.token({ email: INVOKER, aud: WORKER_URL })}`)
      .send({ tenantId: tenant.id, runId })
      .expect(200, { step: 'preflight', outcome: 'not_provisioning' });
    expect(queue.tasks).toHaveLength(0);
  });
});
