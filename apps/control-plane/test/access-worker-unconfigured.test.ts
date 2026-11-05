import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { fakeIdentityToken } from './support/access-fakes.js';
import { createApp } from './support/create-app.js';

/**
 * O cp-worker sem `WORKER_URL` (a audiência que ele confere no token): nenhuma rota interna passa, nem com um token
 * de quem poderia chamá-la; a resposta é 503 e nada é lido nem gravado. Um app por arquivo.
 */
describe('cp-worker sem WORKER_URL (CP-05)', () => {
  const documents = new MemoryDocumentStore();
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({
      role: 'worker',
      documentStore: documents,
      env: {
        PUBLIC_SA_EMAIL: 'cp-public@projeto-exemplo.iam.gserviceaccount.com',
        WORKER_SA_EMAIL: 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com',
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('recusa as rotas internas com 503 worker_unconfigured', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const aud = 'https://cp-worker-123456789012.southamerica-east1.run.app';
    const reveal = await request(app.getHttpServer())
      .post('/internal/access/reveal')
      .set(
        'Authorization',
        `Bearer ${fakeIdentityToken({ email: 'cp-public@projeto-exemplo.iam.gserviceaccount.com', aud, exp })}`,
      )
      .send({ kind: 'cookie', token: 'x'.repeat(43) })
      .expect(503);
    expect(reveal.body).toMatchObject({ code: 'worker_unconfigured' });
    await request(app.getHttpServer())
      .post('/internal/steps/secrets.destroy_bootstrap')
      .set(
        'Authorization',
        `Bearer ${fakeIdentityToken({ email: 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com', aud, exp })}`,
      )
      .send({ tenantId: '01JBZZZZZZZZZZZZZZZZZZZZZZ', runId: '01JBZZZZZZZZZZZZZZZZZZZZZZ' })
      .expect(503);
    expect(await documents.query('auditLog')).toEqual([]);
  });
});
