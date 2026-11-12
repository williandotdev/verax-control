import { brasiliaDay, dayAsDate, type MeteredSource } from '@verax/shared';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { Prisma } from '../generated/prisma/client.js';

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
 * - `aws`: a tarefa `wazuh-usage` (PR-V6, `wazuh-usage.ts`), pela diferença do `bytes.received` do analysisd do Wazuh
 *   do nó, que já é o total lido, e dos eventos do módulo da AWS. Ela chama `add(tenantId, 'aws', bytes, events)` com a
 *   diferença e grava com `flushIn`, na mesma transação da base da diferença seguinte;
 * - `cloudflare`: virá do coletor nativo, com `utf8Bytes` do corpo de cada resposta, depois de avançar o cursor.
 *
 * Uma reentrega da fonte (uma mensagem confirmada que volta) conta duas vezes: fica como "uso justo" nos Termos.
 *
 * **Volume por dia (CE-09, a franquia da Plataforma em GB/dia):** o mesmo medidor soma, à parte, o volume de cada
 * cliente por dia do calendário de Brasília e fonte (`addDaily`, tabela `IngestUsageDay`), gravado na mesma escrita do
 * mês. O dia é o do registro, não o da leitura: a GCP conta no dia do `publishTime` da mensagem, e a auditoria do
 * Cloudflare no dia de cada entrada (`utf8Bytes` do JSON da entrada). Os eventos de segurança do Cloudflare (GraphQL)
 * ficam só no mês: são agregados do tamanho da consulta, não o volume do cliente, e não contam na franquia. A AWS por
 * dia vem do analysisd no nó dedicado (`wazuh-usage.ts`, no dia da leitura) e, na célula, da medição na origem
 * (`aws-volume.ts`), que regrava o total do dia (valor absoluto) em vez de somar. O `IngestUsageDay` só é gravado pelo
 * sistema: o escopo do cliente só o lê.
 */

export const INGEST_SOURCES = ['gcp', 'aws', 'cloudflare'] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

/** Brasília está em UTC-3 o ano todo (sem horário de verão desde 2019): o mês vira às 03:00 UTC do dia 1º. */
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Dia do uso: o dia do calendário de Brasília do instante, à meia-noite UTC (a coluna é `date`). */
export function usageDay(at: Date): Date {
  return dayAsDate(brasiliaDay(at));
}

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

interface DayTally {
  tenantId: string;
  day: Date;
  source: MeteredSource;
  bytes: number;
  events: number;
}

function assertCounters(bytes: number, events: number): void {
  for (const value of [bytes, events]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('o uso medido deve ser um inteiro não negativo');
    }
  }
}

export class UsageMeter {
  private readonly tallies = new Map<string, Tally>();
  private readonly dayTallies = new Map<string, DayTally>();

  /** Soma o volume lido de um cliente, na fonte e no mês de `at` (o momento da leitura). */
  add(tenantId: string, source: IngestSource, bytes: number, events: number, at: Date = new Date()): void {
    assertCounters(bytes, events);
    if (bytes === 0 && events === 0) return;
    const month = usageMonth(at);
    const key = `${tenantId}|${month.toISOString()}|${source}`;
    const tally = this.tallies.get(key) ?? { tenantId, month, source, bytes: 0, events: 0 };
    tally.bytes += bytes;
    tally.events += events;
    this.tallies.set(key, tally);
  }

  /**
   * Soma o volume de um cliente no dia de Brasília de `occurredAt` (o instante do registro na fonte: o `publishTime`
   * da mensagem, o horário da entrada), para a franquia em GB/dia (CE-09). À parte do `add`: o mês continua medido
   * pelo momento da leitura, e cada fonte decide o que entra no dia (os eventos de segurança do Cloudflare, não).
   */
  addDaily(tenantId: string, source: MeteredSource, bytes: number, events: number, occurredAt: Date): void {
    assertCounters(bytes, events);
    if (bytes === 0 && events === 0) return;
    const day = usageDay(occurredAt);
    const key = `${tenantId}|${day.toISOString()}|${source}`;
    const tally = this.dayTallies.get(key) ?? { tenantId, day, source, bytes: 0, events: 0 };
    tally.bytes += bytes;
    tally.events += events;
    this.dayTallies.set(key, tally);
  }

  /** Nada a gravar. */
  get isEmpty(): boolean {
    return this.tallies.size === 0 && this.dayTallies.size === 0;
  }

  /**
   * Grava o que foi somado: uma escrita por cliente, mês e fonte, cada uma no escopo do próprio cliente. Chamar só
   * depois de confirmar a leitura na fonte. O que já foi gravado sai do medidor, então chamar de novo depois de uma
   * falha no meio não conta duas vezes.
   */
  async flush(prisma: PrismaService): Promise<void> {
    await this.write(
      (tenantId) => prisma.forTenant(tenantId),
      () => prisma.db(),
    );
  }

  /**
   * O mesmo `flush`, dentro de uma transação do chamador (cada escrita no escopo do próprio cliente): a escrita do uso
   * vale junto com o resto da transação. Se ela desfizer, este medidor já não serve (o que foi escrito saiu dele):
   * descarte-o e meça de novo a partir do que ficou no banco.
   */
  async flushIn(tx: Prisma.TransactionClient): Promise<void> {
    await this.write(
      (tenantId) => scopeToTenant(tx, tenantId),
      () => tx,
    );
  }

  /**
   * O mês vai pelo escopo do próprio cliente; o dia, que o escopo só lê (`SYSTEM_WRITTEN_MODELS`), pelo cliente base
   * ou pela transação, sempre com o `tenantId` da soma.
   */
  private async write(
    scopeOf: (tenantId: string) => Prisma.TransactionClient,
    system: () => Prisma.TransactionClient,
  ): Promise<void> {
    for (const [key, { tenantId, month, source, bytes, events }] of this.tallies) {
      await scopeOf(tenantId).ingestUsage.upsert({
        where: { tenantId_month_source: { tenantId, month, source } },
        create: { tenantId, month, source, bytes: BigInt(bytes), events: BigInt(events) },
        update: { bytes: { increment: BigInt(bytes) }, events: { increment: BigInt(events) } },
      });
      this.tallies.delete(key);
    }
    for (const [key, { tenantId, day, source, bytes, events }] of this.dayTallies) {
      await system().ingestUsageDay.upsert({
        where: { tenantId_day_source: { tenantId, day, source } },
        create: { tenantId, day, source, bytes: BigInt(bytes), events: BigInt(events) },
        update: { bytes: { increment: BigInt(bytes) }, events: { increment: BigInt(events) } },
      });
      this.dayTallies.delete(key);
    }
  }
}
