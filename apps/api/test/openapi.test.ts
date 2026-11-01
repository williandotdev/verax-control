import 'reflect-metadata';
import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './support/create-app.js';
import { ProbeModule } from './support/probe.module.js';

describe('documentação OpenAPI em desenvolvimento (T1.2)', () => {
  let app: NestExpressApplication;
  let server: Server;

  beforeAll(async () => {
    app = await createApp({ nodeEnv: 'development', imports: [ProbeModule] });
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('publica o documento com as rotas sob /v1 e os schemas zod convertidos', async () => {
    const response = await request(server).get('/v1/docs/openapi.json').expect(200);
    const document = response.body as {
      paths: Record<string, Record<string, { requestBody?: unknown; parameters?: { name: string }[] }>>;
    };

    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(['/v1/probe', '/v1/probe/items']));
    expect(JSON.stringify(document.paths['/v1/probe']?.['post']?.requestBody)).toContain('email');
    expect(document.paths['/v1/probe/items']?.['get']?.parameters?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['page', 'pageSize']),
    );
  });

  it('serve a interface com CSP própria, ainda sem permitir frames', async () => {
    const response = await request(server).get('/v1/docs').redirects(1).expect(200);
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('a CSP aberta não vaza para as rotas da API', async () => {
    const response = await request(server).get('/v1/probe/no-input').expect(200);
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
