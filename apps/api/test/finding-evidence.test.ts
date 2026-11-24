import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  findingDetailSchema,
  findingEvidenceSchema,
  findingWebEvidenceSchema,
  MAX_FINDING_EVIDENCE_BYTES,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { evidenceBytes } from '../src/alerts/finding-evidence.js';
import { FindingStore } from '../src/alerts/finding-store.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { SYSTEM_WRITTEN_MODELS, TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import { AlertNotices } from '../src/notifications/finding-notices.js';
import type { WebFindingDraft } from '../src/weblogs/draft.js';
import {
  EVIDENCE_NOTES,
  MAX_EVIDENCE_BYTES,
  sealEvidence,
  type WebEvidence,
  webEvidenceSchema,
} from '../src/weblogs/evidence.js';
import { PROBE_FAMILIES } from '../src/weblogs/probes.js';
import { UA_FAMILIES } from '../src/weblogs/user-agent.js';
import { ACCOUNT, Harness, LB, type LineSpec, REGION, SLOT, T0, times } from './support/alb-lines.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

/**
 * A evidência dos ataques web pelos logs do ALB (`FindingEvidence`): gravada com o achado, trocada só por uma mais nova,
 * lida por uma rota própria, e nada disso muda (nem custa) para os coletores de sempre.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number): string => new Date(ms).toISOString();

const sample = (atMs: number) => ({
  at: iso(atMs),
  method: 'POST' as const,
  path: '/login',
  status: 401,
  bytes: 512,
});

function evidence(overrides: Partial<WebEvidence> & { attempts?: number } = {}): WebEvidence {
  const { attempts = 20, ...rest } = overrides;
  return sealEvidence({
    version: 1,
    ruleId: '990405',
    windowFrom: iso(T0 - 15 * MINUTE),
    windowTo: iso(T0),
    firstSeenAt: iso(T0 - 5 * MINUTE),
    lastSeenAt: iso(T0),
    client: '198.51.100.7',
    clientClass: 'direct',
    host: 'loja.exemplo.com.br',
    route: '/login',
    routeKind: 'login',
    routeSemantics: 'observed',
    counters: {
      requests: 0,
      blocked: 0,
      errors: 0,
      toolRequests: 0,
      probes: 0,
      distinctPaths: 1,
      attempts,
      failures: attempts,
      successes: 0,
      clients: 1,
      answered: 0,
    },
    blockedPercent: 0,
    statuses: [{ status: '401', count: attempts }],
    probeFamilies: [],
    routes: [{ path: '/login', count: attempts }],
    clients: [],
    userAgents: { families: ['curl'], sample: 'curl/8.1' },
    samples: [sample(T0)],
    pointers: [{ objectKey: 'AWSLogs/111111111111/objeto.log.gz', minute: iso(T0) }],
    truncated: false,
    notes: [],
    ...rest,
  });
}

/** A maior evidência que o motor pode selar. */
function longest(objectKey = 'k'.repeat(512)): WebEvidence {
  const top = Number.MAX_SAFE_INTEGER;
  const base = evidence();
  const path = `/${'a'.repeat(255)}`;
  return {
    ...base,
    client: 'f'.repeat(49),
    clientClass: 'customer_proxy',
    host: 'h'.repeat(253),
    route: path,
    routeKind: 'api_token',
    routeSemantics: 'declared',
    counters: Object.fromEntries(
      Object.keys(base.counters).map((key) => [key, top]),
    ) as WebEvidence['counters'],
    blockedPercent: 100,
    statuses: times(12, () => ({ status: '4xxxx', count: top })),
    probeFamilies: [...PROBE_FAMILIES],
    routes: times(10, () => ({ path, count: top })),
    clients: times(20, () => ({ client: 'f'.repeat(49), requests: top, count: top })),
    userAgents: { families: [...UA_FAMILIES], sample: 'u'.repeat(120) },
    samples: times(10, () => ({ ...sample(T0), method: 'OPTIONS' as const, path, bytes: top })),
    pointers: times(5, () => ({ objectKey, minute: iso(T0) })),
    truncated: true,
    notes: [...EVIDENCE_NOTES],
  };
}

