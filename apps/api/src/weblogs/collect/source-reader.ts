import { setImmediate as nextTurn } from 'node:timers/promises';
import { type ActiveException, matchingException } from '../../alerts/exception-match.js';
import type { FindingStore } from '../../alerts/finding-store.js';
import { lockAwsOnboarding } from '../../aws/discovery/discovery-runs.js';
import { type Sleep, withThrottleRetry } from '../../aws/findings/throttle.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { COLLECTING_TENANT } from '../../tenants/tenant-status.js';
import { objectHash } from '../../usage/aws-volume.js';
import { UsageMeter } from '../../usage/usage-meter.js';
import type { EvaluateResult, WebLogEngine } from '../engine.js';
import { MINUTE_MS, SLOT_MS } from '../limits.js';
import { settleWebLogGaps, settleWebLogObject, type WebLogObjectStatus } from '../store/web-object-ledger.js';
import type { WebTrafficStore } from '../store/web-traffic-store.js';
import { type CountryLookup, ObjectTraffic, type TrafficDelta } from '../traffic.js';
import type { AlbBucket } from './alb-bucket.js';
import { type AlbObject, compactTime, folderOf } from './alb-target.js';
import { mergeSuppressed } from './engine-state.js';
import { ObjectRejected, readAlbObject, type ObjectRead, type ReadLimits } from './object-reader.js';
import type { RunBudget } from './run-budget.js';
import { type AlbAction, AlbCallError, albFailureOf, isArchived, isFatal, isGone } from './s3-errors.js';
import { type EngineContext, isPersisted, markPersisted, type SourceMemory } from './source-memory.js';

/**
 * A leitura de um balanceador numa passagem: lista, lê, avalia, grava e registra.
 *
 * **A ordem, que faz cada coisa acontecer uma vez só:**
 * 1. as linhas de um lote de objetos entram no motor, e a conta por país e o tamanho de cada objeto ficam à parte;
 * 2. o motor é avaliado, e os achados são gravados (a chave de cada um é sempre a mesma: gravar de novo não duplica);
 * 3. só então cada objeto entra no registro, e, na mesma transação, o volume e o tráfego dele.
 *
 * Parar depois do 2 relê o objeto: os achados caem nas mesmas chaves, e o volume entra pela primeira vez. Parar no meio do 3
 * desfaz a transação inteira. Parar depois do 3 não o conta de novo: a linha do registro existe. Nenhuma linha fica contada
 * no plano sem ter sido analisada, e nenhuma é contada duas vezes.
 *
 * **A autorização** é conferida antes de abrir cada objeto e de novo dentro de cada transação, sob o lock da conta (o da
 * autorização e da retirada pelo painel): depois de a retirada ser confirmada, nada mais é aberto nem gravado.
 */

/** Objetos, linhas e bytes de um lote: avaliado e gravado antes de seguir. */
const BATCH = { objects: 25, lines: 200_000, bytes: 128 * 1024 * 1024 };
/** Falhas de objeto numa passagem: sem nenhum lido, a fonte falhou; com algum, a leitura para aí. */
const FAILURES_WITHOUT_SUCCESS = 3;
const FAILURES_PER_RUN = 10;
/** Depois de falhar nesta quantidade de passagens em que outros objetos foram lidos, o objeto é posto de lado. */
export const MAX_OBJECT_ATTEMPTS = 5;
/** Objetos com falhas contadas ao mesmo tempo. */
const MAX_TRACKED_FAILURES = 1_000;
const LEDGER_CHUNK = 1_000;
const GAP_CHUNK = 2_000;
/** As transações daqui esperam o lock da conta, que a descoberta pode segurar por alguns segundos. */
export const WRITE_TRANSACTION = { maxWait: 10_000, timeout: 20_000 } as const;

/** A autorização do balanceador (ou a conta, ou o cliente) deixou de valer no meio da leitura. */
export class SourceWithdrawn extends Error {
  constructor() {
    super('a autorização do balanceador foi retirada');
    this.name = 'SourceWithdrawn';
  }
}

