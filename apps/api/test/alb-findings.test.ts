import 'reflect-metadata';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  detectionPageSchema,
  findingDetailSchema,
  findingEvidenceSchema,
  findingSchema,
  MITRE_TACTIC_NAMES,
  MITRE_TECHNIQUE_PATTERN,
  paginatedSchema,
  relatedFindingsSchema,
  reportSchemas,
  towerSummarySchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FindingStore } from '../src/alerts/finding-store.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { WebFindingDraft } from '../src/weblogs/draft.js';
import { WEB_RULES, type WebRuleId } from '../src/weblogs/rules.js';
import { sealEvidence } from '../src/weblogs/evidence.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { previousFindingDetailSchema, previousFindingSchema } from './support/previous-panel.js';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Um achado dos logs do ALB (`logSource = alb`) por tudo o que lê achados: a lista, o filtro, o detalhe, a evidência, os
 * relacionados, a visão agrupada, os relatórios e o radar da Torre. Nenhum deles depende dos ataques web ligados: o achado
 * gravado continua à vista depois de desligá-los.
 */
describe('achado dos logs do ALB', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let readerA: string;
  let readerB: string;
  const account = String(randomInt(100_000_000_000, 999_999_999_999));
  const atMs = Math.floor((Date.now() - HOUR) / 60_000) * 60_000;
  let alb: { id: string };
  let waf: { id: string };

  /** O que o motor manda gravar. */
  function draft(tenantId: string, ruleId: WebRuleId = '990406'): WebFindingDraft {
    const key = `aws/${account}/alb:${randomBytes(20).toString('hex')}`;
    const rule = WEB_RULES[ruleId];
    return {
      tenantId,
      accountId: account,
      source: 'aws',
      sourceEventId: key,
      occurredAt: iso(atMs),
      severity: 'critical',
      ruleId,
      ruleLevel: 12,
      title: rule.title,
      logSource: 'alb',
      eventName: 'falhas seguidas de sucesso',
      region: 'sa-east-1',
      resource: 'alb:app/loja/0123456789abcdef',
      actorUser: null,
      actorType: null,
      accessKeyId: null,
      sourceIp: '203.0.113.7',
      mitreTactics: [...rule.tactics],
      mitreTechniques: [...rule.techniques],
      recurrence: { lastSeenAt: iso(atMs), chainKey: key, sourceEventId: `${key}@${iso(atMs)}` },
      evidence: sealEvidence({
        version: 1,
        ruleId,
        windowFrom: iso(atMs - HOUR),
        windowTo: iso(atMs),
        firstSeenAt: iso(atMs - HOUR),
        lastSeenAt: iso(atMs),
        client: '203.0.113.7',
        clientClass: 'direct',
        host: 'loja.example.com',
        route: '/login',
        routeKind: 'login',
        routeSemantics: 'declared',
        counters: {
          requests: 60,
          blocked: 0,
          errors: 0,
          toolRequests: 0,
          probes: 0,
          distinctPaths: 1,
          attempts: 60,
          failures: 58,
          successes: 2,
          clients: 1,
          answered: 0,
        },
        blockedPercent: 0,
        statuses: [{ status: '401', count: 58 }],
        probeFamilies: [],
        routes: [{ path: '/login', count: 60 }],
        clients: [],
        userAgents: { families: ['curl'], sample: 'curl/8.1' },
        samples: [],
        pointers: [],
        truncated: false,
        notes: ['valid_account_possible'],
      }),
      correlation: { firstSeenAt: iso(atMs), lastSeenAt: iso(atMs), keys: ['web:actor:203.0.113.7'] },
    };
  }
  const get = (cookie: string, path: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie);
  const pageSchema = paginatedSchema(findingSchema);

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (achados do ALB)');
    tenantB = await createTenant(app, 'Cliente Demo B (achados do ALB)');
    await prisma.cloudAccount.create({
      data: { tenantId: tenantA, accountId: account, regions: ['sa-east-1'] },
    });
    readerA = (await createSignedInUser(app, { role: 'leitura', tenantId: tenantA })).cookie;
    readerB = (await createSignedInUser(app, { role: 'leitura', tenantId: tenantB })).cookie;
    const store = new FindingStore(prisma);
    const own = draft(tenantA);
    expect(await store.persist(own, null, new Date())).toBe('created');
    alb = await prisma.finding.findFirstOrThrow({
      where: { tenantId: tenantA, sourceEventId: own.sourceEventId },
      select: { id: true },
    });
    // Um do WAF, do mesmo endereço e na mesma hora.
    waf = await prisma.finding.create({
      data: {
        tenantId: tenantA,
        accountId: account,
        source: 'wazuh',
        sourceEventId: randomUUID(),
        logSource: 'waf',
        occurredAt: new Date(atMs - 60_000),
        severity: 'high',
        ruleId: '80443',
        ruleLevel: 10,
        title: 'WAF bloqueou requisições',
        sourceIp: '203.0.113.7',
        mitreTactics: ['Reconnaissance'],
        mitreTechniques: ['T1595'],
      },
      select: { id: true },
    });
    await store.persist(draft(tenantB), null, new Date());
  });

  afterAll(async () => {
    await app.close();
  });

  it('lista e filtro pela fonte, pela tática, pela técnica e pela busca', async () => {
    const list = pageSchema.parse((await get(readerA, '/v1/findings').expect(200)).body);
    expect(list.items.map((item) => [item.id, item.source])).toEqual([
      [alb.id, 'alb'],
      [waf.id, 'waf'],
    ]);
    for (const query of [
      'source=alb',
      'tactic=Credential%20Access',
      'technique=T1078',
      'q=app%2Floja%2F0123456789abcdef',
      'severity=critical',
    ]) {
      const { items } = pageSchema.parse((await get(readerA, `/v1/findings?${query}`).expect(200)).body);
      expect(
        items.map((item) => item.id),
        query,
      ).toEqual([alb.id]);
    }
    const others = pageSchema.parse((await get(readerA, '/v1/findings?source=waf').expect(200)).body);
    expect(others.items.map((item) => item.id)).toEqual([waf.id]);
    await get(readerA, '/v1/findings?source=elb').expect(400);
  });

  it('o detalhe, sem evento bruto, e a evidência na rota dela', async () => {
    const detail = findingDetailSchema.parse((await get(readerA, `/v1/findings/${alb.id}`).expect(200)).body);
    expect(detail).toMatchObject({
      source: 'alb',
      ruleId: '990406',
      ruleLevel: 12,
      rawEvent: null,
      resource: 'alb:app/loja/0123456789abcdef',
      actor: { ip: '203.0.113.7' },
      mitreTechniques: ['T1110', 'T1078'],
    });
    const { evidence } = findingEvidenceSchema.parse(
      (await get(readerA, `/v1/findings/${alb.id}/evidence`).expect(200)).body,
    );
    expect(evidence).toMatchObject({ ruleId: '990406', route: '/login' });
  });

  it('os relacionados (pelo IP) e a visão agrupada', async () => {
    const related = relatedFindingsSchema.parse(
      (await get(readerA, `/v1/findings/${waf.id}/related`).expect(200)).body,
    );
    expect(related.items.map((item) => [item.id, item.source])).toEqual([[alb.id, 'alb']]);
    const page = detectionPageSchema.parse(
      (await get(readerA, '/v1/detections?source=alb').expect(200)).body,
    );
    expect(page.items).toMatchObject([{ kind: 'finding', finding: { id: alb.id, source: 'alb' } }]);
  });

  it('os relatórios: a fonte no resumo e na cobertura, as táticas no MITRE e a regra', async () => {
    const summary = reportSchemas.summary.parse((await get(readerA, '/v1/reports/summary').expect(200)).body);
    expect(summary.findings.bySource).toEqual(
      expect.arrayContaining([
        { source: 'alb', count: 1 },
        { source: 'waf', count: 1 },
      ]),
    );
    const coverage = reportSchemas.coverage.parse(
      (await get(readerA, '/v1/reports/coverage').expect(200)).body,
    );
    expect(coverage.accounts[0]?.bySource).toContainEqual({ source: 'alb', count: 1 });
    const mitre = reportSchemas.mitre.parse((await get(readerA, '/v1/reports/mitre').expect(200)).body);
    const tactic = (name: string) => mitre.tactics.find((item) => item.name === name)?.findings;
    expect(tactic('Credential Access')).toBe(1);
    expect(tactic('Initial Access')).toBe(1);
    const rules = reportSchemas.rules.parse((await get(readerA, '/v1/reports/rules').expect(200)).body);
    expect(rules.items.map((item) => item.ruleId)).toContain('990406');
    const entities = reportSchemas.entities.parse(
      (await get(readerA, '/v1/reports/entities').expect(200)).body,
    );
    expect(entities.ips).toContainEqual({ value: '203.0.113.7', findings: 2, incidents: 0 });
  });

  it('o radar da Torre: no setor da AWS, na lista e nas contagens', async () => {
    const { radar } = towerSummarySchema.parse((await get(readerA, '/v1/tower').expect(200)).body);
    expect(radar).toMatchObject({ total: 2, bySector: { aws: 2, gcp: 0, cloudflare: 0, agents: 0 } });
    expect(radar?.detections.map((item) => [item.id, item.source])).toEqual([
      [alb.id, 'alb'],
      [waf.id, 'waf'],
    ]);
  });

  it('o aviso por e-mail de um alerta alto ou crítico é o de sempre', async () => {
    const notices = await prisma.notification.findMany({ where: { findingId: alb.id } });
    expect(notices.map((notice) => [notice.kind, notice.severity])).toEqual([
      ['critical_finding', 'critical'],
    ]);
  });

  it('B não vê o achado de A em lugar nenhum', async () => {
    await get(readerB, `/v1/findings/${alb.id}`).expect(404);
    await get(readerB, `/v1/findings/${alb.id}/evidence`).expect(404);
    await get(readerB, `/v1/findings/${alb.id}/related`).expect(404);
    for (const path of ['/v1/findings?source=alb', '/v1/detections?source=alb', '/v1/tower']) {
      expect(JSON.stringify((await get(readerB, path).expect(200)).body), path).not.toContain(alb.id);
    }
  });

  it('um painel de antes: a página e o detalhe com ele são recusados; sem ele, são lidos', async () => {
    const previous = paginatedSchema(previousFindingSchema);
    const all = (await get(readerA, '/v1/findings').expect(200)).body as unknown;
    expect(previous.safeParse(all).success).toBe(false);
    const others = (await get(readerA, '/v1/findings?source=waf').expect(200)).body as unknown;
    expect(previous.safeParse(others).success).toBe(true);
    const detail = async (id: string) =>
      (await get(readerA, `/v1/findings/${id}`).expect(200)).body as unknown;
    expect(previousFindingDetailSchema.safeParse(await detail(alb.id)).success).toBe(false);
    expect(previousFindingDetailSchema.safeParse(await detail(waf.id)).success).toBe(true);
  });

  it('as táticas e técnicas das regras do motor são as do catálogo que os filtros e os relatórios usam', () => {
    const names: readonly string[] = MITRE_TACTIC_NAMES;
    for (const [ruleId, rule] of Object.entries(WEB_RULES)) {
      for (const tactic of rule.tactics) expect(names, ruleId).toContain(tactic);
      for (const technique of rule.techniques) expect(technique, ruleId).toMatch(MITRE_TECHNIQUE_PATTERN);
      expect(rule.title.length, ruleId).toBeLessThanOrEqual(500);
    }
  });
});