describe('evidência de um achado', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (evidência)');
    tenantB = await createTenant(app, 'Cliente Demo B (evidência)');
  });

  afterAll(async () => {
    await app.close();
  });

  const now = new Date(T0);

  /** Uma detecção por atividade até `lastMs`, com a chave e a versão como o motor as faz. */
  function webDraft(
    tenantId: string,
    key: string,
    lastMs: number,
    proof: WebEvidence | undefined,
    extra: Partial<FindingDraft> = {},
  ): FindingDraft {
    const version = iso(Math.floor(lastMs / HOUR) * HOUR);
    return {
      tenantId,
      accountId: ACCOUNT,
      source: 'aws',
      sourceEventId: key,
      occurredAt: iso(lastMs),
      severity: 'medium',
      ruleId: '990405',
      ruleLevel: 7,
      title: 'Força bruta numa rota de login',
      // A fonte `alb` entra no contrato na PR-3.
      logSource: 'waf',
      eventName: 'falhas de login',
      region: REGION,
      resource: `alb:${LB}`,
      actorUser: null,
      actorType: null,
      accessKeyId: null,
      sourceIp: '198.51.100.7',
      mitreTactics: [],
      mitreTechniques: ['T1110'],
      recurrence: { lastSeenAt: version, chainKey: key, sourceEventId: `${key}@${version}` },
      ...(proof !== undefined && { evidence: proof }),
      correlation: { firstSeenAt: iso(lastMs), lastSeenAt: iso(lastMs), keys: ['web:actor:198.51.100.7'] },
      ...extra,
    };
  }

  const newKey = (): string => `aws/${ACCOUNT}/alb:${randomBytes(20).toString('hex')}`;
  const findingsOf = (key: string) =>
    prisma.finding.findMany({
      where: { chainKey: key },
      orderBy: { createdAt: 'asc' },
      include: { evidence: true },
    });
  const only = async (key: string) => {
    const found = await findingsOf(key);
    expect(found).toHaveLength(1);
    return found[0] as (typeof found)[number];
  };
  const triage = (id: string) =>
    prisma.finding.update({ where: { id }, data: { status: 'investigating', triagedAt: new Date() } });

  async function newException(value: string) {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        name: 'Analista de teste',
        email: `analista-${randomUUID()}@cliente.example`,
        role: 'analista_cliente',
        tenantId: tenantA,
        status: 'active',
      },
    });
    return prisma.alertException.create({
      data: {
        tenantId: tenantA,
        ruleId: '990405',
        field: 'ip',
        value,
        reason: 'teste',
        createdById: user.id,
      },
    });
  }

  describe('gravada com o achado', () => {
    it('achado novo: a evidência entra na mesma transação, com a versão e as datas; a correlação é aceita e não é gravada', async () => {
      const key = newKey();
      const proof = evidence();
      expect(await new FindingStore(prisma).persist(webDraft(tenantA, key, T0, proof), null, now)).toBe(
        'created',
      );
      const finding = await only(key);
      expect(finding.evidence).toMatchObject({
        tenantId: tenantA,
        version: 1,
        data: proof,
        firstSeenAt: new Date(T0 - 5 * MINUTE),
        lastSeenAt: new Date(T0),
        samplesPurgedAt: null,
      });
      expect(Object.keys(finding).filter((column) => /correlation/i.test(column))).toEqual([]);
    });

    it('achado que já nasce esperado por exceção também a tem, e a exceção conta o uso uma vez', async () => {
      const exception = await newException('198.51.100.7');
      const key = newKey();
      const store = new FindingStore(prisma);
      expect(await store.persist(webDraft(tenantA, key, T0, evidence()), exception, now)).toBe('excepted');
      const finding = await only(key);
      expect(finding).toMatchObject({ status: 'legitimate', exceptionId: exception.id });
      expect(finding.evidence).not.toBeNull();
      expect(
        (await prisma.alertException.findUniqueOrThrow({ where: { id: exception.id } })).matchedCount,
      ).toBe(1);
    });

    it('a falha ao gravar a evidência desfaz o achado e o aviso, e a releitura grava tudo', async () => {
      const key = newKey();
      const draft = webDraft(tenantA, key, T0, evidence(), { severity: 'high', ruleLevel: 10 });
      let reached = 0;
      const failing = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property !== '$transaction') return Reflect.get(target, property, receiver) as unknown;
          return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            target.$transaction((tx) =>
              work(
                new Proxy(tx, {
                  get(inner, name, self) {
                    const value: unknown = Reflect.get(inner, name, self);
                    if (name !== '$executeRaw' || typeof value !== 'function') return value;
                    return (strings: TemplateStringsArray, ...values: unknown[]) => {
                      if (strings.join('').includes('"FindingEvidence"')) {
                        reached += 1;
                        throw new Error('banco fora do ar');
                      }
                      return (value as (...args: unknown[]) => unknown).call(inner, strings, ...values);
                    };
                  },
                }),
              ),
            );
        },
      });
      await expect(new FindingStore(failing).persist(draft, null, now)).rejects.toThrow('banco fora do ar');
      expect(reached).toBe(1);
      expect(await findingsOf(key)).toEqual([]);
      expect(await new FindingStore(prisma).persist(draft, null, now)).toBe('created');
      const finding = await only(key);
      expect(finding.evidence).not.toBeNull();
      expect(await prisma.notification.count({ where: { findingId: finding.id } })).toBe(1);
    });

    it('evidência fora do schema ou do teto é recusada, com aviso a quem chamou; o achado entra sem ela', async () => {
      const refused: string[] = [];
      const store = new FindingStore(prisma, new AlertNotices(), {
        onEvidenceRefused: (ruleId) => refused.push(ruleId),
      });
      const bad: WebEvidence[] = [
        { ...evidence(), host: 'a b' },
        { ...evidence(), query: 'senha=1' } as WebEvidence,
        { ...evidence(), samples: [{ ...sample(T0), path: '/login?senha=1' }] },
        { ...evidence(), version: 2 } as unknown as WebEvidence,
        // Uma chave só de aspas dobra de tamanho no JSON: passa no schema, e não no teto.
        longest('"'.repeat(512)),
      ];
      expect(webEvidenceSchema.safeParse(bad[4]).success).toBe(true);
      expect(evidenceBytes(bad[4])).toBeGreaterThan(MAX_EVIDENCE_BYTES);
      for (const proof of bad) {
        const key = newKey();
        expect(await store.persist(webDraft(tenantA, key, T0, proof), null, now)).toBe('created');
        expect((await only(key)).evidence).toBeNull();
      }
      expect(refused).toEqual(bad.map(() => '990405'));
    });

    it('datas trocadas na evidência não derrubam o achado: a última atividade nunca é antes da primeira', async () => {
      const key = newKey();
      const proof = evidence({ firstSeenAt: iso(T0), lastSeenAt: iso(T0 - MINUTE) });
      expect(await new FindingStore(prisma).persist(webDraft(tenantA, key, T0, proof), null, now)).toBe(
        'created',
      );
      expect((await only(key)).evidence).toMatchObject({
        firstSeenAt: new Date(T0),
        lastSeenAt: new Date(T0),
      });
    });

    it('a maior evidência possível cabe no teto do banco, e o tamanho contado é o que o banco mede', async () => {
      const key = newKey();
      const proof = longest();
      expect(await new FindingStore(prisma).persist(webDraft(tenantA, key, T0, proof), null, now)).toBe(
        'created',
      );
      const finding = await only(key);
      expect(finding.evidence?.data).toEqual(proof);
      const [row] = await prisma.$queryRaw<{ bytes: number }[]>`
        SELECT octet_length("data"::text) AS bytes FROM "FindingEvidence" WHERE "findingId" = ${finding.id}::uuid`;
      expect(row?.bytes).toBe(evidenceBytes(proof));
      expect(row?.bytes).toBeGreaterThan(14_000);
      expect(row?.bytes).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
    });

    it('o achado de outro cliente com a mesma chave não é visto, nem a evidência dele tocada', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(webDraft(tenantB, key, T0, evidence()), null, now);
      const before = await only(key);
      const newer = evidence({ lastSeenAt: iso(T0 + MINUTE), attempts: 900 });
      expect(await store.persist(webDraft(tenantA, key, T0 + MINUTE, newer), null, now)).toBe('duplicate');
      expect(await store.persist(webDraft(tenantA, key, T0 + HOUR, newer), null, now)).toBe('duplicate');
      expect(await only(key)).toEqual(before);
      expect(await prisma.findingEvidence.count({ where: { findingId: before.id } })).toBe(1);
    });

    it('duas gravações ao mesmo tempo: uma linha só, com a atividade mais nova', async () => {
      const store = new FindingStore(prisma);
      for (let round = 0; round < 3; round += 1) {
        const key = newKey();
        const lasts = [T0, T0 + MINUTE, T0 + 2 * MINUTE, T0 + 3 * MINUTE];
        await Promise.all(
          lasts.map((last, i) =>
            store.persist(
              webDraft(tenantA, key, last, evidence({ lastSeenAt: iso(last), attempts: 20 + i })),
              null,
              now,
            ),
          ),
        );
        const finding = await only(key);
        expect(finding.evidence?.lastSeenAt).toEqual(new Date(T0 + 3 * MINUTE));
        expect(finding.evidence?.data).toMatchObject({ counters: { attempts: 23 } });
      }
    });
  });

  describe('atividade nova (recorrência)', () => {
    it('não triado, na mesma hora: a evidência acompanha, o achado não muda', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(webDraft(tenantA, key, T0, evidence()), null, now);
      const before = await only(key);
      const newer = evidence({
        firstSeenAt: iso(T0 + 5 * MINUTE),
        lastSeenAt: iso(T0 + 10 * MINUTE),
        attempts: 5_000,
      });
      const draft = webDraft(tenantA, key, T0 + 10 * MINUTE, newer, { eventName: 'outro texto' });
      expect(await store.persist(draft, null, now)).toBe('duplicate');
      const after = await only(key);
      expect(after.evidence).toMatchObject({
        data: newer,
        // A primeira atividade é a do achado.
        firstSeenAt: new Date(T0 - 5 * MINUTE),
        lastSeenAt: new Date(T0 + 10 * MINUTE),
      });
      const strip = ({ evidence: _, ...row }: typeof after) => row;
      expect(strip(after)).toEqual(strip(before));
    });

    it('reavaliar a mesma coisa não grava; no mesmo instante, só a contagem maior; a mais antiga nunca', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      const save = (proof: WebEvidence, last = T0) =>
        store.persist(webDraft(tenantA, key, last, proof), null, now);
      await save(evidence({ attempts: 100 }));
      const first = (await only(key)).evidence;
      await save(evidence({ attempts: 100 }));
      await save(evidence({ attempts: 99 }));
      // O objeto atrasado, avaliado sozinho: atividade mais antiga, e a primeira atividade também não recua.
      await save(
        evidence({
          firstSeenAt: iso(T0 - HOUR),
          lastSeenAt: iso(T0 - MINUTE),
          attempts: 9_000,
        }),
      );
      expect((await only(key)).evidence).toEqual(first);
      // O arquivo de outro nó do balanceador, com o mesmo último horário.
      await save(evidence({ attempts: 101 }));
      expect((await only(key)).evidence).toMatchObject({ data: { counters: { attempts: 101 } } });
      // Toda contagem entra na comparação: a 990403 não tem tentativas, só respostas.
      const { counters } = evidence({ attempts: 101 });
      for (const name of Object.keys(counters) as (keyof typeof counters)[]) {
        const held = ((await only(key)).evidence?.data as unknown as WebEvidence).counters;
        await save({ ...evidence(), counters: { ...held, [name]: held[name] + 1 } });
        expect((await only(key)).evidence?.data, name).toMatchObject({
          counters: { ...held, [name]: held[name] + 1 },
        });
      }
    });

    it('a evidência guardada por outra versão do nó não derruba a gravação: só a atividade mais nova a troca', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(webDraft(tenantA, key, T0, evidence()), null, now);
      const { id } = await only(key);
      const future = { version: 2, counters: { total: 'muitos' } };
      await prisma.findingEvidence.updateMany({
        where: { findingId: id },
        data: { version: 2, data: future },
      });
      await store.persist(webDraft(tenantA, key, T0, evidence({ attempts: 9_000 })), null, now);
      expect((await only(key)).evidence).toMatchObject({ version: 2, data: future });
      const newer = evidence({ lastSeenAt: iso(T0 + MINUTE) });
      await store.persist(webDraft(tenantA, key, T0 + MINUTE, newer), null, now);
      expect((await only(key)).evidence).toMatchObject({ version: 1, data: newer });
    });

    it('não triado, em outra hora: avança o achado e a evidência', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(webDraft(tenantA, key, T0, evidence()), null, now);
      const last = T0 + 2 * HOUR + MINUTE;
      const newer = evidence({ firstSeenAt: iso(last - MINUTE), lastSeenAt: iso(last), attempts: 30 });
      expect(await store.persist(webDraft(tenantA, key, last, newer), null, now)).toBe('duplicate');
      const after = await only(key);
      expect(after.lastSeenAt).toEqual(new Date(T0 + 2 * HOUR));
      expect(after.evidence).toMatchObject({ data: newer, firstSeenAt: new Date(T0 - 5 * MINUTE) });
      // A versão mais antiga (o objeto atrasado de uma hora anterior) não mexe em nada, nem com evidência mais nova.
      const late = evidence({ lastSeenAt: iso(last + HOUR), attempts: 99_999 });
      await store.persist(webDraft(tenantA, key, T0 + HOUR, late), null, now);
      expect(await only(key)).toEqual(after);
    });

    it('achado de antes da versão (sem lastSeenAt): vira a base e ganha a evidência', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(webDraft(tenantA, key, T0, undefined), null, now);
      const { id } = await only(key);
      await prisma.finding.update({ where: { id }, data: { lastSeenAt: null } });
      await store.persist(webDraft(tenantA, key, T0, evidence()), null, now);
      expect(await only(key)).toMatchObject({ lastSeenAt: new Date(T0), evidence: { version: 1 } });
      // O mesmo, já triado: a versão vira a base, e a evidência não entra.
      const triaged = newKey();
      await store.persist(webDraft(tenantA, triaged, T0, undefined), null, now);
      const other = await only(triaged);
      await prisma.finding.update({
        where: { id: other.id },
        data: { lastSeenAt: null, status: 'resolved', triagedAt: new Date() },
      });
      await store.persist(webDraft(tenantA, triaged, T0, evidence()), null, now);
      expect(await only(triaged)).toMatchObject({ lastSeenAt: new Date(T0), evidence: null });
    });

    it('triado: a evidência do achado fica como a pessoa a viu; a atividade de outra hora é outro achado, com a dela', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(webDraft(tenantA, key, T0, evidence()), null, now);
      const original = await only(key);
      await triage(original.id);
      const sameHour = evidence({ lastSeenAt: iso(T0 + 10 * MINUTE), attempts: 800 });
      expect(await store.persist(webDraft(tenantA, key, T0 + 10 * MINUTE, sameHour), null, now)).toBe(
        'duplicate',
      );
      expect((await only(key)).evidence).toEqual(original.evidence);

      const last = T0 + HOUR + MINUTE;
      const next = evidence({ firstSeenAt: iso(last), lastSeenAt: iso(last), attempts: 40 });
      expect(await store.persist(webDraft(tenantA, key, last, next), null, now)).toBe('created');
      const [kept, recurrence] = await findingsOf(key);
      expect(kept?.evidence).toEqual(original.evidence);
      expect(recurrence).toMatchObject({ recurrenceOfId: original.id, status: 'new' });
      expect(recurrence?.evidence).toMatchObject({ data: next, firstSeenAt: new Date(last) });

      // Na mesma hora da recorrência, quem acompanha é ela.
      const more = evidence({ firstSeenAt: iso(last), lastSeenAt: iso(last + MINUTE), attempts: 41 });
      await store.persist(webDraft(tenantA, key, last + MINUTE, more), null, now);
      const chain = await findingsOf(key);
      expect(chain).toHaveLength(2);
      expect(chain[0]?.evidence).toEqual(original.evidence);
      expect(chain[1]?.evidence).toMatchObject({ data: more });
    });

    it('amostras já expurgadas: a atividade nova traz amostras novas, com o prazo delas', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(webDraft(tenantA, key, T0, evidence()), null, now);
      const { id } = await only(key);
      await prisma.findingEvidence.updateMany({
        where: { findingId: id },
        data: { samplesPurgedAt: new Date() },
      });
      const same = evidence();
      await store.persist(webDraft(tenantA, key, T0, same), null, now);
      expect((await only(key)).evidence?.samplesPurgedAt).not.toBeNull();
      const newer = evidence({ lastSeenAt: iso(T0 + MINUTE) });
      await store.persist(webDraft(tenantA, key, T0 + MINUTE, newer), null, now);
      expect((await only(key)).evidence).toMatchObject({ samplesPurgedAt: null, data: newer });
    });
  });

  describe('resumo do dia (revisão)', () => {
    const digestDraft = (tenantId: string, key: string, lastMs: number, attempts: number, name: string) =>
      webDraft(
        tenantId,
        key,
        lastMs,
        evidence({ ruleId: '990400', client: null, lastSeenAt: iso(lastMs), attempts }),
        {
          ruleId: '990400',
          severity: 'low',
          ruleLevel: 4,
          eventName: name,
          recurrence: undefined,
          revision: { lastSeenAt: iso(lastMs) },
        },
      );
    const read = (key: string) =>
      prisma.finding.findFirstOrThrow({ where: { sourceEventId: key }, include: { evidence: true } });

    it('a versão mais nova troca o texto e a evidência; a mesma, só se cresceu; a antiga, nada', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(digestDraft(tenantA, key, T0, 10, 'dez'), null, now);
      expect(await read(key)).toMatchObject({ eventName: 'dez', evidence: { lastSeenAt: new Date(T0) } });

      await store.persist(digestDraft(tenantA, key, T0 + MINUTE, 30, 'trinta'), null, now);
      const revised = await read(key);
      expect(revised).toMatchObject({
        eventName: 'trinta',
        lastSeenAt: new Date(T0 + MINUTE),
        evidence: { data: { counters: { attempts: 30 } } },
      });

      // A mesma versão, igual ou menor: nem o updatedAt muda.
      for (const attempts of [30, 29]) {
        await store.persist(digestDraft(tenantA, key, T0 + MINUTE, attempts, 'não entra'), null, now);
        expect(await read(key)).toEqual(revised);
      }
      await store.persist(digestDraft(tenantA, key, T0, 900, 'antiga'), null, now);
      expect(await read(key)).toEqual(revised);
      // Nem com uma evidência que se diz mais nova que a versão dela.
      const mixed = digestDraft(tenantA, key, T0, 900, 'antiga');
      await store.persist(
        { ...mixed, evidence: evidence({ lastSeenAt: iso(T0 + HOUR), attempts: 900 }) },
        null,
        now,
      );
      expect(await read(key)).toEqual(revised);

      await store.persist(digestDraft(tenantA, key, T0 + MINUTE, 31, 'trinta e um'), null, now);
      expect(await read(key)).toMatchObject({
        eventName: 'trinta e um',
        lastSeenAt: new Date(T0 + MINUTE),
        evidence: { data: { counters: { attempts: 31 } } },
      });
    });

    it('também no triado: é o mesmo resumo, que segue o dia; um achado só', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(digestDraft(tenantA, key, T0, 10, 'dez'), null, now);
      await triage((await read(key)).id);
      await store.persist(digestDraft(tenantA, key, T0 + MINUTE, 30, 'trinta'), null, now);
      expect(await read(key)).toMatchObject({
        status: 'investigating',
        eventName: 'trinta',
        evidence: { data: { counters: { attempts: 30 } } },
      });
      expect(await prisma.finding.count({ where: { sourceEventId: key } })).toBe(1);
    });

    it('o texto é cortado no tamanho da coluna, e o vazio vira null', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      await store.persist(digestDraft(tenantA, key, T0, 10, 'dez'), null, now);
      await store.persist(digestDraft(tenantA, key, T0 + MINUTE, 11, 'x'.repeat(300)), null, now);
      expect((await read(key)).eventName).toBe('x'.repeat(256));
      const none = { ...digestDraft(tenantA, key, T0 + 2 * MINUTE, 12, ''), eventName: null };
      await store.persist(none, null, now);
      expect((await read(key)).eventName).toBeNull();
    });

    it('sem evidência (Security Hub, Inspector, Access Analyzer), a revisão não mexe no texto, como sempre', async () => {
      const key = newKey();
      const store = new FindingStore(prisma);
      const draft = (lastMs: number, name: string): FindingDraft => {
        const { evidence: _, correlation: __, ...rest } = digestDraft(tenantA, key, lastMs, 1, name);
        return rest;
      };
      await store.persist(draft(T0, 'primeiro'), null, now);
      await store.persist(draft(T0 + MINUTE, 'segundo'), null, now);
      expect(await read(key)).toMatchObject({
        eventName: 'primeiro',
        lastSeenAt: new Date(T0 + MINUTE),
        evidence: null,
      });
      // Na mesma versão, nem com texto novo.
      const before = await read(key);
      await store.persist(draft(T0 + MINUTE, 'terceiro'), null, now);
      expect(await read(key)).toEqual(before);
    });
  });

  describe('com os achados do motor de verdade', () => {
    const login = (status: number): LineSpec => ({
      client: '198.51.100.9',
      method: 'POST',
      path: '/login?usuario=ana&senha=segredo',
      status,
    });
    /** A fonte `alb` entra no contrato na PR-3; até lá, o achado do teste usa uma que existe. */
    const asDraft = (draft: WebFindingDraft): FindingDraft => ({ ...draft, logSource: 'waf' });

    it('gravados, lidos pela rota e iguais ao que o motor selou; a escalada é outro achado; nenhum byte de query', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo (motor)');
      const { cookie } = await createSignedInUser(app, { role: 'leitura', tenantId });
      const harness = new Harness({
        source: { tenantId, accountId: ACCOUNT, region: REGION, loadBalancer: LB },
      });
      const store = new FindingStore(prisma);
      const persistAll = async (at: number) => {
        for (const draft of harness.evaluate(at).drafts) {
          if (draft.ruleId === '990405') await store.persist(asDraft(draft), null, new Date(at));
        }
      };
      harness.feed(times(20, () => login(401)));
      await persistAll(T0 + MINUTE);
      const [first] = await prisma.finding.findMany({ where: { tenantId }, include: { evidence: true } });
      expect(first).toMatchObject({ ruleLevel: 7, evidence: { version: 1 } });
      // Reavaliar não muda nada.
      await persistAll(T0 + 2 * MINUTE);
      expect(await prisma.finding.findMany({ where: { tenantId }, include: { evidence: true } })).toEqual([
        first,
      ]);
      // Mais 100 falhas: nível 10, outro achado, com evidência própria; o primeiro fica como está.
      harness.feed(
        times(100, () => login(401)),
        T0 + SLOT,
        T0 + SLOT + MINUTE,
      );
      await persistAll(T0 + SLOT + 2 * MINUTE);
      const all = await prisma.finding.findMany({
        where: { tenantId },
        orderBy: { ruleLevel: 'asc' },
        include: { evidence: true },
      });
      expect(all.map((finding) => finding.ruleLevel)).toEqual([7, 10]);
      expect(all[0]).toEqual(first);
      expect(all[1]?.evidence?.data).toMatchObject({ counters: { failures: 120 } });
      for (const finding of all) {
        const response = await request(app.getHttpServer())
          .get(`/v1/findings/${finding.id}/evidence`)
          .set('Cookie', cookie)
          .expect(200);
        const body = findingEvidenceSchema.parse(response.body);
        expect(body).toEqual({ evidence: finding.evidence?.data, samplesPurgedAt: null });
        for (const trace of ['senha', 'segredo', 'ana', '?']) expect(response.text).not.toContain(trace);
      }
    });

    it('o maior resumo do dia possível cabe no estado do motor e volta igual', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo (estado)');
      const { sourceId } = await newSource(tenantId);
      const top = Number.MAX_SAFE_INTEGER;
      const net = (i: number) =>
        `2001:db8:${(i >> 8).toString(16)}${'f'.repeat(2)}:${(0xf000 + (i & 0xff)).toString(16)}::/64`;
      const client = {
        requests: top,
        tool: top,
        probes: top,
        errors: top,
        families: top,
        firstMs: top,
        lastMs: top,
      };
      const day = Math.floor(T0 / 86_400_000);
      const state = {
        version: 1 as const,
        settledThrough: Math.floor(T0 / SLOT),
        days: times(3, (d) => ({
          day: day - d,
          clients: times(2_000, (i) => [net(i), client] as [string, typeof client]),
          dropped: top,
        })),
        tracks: times(
          4_000,
          (i) =>
            [net(i), { slots: times(3, () => Math.floor(T0 / SLOT)), seriousMs: T0, targetedMs: T0 }] as [
              string,
              { slots: number[]; seriousMs: number; targetedMs: number },
            ],
        ),
      };
      await prisma.webEngineState.create({
        data: { tenantId, sourceId, loadBalancer: LB, version: state.version, state },
      });
      const row = await prisma.webEngineState.findFirstOrThrow({ where: { tenantId } });
      const harness = new Harness();
      harness.engine.restore(row.state);
      const restored = harness.engine.snapshot();
      expect(restored.days).toHaveLength(3);
      expect(restored.days[0]?.clients).toHaveLength(2_000);
      expect(restored.tracks).toHaveLength(4_000);
      const [size] = await prisma.$queryRaw<{ bytes: number }[]>`
        SELECT octet_length("state"::text) AS bytes FROM "WebEngineState" WHERE "tenantId" = ${tenantId}::uuid`;
      // Folga: menos da metade dos 4 MiB.
      expect(size?.bytes).toBeGreaterThan(1_000_000);
      expect(size?.bytes).toBeLessThan(2 * 1024 * 1024);
    });
  });

  async function newSource(tenantId: string): Promise<{ cloudAccountId: string; sourceId: string }> {
    const account = await prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: String(100_000_000_000 + Math.floor(Math.random() * 8e11)),
        regions: [REGION],
      },
    });
    const source = await prisma.awsSource.create({
      data: {
        tenantId,
        cloudAccountId: account.id,
        kind: 'elb_logs',
        region: REGION,
        resourceId: 'loja',
        name: 'loja',
        method: 's3',
        availability: 'available',
        state: 'available',
      },
    });
    return { cloudAccountId: account.id, sourceId: source.id };
  }

  describe('rota GET /v1/findings/:id/evidence', () => {
    let cookieA: string;
    let cookieB: string;

    beforeAll(async () => {
      cookieA = (await createSignedInUser(app, { role: 'leitura', tenantId: tenantA })).cookie;
      cookieB = (await createSignedInUser(app, { role: 'analista_cliente', tenantId: tenantB })).cookie;
    });

    const get = (path: string, cookie = cookieA) => {
      const call = request(app.getHttpServer()).get(path);
      return cookie === '' ? call : call.set('Cookie', cookie);
    };
    const created = async (proof: WebEvidence | undefined, tenantId = tenantA) => {
      const key = newKey();
      await new FindingStore(prisma).persist(webDraft(tenantId, key, T0, proof), null, now);
      return only(key);
    };

    it('devolve a evidência no contrato, com a primeira atividade do achado inteiro e o expurgo das amostras', async () => {
      const finding = await created(evidence());
      const newer = evidence({ firstSeenAt: iso(T0 + MINUTE), lastSeenAt: iso(T0 + 2 * MINUTE) });
      await new FindingStore(prisma).persist(
        webDraft(tenantA, finding.sourceEventId, T0 + 2 * MINUTE, newer),
        null,
        now,
      );
      const read = async () =>
        findingEvidenceSchema.parse((await get(`/v1/findings/${finding.id}/evidence`).expect(200)).body);
      expect(await read()).toEqual({
        evidence: { ...newer, firstSeenAt: iso(T0 - 5 * MINUTE) },
        samplesPurgedAt: null,
      });
      const purgedAt = new Date('2026-12-30T04:00:00.000Z');
      await prisma.findingEvidence.updateMany({
        where: { findingId: finding.id },
        data: { samplesPurgedAt: purgedAt },
      });
      expect((await read()).samplesPurgedAt).toBe(purgedAt.toISOString());
    });

    it('sem evidência, 200 com null; achado que não existe ou de outro cliente, 404; sem sessão, 401; id inválido, 400', async () => {
      const bare = await created(undefined);
      expect((await get(`/v1/findings/${bare.id}/evidence`).expect(200)).body).toEqual({
        evidence: null,
        samplesPurgedAt: null,
      });
      const finding = await created(evidence());
      const path = `/v1/findings/${finding.id}/evidence`;
      const denied = await get(path, cookieB).expect(404);
      expect(denied.text).not.toContain('198.51.100.7');
      await get(`/v1/findings/${randomUUID()}/evidence`).expect(404);
      await get(path, '').expect(401);
      await get('/v1/findings/nao-e-um-id/evidence').expect(400);
      await get(path).expect(200);
    });

    it('o que está no banco fora do formato desta versão não vai para a tela, e o detalhe segue', async () => {
      const finding = await created(evidence());
      for (const data of [
        { ...evidence(), version: 2, novo: true },
        { ...evidence(), samples: [{ ...sample(T0), path: '/login?senha=1' }] },
        { version: 1 },
      ]) {
        await prisma.findingEvidence.updateMany({
          where: { findingId: finding.id },
          data: { data, version: data.version },
        });
        expect((await get(`/v1/findings/${finding.id}/evidence`).expect(200)).body).toEqual({
          evidence: null,
          samplesPurgedAt: null,
        });
      }
      await get(`/v1/findings/${finding.id}`).expect(200);
    });

    it('a lista e o detalhe não mudam: nenhum campo novo, que um painel de antes recusaria', async () => {
      const finding = await created(evidence());
      const detail = (await get(`/v1/findings/${finding.id}`).expect(200)).body as object;
      expect(findingDetailSchema.parse(detail)).toMatchObject({ id: finding.id, rawEvent: null });
      expect(Object.keys(detail)).not.toContain('evidence');
      // O contrato é estrito: com o campo, o painel de antes perderia a tela inteira.
      expect(findingDetailSchema.safeParse({ ...detail, evidence: null }).success).toBe(false);
    });

    it('tudo o que o motor sela passa no contrato do painel, e os dois têm os mesmos campos e teto', () => {
      for (const proof of [evidence(), longest(), sealEvidence(longest())]) {
        expect(findingWebEvidenceSchema.parse(proof)).toEqual(proof);
      }
      expect(Object.keys(findingWebEvidenceSchema.shape).sort()).toEqual(
        Object.keys(webEvidenceSchema.shape).sort(),
      );
      expect(MAX_FINDING_EVIDENCE_BYTES).toBe(MAX_EVIDENCE_BYTES);
    });
  });

  describe('isolamento entre clientes', () => {
    it('no escopo do cliente, o que só o sistema grava é só leitura, e só do próprio cliente', async () => {
      const key = newKey();
      await new FindingStore(prisma).persist(webDraft(tenantB, key, T0, evidence()), null, now);
      const finding = await only(key);
      const { cloudAccountId, sourceId } = await newSource(tenantB);
      const common = { tenantId: tenantB, sourceId };
      const counters = { requests: 1n, blocked: 0n, clientErrors: 0n, serverErrors: 0n, flagged: 0n };
      await prisma.webLogObject.create({
        data: { ...common, cloudAccountId, objectHash: 'a'.repeat(64), status: 'read', slotStart: now },
      });
      await prisma.webEngineState.create({
        data: { ...common, loadBalancer: LB, version: 1, state: { version: 1 } },
      });
      const traffic = { country: 'BR', clientClass: 'direct', ...counters };
      await prisma.webTrafficSlot.create({ data: { ...common, slotStart: now, ...traffic } });
      await prisma.webTrafficHour.create({ data: { ...common, hourStart: now, ...traffic } });

      const a = prisma.forTenant(tenantA);
      const b = prisma.forTenant(tenantB);
      const reads = (db: Prisma.TransactionClient) => [
        db.findingEvidence.count({ where: { findingId: finding.id } }),
        db.webLogObject.count({ where: { sourceId } }),
        db.webEngineState.count({ where: { sourceId } }),
        db.webTrafficSlot.count({ where: { sourceId } }),
        db.webTrafficHour.count({ where: { sourceId } }),
        // Nem pedindo o cliente do lado.
        db.webTrafficSlot.count({ where: { sourceId, tenantId: tenantB } }),
      ];
      expect(await Promise.all(reads(a))).toEqual([0, 0, 0, 0, 0, 0]);
      expect(await Promise.all(reads(b))).toEqual([1, 1, 1, 1, 1, 1]);

      for (const model of [
        'findingEvidence',
        'webLogObject',
        'webEngineState',
        'webTrafficSlot',
        'webTrafficHour',
      ] as const) {
        expect(SYSTEM_WRITTEN_MODELS).toContain(model);
        const delegate = b[model] as unknown as Record<string, (args: object) => unknown>;
        for (const operation of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'deleteMany']) {
          expect(() => delegate[operation]?.({ where: {}, data: {} }), `${model}.${operation}`).toThrow(
            TenantScopeViolation,
          );
        }
      }
    });

    it('a configuração: A não lê, não muda, não apaga e não cria nada em B, nem apontando para a fonte dele', async () => {
      const { sourceId: sourceA } = await newSource(tenantA);
      const { sourceId: sourceB } = await newSource(tenantB);
      const a = prisma.forTenant(tenantA);
      const b = prisma.forTenant(tenantB);
      const trusted = {
        cidr: '198.51.100.0/24',
        kind: 'office',
        reason: 'teste',
        expiresAt: new Date(Date.now() + 86_400_000),
      };
      const route = { path: '/entrar', kind: 'login' };
      // O cliente vem do escopo, e o `tenantId` do dado é conferido.
      const settingsB = await b.webSourceSettings.create({ data: { sourceId: sourceB, tenantId: tenantB } });
      const trustedB = await b.webTrustedSource.create({
        data: { ...trusted, tenantId: tenantB, sourceId: sourceB },
      });
      const routeB = await b.webRoute.create({ data: { ...route, tenantId: tenantB, sourceId: sourceB } });
      expect(settingsB).toMatchObject({ tenantId: tenantB, mode: 'observe', thresholdMultiplier: 1 });

      expect(await a.webSourceSettings.findMany({ where: { sourceId: sourceB } })).toEqual([]);
      expect(await a.webTrustedSource.findUnique({ where: { id: trustedB.id } })).toBeNull();
      expect(await a.webRoute.findUnique({ where: { id: routeB.id } })).toBeNull();
      expect(
        (await a.webSourceSettings.updateMany({ where: { sourceId: sourceB }, data: { mode: 'alert' } }))
          .count,
      ).toBe(0);
      expect(
        (await a.webTrustedSource.updateMany({ where: { id: trustedB.id }, data: { reason: 'x' } })).count,
      ).toBe(0);
      await expect(
        a.webRoute.update({ where: { id: routeB.id }, data: { kind: 'ignore' } }),
      ).rejects.toThrow();
      expect((await a.webRoute.deleteMany({ where: { id: routeB.id } })).count).toBe(0);
      expect((await a.webTrustedSource.deleteMany({})).count).toBe(0);
      expect((await a.webSourceSettings.deleteMany({ where: { sourceId: sourceB } })).count).toBe(0);
      expect(() => a.webRoute.update({ where: { id: routeB.id }, data: { tenantId: tenantB } })).toThrow(
        TenantScopeViolation,
      );

      // A linha de A na fonte de B: o banco recusa.
      const crossed = { sourceId: sourceB, tenantId: tenantA };
      await expect(a.webSourceSettings.create({ data: crossed })).rejects.toThrow();
      await expect(a.webTrustedSource.create({ data: { ...trusted, ...crossed } })).rejects.toThrow();
      await expect(a.webRoute.create({ data: { ...route, ...crossed } })).rejects.toThrow();
      expect(() => a.webRoute.create({ data: { ...route, sourceId: sourceB, tenantId: tenantB } })).toThrow(
        TenantScopeViolation,
      );

      expect(await prisma.webSourceSettings.findFirstOrThrow({ where: { sourceId: sourceB } })).toEqual(
        settingsB,
      );
      expect(await prisma.webTrustedSource.findUniqueOrThrow({ where: { id: trustedB.id } })).toEqual(
        trustedB,
      );
      expect(await prisma.webRoute.findUniqueOrThrow({ where: { id: routeB.id } })).toEqual(routeB);
      // E A grava no que é dele.
      await a.webSourceSettings.create({ data: { sourceId: sourceA, tenantId: tenantA, mode: 'alert' } });
      await a.webTrustedSource.create({ data: { ...trusted, tenantId: tenantA, sourceId: null } });
    });

    it('só estes arquivos gravam as tabelas do sistema', () => {
      const src = fileURLToPath(new URL('../src', import.meta.url));
      const files = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) return entry.name === 'generated' ? [] : files(path);
          return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
        });
      const operation = /(\w+)\s*\.\s*(?:create|update|upsert|delete)(?:Many)?(?:AndReturn)?\s*\(/g;
      const command = /(?:INSERT INTO|UPDATE|DELETE FROM)\s+"(\w+)"/g;
      const writers = (model: string): string[] => {
        const table = model.charAt(0).toUpperCase() + model.slice(1);
        return files(src)
          .filter((file) => {
            const text = readFileSync(file, 'utf8');
            return (
              [...text.matchAll(operation)].some(([, name]) => name === model) ||
              [...text.matchAll(command)].some(([, name]) => name === table)
            );
          })
          .map((file) => relative(src, file).split(sep).join('/'))
          .sort();
      };
      expect({
        findingEvidence: writers('findingEvidence'),
        webLogObject: writers('webLogObject'),
        webEngineState: writers('webEngineState'),
        webTrafficSlot: writers('webTrafficSlot'),
        webTrafficHour: writers('webTrafficHour'),
      }).toEqual({
        findingEvidence: ['alerts/finding-evidence.ts', 'retention/retention-job.ts'],
        webLogObject: ['retention/retention-job.ts', 'weblogs/store/web-object-ledger.ts'],
        webEngineState: ['retention/retention-job.ts'],
        webTrafficSlot: ['weblogs/store/web-traffic-store.ts'],
        webTrafficHour: ['weblogs/store/web-traffic-store.ts'],
      });
    });
  });

  describe('os coletores de sempre', () => {
    /** Cliente com o registro das consultas, na ordem: `<verbo> <tabela>`. */
    function logged() {
      const statements: string[] = [];
      const client = new PrismaClient({
        adapter: new PrismaPg({ connectionString: inject('testDatabaseUrl'), max: 1 }),
        log: [{ emit: 'event', level: 'query' }],
      });
      client.$on('query', ({ query }) => {
        const table = /(?:FROM|INTO|UPDATE) (?:"public"\.)?"(\w+)"/.exec(query)?.[1];
        const [verb] = query.trim().split(/\s+/);
        statements.push(query.includes('pg_advisory') ? 'lock' : [verb, table].filter(Boolean).join(' '));
      });
      return {
        client,
        store: new FindingStore(client as unknown as PrismaService),
        take: () => statements.splice(0),
      };
    }

    const created = ['lock', 'INSERT Finding', 'SELECT Finding', 'INSERT Notification', 'COMMIT'];

    it('sem evidência, cada caminho faz as mesmas consultas de antes, na mesma ordem, e nenhuma na tabela nova', async () => {
      const { client, store, take } = logged();
      try {
        const key = newKey();
        const { correlation: _, ...plain } = webDraft(tenantA, key, T0, undefined, { severity: 'high' });
        const at = (lastMs: number): FindingDraft => ({
          ...plain,
          recurrence: {
            lastSeenAt: iso(lastMs),
            chainKey: key,
            sourceEventId: `${key}@${iso(lastMs)}`,
          },
        });
        await store.persist(plain, null, now);
        expect(take()).toEqual(created);
        const lookup = ['lock', 'INSERT Finding', 'SELECT Finding', 'SELECT Finding'];
        // A mesma versão, a antiga e a nova, num achado ainda não triado.
        await store.persist(plain, null, now);
        expect(take()).toEqual([...lookup, 'COMMIT']);
        await store.persist(at(T0 - HOUR), null, now);
        expect(take()).toEqual([...lookup, 'COMMIT']);
        await store.persist(at(T0 + HOUR), null, now);
        expect(take()).toEqual([...lookup, 'UPDATE Finding', 'COMMIT']);
        // Triado, com versão nova: a recorrência.
        await triage((await only(key)).id);
        await store.persist(at(T0 + 2 * HOUR), null, now);
        expect(take()).toEqual([
          ...lookup,
          'INSERT Finding',
          'SELECT Finding',
          'INSERT Notification',
          'COMMIT',
        ]);

        // Achado de estado: novo, repetido e revisto com severidade que sobe.
        const state = newKey();
        const { recurrence: __, ...base } = { ...plain, sourceEventId: state, severity: 'low' as const };
        const revision = (lastMs: number, severity: FindingDraft['severity']): FindingDraft => ({
          ...base,
          severity,
          revision: { lastSeenAt: iso(lastMs) },
        });
        await store.persist(revision(T0, 'low'), null, now);
        expect(take()).toEqual(created.filter((step) => step !== 'INSERT Notification'));
        await store.persist(revision(T0, 'low'), null, now);
        expect(take()).toEqual(['lock', 'INSERT Finding', 'SELECT Finding', 'COMMIT']);
        await store.persist(revision(T0 + MINUTE, 'critical'), null, now);
        expect(take()).toEqual([
          'lock',
          'INSERT Finding',
          'SELECT Finding',
          'UPDATE Finding',
          'INSERT Notification',
          'COMMIT',
        ]);

        // Esperado por exceção: só o uso dela.
        const exception = await newException('198.51.100.8');
        const { recurrence: ____, ...expected } = { ...plain, sourceEventId: newKey() };
        expect(await store.persist(expected, exception, now)).toBe('excepted');
        expect(take()).toEqual(['lock', 'INSERT Finding', 'UPDATE AlertException', 'COMMIT']);

        // Sem versão: novo e duplicado.
        const { recurrence: ___, ...simple } = { ...plain, sourceEventId: newKey() };
        await store.persist(simple, null, now);
        expect(take()).toEqual(created);
        await store.persist(simple, null, now);
        expect(take()).toEqual(['lock', 'INSERT Finding', 'COMMIT']);
      } finally {
        await client.$disconnect();
      }
    });

    it('com evidência, uma consulta a mais, e só ela', async () => {
      const { client, store, take } = logged();
      try {
        const key = newKey();
        await store.persist(webDraft(tenantA, key, T0, evidence(), { severity: 'high' }), null, now);
        expect(take()).toEqual([...created.slice(0, -1), 'INSERT FindingEvidence', 'COMMIT']);
        await store.persist(webDraft(tenantA, key, T0, evidence()), null, now);
        expect(take()).toEqual([
          'lock',
          'INSERT Finding',
          'SELECT Finding',
          'SELECT Finding',
          'INSERT FindingEvidence',
          'COMMIT',
        ]);
      } finally {
        await client.$disconnect();
      }
    });
  });
});
