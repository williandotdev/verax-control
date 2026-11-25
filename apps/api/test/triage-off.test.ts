import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ROLES } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createTenant } from './support/auth-helpers.js';
import { cleanCases, insertOperation } from './support/cases.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import {
  caseWith,
  findingsById,
  type Operator,
  operatorFor,
  patch,
  post,
  read,
  statusRequest,
} from './support/triage.js';

/** Com `CASES_MODE=off`, a triagem em massa não existe para ninguém. */
describe('triagem em massa desligada (CASES_MODE=off)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let caseId: string;
  let ids: string[];
  let operationId: string;
  const people: Operator[] = [];

  beforeAll(async () => {
    // Sem informar o modo: o padrão.
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo (lote desligado)');
    ({ caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]));
    operationId = await insertOperation(prisma, tenantId, { state: 'queued' });
    for (const role of ROLES) people.push(await operatorFor(app, tenantId, role));
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, [tenantId]);
    await app.close();
  }, 60_000);

  const reads = () => [
    '/v1/triage-operations',
    '/v1/triage-operations?x=1',
    '/v1/triage-operations/preview?q=x',
    '/v1/triage-operations/preview',
    `/v1/triage-operations/${operationId}`,
    '/v1/triage-operations/abc',
  ];
  const writes = (): [string, object | undefined][] => [
    ['/v1/triage-operations', statusRequest({ caseIds: [caseId] }, 2)],
    // Também com um pedido inválido: nada diz que a rota existe.
    ['/v1/triage-operations', { x: 1 }],
    [`/v1/triage-operations/${operationId}/cancel`, undefined],
    [`/v1/triage-operations/${operationId}/continue`, undefined],
    [`/v1/triage-operations/${operationId}/undo`, { requestId: randomUUID() }],
    ['/v1/triage-operations/abc/undo', {}],
    [`/v1/cases/${caseId}/split`, { findingIds: [ids[0]] }],
    [`/v1/cases/${caseId}/split`, {}],
  ];
  const shape = (body: unknown) => ({ ...(body as object), requestId: undefined });

  it.each(ROLES)('%s recebe a resposta de uma rota que não existe, e nada muda', async (role) => {
    const who = people.find((person) => person.role === role) as Operator;
    const none = await read(app, who, '/v1/rota-que-nao-existe').expect(404);
    const before = await findingsById(prisma, ids);
    for (const path of reads()) {
      // Quem só lê não tem a prévia, nem com os casos ligados: a permissão vem antes.
      const status = role === 'leitura' && path.includes('/preview') ? 403 : 404;
      const response = await read(app, who, path).expect(status);
      if (status === 404) expect(shape(response.body), path).toEqual(shape(none.body));
    }
    for (const [path, body] of writes()) {
      const response = await post(app, who, path, body);
      expect(response.status, path).toBe(role === 'leitura' ? 403 : 404);
      if (role !== 'leitura') expect(shape(response.body), path).toEqual(shape(none.body));
    }
    expect(await findingsById(prisma, ids)).toEqual(before);
    expect(await prisma.triageOperation.count({ where: { tenantId } })).toBe(1);
    expect(await prisma.alertCase.count({ where: { tenantId } })).toBe(1);
  });

  it('a escrita recusada de quem tem sessão fica na trilha; sem sessão, 401 e nada', async () => {
    const who = people.find((person) => person.role === 'admin_cliente') as Operator;
    const before = await prisma.auditLog.count({ where: { actorId: who.userId, statusCode: 404 } });
    await post(app, who, '/v1/triage-operations', statusRequest({ caseIds: [caseId] }, 2)).expect(404);
    const rows = await prisma.auditLog.findMany({
      where: { actorId: who.userId, statusCode: 404 },
      orderBy: { id: 'desc' },
    });
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]).toMatchObject({ tenantId, outcome: 'denied', action: 'POST /v1/triage-operations' });
    for (const [path, body] of writes()) {
      await request(app.getHttpServer())
        .post(path)
        .set('Origin', TEST_WEB_ORIGIN)
        .send(body ?? {})
        .expect(401);
    }
    for (const path of reads()) await request(app.getHttpServer()).get(path).expect(401);
  });

  it('a triagem de um alerta tira a operação dele em qualquer modo', async () => {
    const who = people.find((person) => person.role === 'analista_cliente') as Operator;
    const id = ids[0] as string;
    await prisma.finding.update({ where: { id }, data: { triageOpId: operationId } });
    await patch(app, who, `/v1/findings/${id}/status`, { status: 'investigating' }).expect(200);
    expect((await findingsById(prisma, [id])).get(id)?.triageOpId).toBeNull();
  });
});
