import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { CollectorCursor } from '../generated/prisma/client.js';

export type { CollectorCursor };

/** Qual cursor: a conta, o fluxo (`aws_cloudtrail`, `cloudflare_audit`) e a região (vazia nos fluxos sem região). */
export interface CursorKey {
  cloudAccountId: string;
  stream: string;
  region?: string;
}

/** Resultado de uma leitura bem-sucedida. */
export interface CursorAdvance {
  /** Horário do evento mais recente processado. O cursor só anda para a frente; sem valor, fica onde está. */
  cursorAt?: Date;
  /** Continuação da fonte quando a execução parou no teto de páginas; `null` quando leu tudo. */
  continuation: string | null;
  /** Quando ler de novo: o intervalo do fluxo. */
  nextRunAt: Date;
}

/** Recuo depois de falhas seguidas: `baseMs` na primeira, dobrando a cada falha, até `maxMs`. */
export interface Backoff {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: Readonly<Backoff> = { baseMs: 60_000, maxMs: 60 * 60_000 };

export interface CursorFailure {
  backoff?: Backoff;
  /** Hora pedida pela própria fonte (`Retry-After`, throttling); vale no lugar do recuo calculado. */
  retryAt?: Date;
}

const STREAM = /^[a-z][a-z0-9_]{0,31}$/;
const REGION = /^[a-z0-9-]{0,32}$/;
const CONTINUATION_MAX = 2048;

/** Espera depois da `failures`-ésima falha seguida. */
export function backoffDelay(failures: number, backoff: Backoff = DEFAULT_BACKOFF): number {
  const doublings = Math.min(Math.max(failures - 1, 0), 30);
  return Math.min(backoff.maxMs, backoff.baseMs * 2 ** doublings);
}

function uniqueKey(key: CursorKey) {
  const region = key.region ?? '';
  // Nomes fixos do código, conferidos para um erro de digitação não virar um cursor novo e silencioso.
  if (!STREAM.test(key.stream)) throw new RangeError(`fluxo de coletor inválido: ${key.stream}`);
  if (!REGION.test(region)) throw new RangeError('região do cursor inválida');
  return { cloudAccountId: key.cloudAccountId, stream: key.stream, region };
}

/**
 * Cursor de cada fluxo de cada conta, a base dos coletores nativos (AWS, Cloudflare): até onde a conta já foi lida,
 * a continuação de uma leitura cortada no teto de páginas e quando ler de novo. É dado de sistema (sem cliente), lido
 * e gravado só pelo worker, sem escopo. A concessão do coletor (`SyncLease`) garante um worker por vez em cada fluxo.
 *
 * - `read` devolve o cursor e o cria vazio, para rodar já, na primeira vez;
 * - `due` lista os cursores do fluxo com a hora de rodar já chegada, de contas ativas;
 * - `advance` registra uma leitura bem-sucedida: o cursor anda (nunca volta), as falhas zeram e a próxima leitura é
 *   marcada;
 * - `fail` registra uma falha sem mexer na posição: guarda só o tipo do erro e marca a próxima leitura com recuo.
 */
export class CollectorCursors {
  constructor(private readonly prisma: PrismaService) {}

  async read(key: CursorKey, now: Date): Promise<CollectorCursor> {
    const unique = uniqueKey(key);
    await this.prisma.collectorCursor.createMany({
      data: [{ ...unique, nextRunAt: now }],
      skipDuplicates: true,
    });
    return this.prisma.collectorCursor.findUniqueOrThrow({ where: { cloudAccountId_stream_region: unique } });
  }

  async due(stream: string, now: Date, limit = 100): Promise<CollectorCursor[]> {
    return this.prisma.collectorCursor.findMany({
      where: { stream, nextRunAt: { lte: now }, cloudAccount: { status: 'active' } },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  async advance(key: CursorKey, step: CursorAdvance, now: Date): Promise<CollectorCursor> {
    const unique = uniqueKey(key);
    if (step.continuation !== null && step.continuation.length > CONTINUATION_MAX) {
      throw new RangeError(`continuação maior que ${CONTINUATION_MAX} caracteres`);
    }
    const where = { cloudAccountId_stream_region: unique };
    const success = {
      continuation: step.continuation,
      nextRunAt: step.nextRunAt,
      lastSuccessAt: now,
      lastErrorKind: null,
      failures: 0,
    };
    if (step.cursorAt === undefined) return this.prisma.collectorCursor.update({ where, data: success });
    // A condição de "só para a frente" fica no próprio UPDATE; os dois juntos ou nenhum.
    const [, cursor] = await this.prisma.$transaction([
      this.prisma.collectorCursor.updateMany({
        where: { ...unique, OR: [{ cursorAt: null }, { cursorAt: { lt: step.cursorAt } }] },
        data: { cursorAt: step.cursorAt },
      }),
      this.prisma.collectorCursor.update({ where, data: success }),
    ]);
    return cursor;
  }

  async fail(
    key: CursorKey,
    error: unknown,
    now: Date,
    options: CursorFailure = {},
  ): Promise<CollectorCursor> {
    const where = { cloudAccountId_stream_region: uniqueKey(key) };
    const { failures } = await this.prisma.collectorCursor.update({
      where,
      data: { failures: { increment: 1 }, lastErrorKind: errorKind(error) },
      select: { failures: true },
    });
    const nextRunAt = options.retryAt ?? new Date(now.getTime() + backoffDelay(failures, options.backoff));
    return this.prisma.collectorCursor.update({ where, data: { nextRunAt } });
  }
}