/** O que a leitura usa do worker. */
export interface ReaderDeps {
  prisma: PrismaService;
  store: FindingStore;
  traffic: WebTrafficStore;
  countries: CountryLookup | null;
  readLimits: ReadLimits;
  now: () => Date;
  random: () => number;
  sleep: Sleep;
  throttle: { attempts: number; baseMs: number; maxMs: number };
}

/** Contagens de uma execução (vão para o log: nenhuma chave, caminho, host ou endereço). */
export interface ReadCounts {
  lists: number;
  /** Objetos lidos pela primeira vez, e os relidos para refazer a janela (não contam de novo). */
  objects: number;
  replayed: number;
  late: number;
  quarantined: number;
  gaps: number;
  /** Com fim no futuro: esperam a hora deles. */
  future: number;
  /** Apagados entre a listagem e a leitura. */
  gone: number;
  /** Chaves da pasta que não são do balanceador. */
  ignored: number;
  objectFailures: number;
  lines: number;
  malformed: number;
  oversize: number;
  foreign: number;
  bytes: number;
  /** Já registrados por outra réplica: nada foi somado. */
  duplicates: number;
  findings: number;
  excepted: number;
  /** Achados que abririam, com o balanceador só observando. */
  observed: number;
  throttled: number;
}

export const emptyCounts = (): ReadCounts => ({
  lists: 0,
  objects: 0,
  replayed: 0,
  late: 0,
  quarantined: 0,
  gaps: 0,
  future: 0,
  gone: 0,
  ignored: 0,
  objectFailures: 0,
  lines: 0,
  malformed: 0,
  oversize: 0,
  foreign: 0,
  bytes: 0,
  duplicates: 0,
  findings: 0,
  excepted: 0,
  observed: 0,
  throttled: 0,
});

/** O balanceador de uma passagem. */
export interface ReaderSource {
  tenantId: string;
  cloudAccountId: string;
  sourceId: string;
  authorizedAt: Date;
  bucket: AlbBucket;
  mode: 'observe' | 'alert';
  multiplier: number;
  wafCollecting: boolean;
  exceptions: readonly ActiveException[];
  memory: SourceMemory;
}

export interface Candidate extends AlbObject {
  hash: string;
  /** O que o registro diz dele; null se ainda não foi tratado. */
  status: WebLogObjectStatus | null;
}

interface Unsettled {
  object: Candidate;
  late: boolean;
  slotStart: Date;
  read: ObjectRead;
  malformed: number;
  foreign: number;
  deltas: TrafficDelta[];
}

const slotStartOf = (index: number): Date => new Date((index - 1) * SLOT_MS);

/** Uma avaliação inteira, soltando o laço de eventos entre os passos. */
export async function evaluateEngine(
  engine: WebLogEngine,
  input: Parameters<WebLogEngine['evaluateSteps']>[0],
  signal: AbortSignal,
): Promise<EvaluateResult> {
  const steps = engine.evaluateSteps(input);
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
    await nextTurn();
    signal.throwIfAborted();
  }
}

export class SourceReader {
  /** O S3 entregou o conteúdo de algum objeto. */
  opened = false;
  /** Algum objeto novo entrou no registro. */
  ingested = false;
  newestMs = 0;
  /** A leitura parou por falhas demais. */
  halted = false;
  private readOk = 0;
  private readonly failed: { hash: string; error: unknown }[] = [];
  private unsettled: Unsettled[] = [];
  private batch = { lines: 0, bytes: 0 };

  constructor(
    private readonly deps: ReaderDeps,
    private readonly source: ReaderSource,
    private readonly counts: ReadCounts,
    private readonly signal: AbortSignal,
  ) {}

  // --- O S3 ---

