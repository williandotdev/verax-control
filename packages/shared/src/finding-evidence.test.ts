import { describe, expect, it } from 'vitest';
import {
  findingDetailSchema,
  findingEvidenceSchema,
  findingWebEvidenceSchema,
  MAX_FINDING_EVIDENCE_BYTES,
} from './index.js';

const at = '2026-11-24T12:00:00.000Z';
const valid = {
  version: 1,
  ruleId: '990405',
  windowFrom: at,
  windowTo: at,
  firstSeenAt: at,
  lastSeenAt: at,
  client: '198.51.100.7',
  clientClass: 'direct',
  host: 'loja.exemplo.com.br',
  route: '/login/*',
  routeKind: 'login',
  routeSemantics: 'observed',
  counters: {
    requests: 1,
    blocked: 0,
    errors: 0,
    toolRequests: 0,
    probes: 0,
    distinctPaths: 1,
    attempts: 20,
    failures: 20,
    successes: 0,
    clients: 1,
    answered: 0,
  },
  blockedPercent: 0,
  statuses: [{ status: '401', count: 20 }],
  probeFamilies: ['env'],
  routes: [{ path: '/conta/{num}', count: 3 }],
  clients: [{ client: '2001:db8:0:1::/64', requests: 3, count: 3 }],
  userAgents: { families: ['curl'], sample: 'curl/8.1 ({token})' },
  samples: [{ at, method: 'POST', path: '/login', status: 401, bytes: 512 }],
  pointers: [{ objectKey: 'AWSLogs/111111111111/objeto.log.gz', minute: at }],
  truncated: false,
  notes: ['volume_only'],
};

describe('evidência de um achado (contrato)', () => {
  it('aceita a evidência completa e a resposta sem evidência', () => {
    expect(findingWebEvidenceSchema.parse(valid)).toEqual(valid);
    for (const body of [
      { evidence: valid, samplesPurgedAt: null },
      { evidence: { ...valid, samples: [], pointers: [] }, samplesPurgedAt: at },
      { evidence: null, samplesPurgedAt: null },
    ]) {
      expect(findingEvidenceSchema.parse(body)).toEqual(body);
    }
    expect(findingEvidenceSchema.safeParse({ evidence: valid }).success).toBe(false);
    expect(findingEvidenceSchema.safeParse({ evidence: null, samplesPurgedAt: null, raw: 'x' }).success).toBe(
      false,
    );
  });

  it('é estrita em todo nível: um campo a mais, ou a menos, não passa', () => {
    const extra = { query: 'senha=1' };
    for (const item of [
      { ...valid, ...extra },
      { ...valid, counters: { ...valid.counters, ...extra } },
      { ...valid, userAgents: { ...valid.userAgents, ...extra } },
      { ...valid, statuses: [{ ...valid.statuses[0], ...extra }] },
      { ...valid, routes: [{ ...valid.routes[0], ...extra }] },
      { ...valid, clients: [{ ...valid.clients[0], ...extra }] },
      { ...valid, samples: [{ ...valid.samples[0], ...extra }] },
      { ...valid, pointers: [{ ...valid.pointers[0], ...extra }] },
    ]) {
      expect(findingWebEvidenceSchema.safeParse(item).success, JSON.stringify(item)).toBe(false);
    }
    for (const key of Object.keys(valid)) {
      const { [key as keyof typeof valid]: _, ...rest } = valid;
      expect(findingWebEvidenceSchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it('texto fora do formato mascarado não chega à tela', () => {
    for (const over of [
      { version: 2 },
      { ruleId: '99040' },
      { ruleId: 'abcdef' },
      { client: 'joao' },
      { client: 'f'.repeat(50) },
      { host: 'a b' },
      { host: '<b>' },
      { host: 'h'.repeat(254) },
      { route: '/a?b=c' },
      { route: 'login' },
      { clientClass: 'Direct' },
      { routeKind: 'x'.repeat(33) },
      { notes: ['nota com espaço'] },
      { blockedPercent: 101 },
      { counters: { ...valid.counters, requests: -1 } },
      { counters: { ...valid.counters, requests: 1.5 } },
      { counters: { ...valid.counters, requests: Number.MAX_SAFE_INTEGER + 1 } },
      { windowFrom: 'ontem' },
      { userAgents: { families: ['curl'], sample: 'a\u202eb' } },
      { userAgents: { families: ['curl'], sample: 'u'.repeat(121) } },
      { samples: [{ ...valid.samples[0], path: '/a?senha=1' }] },
      { samples: [{ ...valid.samples[0], path: '/A' }] },
      { samples: [{ ...valid.samples[0], path: `/${'a'.repeat(256)}` }] },
      { samples: [{ ...valid.samples[0], method: 'get' }] },
      { samples: [{ ...valid.samples[0], status: 1000 }] },
      { pointers: [{ objectKey: 'a\nb', minute: at }] },
      { pointers: [{ objectKey: 'k'.repeat(513), minute: at }] },
    ]) {
      expect(findingWebEvidenceSchema.safeParse({ ...valid, ...over }).success, JSON.stringify(over)).toBe(
        false,
      );
    }
  });

  it('um código novo do nó (família, nota, classe) não derruba a evidência num painel de antes', () => {
    const newer = {
      ...valid,
      clientClass: 'outra_cdn',
      routeKind: 'graphql',
      routeSemantics: 'learned',
      probeFamilies: ['graphql_introspection'],
      userAgents: { ...valid.userAgents, families: ['ferramenta2'] },
      notes: ['nota_nova'],
    };
    expect(findingWebEvidenceSchema.parse(newer)).toEqual(newer);
  });

  it('tem tetos: listas e tamanho', () => {
    const many = <T>(item: T, count: number): T[] => Array.from({ length: count }, () => item);
    for (const [key, max] of [
      ['statuses', 12],
      ['probeFamilies', 32],
      ['routes', 10],
      ['clients', 20],
      ['samples', 10],
      ['pointers', 5],
      ['notes', 32],
    ] as const) {
      const [item] = valid[key];
      expect(findingWebEvidenceSchema.safeParse({ ...valid, [key]: many(item, max) }).success, key).toBe(
        true,
      );
      expect(findingWebEvidenceSchema.safeParse({ ...valid, [key]: many(item, max + 1) }).success, key).toBe(
        false,
      );
    }
    expect(MAX_FINDING_EVIDENCE_BYTES).toBe(16_384);
  });

  it('o detalhe do achado continua estrito: a evidência é de outra rota', () => {
    expect(Object.keys(findingDetailSchema.shape)).not.toContain('evidence');
  });
});
