import 'reflect-metadata';
import type { Server } from 'node:http';
import { Body, Controller, type INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InjectPinoLogger, Logger, PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/common/config/load-config.js';
import { LogCapture } from './support/log-capture.js';

const LEAKS = {
  bearer: 'leak-bearer-1001',
  cookie: 'leak-cookie-1002',
  queryToken: 'leak-query-token-1003',
  password: 'leak-password-1004',
  awsCredential: 'leak-aws-1005',
};

@Controller('test-log')
class LoggingProbeController {
  constructor(@InjectPinoLogger(LoggingProbeController.name) private readonly logger: PinoLogger) {}

  @Post()
  probe(@Body() body: unknown): { ok: true } {
    // Simula um descuido: logar o corpo inteiro e credenciais AWS.
    this.logger.info({ body, aws: { SecretAccessKey: LEAKS.awsCredential } }, 'recebido');
    return { ok: true };
  }
}

@Module({ controllers: [LoggingProbeController] })
class LoggingProbeModule {}

describe('logs HTTP da API (T1.1)', () => {
  const capture = new LogCapture();
  let app: INestApplication;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      WEB_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: 'postgresql://verax:unused@localhost:5432/verax_test',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config, { logger: { destination: capture } }), LoggingProbeModule],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('não registra header Authorization, cookie, query string nem campos sensíveis do corpo', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post(`/test-log?token=${LEAKS.queryToken}`)
      .set('Authorization', `Bearer ${LEAKS.bearer}`)
      .set('Cookie', `verax.session=${LEAKS.cookie}`)
      .send({ email: 'analista@cliente.example', password: LEAKS.password })
      .expect(201);

    await vi.waitFor(() => expect(capture.text).toContain('request completed'));

    for (const leak of Object.values(LEAKS)) {
      expect(capture.text).not.toContain(leak);
    }

    const requestId = response.headers['x-request-id'] as string;
    const completed = capture.entries().find((entry) => entry['msg'] === 'request completed');
    expect(completed).toMatchObject({
      req: { id: requestId, method: 'POST', url: '/test-log' },
      res: { statusCode: 201 },
    });
    expect(completed?.['req']).not.toHaveProperty('headers');
  });

  it('gera um request id próprio quando o recebido não tem formato válido', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/test-log')
      .set('x-request-id', '<script>alert(1)</script>')
      .send({})
      .expect(201);

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reaproveita um request id válido vindo do proxy', async () => {
    const response = await request(app.getHttpServer() as Server)
      .post('/test-log')
      .set('x-request-id', 'alb-trace-12345678')
      .send({})
      .expect(201);

    expect(response.headers['x-request-id']).toBe('alb-trace-12345678');
  });

  it('não gera log por requisição para o health check', async () => {
    const before = capture.lines.length;
    await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200, { status: 'ok' });
    // Uma requisição de controle depois garante que o log do health, se existisse, já teria sido escrito.
    await request(app.getHttpServer() as Server)
      .post('/test-log')
      .send({})
      .expect(201);
    const newEntries = (): Record<string, unknown>[] => capture.entries().slice(before);
    await vi.waitFor(() =>
      expect(newEntries().some((entry) => entry['msg'] === 'request completed')).toBe(true),
    );

    expect(newEntries().some((entry) => JSON.stringify(entry).includes('/health'))).toBe(false);
  });
});
