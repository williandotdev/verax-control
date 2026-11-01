import 'reflect-metadata';
import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Paginated } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorResponseBody } from '../src/common/http/all-exceptions.filter.js';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import { ProbeModule } from './support/probe.module.js';

const validBody = { name: 'Cliente demo', contact: { email: 'seguranca@cliente.example' } };

describe('padrões da API (T1.2)', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let server: Server;

  beforeAll(async () => {
    app = await createApp({ capture, imports: [ProbeModule] });
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('prefixo /v1', () => {
    it('serve as rotas da API sob /v1', async () => {
      await request(server).get('/v1/probe/no-input').expect(200, { ok: true });
    });

    it('não serve as rotas da API fora do prefixo', async () => {
      await request(server).get('/probe/no-input').expect(404);
    });
  });

  describe('validação de entrada', () => {
    it('aceita um corpo válido', async () => {
      const response = await request(server).post('/v1/probe').send(validBody).expect(201);
      expect(response.body).toEqual({ received: validBody });
    });

    it('rejeita campo desconhecido no corpo, inclusive em objeto aninhado', async () => {
      const response = await request(server)
        .post('/v1/probe')
        .send({ ...validBody, role: 'admin_verax', contact: { email: 'a@b.example', phone: '1' } })
        .expect(400);

      expect(response.body).toMatchObject({ statusCode: 400, message: 'Dados inválidos' });
      const issues = (response.body as ErrorResponseBody).issues;
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '', code: 'unrecognized_keys' }),
          expect.objectContaining({ path: 'contact', code: 'unrecognized_keys' }),
        ]),
      );
    });

    it('responde em português e não repete o valor recebido', async () => {
      const response = await request(server)
        .post('/v1/probe')
        .send({ name: 'x'.repeat(61), contact: { email: 'leak-value-4002' } })
        .expect(400);

      const text = JSON.stringify(response.body);
      expect(text).not.toContain('leak-value-4002');
      expect(text).not.toContain('x'.repeat(61));
      expect(text).toMatch(/inválid|grande|esperava/i);
    });

    it('remove __proto__ do corpo antes de validar (prototype pollution)', async () => {
      const response = await request(server)
        .post('/v1/probe')
        .set('Content-Type', 'application/json')
        .send(`{"name":"ok","contact":{"email":"a@b.example"},"__proto__":{"polluted":true}}`)
        .expect(201);

      expect(response.body).toEqual({ received: { name: 'ok', contact: { email: 'a@b.example' } } });
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('valida e converte a query de paginação', async () => {
      const response = await request(server).get('/v1/probe/items?page=2&pageSize=10').expect(200);
      expect(response.body).toMatchObject({ page: 2, pageSize: 10, total: 30 });
      const page = response.body as Paginated<{ id: string }>;
      expect(page.items).toHaveLength(10);
      expect(page.items[0]).toEqual({ id: 'item-11' });
    });

    it('aplica os padrões de paginação', async () => {
      const response = await request(server).get('/v1/probe/items').expect(200);
      expect(response.body).toMatchObject({ page: 1, pageSize: 25 });
    });

    it.each([
      ['página inválida', '?page=0'],
      ['pageSize acima do máximo', '?pageSize=101'],
      ['parâmetro desconhecido', '?page=1&orderBy=password'],
    ])('rejeita query com %s', async (_label, query) => {
      await request(server).get(`/v1/probe/items${query}`).expect(400);
    });

    it('valida parâmetros de rota', async () => {
      await request(server).get('/v1/probe/items/nao-e-uuid').expect(400);
      await request(server).get('/v1/probe/items/0b6f1f7e-3a1d-4c55-9a8e-4f1d2a7b9c10').expect(200);
    });

    it('rejeita query string em rota que não declara @Query', async () => {
      const response = await request(server).get('/v1/probe/no-input?debug=true').expect(400);
      expect((response.body as ErrorResponseBody).issues?.[0]?.message).toBe(
        'Esta rota não aceita parâmetros de consulta',
      );
    });

    it('rejeita corpo em rota que não declara @Body', async () => {
      await request(server).post('/v1/probe/no-body').send({ anything: 1 }).expect(400);
      await request(server).post('/v1/probe/no-body').expect(200);
    });

    it('só aceita JSON: formulário não vira corpo', async () => {
      await request(server)
        .post('/v1/probe')
        .type('form')
        .send('name=x&contact[email]=a@b.example')
        .expect(400);
    });

    it('rejeita JSON malformado com mensagem genérica', async () => {
      const response = await request(server)
        .post('/v1/probe')
        .set('Content-Type', 'application/json')
        .send('{"name": "x",')
        .expect(400);
      expect(response.body).toMatchObject({ statusCode: 400, message: 'Requisição inválida' });
      expect(JSON.stringify(response.body)).not.toMatch(/Unexpected|JSON at position|SyntaxError/);
    });

    it('rejeita corpo maior que 100 kB', async () => {
      const response = await request(server)
        .post('/v1/probe')
        .send({ name: 'x', contact: { email: 'a@b.example' }, pad: 'a'.repeat(110 * 1024) })
        .expect(413);
      expect((response.body as ErrorResponseBody).message).toBe('Requisição muito grande');
    });
  });

  describe('filtro de erros', () => {
    it('erro inesperado vira 500 genérico com requestId; o detalhe só vai para o log, sem senha', async () => {
      const response = await request(server).get('/v1/probe/crash').expect(500);

      expect(response.body).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Erro interno',
        requestId: response.headers['x-request-id'],
      });
      const logged = capture.entries().find((entry) => entry['msg'] === 'erro não tratado');
      expect(JSON.stringify(logged)).toContain('falha conectando');
      expect(capture.text).not.toContain('leak-crash-4001');
    });

    it('ApiError mostra a mensagem pública', async () => {
      const response = await request(server).get('/v1/probe/conflict').expect(409);
      expect((response.body as ErrorResponseBody).message).toBe(
        'Este ID de conta já pertence a outro cliente',
      );
    });

    it('outras exceções HTTP saem com a mensagem genérica do status', async () => {
      const response = await request(server).get('/v1/probe/forbidden').expect(403);
      expect((response.body as ErrorResponseBody).message).toBe('Sem permissão');
      expect(JSON.stringify(response.body)).not.toContain('detalhe interno');
    });
  });

  describe('headers de segurança (helmet)', () => {
    it('envia CSP fechada, nosniff, HSTS e anti-frame, sem X-Powered-By', async () => {
      const response = await request(server).get('/v1/probe/no-input').expect(200);

      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toMatch(/max-age=\d+/);
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('também protege respostas de erro', async () => {
      const response = await request(server).get('/v1/nao-existe').expect(404);
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    });
  });

  describe('documentação OpenAPI', () => {
    it('não existe fora do ambiente de desenvolvimento', async () => {
      await request(server).get('/v1/docs').expect(404);
      await request(server).get('/v1/docs/openapi.json').expect(404);
    });
  });
});
