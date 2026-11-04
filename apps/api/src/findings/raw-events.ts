/**
 * Evento bruto do detalhe do achado (T5.4). Fica no indexer do Wazuh, não no PostgreSQL: o achado guarda só
 * `(source, rawEventId)` para buscá-lo, com o ID do alerta da primeira leitura. Sem indexer configurado, o detalhe sai
 * sem o evento.
 */
export const RAW_EVENT_READER = Symbol('RAW_EVENT_READER');

export interface RawEventReader {
  /** O evento já saneado (sem `full_log`, `previous_output` nem cabeçalhos de credencial), ou null. */
  read(source: string, rawEventId: string): Promise<Record<string, unknown> | null>;
}

/** Ambiente sem Wazuh (desenvolvimento e testes): o detalhe mostra que o evento não está disponível. */
export class NoRawEvents implements RawEventReader {
  read(): Promise<Record<string, unknown> | null> {
    return Promise.resolve(null);
  }
}