  /** Uma chamada ao S3, com nova tentativa se a AWS a limitar. A falha sai embrulhada, só com a ação. */
  private async call<T>(action: AlbAction, send: () => Promise<T>): Promise<T> {
    try {
      return await withThrottleRetry(send, {
        ...this.deps.throttle,
        random: this.deps.random,
        sleep: this.deps.sleep,
        signal: this.signal,
        onRetry: () => {
          this.counts.throttled += 1;
        },
      });
    } catch (error) {
      if (isFatal(error, this.signal)) throw error;
      throw new AlbCallError(action, error);
    }
  }

  /** Uma página da pasta de um dia. */
  async listPage(day: string, after: string | null): Promise<{ objects: AlbObject[]; next: string | null }> {
    const page = await this.call('s3:ListBucket', () => this.source.bucket.list(day, after));
    this.counts.lists += 1;
    this.counts.ignored += page.ignored;
    return page;
  }

  /**
   * Os objetos das pastas dos dias, do fim de intervalo `fromMs` (inclusive) ao slot `toIndex`. As chaves de uma pasta saem
   * em ordem de horário: a listagem começa e para no meio dela. `complete` é falso se o limite de páginas acabou antes.
   */
  async listRange(
    days: readonly string[],
    fromMs: number,
    toIndex: number,
    maxPages: number,
  ): Promise<{ objects: AlbObject[]; complete: boolean }> {
    const objects: AlbObject[] = [];
    let pages = 0;
    for (const day of days) {
      let after: string | null = `${folderOf(this.source.bucket.target, day)}${compactTime(fromMs)}`;
      while (after !== null) {
        if (pages >= maxPages) return { objects, complete: false };
        pages += 1;
        const page = await this.listPage(day, after);
        for (const object of page.objects) if (object.index <= toIndex) objects.push(object);
        const last = page.objects.at(-1);
        after = last !== undefined && last.index > toIndex ? null : page.next;
      }
    }
    return { objects, complete: true };
  }

  /** O que o registro diz de cada objeto. */
  async annotate(objects: readonly AlbObject[]): Promise<Candidate[]> {
    const { bucket, cloudAccountId, tenantId } = this.source;
    const candidates = objects.map((object): Candidate => ({
      ...object,
      hash: objectHash(bucket.target.bucket, object.key),
      status: null,
    }));
    for (let start = 0; start < candidates.length; start += LEDGER_CHUNK) {
      const chunk = candidates.slice(start, start + LEDGER_CHUNK);
      const rows = await this.deps.prisma.webLogObject.findMany({
        where: { cloudAccountId, tenantId, objectHash: { in: chunk.map((object) => object.hash) } },
        select: { objectHash: true, status: true },
      });
      const known = new Map(rows.map((row) => [row.objectHash, row.status as WebLogObjectStatus]));
      for (const object of chunk) object.status = known.get(object.hash) ?? null;
    }
    return candidates;
  }

  // --- A leitura ---

  /**
   * Lê os objetos na ordem dada, em lotes. `openAt` é o relógio de cada objeto (o de agora, ou o virtual do atraso);
   * `evaluateAt`, o da avaliação de um lote, com o próximo objeto por ler. Devolve os que ficaram por ler (o orçamento, ou
   * falhas demais). Quem chama avalia o último lote (`flush`).
   */
  async read(
    context: EngineContext,
    objects: readonly Candidate[],
    budget: RunBudget,
    clock: { openAt: (object: Candidate) => number; evaluateAt: (next: Candidate | null) => number },
    isLive: boolean,
  ): Promise<Candidate[]> {
    const skipped: Candidate[] = [];
    for (const [i, object] of objects.entries()) {
      this.signal.throwIfAborted();
      if (budget.exhausted || this.halted) return [...skipped, ...objects.slice(i)];
      // Depois da retirada, nenhum objeto novo é aberto.
      if (!(await this.allowed(this.deps.prisma))) throw new SourceWithdrawn();
      let outcome = await this.take(context, object, clock.openAt(object), budget);
      if (outcome === 'late_backlog') {
        await this.flush(context, clock.evaluateAt(object), isLive);
        outcome = await this.take(context, object, clock.openAt(object), budget);
      }
      if (outcome === 'late_backlog') skipped.push(object);
      const { lines, bytes } = this.batch;
      if (this.unsettled.length >= BATCH.objects || lines >= BATCH.lines || bytes >= BATCH.bytes) {
        await this.flush(context, clock.evaluateAt(objects[i + 1] ?? null), isLive);
      }
    }
    return skipped;
  }

