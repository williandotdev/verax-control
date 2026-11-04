import type { AlertSearchClient } from '../alerts/alert-sync.js';
import { sanitizeRawAlert } from '../alerts/raw-alert.js';
import { alertById } from '../indexer/alert-queries.js';
import type { RawEventReader } from './raw-events.js';

/**
 * Evento bruto do detalhe buscado no indexer do Wazuh pelo id do alerta, já saneado: sem `full_log`, sem
 * `previous_output` e sem valor de cabeçalho de credencial (T5.3). Fora da retenção, não há evento.
 */
export class IndexerRawEvents implements RawEventReader {
  constructor(private readonly indexer: AlertSearchClient) {}

  async read(source: string, rawEventId: string): Promise<Record<string, unknown> | null> {
    if (source !== 'wazuh') return null;
    const [hit] = await this.indexer.search(alertById(rawEventId));
    if (!hit) return null;
    const clean = sanitizeRawAlert(hit.source);
    return typeof clean === 'object' && clean !== null && !Array.isArray(clean)
      ? (clean as Record<string, unknown>)
      : null;
  }
}
