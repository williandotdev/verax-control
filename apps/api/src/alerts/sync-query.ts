import { alertsAfter, type AlertCursor, type AlertSearch } from '../indexer/alert-queries.js';
import { AWS_SOURCES } from './wazuh-alert.js';

/**
 * Leitura incremental dos alertas para o sync (T5.3).
 *
 * Cada execução relê uma janela que começa um pouco antes do último alerta processado: o Wazuh grava o horário de
 * processamento, mas o alerta chega ao indexer pelo filebeat e pode ser indexado fora de ordem. Como a gravação é
 * idempotente (`source` + `sourceEventId`), reler a sobreposição não duplica achado. Dentro da execução, as páginas
 * seguem pelo cursor (horário e id), sem pular nem repetir.
 */

export interface SyncSettings {
  /** Nível mínimo da regra para virar achado. Abaixo de 5 ficam os eventos de auditoria do CloudTrail (nível 3). */
  minLevel: number;
  /** Quanto reler antes do último alerta processado. */
  overlapMs: number;
  /** Na primeira execução (sem alerta processado), quanto olhar para trás. */
  initialLookbackMs: number;
  pageSize: number;
}

export const DEFAULT_SYNC_SETTINGS: Readonly<SyncSettings> = {
  minLevel: 5,
  overlapMs: 10 * 60 * 1000,
  initialLookbackMs: 24 * 60 * 60 * 1000,
  pageSize: 500,
};

/** Início da janela de uma execução, em ISO 8601 UTC. */
export function syncWindowStart(lastProcessedAt: string | null, now: Date, settings: SyncSettings): string {
  const start =
    lastProcessedAt === null
      ? now.getTime() - settings.initialLookbackMs
      : new Date(lastProcessedAt).getTime() - settings.overlapMs;
  if (!Number.isFinite(start)) {
    throw new RangeError('horário do último alerta processado inválido');
  }
  return new Date(start).toISOString();
}

/** Uma página: só alertas do módulo aws-s3, das fontes coletadas, a partir do nível mínimo. */
export function syncPage(
  windowStart: string,
  cursor: AlertCursor | null,
  settings: SyncSettings,
): AlertSearch {
  return alertsAfter({
    cursor,
    since: windowStart,
    size: settings.pageSize,
    filters: [
      { field: 'data.integration', equals: 'aws' },
      { field: 'data.aws.source', oneOf: AWS_SOURCES },
      { field: 'rule.level', atLeast: settings.minLevel },
    ],
  });
}

/**
 * Cursor da próxima página, a partir dos valores de ordenação do último resultado: o indexer devolve o horário em
 * milissegundos e o id. Vem da ordenação, e não do alerta, porque um alerta inválido também precisa ser pulado.
 */
export function cursorFromSort(sort: readonly unknown[]): AlertCursor {
  const [time, id] = sort;
  const ms =
    typeof time === 'number'
      ? time
      : typeof time === 'string' && /^\d{1,15}$/.test(time)
        ? Number(time)
        : NaN;
  if (!Number.isSafeInteger(ms) || typeof id !== 'string') {
    throw new RangeError('valores de ordenação do indexer fora do esperado');
  }
  return { timestamp: new Date(ms).toISOString(), id };
}