  private async take(
    context: EngineContext,
    object: Candidate,
    openAt: number,
    budget: RunBudget,
  ): Promise<'taken' | 'late_backlog'> {
    const { memory, bucket } = this.source;
    const replay = object.status !== null;
    if (
      object.size > this.deps.readLimits.compressed ||
      (memory.attempts.get(object.hash) ?? 0) >= MAX_OBJECT_ATTEMPTS
    ) {
      await this.quarantine(object);
      return 'taken';
    }
    const traffic = replay ? null : new ObjectTraffic(this.deps.countries);
    const opened = context.engine.openObject(object.key, openAt, traffic);
    if (!opened.ok) {
      if (opened.reason === 'late_backlog') return 'late_backlog';
      // A mesma gramática e o mesmo balanceador da listagem: só um defeito nosso chega aqui.
      throw new Error(`objeto recusado pelo motor: ${opened.reason}`);
    }
    // As linhas que este motor já contou só voltam para a conta do objeto.
    const skip = context.seen.has(object.hash) ? Infinity : (context.partial.get(object.hash) ?? 0);
    let index = 0;
    let malformed = 0;
    let foreign = 0;
    const onLine = (line: string): void => {
      index += 1;
      if (replay && index <= skip) return;
      const outcome =
        index <= skip ? context.engine.recount(opened, line) : context.engine.ingest(opened, line);
      if (outcome === 'malformed') malformed += 1;
      else if (outcome === 'foreign') foreign += 1;
    };
    let read: ObjectRead = { bytes: 0, lines: 0, oversize: 0 };
    const progress = { bytes: 0 };
    if (object.size > 0) {
      try {
        const body = await this.call('s3:GetObject', () => bucket.open(object));
        this.opened = true;
        read = await readAlbObject(body, object.size, onLine, this.signal, {
          limits: this.deps.readLimits,
          progress,
        });
      } catch (error) {
        if (isFatal(error, this.signal)) throw error;
        // O que já entrou no motor não entra de novo.
        if (index > 0 && !context.seen.has(object.hash)) {
          context.partial.set(object.hash, Math.max(skip, index));
        }
        budget.spend({ objects: 1, lines: index, bytes: progress.bytes });
        if (error instanceof ObjectRejected || isArchived(error)) {
          // As linhas lidas até a recusa seguem na detecção, como piso (veja `quarantine`).
          if (index > 0) opened.slot.truncated = true;
          await this.quarantine(object);
        } else if (isGone(error)) this.counts.gone += 1;
        else this.objectFailed(object, error);
        return 'taken';
      }
    }
    context.partial.delete(object.hash);
    context.seen.set(object.hash, object.index);
    this.readOk += 1;
    this.batch.lines += read.lines;
    this.batch.bytes += read.bytes;
    budget.spend({ objects: 1, lines: read.lines, bytes: read.bytes });
    if (replay || traffic === null) {
      this.counts.replayed += 1;
      return 'taken';
    }
    const slotStart = new Date(opened.slot.startMs);
    this.unsettled.push({
      object,
      late: opened.late,
      slotStart,
      read,
      malformed,
      foreign,
      deltas: traffic.deltas(this.source, slotStart),
    });
    // A linha fora do intervalo do arquivo não adianta o relógio da fonte.
    this.newestMs = Math.max(this.newestMs, Math.min(traffic.newestMs, object.endMs));
    return 'taken';
  }

