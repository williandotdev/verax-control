import { describe, expect, it } from 'vitest';
import {
  ALERTS_INDEX,
  alertById,
  alertsAfter,
  assertStructuredQuery,
  type AlertFilter,
} from '../../src/indexer/alert-queries.js';

const FORBIDDEN = ['query_string', 'simple_query_string', 'wildcard', 'regexp', 'script', 'fuzzy', 'prefix'];

function keysOf(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, keys));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      keysOf(child, keys);
    }
  }
  return keys;
}

describe('consultas aos alertas (T5.1)', () => {
  it('lê em ordem de chegada a partir de uma data, sem contar o total', () => {
    expect(alertsAfter({ cursor: null, since: '2026-11-01T00:00:00Z', size: 100 })).toEqual({
      index: ALERTS_INDEX,
      body: {
        size: 100,
        track_total_hits: false,
        sort: [{ timestamp: 'asc' }, { id: 'asc' }],
        query: { bool: { filter: [{ range: { timestamp: { gte: '2026-11-01T00:00:00Z' } } }] } },
      },
    });
  });

  it('continua do cursor (timestamp e id do último alerta)', () => {
    const search = alertsAfter({ cursor: { timestamp: '2026-11-01T10:00:00.123Z', id: '1793500000.4242' } });
    expect(search.body['search_after']).toEqual(['2026-11-01T10:00:00.123Z', '1793500000.4242']);
  });

  it('filtra só por term, terms e range nos campos permitidos', () => {
    const filters: AlertFilter[] = [
      { field: 'data.aws.aws_account_id', equals: '111122223333' },
      { field: 'rule.groups', oneOf: ['aws', 'guardduty'] },
      { field: 'rule.level', atLeast: 7 },
    ];
    const { body } = alertsAfter({ cursor: null, filters });
    expect((body['query'] as { bool: { filter: unknown[] } }).bool.filter).toEqual([
      { term: { 'data.aws.aws_account_id': '111122223333' } },
      { terms: { 'rule.groups': ['aws', 'guardduty'] } },
      { range: { 'rule.level': { gte: 7 } } },
    ]);
  });

  it('"diferente de" vira term no must_not, sem mudar o filtro; sem ele, a consulta não ganha must_not', () => {
    const { body } = alertsAfter({
      cursor: null,
      filters: [
        { field: 'agent.id', notEquals: '000' },
        { field: 'rule.level', atLeast: 5 },
      ],
    });
    expect(body['query']).toEqual({
      bool: {
        filter: [{ range: { 'rule.level': { gte: 5 } } }],
        must_not: [{ term: { 'agent.id': '000' } }],
      },
    });
    expect(() => assertStructuredQuery(body)).not.toThrow();
    const plain = alertsAfter({ cursor: null, filters: [{ field: 'rule.level', atLeast: 5 }] });
    expect(Object.keys((plain.body['query'] as { bool: object }).bool)).toEqual(['filter']);
    // A mesma régua dos outros filtros: campo fora da lista e valor com controle são recusados.
    const forced = { field: 'full_log', notEquals: 'x' } as unknown as AlertFilter;
    expect(() => alertsAfter({ cursor: null, filters: [forced] })).toThrow(/não permitido/);
    const control: AlertFilter = { field: 'agent.id', notEquals: 'a\nb' };
    expect(() => alertsAfter({ cursor: null, filters: [control] })).toThrow(RangeError);
  });

  it('texto vindo de fora vira valor literal de term, nunca sintaxe de busca', () => {
    const malicious = '*) OR (_exists_:data) OR rule.level:>0';
    const { body } = alertsAfter({ cursor: null, filters: [{ field: 'rule.id', equals: malicious }] });
    expect(keysOf(body).filter((key) => FORBIDDEN.includes(key))).toEqual([]);
    expect(JSON.stringify(body)).toContain(JSON.stringify(malicious));
  });

  it('recusa campo fora da lista, mesmo com o tipo forçado', () => {
    const forced = { field: 'full_log', equals: 'x' } as unknown as AlertFilter;
    expect(() => alertsAfter({ cursor: null, filters: [forced] })).toThrow(/não permitido/);
    const forcedLevel = { field: 'rule.id', atLeast: 3 } as unknown as AlertFilter;
    expect(() => alertsAfter({ cursor: null, filters: [forcedLevel] })).toThrow(/rule.level/);
  });

  it('recusa valores inválidos: controle, texto longo, lista vazia ou enorme, número não finito', () => {
    const cases: AlertFilter[] = [
      { field: 'rule.id', equals: 'linha\nquebrada' },
      { field: 'rule.id', equals: 'x'.repeat(257) },
      { field: 'rule.groups', oneOf: [] },
      { field: 'rule.groups', oneOf: Array.from({ length: 101 }, (_, n) => `g${n}`) },
      { field: 'rule.level', equals: Number.POSITIVE_INFINITY },
    ];
    for (const filter of cases) {
      expect(() => alertsAfter({ cursor: null, filters: [filter] })).toThrow(RangeError);
    }
  });

  it('valida tamanho da página, datas e cursor', () => {
    expect(() => alertsAfter({ cursor: null, size: 0 })).toThrow(/size/);
    expect(() => alertsAfter({ cursor: null, size: 1001 })).toThrow(/size/);
    expect(() => alertsAfter({ cursor: null, since: 'ontem' })).toThrow(/ISO 8601/);
    expect(() => alertsAfter({ cursor: { timestamp: '2026-11-01T00:00:00Z', id: 'a b' } })).toThrow(/id/);
    expect(() => alertById('" OR 1=1')).toThrow(/id/);
  });

  it('busca um alerta pelo id com term', () => {
    expect(alertById('1793500000.4242').body).toEqual({
      size: 1,
      track_total_hits: false,
      query: { bool: { filter: [{ term: { id: '1793500000.4242' } }] } },
    });
  });

  it('a guarda recusa construções interpretáveis em qualquer nível', () => {
    // eslint-disable-next-line no-restricted-syntax -- o teste confere que a guarda recusa query_string
    expect(() => assertStructuredQuery({ query: { query_string: { query: 'x' } } })).toThrow(/query_string/);
    expect(() =>
      assertStructuredQuery({
        query: { bool: { filter: [{ bool: { should: [{ script: { source: '1' } }] } }] } },
      }),
    ).toThrow(/script/);
    expect(() => assertStructuredQuery({ runtime_mappings: {} })).toThrow(/runtime_mappings/);
    expect(() => assertStructuredQuery(alertsAfter({ cursor: null }).body)).not.toThrow();
  });
});
