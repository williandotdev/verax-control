import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAnalysisdStats, WAZUH_STATS_ACCOUNT, WazuhApiError } from './wazuh-stats.js';

/**
 * A resposta de verdade do `GET /manager/daemons/stats?daemons_list=wazuh-analysisd` de um manager 4.14.9 avulso (a do
 * `infra/wazuh/scripts/test-api-users.sh`, com `STATS_SAMPLE`), depois de três eventos no formato do módulo da AWS.
 */
const sample = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../test/fixtures/wazuh-analysisd-stats.json', import.meta.url)),
    'utf8',
  ),
) as { data: { affected_items: Record<string, unknown>[] } };

type Json = Record<string, unknown>;
function variant(change: (item: Json) => void): unknown {
  const copy: { data: { affected_items: Json[] } } = structuredClone(sample);
  const [item] = copy.data.affected_items;
  if (item !== undefined) change(item);
  return copy;
}
function metrics(item: Json): Json {
  return item.metrics as Json;
}
function modules(item: Json): Json {
  const events = metrics(item).events as Json;
  const breakdown = events.received_breakdown as Json;
  return (breakdown.decoded_breakdown as Json).modules_breakdown as Json;
}

describe('contadores do analysisd: contrato com a API do manager (PR-V6)', () => {
  it('a resposta do Wazuh 4.14.9: a partida, os bytes recebidos e os eventos do módulo da AWS', () => {
    const counters = parseAnalysisdStats(sample);
    expect(counters.startedAt).toEqual(new Date('2026-11-05T07:18:18.000Z'));
    expect(counters.bytesReceived).toBe(978_815);
    expect(counters.awsEvents).toBe(3);
  });

  it('o usuário é o do init-api-users.sh', () => {
    expect(WAZUH_STATS_ACCOUNT).toBe('verax_stats');
  });

  it('campos que a tarefa não usa podem mudar; os que ela usa, não', () => {
    expect(() =>
      parseAnalysisdStats(
        variant((item) => {
          item.extra = { novo: true };
          delete (metrics(item).events as Json).processed;
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['sem os eventos da AWS', (item: Json) => delete modules(item).aws],
    ['eventos negativos', (item: Json) => (modules(item).aws = -1)],
    ['eventos fracionários', (item: Json) => (modules(item).aws = 1.5)],
    ['eventos em texto', (item: Json) => (modules(item).aws = '3')],
    ['bytes acima do inteiro seguro', (item: Json) => ((metrics(item).bytes as Json).received = 2 ** 53)],
    ['sem os bytes', (item: Json) => delete metrics(item).bytes],
    ['partida fora do ISO 8601', (item: Json) => (item.uptime = 'ontem')],
    ['outro daemon', (item: Json) => (item.name = 'wazuh-remoted')],
  ])('recusa a resposta %s', (_, change) => {
    expect(() => parseAnalysisdStats(variant(change))).toThrow(WazuhApiError);
    try {
      parseAnalysisdStats(variant(change));
    } catch (error) {
      expect((error as WazuhApiError).kind).toBe('format');
    }
  });

  it('recusa erro do Wazuh, lista vazia, dois itens e o que não é objeto', () => {
    const items = sample.data.affected_items;
    for (const body of [
      { ...sample, error: 1 },
      { ...sample, data: { ...sample.data, affected_items: [] } },
      { ...sample, data: { ...sample.data, affected_items: [...items, ...items] } },
      null,
      'texto',
      [],
    ]) {
      expect(() => parseAnalysisdStats(body)).toThrow(WazuhApiError);
    }
  });
});