  /** Uma falha que pode passar: o objeto fica para a próxima. */
  private objectFailed(object: Candidate, error: unknown): void {
    this.counts.objectFailures += 1;
    this.failed.push({ hash: object.hash, error });
    if (this.readOk === 0) {
      const refused = albFailureOf(error).type === 'permission';
      if (refused || this.failed.length >= FAILURES_WITHOUT_SUCCESS) {
        throw error instanceof AlbCallError ? error : new AlbCallError('s3:GetObject', error);
      }
    }
    if (this.failed.length >= FAILURES_PER_RUN) this.halted = true;
  }

  /** O primeiro erro, se nada foi lido nesta passagem; as falhas dos objetos que sobraram ficam contadas na memória. */
  closeFailures(): unknown {
    if (this.failed.length === 0) return null;
    if (this.readOk === 0) return this.failed[0]?.error ?? null;
    const { attempts } = this.source.memory;
    if (attempts.size >= MAX_TRACKED_FAILURES) attempts.clear();
    for (const { hash } of this.failed) attempts.set(hash, (attempts.get(hash) ?? 0) + 1);
    return null;
  }

  /**
   * O objeto que não serve: registrado, contado e à vista. Não é cobrado nem entra no tráfego, e nunca é lido de novo. As
   * linhas lidas antes da recusa **ficam** na detecção, com as contagens do slot marcadas como piso (`counts_are_floor`):
   * descartá-las deixaria um ataque que estoura o limite do arquivo sumir dos achados.
   */
  async quarantine(object: Candidate, slotStart: Date | null = slotStartOf(object.index)): Promise<void> {
    // O relido que deixou de servir continua com o que já foi contado dele.
    if (object.status !== null) return;
    this.source.memory.attempts.delete(object.hash);
    const settled = await this.deps.prisma.$transaction(async (tx) => {
      await this.authorize(tx);
      return settleWebLogObject(
        tx,
        this.deps.traffic,
        { ...this.recordOf(object), status: 'quarantined', slotStart, ...ZERO },
        [],
      );
    }, WRITE_TRANSACTION);
    if (settled) this.counts.quarantined += 1;
  }

  /**
   * Os objetos velhos demais para ler: registrados e contados. `onRecorded` entra na mesma transação (a trilha), só com
   * objeto novo no registro. Devolve quantos são novos.
   */
  async recordGaps(
    objects: readonly Candidate[],
    onRecorded: (tx: Prisma.TransactionClient, count: number, chunk: readonly Candidate[]) => Promise<void>,
  ): Promise<number> {
    let recorded = 0;
    for (let start = 0; start < objects.length; start += GAP_CHUNK) {
      const chunk = objects.slice(start, start + GAP_CHUNK);
      recorded += await this.deps.prisma.$transaction(async (tx) => {
        await this.authorize(tx);
        const count = await settleWebLogGaps(
          tx,
          chunk.map((object) => ({ ...this.recordOf(object), slotStart: slotStartOf(object.index) })),
        );
        if (count > 0) await onRecorded(tx, count, chunk);
        return count;
      }, WRITE_TRANSACTION);
    }
    this.counts.gaps += recorded;
    return recorded;
  }

  private recordOf(object: Candidate) {
    const { tenantId, cloudAccountId, sourceId, bucket } = this.source;
    return {
      tenantId,
      cloudAccountId,
      sourceId,
      bucket: bucket.target.bucket,
      key: object.key,
      readAt: this.deps.now(),
    };
  }

  // --- A avaliação e a gravação ---

