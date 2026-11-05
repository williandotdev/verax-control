import type { NoticeRow } from './finding-notices.js';

/**
 * Aviso de coleta da AWS parada (`aws_ingestion_stalled`, fase 2, PR-V6): sai da tarefa `wazuh-usage` quando o cliente
 * tem conta AWS conectada e os eventos do módulo da AWS no analysisd do Wazuh do nó estão parados há mais de 2 horas (a
 * mesma regra da Torre, `awsLogsStalledSince`).
 *
 * Uma parada é identificada pelo começo dela (a última vez que o contador andou): a chave de deduplicação
 * `aws-stalled:<começo>` faz cada parada avisar uma vez só, por mais que a tarefa a releia. Quando os eventos voltam,
 * o começo da próxima parada é outro, e ela avisa de novo. O contador é do nó inteiro (o nó atende um cliente só), então
 * a parada é do cliente, e não de uma conta: um e-mail por parada, mesmo com mais de uma conta conectada.
 */
export function awsStallDedupeKey(since: Date): string {
  return `aws-stalled:${since.toISOString()}`;
}

/** A linha da fila de saída do aviso de uma parada. */
export function awsStallNotice(tenantId: string, since: Date): NoticeRow {
  return { tenantId, kind: 'aws_ingestion_stalled', dedupeKey: awsStallDedupeKey(since) };
}
