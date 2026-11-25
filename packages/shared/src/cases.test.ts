import { describe, expect, it } from 'vitest';
import {
  CASE_STATES,
  caseDetailSchema,
  caseFindingPageSchema,
  caseFindingsQuerySchema,
  caseGroupsQuerySchema,
  caseListQuerySchema,
  casePageSchema,
  caseStatusSchema,
  caseSummarySchema,
  caseTimelineSchema,
  findingTriageSchema,
  MAX_CASE_PAGE,
} from './cases.js';
import { FINDING_SEVERITIES } from './findings.js';

const ok = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('filtros da lista de casos', () => {
  it('sem nada: pendentes, por prioridade, primeira página', () => {
    expect(caseListQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 25,
      state: 'pending',
      sort: 'priority',
    });
  });

  it('todos os filtros juntos', () => {
    const query = {
      page: '2',
      pageSize: '100',
      queue: 'vulnerability',
      state: 'investigating',
      severity: 'critical',
      source: 'inspector',
      accountId: '111122223333',
      tactic: 'Impact',
      technique: 'T1078.004',
      period: '7d',
      q: 'openssl',
      groupBy: 'package',
      group: 'openssl',
      sort: 'volume',
    };
    expect(caseListQuerySchema.parse(query)).toEqual({ ...query, page: 2, pageSize: 100 });
  });

  it('a conta pode ser a de um agente; o intervalo personalizado vale no lugar do período', () => {
    expect(ok(caseListQuerySchema, { accountId: 'agent:001' })).toBe(true);
    const range = { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };
    expect(ok(caseListQuerySchema, range)).toBe(true);
    expect(ok(caseListQuerySchema, { ...range, period: '7d' })).toBe(false);
    expect(ok(caseListQuerySchema, { from: range.from })).toBe(false);
    expect(ok(caseListQuerySchema, { from: range.to, to: range.from })).toBe(false);
  });

  it.each([
    { desconhecido: '1' },
    { tenantId: '018f2c1e-0000-7000-8000-000000000001' },
    { queue: 'ruido' },
    { state: 'sealed' },
    { severity: 'urgente' },
    { source: 'syslog' },
    { accountId: "1' OR '1'='1" },
    { tactic: 'Ataque' },
    { technique: 'T1' },
    { period: '1y' },
    { q: ' ' },
    { q: 'a\nb' },
    { q: 'x'.repeat(201) },
    { sort: 'severity' },
    { page: '0' },
    { page: String(MAX_CASE_PAGE + 1) },
    { page: '1.5' },
    { page: '1e999' },
    { pageSize: '101' },
    { groupBy: 'actor' },
    { groupBy: 'package', group: '' },
    { groupBy: 'package', group: 'a\0b' },
    { groupBy: 'package', group: 'a\ud800b' },
    { groupBy: 'package', group: 'x'.repeat(513) },
    { group: 'openssl' },
    { severity: ['critical', 'high'] },
  ])('recusa %j', (query) => {
    expect(ok(caseListQuerySchema, query)).toBe(false);
  });

  it('a severidade é a do que está pendente: só com os pendentes e os em análise', () => {
    for (const state of CASE_STATES) {
      for (const severity of FINDING_SEVERITIES) {
        expect(ok(caseListQuerySchema, { state, severity }), state).toBe(
          state === 'pending' || state === 'investigating',
        );
      }
    }
    expect(ok(caseListQuerySchema, { severity: 'critical' })).toBe(true);
  });

  it('o valor do grupo é comparado por inteiro: nada é cortado', () => {
    expect(caseListQuerySchema.parse({ groupBy: 'resource', group: ' espaço \n' }).group).toBe(' espaço \n');
    expect(caseListQuerySchema.parse({ groupBy: 'resource', group: '😀'.repeat(256) }).group).toHaveLength(
      512,
    );
  });
});