  /** Avalia o motor, grava (ou só conta, observando) os achados e, só depois, registra os objetos do lote. */
  async flush(context: EngineContext, evaluateAt: number, isLive: boolean): Promise<EvaluateResult> {
    const { memory, mode, multiplier, wafCollecting } = this.source;
    const result = await evaluateEngine(
      context.engine,
      { now: evaluateAt, wafCollecting, multiplier },
      this.signal,
    );
    if (isLive) {
      memory.suppressed = mergeSuppressed(memory.suppressed, result.suppressed, this.deps.now().getTime());
      memory.notes = result.notes;
    }
    if (mode === 'alert') await this.persist(result);
    else this.counts.observed += memory.observation.record(result.drafts);
    const settled = this.unsettled;
    this.unsettled = [];
    this.batch = { lines: 0, bytes: 0 };
    for (const item of settled) await this.settle(item);
    return result;
  }

  private async persist(result: EvaluateResult): Promise<void> {
    const { memory, exceptions } = this.source;
    for (const draft of result.drafts) {
      if (isPersisted(memory, draft)) continue;
      this.signal.throwIfAborted();
      const now = this.deps.now();
      const exception = matchingException(draft, exceptions, now);
      const outcome = await this.deps.store.persist(draft, exception, now, this.authorize);
      markPersisted(memory, draft);
      if (outcome !== 'duplicate') this.counts.findings += 1;
      if (outcome === 'excepted') this.counts.excepted += 1;
    }
  }

  /** A linha do objeto no registro, o tráfego e o volume dele: tudo ou nada, e uma vez só. */
  private async settle({
    object,
    late,
    slotStart,
    read,
    malformed,
    foreign,
    deltas,
  }: Unsettled): Promise<void> {
    const { tenantId } = this.source;
    const fresh = await this.deps.prisma.$transaction(async (tx) => {
      await this.authorize(tx);
      const record = {
        ...this.recordOf(object),
        status: late ? ('late' as const) : ('read' as const),
        slotStart,
        lines: read.lines,
        bytes: read.bytes,
        malformed,
        oversize: read.oversize,
        foreign,
      };
      if (!(await settleWebLogObject(tx, this.deps.traffic, record, deltas))) return false;
      const meter = new UsageMeter();
      // O mês é o da leitura; o dia, o do tráfego (`usage/usage-meter.ts`).
      meter.add(tenantId, 'aws', read.bytes, read.lines, this.deps.now());
      meter.addDaily(tenantId, 'aws', read.bytes, read.lines, slotStart);
      await meter.flushIn(tx);
      return true;
    }, WRITE_TRANSACTION);
    this.source.memory.attempts.delete(object.hash);
    if (!fresh) {
      this.counts.duplicates += 1;
      return;
    }
    this.ingested = true;
    this.counts.objects += 1;
    if (late) this.counts.late += 1;
    this.counts.lines += read.lines;
    this.counts.malformed += malformed;
    this.counts.oversize += read.oversize;
    this.counts.foreign += foreign;
    this.counts.bytes += read.bytes;
  }

  // --- A autorização ---

  /** A autorização desta leitura ainda vale, a conta está ativa e o cliente é coletado. */
  private async allowed(db: Pick<Prisma.TransactionClient, 'awsSource'>): Promise<boolean> {
    const { sourceId, tenantId, cloudAccountId, authorizedAt } = this.source;
    const row = await db.awsSource.findFirst({
      where: {
        id: sourceId,
        tenantId,
        cloudAccountId,
        authorizedAt,
        revokedAt: null,
        cloudAccount: { status: 'active', ...COLLECTING_TENANT },
      },
      select: { id: true },
    });
    return row !== null;
  }

  /** O mesmo, dentro da transação que grava, sob o lock da conta: a retirada espera, ou já valeu. */
  readonly authorize = async (tx: Prisma.TransactionClient): Promise<void> => {
    await lockAwsOnboarding(tx, this.source.cloudAccountId);
    if (!(await this.allowed(tx))) throw new SourceWithdrawn();
  };
}

const ZERO = { lines: 0, bytes: 0, malformed: 0, oversize: 0, foreign: 0 } as const;

/** O relógio virtual do atraso: logo depois do fim do slot, como se ele tivesse acabado de ser entregue. */
export const backlogClock = (index: number): number => index * SLOT_MS + MINUTE_MS;
