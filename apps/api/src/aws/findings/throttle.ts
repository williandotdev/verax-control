import { awsErrorName } from '../web-identity.js';

/**
 * O cuidado com os limites de requisição da conta do cliente (tarefa `aws-findings`): o espaçamento das chamadas de um
 * serviço com limite baixo (o Security Hub aceita 3 por segundo por conta e região) e a nova tentativa da chamada que a
 * AWS limitou, com recuo que dobra e sorteio, para as chamadas de várias contas não voltarem juntas.
 */

/** Os nomes que a AWS dá ao limite de requisições, conforme o serviço. */
const THROTTLING_NAMES: ReadonlySet<string> = new Set([
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'LimitExceededException',
  'SlowDown',
]);

/** A AWS limitou a chamada: pelo nome do erro ou pelo HTTP 429. */
export function isThrottling(error: unknown): boolean {
  if (THROTTLING_NAMES.has(awsErrorName(error))) return true;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  return status === 429;
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Espera que termina na hora se o sinal for abortado (a parada do worker, o orçamento, a concessão perdida). */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('abortado', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('abortado', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export interface ThrottleRetry {
  /** Tentativas ao todo (a primeira e as novas). */
  attempts: number;
  /** A espera antes da segunda tentativa; dobra a cada uma, até `maxMs`. */
  baseMs: number;
  maxMs: number;
  /** O sorteio, de 0 a 1 (os testes fixam). */
  random: () => number;
  sleep: Sleep;
  signal: AbortSignal;
  /** Chamado a cada nova tentativa (a contagem do relatório da tarefa). */
  onRetry?: () => void;
}

export const DEFAULT_THROTTLE_RETRY = { attempts: 3, baseMs: 1_000, maxMs: 8_000 } as const;

/**
 * A espera antes da tentativa seguinte, depois de `failed` tentativas limitadas: metade do recuo fixa e metade
 * sorteada. Com o `retryAfterSeconds` que alguns serviços mandam, vale o maior dos dois, sem passar de `maxMs`.
 */
export function throttleDelay(
  failed: number,
  { baseMs, maxMs, random }: Pick<ThrottleRetry, 'baseMs' | 'maxMs' | 'random'>,
  retryAfterSeconds?: number,
): number {
  const backoff = Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(failed - 1, 0), 20));
  const jitter = Math.min(Math.max(random(), 0), 1);
  const delay = Math.round(backoff / 2 + (backoff / 2) * jitter);
  const asked =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1_000
      : 0;
  return Math.min(maxMs, Math.max(delay, asked));
}

/**
 * Executa a chamada e, se a AWS a limitar, tenta de novo depois do recuo, até o número de tentativas. Qualquer outro
 * erro sobe na hora; o limite que persiste sobe como veio (e a tarefa marca a fonte para depois).
 */
export async function withThrottleRetry<T>(call: () => Promise<T>, options: ThrottleRetry): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    options.signal.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      if (options.signal.aborted || !isThrottling(error) || attempt >= options.attempts) throw error;
      const retryAfter = (error as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
      options.onRetry?.();
      await options.sleep(
        throttleDelay(attempt, options, typeof retryAfter === 'number' ? retryAfter : undefined),
        options.signal,
      );
    }
  }
}

/**
 * Espaça as chamadas de uma mesma chave (serviço, conta e região): cada uma só sai `minIntervalMs` depois da anterior.
 * As chamadas da mesma chave que chegam juntas saem em fila, na ordem.
 */
export class RateGate {
  private readonly next = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly sleep: Sleep = abortableSleep,
    private readonly clock: () => number = Date.now,
  ) {}

  async wait(key: string, signal: AbortSignal): Promise<void> {
    const now = this.clock();
    const at = Math.max(now, this.next.get(key) ?? 0);
    this.next.set(key, at + this.minIntervalMs);
    if (at > now) await this.sleep(at - now, signal);
  }
}
