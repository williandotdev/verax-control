import type { PrismaService } from '../common/prisma/prisma.service.js';

/**
 * Medidor de uso (fase 2, PR-03): o volume de log lido por cliente, mês e fonte, que mede os GiB por mês do plano.
 *
 * A regra é uma só, igual em todas as fontes: os bytes UTF-8 de cada registro como a fonte entrega, já descompactado,
 * contando todos os registros lidos, inclusive os que nenhuma regra acusa (descartar não diminui o que foi lido).
 *
 * Como cada coletor usa:
 * 1. cria um `UsageMeter` para o lote (ou para a execução) e chama `add` a cada registro lido;
 * 2. confirma a leitura na fonte (o ack do Pub/Sub, o avanço do cursor);
 * 3. só então chama `flush`: uma escrita por cliente, mês e fonte. Se algo falhar antes da confirmação, o medidor é
 *    descartado sem gravar, e o lote é medido quando for lido de novo e confirmado.
 *
 * Fontes:
 * - `gcp`: o sync da auditoria da GCP mede o `data` de cada mensagem do Pub/Sub (`base64Bytes`), depois do ack;
 * - `aws`: virá da tarefa `wazuh-usage` (PR-V6), pela diferença do `bytes.received` do analysisd do Wazuh do nó, que
 *   já é o total lido. Ela chama `add(tenantId, 'aws', bytes, events)` com a diferença e grava com `flush`;
 * - `cloudflare`: virá do coletor nativo, com `utf8Bytes` do corpo de cada resposta, depois de avançar o cursor.
 *
 * Uma reentrega da fonte (uma mensagem confirmada que volta) conta duas vezes: fica como "uso justo" nos Termos.
 */

export const INGEST_SOURCES = ['gcp', 'aws', 'cloudflare'] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

/** Brasília está em UTC-3 o ano todo (sem horário de verão desde 2019): o mês vira às 03:00 UTC do dia 1º. */
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Mês do uso: o primeiro dia do mês no calendário de Brasília, à meia-noite UTC (a coluna é `date`). */
export function usageMonth(at: Date): Date {
  const local = new Date(at.getTime() - BRASILIA_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
}

/** Bytes UTF-8 de um registro em texto (o corpo de uma resposta, uma linha de log). */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Bytes do registro que a fonte entrega em base64 (o `data` do Pub/Sub): o tamanho já decodificado. */
export function base64Bytes(data: string | undefined): number {
  return data ? Buffer.byteLength(data, 'base64') : 0;
}

interface Tally {
  tenantId: string;
  month: Date;
  source: IngestSource;
  bytes: number;
  events: number;
}

export class UsageMeter {
  private readonly tallies = new Map<string, Tally>();

  /** Soma o volume lido de um cliente, na fonte e no mês de `at` (o momento da leitura). */
  add(tenantId: string, source: IngestSource, bytes: number, events: number, at: Date = new Date()): void {
    for (const value of [bytes, events]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('o uso medido deve ser um inteiro não negativo');
      }
    }
    if (bytes === 0 && events === 0) return;
    const month = usageMonth(at);
    const key = `${tenantId}|${month.toISOString()}|${source}`;
    const tally = this.tallies.get(key) ?? { tenantId, month, source, bytes: 0, events: 0 };
    tally.bytes += bytes;
    tally.events += events;
    this.tallies.set(key, tally);
  }

  /** Nada a gravar. */
  get isEmpty(): boolean {
    return this.tallies.size === 0;
  }

  /**
   * Grava o que foi somado: uma escrita por cliente, mês e fonte, cada uma no escopo do próprio cliente. Chamar só
   * depois de confirmar a leitura na fonte. O que já foi gravado sai do medidor, então chamar de novo depois de uma
   * falha no meio não conta duas vezes.
   */
  async flush(prisma: PrismaService): Promise<void> {
    for (const [key, { tenantId, month, source, bytes, events }] of this.tallies) {
      await prisma.forTenant(tenantId).ingestUsage.upsert({
        where: { tenantId_month_source: { tenantId, month, source } },
        create: { tenantId, month, source, bytes: BigInt(bytes), events: BigInt(events) },
        update: { bytes: { increment: BigInt(bytes) }, events: { increment: BigInt(events) } },
      });
      this.tallies.delete(key);
    }
  }
}