describe('grupos', () => {
  it('só da fila de vulnerabilidades, com o agrupamento obrigatório', () => {
    expect(caseGroupsQuerySchema.parse({ by: 'package' })).toEqual({
      page: 1,
      pageSize: 25,
      queue: 'vulnerability',
      by: 'package',
      state: 'pending',
    });
    for (const query of [
      {},
      { by: 'rule' },
      { by: 'package', queue: 'detection' },
      { by: 'package', state: 'treated' },
      { by: 'package', state: 'all' },
      { by: 'package', page: '10001' },
      { by: 'package', sort: 'recent' },
      { by: 'package', desconhecido: 'x' },
    ]) {
      expect(ok(caseGroupsQuerySchema, query), JSON.stringify(query)).toBe(false);
    }
  });
});

describe('alertas do caso', () => {
  it('o cursor só tem os caracteres de uma URL e um tamanho limitado', () => {
    expect(caseFindingsQuerySchema.parse({})).toEqual({ pageSize: 50 });
    expect(ok(caseFindingsQuerySchema, { cursor: 'WzEsMl0' })).toBe(true);
    for (const cursor of ['', 'a b', 'a=', 'a/b', "a'", 'x'.repeat(257)]) {
      expect(ok(caseFindingsQuerySchema, { cursor }), cursor).toBe(false);
    }
    for (const query of [{ page: '1' }, { pageSize: '0' }, { pageSize: '101' }, { group: '' }, { q: 'x' }]) {
      expect(ok(caseFindingsQuerySchema, query), JSON.stringify(query)).toBe(false);
    }
  });
});

describe('respostas', () => {
  const counts = { total: 1, new: 1, investigating: 0, legitimate: 0, resolved: 0, incident: 0 };
  const pending = { critical: 0, high: 1, medium: 0, low: 0 };
  const summary = {
    id: '018f2c1e-0000-7000-8000-000000000001',
    queue: 'detection',
    family: 'cloudtrail',
    title: 'Atividade suspeita na conta da AWS',
    keyParts: [{ name: 'rule', value: '100305' }],
    sources: ['cloudtrail'],
    severity: 'high',
    protected: false,
    pending,
    counts,
    sealedAt: null,
    sealReason: null,
    recurrence: 0,
    openedAt: '2026-11-24T10:00:00.000Z',
    firstSeenAt: '2026-11-24T10:00:00.000Z',
    lastSeenAt: '2026-11-24T10:00:00.000Z',
    lastAlertAt: '2026-11-24T10:00:00.000Z',
    preview: { accounts: ['111122223333'], actors: [], ips: [], resources: [] },
    mitreTactics: [],
  };

  it('o resumo é estrito e limitado', () => {
    expect(ok(caseSummarySchema, summary)).toBe(true);
    expect(ok(caseSummarySchema, { ...summary, tenantId: 'x' })).toBe(false);
    expect(ok(caseSummarySchema, { ...summary, title: 'x'.repeat(201) })).toBe(false);
    expect(
      ok(caseSummarySchema, { ...summary, preview: { ...summary.preview, ips: ['1', '2', '3', '4'] } }),
    ).toBe(false);
    expect(ok(casePageSchema, { items: [summary], page: 1, pageSize: 25, total: 1 })).toBe(true);
  });

  it('o detalhe vale sem a leitura dos alertas (o prazo passou)', () => {
    const detail = {
      ...summary,
      samples: { ruleIds: [], accounts: [], actors: [], ips: [], resources: [], mitreTechniques: [] },
      analysis: null,
      previous: [],
      incidents: [],
      operations: [],
      can: { triage: true, promote: false },
    };
    expect(ok(caseDetailSchema, detail)).toBe(true);
    expect(ok(caseDetailSchema, { ...detail, can: { triage: true } })).toBe(false);
  });

  it('sem operação, o alerta não tem trilha de triagem em massa', () => {
    expect(ok(findingTriageSchema, { operation: null, operations: [] })).toBe(true);
  });

  it('a linha do tempo, a página de alertas e a situação vazias', () => {
    expect(
      ok(caseTimelineSchema, { granularity: 'hour', from: null, to: null, truncated: false, buckets: [] }),
    ).toBe(true);
    expect(ok(caseFindingPageSchema, { items: [], nextCursor: null })).toBe(true);
    expect(ok(caseStatusSchema, { mode: 'off', asOf: null, oldestUnassignedMinutes: null })).toBe(true);
    expect(ok(caseStatusSchema, { mode: 'ligado', asOf: null, oldestUnassignedMinutes: null })).toBe(false);
  });
});
