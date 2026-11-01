import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createApp } from './support/create-app.js';
import { WidgetProbeModule } from './support/widget-probe.module.js';

describe('IP do cliente atrás do ALB (T1.3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp({ trustProxyHops: 1, imports: [WidgetProbeModule] });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('usa o IP informado pelo proxy confiável', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/widgets-probe')
      .set('X-Forwarded-For', '203.0.113.7')
      .send({ name: 'via-alb' })
      .expect(201);

    const entry = await prisma.auditLog.findFirst({ where: { requestId: response.headers['x-request-id'] } });
    expect(entry?.ip).toBe('203.0.113.7');
  });

  it('com um salto confiável, só o último endereço da cadeia vale (o cliente não forja o resto)', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/widgets-probe')
      .set('X-Forwarded-For', '198.51.100.66, 203.0.113.8')
      .send({ name: 'cadeia' })
      .expect(201);

    const entry = await prisma.auditLog.findFirst({ where: { requestId: response.headers['x-request-id'] } });
    expect(entry?.ip).toBe('203.0.113.8');
  });
});
