import { describe, expect, it } from 'vitest';
import type { AlertSearchClient } from '../../src/alerts/alert-sync.js';
import { IndexerRawEvents } from '../../src/findings/indexer-raw-events.js';
import type { AlertSearch } from '../../src/indexer/alert-queries.js';
import type { AlertHit } from '../../src/indexer/indexer.client.js';
import { wafAlert } from '../alerts/fixtures.js';

class OneHit implements AlertSearchClient {
  requests: AlertSearch[] = [];
  constructor(private readonly source: Record<string, unknown> | null) {}
  search(request: AlertSearch): Promise<AlertHit[]> {
    this.requests.push(request);
    return Promise.resolve(
      this.source ? [{ index: 'wazuh-alerts', id: 'x', sort: [], source: this.source }] : [],
    );
  }
}

describe('evento bruto do detalhe, lido do indexer (T5.4)', () => {
  it('busca pelo id do alerta e devolve o evento saneado', async () => {
    const alert = wafAlert();
    const indexer = new OneHit(alert);
    const event = await new IndexerRawEvents(indexer).read('wazuh', String(alert['id']));
    expect(indexer.requests).toHaveLength(1);
    const text = JSON.stringify(event);
    expect(text).toContain('AWS-AWSManagedRulesCommonRuleSet');
    // Nada do log bruto, de eventos anteriores nem de credencial do cliente.
    expect(text).not.toContain('full_log');
    expect(text).not.toContain('previous_output');
    expect(text).not.toContain('token-do-usuario-do-cliente');
  });

  it('fora da retenção, não há evento', async () => {
    expect(await new IndexerRawEvents(new OneHit(null)).read('wazuh', '1793527200.000001')).toBeNull();
  });

  it('origem que não é o Wazuh nem chega ao indexer', async () => {
    const indexer = new OneHit(wafAlert());
    expect(await new IndexerRawEvents(indexer).read('outra', '1')).toBeNull();
    expect(indexer.requests).toHaveLength(0);
  });

  it('id fora do formato é recusado antes da consulta', async () => {
    const indexer = new OneHit(wafAlert());
    await expect(new IndexerRawEvents(indexer).read('wazuh', 'id com espaço')).rejects.toThrow(RangeError);
    expect(indexer.requests).toHaveLength(0);
  });
});
