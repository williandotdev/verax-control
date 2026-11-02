import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TEST_WEB_ORIGIN } from './create-app.js';

/** Sessão pronta para chamadas autenticadas (cookie + token CSRF). */
export interface TestSession {
  cookie: string;
  csrfToken: string;
}

export interface TenantIsolationOptions {
  /** Nome do recurso no relatório do teste. */
  resource: string;
  /** Caminho da coleção, ex.: `/v1/cloud-accounts`. */
  basePath: string;
  /** Contexto preparado no `beforeAll` do arquivo: app e uma sessão de cada cliente. */
  context: () => { app: NestExpressApplication; sessionA: TestSession; sessionB: TestSession };
  /** Cria um registro no cliente B e devolve o id. */
  createInTenantB: () => Promise<string>;
  /** Lê o registro direto do banco (sem escopo), para conferir que nada mudou. */
  readDirect: (id: string) => Promise<unknown>;
  /** Corpo válido de PATCH. Omita se o recurso não tem alteração. */
  patchBody?: object;
  /** O recurso tem DELETE. */
  hasDelete?: boolean;
}

function write(
  app: NestExpressApplication,
  method: 'patch' | 'delete',
  path: string,
  session: TestSession,
  body?: object,
) {
  const agent = request(app.getHttpServer());
  const call = agent[method](path)
    .set('Cookie', session.cookie)
    .set('Origin', TEST_WEB_ORIGIN)
    .set('X-CSRF-Token', session.csrfToken);
  return body ? call.send(body) : call;
}

/**
 * Suíte negativa genérica de isolamento (T2.5): um usuário do cliente A não lista, não lê, não altera e
 * não apaga dado do cliente B. Todo módulo com dado de cliente chama esta suíte no seu arquivo de teste.
 */
export function describeTenantIsolation(options: TenantIsolationOptions): void {
  describe(`isolamento entre clientes: ${options.resource}`, () => {
    it('A não vê registro de B na listagem', async () => {
      const { app, sessionA } = options.context();
      const id = await options.createInTenantB();
      const response = await request(app.getHttpServer())
        .get(options.basePath)
        .set('Cookie', sessionA.cookie)
        .expect(200);
      expect(JSON.stringify(response.body)).not.toContain(id);
    });

    it('A recebe 404 ao ler registro de B (sem confirmar que existe)', async () => {
      const { app, sessionA } = options.context();
      const id = await options.createInTenantB();
      await request(app.getHttpServer())
        .get(`${options.basePath}/${id}`)
        .set('Cookie', sessionA.cookie)
        .expect(404);
    });

    if (options.patchBody) {
      const body = options.patchBody;
      it('A recebe 404 ao alterar registro de B, e nada muda', async () => {
        const { app, sessionA } = options.context();
        const id = await options.createInTenantB();
        const before = await options.readDirect(id);
        await write(app, 'patch', `${options.basePath}/${id}`, sessionA, body).expect(404);
        expect(await options.readDirect(id)).toEqual(before);
      });
    }

    if (options.hasDelete) {
      it('A recebe 404 ao apagar registro de B, e nada muda', async () => {
        const { app, sessionA } = options.context();
        const id = await options.createInTenantB();
        const before = await options.readDirect(id);
        await write(app, 'delete', `${options.basePath}/${id}`, sessionA).expect(404);
        expect(await options.readDirect(id)).toEqual(before);
      });
    }

    it('B continua enxergando o próprio registro (o filtro não esconde demais)', async () => {
      const { app, sessionB } = options.context();
      const id = await options.createInTenantB();
      await request(app.getHttpServer())
        .get(`${options.basePath}/${id}`)
        .set('Cookie', sessionB.cookie)
        .expect(200);
    });
  });
}
