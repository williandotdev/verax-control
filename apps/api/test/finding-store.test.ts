import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { FindingStore } from '../src/alerts/finding-store.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { IncidentGrouping } from '../src/incidents/incident-grouping.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

describe('gravação de achados com coletores rodando ao mesmo tempo (agendador)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  function draft(tenantId: string, source: 'wazuh' | 'gcp', sourceIp: string): FindingDraft {
    return {
      tenantId,
      accountId: source === 'gcp' ? 'vx-projeto-demo' : '111111111111',
      source,
      sourceEventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      severity: 'high',
      ruleId: source === 'gcp' ? '990106' : '80202',
      ruleLevel: 10,
      title: 'Achado de teste',
      logSource: source === 'gcp' ? 'gcp_audit' : 'cloudtrail',
      eventName: null,
      region: null,
      resource: null,
      actorUser: null,
      actorType: null,
      accessKeyId: null,
      sourceIp,
      mitreTactics: [],
      mitreTechniques: [],
    };
  }

  it('dois achados do mesmo cliente com a mesma chave, gravados juntos por coletores diferentes, abrem um incidente só', async () => {
    const store = new FindingStore(prisma, new IncidentGrouping());
    const now = new Date();
    // Algumas rodadas: sem o lock por cliente, as duas transações não se veem e cada uma abre o próprio incidente.
    for (let round = 0; round < 5; round += 1) {
      const tenantId = await createTenant(app, `Cliente demo ${randomInt(1e6, 9e6)}`);
      const ip = `198.51.100.${round + 1}`;
      const outcomes = await Promise.all([
        store.persist(draft(tenantId, 'wazuh', ip), null, new Set(), now),
        store.persist(draft(tenantId, 'gcp', ip), null, new Set(), now),
      ]);
      expect(outcomes.sort()).toEqual(['joined', 'opened']);
      const incidents = await prisma.incident.findMany({
        where: { tenantId },
        select: { findingCount: true },
      });
      expect(incidents).toEqual([{ findingCount: 2 }]);
    }
  });

  it('clientes diferentes não se juntam nem se esperam: cada um abre o seu', async () => {
    const store = new FindingStore(prisma, new IncidentGrouping());
    const [a, b] = [await createTenant(app, 'Cliente demo A'), await createTenant(app, 'Cliente demo B')];
    const now = new Date();
    const outcomes = await Promise.all([
      store.persist(draft(a, 'wazuh', '198.51.100.200'), null, new Set(), now),
      store.persist(draft(b, 'gcp', '198.51.100.200'), null, new Set(), now),
    ]);
    expect(outcomes).toEqual(['opened', 'opened']);
    expect(await prisma.incident.count({ where: { tenantId: { in: [a, b] } } })).toBe(2);
  });
});
