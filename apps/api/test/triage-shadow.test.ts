import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ROLES, triageOperationPageSchema, triagePreviewSchema } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createTenant } from './support/auth-helpers.js';
import { cleanCases, insertOperation } from './support/cases.js';
import { createApp } from './support/create-app.js';
import {
  caseWith,
  findingsById,
  type Operator,
  operation,
  operatorFor,
  post,
  read,
  statusRequest,
} from './support/triage.js';

/** Com `CASES_MODE=shadow` (a medição), a equipe da Verax só lê as operações, e ninguém opera, nem ela. */
describe('triagem em massa em medição (CASES_MODE=shadow)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let caseId: string;
  let ids: string[];
  let operationId: string;
  const people: Operator[] = [];

  beforeAll(async () => {
    app = await createApp({ casesMode: 'shadow' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo (lote em medição)');
    ({ caseId, ids } = await caseWith(prisma, tenantId, [{}, {}], { actors: ['alguém'] }));
    operationId = await insertOperation(prisma, tenantId, { state: 'queued', matched: 2 });
    for (const role of ROLES) people.push(await operatorFor(app, tenantId, role));
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, [tenantId]);
    await app.close();
  }, 60_000);

  it.each(ROLES)('%s', async (role) => {
    const who = people.find((person) => person.role === role) as Operator;
    const verax = role === 'admin_verax';
    for (const path of ['/v1/triage-operations', `/v1/triage-operations/${operationId}`]) {
      await read(app, who, path).expect(verax ? 200 : 404);
    }
    const preview = await read(app, who, '/v1/triage-operations/preview?q=algu%C3%A9m');
    expect(preview.status).toBe(verax ? 200 : role === 'leitura' ? 403 : 404);
    if (verax) {
      expect(triagePreviewSchema.parse(preview.body)).toMatchObject({ cases: 1, alerts: 2 });
      const list = await read(app, who, '/v1/triage-operations').expect(200);
      expect(triageOperationPageSchema.parse(list.body).items.map((item) => item.id)).toEqual([operationId]);
      // A fila não roda na medição: nada a cancelar por aqui.
      expect((await operation(app, who, operationId)).can).toEqual({
        cancel: false,
        continue: false,
        undo: false,
      });
    }
    const before = await findingsById(prisma, ids);
    const writes: [string, object | undefined][] = [
      ['/v1/triage-operations', statusRequest({ caseIds: [caseId] }, 2)],
      ['/v1/triage-operations', {}],
      [`/v1/triage-operations/${operationId}/cancel`, undefined],
      [`/v1/triage-operations/${operationId}/continue`, undefined],
      [`/v1/triage-operations/${operationId}/undo`, { requestId: randomUUID() }],
      [`/v1/cases/${caseId}/split`, { findingIds: [ids[0]] }],
    ];
    for (const [path, body] of writes) {
      expect((await post(app, who, path, body)).status, path).toBe(role === 'leitura' ? 403 : 404);
    }
    expect(await findingsById(prisma, ids)).toEqual(before);
    expect(await prisma.triageOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({
      state: 'queued',
    });
  });
});
