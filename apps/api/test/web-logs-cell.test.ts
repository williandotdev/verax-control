import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCellTenant,
  createSignedInUserOnHost,
  csrfOnHost,
  onHost,
  testCell,
  uniqueSlug,
} from './support/cell.js';
import { createApp } from './support/create-app.js';

const SLUG = uniqueSlug('weblogs');

/** Na célula compartilhada, a coleta da AWS não existe: `AWS_WEB_LOGS_ENABLED=true` não liga nada. */
describe('ataques web pelos logs do ALB na célula compartilhada', () => {
  let app: NestExpressApplication;
  let session: { cookie: string; token: string };

  beforeAll(async () => {
    app = await createApp({ cell: testCell(), awsWebLogs: true });
    const tenant = await createCellTenant(app, SLUG);
    const admin = await createSignedInUserOnHost(app, SLUG, { role: 'admin_cliente', tenantId: tenant });
    session = await csrfOnHost(app, SLUG, admin.cookie);
  });

  afterAll(async () => {
    await app.close();
  });

  it('as rotas respondem 404, mesmo com a linha ligada', async () => {
    const read = await onHost(app, SLUG)('get', '/v1/web-logs/sources').set('Cookie', session.cookie);
    expect(read.status).toBe(404);
    expect(read.body).toMatchObject({ code: 'WEB_LOGS_DISABLED' });
    const written = await onHost(app, SLUG)('post', '/v1/web-logs/trusted-sources')
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.token)
      .send({});
    expect(written.status).toBe(404);
  });
});
