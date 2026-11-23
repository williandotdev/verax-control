import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const PATH = '/v1/public/cloudflare/callback';

/** Sem `CLOUDFLARE_OAUTH_CLIENT_ID` (o padrão), o retorno responde a mesma recusa de sempre e não lê nada. */
describe('cp-public: retorno do Cloudflare (desligado)', () => {
  const clock = new FakeClock(new Date('2026-11-20T12:00:00.000Z'));
  const documents = new MemoryDocumentStore();
  const tenants = new TenantStore(documents, clock, new AuditService(documents, clock));
  let app: NestExpressApplication;

  beforeAll(async () => {
    await tenantIn(tenants, 'liberado-a', 'active');
    app = await createApp({
      role: 'public',
      clock,
      documentStore: documents,
      capture: new LogCapture(),
      env: { CLOUDFLARE_OAUTH_TENANT_SLUGS: '*' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('cliente que existe e pedido bem formado: recusa genérica, sem redirecionar nem ler o banco', async () => {
    const find = vi.spyOn(TenantStore.prototype, 'findBySlug');
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({ code: 'CODIGO-de-teste', state: `liberado-a.${'n'.repeat(43)}` })
      .redirects(0);
    expect(response.status).toBe(400);
    expect(response.headers['location']).toBeUndefined();
    expect(response.text).toContain('Não foi possível concluir a conexão com o Cloudflare');
    expect(find).not.toHaveBeenCalled();
  });
});
