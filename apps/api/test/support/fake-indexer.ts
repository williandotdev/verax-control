import { randomUUID } from 'node:crypto';
import type { AlertSearchClient } from '../../src/alerts/alert-sync.js';
import type { AlertSearch } from '../../src/indexer/alert-queries.js';
import type { AlertHit } from '../../src/indexer/indexer.client.js';

/** Horário no formato que o Wazuh grava (fuso sem dois-pontos). */
export function wazuhTime(at: Date): string {
  return at.toISOString().replace('Z', '+0000');
}

/**
 * Indexer falso com a mesma semântica do real: só alertas a partir de `since`, em ordem de horário e id, depois do
 * cursor (exclusivo) e no tamanho de página pedido. Os filtros de fonte, nível e agente são do indexer e não entram
 * aqui: cada sync confere de novo se o alerta é do manager ou de um agente (`isAgentAlert`), e é isso que os testes
 * com os dois syncs no mesmo indexer provam.
 */
export class FakeIndexer implements AlertSearchClient {
  requests: AlertSearch[] = [];
  failWith: Error | null = null;
  /** Falha só a partir desta chamada (1 é a primeira): simula o indexer caindo no meio de uma execução. */
  failFromCall: number | null = null;

  constructor(private readonly documents: Record<string, unknown>[]) {}

  search(request: AlertSearch): Promise<AlertHit[]> {
    this.requests.push(request);
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.failFromCall !== null && this.requests.length >= this.failFromCall) {
      return Promise.reject(new Error('indexer caiu no meio'));
    }
    const body = request.body as {
      size: number;
      search_after?: [string, string];
      query: { bool: { filter: { range?: { timestamp: { gte: string } } }[] } };
    };
    const since = body.query.bool.filter.find((clause) => clause.range)?.range?.timestamp.gte;
    const sortOf = (doc: Record<string, unknown>): [number, string] => [
      Date.parse(String(doc['timestamp']).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')),
      String(doc['id']),
    ];
    const after = body.search_after ? [Date.parse(body.search_after[0]), body.search_after[1]] : null;
    const hits = this.documents
      .map((doc) => ({ doc, sort: sortOf(doc) }))
      .filter(({ sort }) => since === undefined || sort[0] >= Date.parse(since))
      .filter(
        ({ sort }) =>
          after === null ||
          sort[0] > (after[0] as number) ||
          (sort[0] === after[0] && sort[1] > (after[1] as string)),
      )
      .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1].localeCompare(b.sort[1]))
      .slice(0, body.size);
    return Promise.resolve(
      hits.map(({ doc, sort }) => ({
        index: 'wazuh-alerts-4.x-2026.11.03',
        id: randomUUID(),
        sort,
        source: doc,
      })),
    );
  }
}
