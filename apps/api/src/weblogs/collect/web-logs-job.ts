import { randomBytes, randomUUID } from 'node:crypto';
import {
  AWS_MAX_AUTHORIZED_WEB_SOURCES,
  AWS_SOURCE_ACTIVE_STATES,
  isAwsRegion,
  WEB_OBSERVE_MS,
} from '@verax/shared';
import type { ActiveException } from '../../alerts/exception-match.js';
import { FindingStore, SyncLease } from '../../alerts/finding-store.js';
import { type DiscoveryClientFactory, DiscoveryRunClients } from '../../aws/discovery/clients.js';
import { lockAwsOnboarding } from '../../aws/discovery/discovery-runs.js';
import { ReadOnlyViolation } from '../../aws/discovery/read-only.js';
import { abortableSleep, DEFAULT_THROTTLE_RETRY, type Sleep } from '../../aws/findings/throttle.js';
import { entersRole } from '../../aws/onboarding/account-access.js';
import { sourceDetails } from '../../aws/onboarding/onboarding-view.js';
import {
  AwsConnectionError,
  type AwsReaderCredentials,
  STS_FALLBACK_REGION,
} from '../../aws/web-identity.js';
import {
  type Backoff,
  type CollectorCursor,
  CollectorCursors,
  type CursorKey,
} from '../../collectors/collector-cursor.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { errorKind } from '../../common/logger/error-kind.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { concurrencyLimit } from '../../inventory/inventory.js';
import type { AlertNotices } from '../../notifications/finding-notices.js';
import type { ScopedExceptionSource } from '../../alerts/scoped-exception-match.js';
import { COLLECTING_TENANT } from '../../tenants/tenant-status.js';
import type { ProviderRanges } from '../data/proxy-ranges.js';
import { WebLogEngine } from '../engine.js';
import {
  CLOSE_DELAY_MS,
  DEFAULT_LIMITS,
  divideLimits,
  FUTURE_TOLERANCE_MS,
  KEEP_SLOTS,
  LONG_SLOTS,
  MINUTE_MS,
  SLOT_MS,
  type WebLimits,
} from '../limits.js';
import { deleteWebEngineState, saveWebEngineState } from '../store/web-engine-state.js';
import { WebTrafficStore } from '../store/web-traffic-store.js';
import type { CountryLookup } from '../traffic.js';
import { AlbBucket } from './alb-bucket.js';
import { type AlbTarget, albTargetOf, slotOf, utcDay, utcDays } from './alb-target.js';
import { ENGINE_STATE_VERSION, readEngineState, writeEngineState } from './engine-state.js';
import { READ_LIMITS, type ReadLimits } from './object-reader.js';
import { Observation } from './observation.js';
import { type BudgetAmounts, RunBudget } from './run-budget.js';
import { AlbCallError, albFailureOf, isFatal } from './s3-errors.js';
import { loadSourceConfig, type SourceConfig, webLogsStream } from './source-config.js';
import { type EngineContext, newContext, pruneContext, type SourceMemory } from './source-memory.js';
import {
  backlogClock,
  type Candidate,
  emptyCounts,
  type ReadCounts,
  type ReaderSource,
  SourceReader,
  SourceWithdrawn,
  WRITE_TRANSACTION,
} from './source-reader.js';
import { webLagSeconds, type WebOutcome, webSourceChange } from './web-health.js';

/** Nome da concessão em `SyncState` e da tarefa no agendador. */
export const WEB_LOGS_SYNC = 'web-logs';
/** A tarefa roda a cada 2 min; cada balanceador é lido de novo 5 min depois da última passagem. */
export const WEB_LOGS_TICK_MS = 2 * MINUTE_MS;
export const WEB_LOGS_INTERVAL_MS = 5 * MINUTE_MS;
/** O tempo que uma execução gasta abrindo objetos; passado dele, o que falta fica para a próxima. */
export const WEB_LOGS_RUN_BUDGET_MS = 4 * MINUTE_MS;
/** O orçamento do agendador: estourado, o sinal da execução é abortado. */
export const WEB_LOGS_BUDGET_MS = 8 * MINUTE_MS;
/**
 * A concessão não é devolvida entre uma execução e outra: o motor vive na memória, e duas réplicas que se revezassem veriam
 * metade dos objetos cada uma. Ela vence sozinha 5 min depois de o worker morrer.
 */
export const WEB_LOGS_LEASE_MS = 5 * MINUTE_MS;
/** Por execução, somados todos os balanceadores. */
export const WEB_LOGS_RUN_AMOUNTS: BudgetAmounts = { objects: 500, lines: 2_000_000, bytes: 1_500_000_000 };
/** Balanceadores lidos ao mesmo tempo. */
export const WEB_LOGS_CONCURRENCY = 2;
/** O que é mais velho que isto não é lido: fica registrado como lacuna (D3 do desenho). */
export const WEB_LOGS_MAX_AGE_MS = 24 * 60 * MINUTE_MS;
/** A conferência inteira das pastas de ontem e de hoje contra o registro: acha o que chegou atrasado. */
export const WEB_LOGS_DEEP_INTERVAL_MS = 60 * MINUTE_MS;
/** A lacuna mais velha que isto não é contada arquivo por arquivo: o registro já não a guardaria. */
export const WEB_LOGS_MAX_GAP_SCAN_MS = 9 * 24 * 60 * MINUTE_MS;
/** A passagem das contagens por país de 5 minutos para as horas. */
export const WEB_LOGS_ROLLUP_INTERVAL_MS = 60 * MINUTE_MS;
/** A leitura de um objeto, do pedido ao último byte. */
export const WEB_LOGS_OBJECT_TIMEOUT_MS = 150_000;
/** Depois de uma falha passageira: 5 min, dobrando, até 1 h. */
export const WEB_LOGS_BACKOFF: Readonly<Backoff> = { baseMs: 5 * MINUTE_MS, maxMs: 60 * MINUTE_MS };
/** Depois de uma recusa: 15 min, dobrando, até 6 h (cada tentativa é um acesso negado na trilha do cliente). */
export const WEB_LOGS_REFUSAL_BACKOFF: Readonly<Backoff> = {
  baseMs: 15 * MINUTE_MS,
  maxMs: 6 * 60 * MINUTE_MS,
};

/** Páginas de listagem por passagem de um balanceador. */
const LIVE_PAGES = 30;
const DEEP_PAGES = 40;
const GAP_PAGES = 100;
const BACKLOG_PAGES = 20;
/** Slots listados de cada vez no atraso (3 h) e na lacuna (1 dia). */
const BACKLOG_WINDOW = 36;
const GAP_WINDOW = 288;
/** Motores de atraso ao mesmo tempo, com uma fração da memória de um motor. */
const MAX_BACKLOGS = 2;
const BACKLOG_SHARE = 4;
/** Partes do orçamento na primeira vez de cada balanceador. */
const MAX_SLICES = 4;
const AUDIT_ACTION = 'cloud_account.aws_source_collection';

export type WebLogsCredentials = Pick<AwsReaderCredentials, 'session' | 'credentialsFor'>;

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente nem do log). */
export interface WebLogsReport extends ReadCounts {
  /** `locked`: outra réplica tem a concessão; `lease_lost`: ela venceu no meio e outra réplica a tomou. */
  status: 'done' | 'locked' | 'lease_lost';
  /** Balanceadores autorizados na coleta. */
  sources: number;
  /** Além do teto por conta. */
  overLimit: number;
  /** Contas que não entram no papel agora: esperam a conferência da conexão. */
  waiting: number;
  notDue: number;
  /** Ficaram para a execução seguinte, pelo tempo. */
  deferred: number;
  synced: number;
  /** Dos lidos, os que ainda têm objeto à espera. */
  capped: number;
  /** Com atraso a recuperar. */
  backlog: number;
  /** Com a leitura da AWS falhando. */
  failed: number;
  /** Com erro que não é da AWS (banco, gravação). */
  broken: number;
  /** A autorização foi retirada no meio. */
  withdrawn: number;
  /** O balanceador foi recriado com o mesmo nome. */
  replaced: number;
  transitions: number;
  /** Linhas do tráfego por país que passaram para as horas. */
  rolledUp: number;
  failures?: Record<string, number>;
}

export interface WebLogsOptions {
  audit?: AuditService;
  notices?: AlertNotices;
  /** As exceções amplas (casos, PR-9), só com `CASES_MODE=on`. */
  scopedExceptions?: ScopedExceptionSource;
  /** A evidência de um achado foi recusada: ele foi gravado sem ela. Recebe só o id da regra. */
  onEvidenceRefused?: (ruleId: string) => void;
  /** A tabela de países; null: o tráfego sai com o país desconhecido. */
  countries?: CountryLookup | null;
  name?: string;
  owner?: string;
  leaseMs?: number;
  now?: () => Date;
  elapsed?: () => number;
  random?: () => number;
  sleep?: Sleep;
  throttle?: { attempts: number; baseMs: number; maxMs: number };
  intervalMs?: number;
  runBudgetMs?: number;
  amounts?: BudgetAmounts;
  concurrency?: number;
  limits?: WebLimits;
  readLimits?: ReadLimits;
  objectTimeoutMs?: number;
  backoff?: Backoff;
  refusalBackoff?: Backoff;
  /** Só os testes: as faixas das CDNs no lugar das vendorizadas. */
  ranges?: readonly ProviderRanges[];
  /** Só os testes, que dividem o banco: restringe a execução às contas destes clientes. */
  tenantIds?: readonly string[];
}

const ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  accountId: true,
  regions: true,
  connection: true,
  connectionError: true,
  ingestFrom: true,
} as const satisfies Prisma.CloudAccountSelect;
type AccountRow = Prisma.CloudAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

const SOURCE_SELECT = {
  id: true,
  tenantId: true,
  cloudAccountId: true,
  kind: true,
  region: true,
  resourceId: true,
  details: true,
  state: true,
  stateCode: true,
  permission: true,
  permissionDetail: true,
  authorizedAt: true,
  lastEventAt: true,
  lastIngestedAt: true,
} as const satisfies Prisma.AwsSourceSelect;
type SourceRow = Prisma.AwsSourceGetPayload<{ select: typeof SOURCE_SELECT }> & { authorizedAt: Date };

/** A concessão não é mais deste worker: a execução para onde está. */
class LeaseLost extends Error {
  constructor() {
    super('logs do ALB: concessão perdida');
    this.name = 'LeaseLost';
  }
}

/** Um balanceador na hora de ler. */
interface Item {
  account: AccountRow;
  source: SourceRow;
  key: CursorKey;
  cursor: CollectorCursor;
  pass: Pass | null;
}

/** A passagem de um balanceador, da leitura ao vivo ao fechamento. Os números de slot são `fim / 5 min`. */
interface Pass {
  item: Item;
  target: AlbTarget;
  source: ReaderSource;
  reader: SourceReader;
  nowMs: number;
  /** O primeiro slot inteiro depois da autorização. */
  first: number;
  /** O último slot já tratado. */
  position: number;
  /** O último slot fechado, e o último que já saiu da janela do motor. */
  closed: number;
  oldest: number;
  /** Os que o motor ao vivo ainda não leu. */
  pending: Candidate[];
  /** A listagem ao vivo foi cortada neste slot. */
  cutAt: number | null;
  /** Atrasados que ficaram para a próxima, e o atraso que não acabou. */
  lateLeft: number;
  backlogLeft: boolean;
}

interface RunContext {
  signal: AbortSignal;
  /** Abortado quando a concessão é perdida: os balanceadores em curso param. */
  ownership: AbortController;
  report: WebLogsReport;
  budget: RunBudget;
  exceptions: ReadonlyMap<string, ActiveException[]>;
  /** As fontes do WAF que estão coletando: `conta|região` (`conta|` na linha do cadastro anterior). */
  waf: ReadonlySet<string>;
  clients: Map<string, Promise<AccountClients>>;
  slices: number;
  expired: () => boolean;
  firstError: string | null;
}

interface AccountClients {
  calls: DiscoveryRunClients;
  bodies: DiscoveryRunClients;
}

/** Um erro que o cursor guarda só pelo código. */
const named = (code: string): Error => Object.assign(new Error(code), { name: code });
const iso = (index: number): string => new Date(index * SLOT_MS).toISOString();
const byTime = (a: Candidate, b: Candidate): number => a.index - b.index || (a.key < b.key ? -1 : 1);
const unread = (object: Candidate): boolean => object.status === null;
/** Já analisado: só volta a ser lido para refazer a janela. */
const analysed = (object: Candidate): boolean => object.status === 'read' || object.status === 'late';

/**
 * Tarefa `web-logs` do worker: lê do S3 do cliente, só leitura, os logs de acesso dos balanceadores autorizados, passa as
 * linhas pelo motor (`weblogs/engine.ts`), grava os achados e mede o volume e o tráfego por país. Só existe com
 * `AWS_WEB_LOGS_ENABLED`, fora da célula.
 *
 * **Quem entra:** a fonte `elb_logs` autorizada e não retirada, num estado de coleta, de conta ativa já verificada que entra
 * no papel, de cliente coletado. A permissão gravada não decide: quem prova é a leitura.
 *
 * **Uma passagem** (a cada 5 min por balanceador, dois ao mesmo tempo, primeiro quem está há mais tempo sem vez), em duas fases:
 * 1. ao vivo: os objetos dos últimos 70 minutos que o motor ainda não leu, em ordem. No primeiro uso (ou depois de um
 *    reinício), os já registrados são relidos para refazer as janelas, sem contar de novo;
 * 2. com o que sobrou do orçamento: o que ficou da fase 1; a lacuna (mais de 24 h); a conferência de hora em hora das pastas
 *    de ontem e de hoje (o que chegou atrasado é avaliado sozinho); e o atraso, do mais antigo para o mais novo, num motor à
 *    parte com relógio virtual.
 *
 * **O slot que ainda não foi lido não fecha:** com objeto à espera, a avaliação usa o relógio dele, e não o de agora.
 *
 * **Estado entre reinícios:** o resumo do dia do motor, a observação e o que as fontes confiáveis calaram
 * (`WebEngineState`), gravados no máximo uma vez por slot fechado. O resto da memória é refeito do S3. Uma parada de mais de
 * 70 minutos vira atraso, e o resumo do dia (990400) de hoje conta só o que o motor ao vivo viu.
 *
 * **Balanceador recriado:** a fonte é pelo nome. Se o `app/<nome>/<id>` mudou, é outro balanceador: nada do estado do
 * anterior vale, e a observação de 72 h recomeça (o modo volta a `observe`), na trilha do cliente.
 *
 * O tráfego do ALB nunca conta como sinal de vida da conta (`LastEvents`): ele esconderia uma trilha parada.
 */
export class WebLogsCollector {
  private readonly audit: AuditService;
  private readonly lease: SyncLease;
  private readonly cursors: CollectorCursors;
  private readonly store: FindingStore;
  private readonly traffic: WebTrafficStore;
  private readonly hashKey = randomBytes(16);
  private readonly countries: CountryLookup | null;
  private readonly name: string;
  private readonly now: () => Date;
  private readonly elapsed: () => number;
  private readonly random: () => number;
  private readonly sleep: Sleep;
  private readonly throttle: { attempts: number; baseMs: number; maxMs: number };
  private readonly intervalMs: number;
  private readonly runBudgetMs: number;
  private readonly amounts: BudgetAmounts;
  private readonly concurrency: number;
  private readonly limits: WebLimits;
  private readonly readLimits: ReadLimits;
  private readonly objectTimeoutMs: number;
  private readonly backoff: Backoff;
  private readonly refusalBackoff: Backoff;
  private readonly ranges: readonly ProviderRanges[] | undefined;
  private readonly tenantIds: readonly string[] | undefined;
  private readonly renewEveryMs: number;
  private readonly memories = new Map<string, SourceMemory>();
  private readonly backlogs = new Set<string>();
  /** A ordem da última vez de cada balanceador: havia orçamento quando ela chegou. */
  private readonly turns = new Map<string, number>();
  private turn = 0;
  private rolledAt: number | null = null;
  /** Em quantas partes a memória do motor está dividida. */
  private share = 1;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: WebLogsCredentials,
    private readonly clients: DiscoveryClientFactory,
    {
      audit = new AuditService(),
      notices,
      scopedExceptions,
      onEvidenceRefused,
      countries = null,
      name = WEB_LOGS_SYNC,
      owner = `worker-${randomUUID()}`,
      leaseMs = WEB_LOGS_LEASE_MS,
      now = () => new Date(),
      elapsed = () => performance.now(),
      random = Math.random,
      sleep = abortableSleep,
      throttle = DEFAULT_THROTTLE_RETRY,
      intervalMs = WEB_LOGS_INTERVAL_MS,
      runBudgetMs = WEB_LOGS_RUN_BUDGET_MS,
      amounts = WEB_LOGS_RUN_AMOUNTS,
      concurrency = WEB_LOGS_CONCURRENCY,
      limits = DEFAULT_LIMITS,
      readLimits = READ_LIMITS,
      objectTimeoutMs = WEB_LOGS_OBJECT_TIMEOUT_MS,
      backoff = WEB_LOGS_BACKOFF,
      refusalBackoff = WEB_LOGS_REFUSAL_BACKOFF,
      ranges,
      tenantIds,
    }: WebLogsOptions = {},
  ) {
    this.audit = audit;
    this.lease = new SyncLease(prisma, name, owner, leaseMs);
    this.renewEveryMs = Math.max(250, Math.floor(leaseMs / 3));
    this.cursors = new CollectorCursors(prisma);
    this.store = new FindingStore(prisma, notices, {
      ...(onEvidenceRefused !== undefined && { onEvidenceRefused }),
      ...(scopedExceptions !== undefined && { scopedExceptions }),
    });
    this.traffic = new WebTrafficStore(prisma);
    this.countries = countries;
    this.name = name;
    this.now = now;
    this.elapsed = elapsed;
    this.random = random;
    this.sleep = sleep;
    this.throttle = throttle;
    this.intervalMs = intervalMs;
    this.runBudgetMs = runBudgetMs;
    this.amounts = amounts;
    this.concurrency = concurrency;
    this.limits = limits;
    this.readLimits = readLimits;
    this.objectTimeoutMs = objectTimeoutMs;
    this.backoff = backoff;
    this.refusalBackoff = refusalBackoff;
    this.ranges = ranges;
    this.tenantIds = tenantIds;
  }

  // --- A execução ---

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<WebLogsReport> {
    const report = emptyReport();
    const startedAt = this.now();
    // A concessão que continuou deste processo, sem interrupção, é o que faz valer o que está na memória.
    if (!(await this.lease.renew())) {
      this.forgetAll();
      if (!(await this.lease.acquire(startedAt))) return { ...report, status: 'locked' };
    }
    const ownership = new AbortController();
    const active = AbortSignal.any([signal, ownership.signal]);
    const keeper = setInterval(() => void this.keepLease(ownership), this.renewEveryMs);
    const startedClock = this.elapsed();
    const expired = (): boolean => this.elapsed() - startedClock >= this.runBudgetMs;
    const context: RunContext = {
      signal: active,
      ownership,
      report,
      budget: new RunBudget(this.amounts, expired),
      exceptions: new Map(),
      waf: new Set(),
      clients: new Map(),
      slices: 1,
      expired,
      firstError: null,
    };
    try {
      const items = await this.selectItems(context, startedAt);
      if (items.length > 0) await this.collect(items, context);
      await this.rollUp(context);
      active.throwIfAborted();
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastRunAt: startedAt,
          ...(context.firstError === null && { lastSuccessAt: this.now() }),
          lastError: context.firstError,
        },
      });
      // Até a próxima execução, a concessão continua deste processo.
      if (!(await this.lease.renew())) this.forgetAll();
      return report;
    } catch (error) {
      this.forgetAll();
      if (ownership.signal.aborted && !signal.aborted) return { ...report, status: 'lease_lost' };
      // Só o tipo do erro: a mensagem de um erro do banco pode carregar dado.
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: { lastRunAt: startedAt, lastError: errorKind(error) },
      });
      // A memória já foi embora: quem quiser pode assumir na hora (a parada do worker, o orçamento).
      await this.lease.release();
      throw error;
    } finally {
      clearInterval(keeper);
      for (const opened of context.clients.values()) {
        const clients = await opened.catch(() => null);
        clients?.calls.destroy();
        clients?.bodies.destroy();
      }
    }
  }

  /** Na parada do worker: devolve a concessão, para o próximo processo não esperar ela vencer. */
  async close(): Promise<void> {
    this.forgetAll();
    await this.lease.release();
  }

  private forget(sourceId: string): void {
    this.memories.delete(sourceId);
    this.backlogs.delete(sourceId);
  }

  private forgetAll(): void {
    this.memories.clear();
    this.backlogs.clear();
  }

  private tenantFilter(): { tenantId?: { in: string[] } } {
    return this.tenantIds === undefined ? {} : { tenantId: { in: [...this.tenantIds] } };
  }

  /** Renova a concessão. Perdida, aborta a execução. Uma falha do banco fica para a renovação seguinte. */
  private async keepLease(ownership: AbortController): Promise<void> {
    if (ownership.signal.aborted) return;
    try {
      if (!(await this.lease.renew())) ownership.abort(new LeaseLost());
    } catch {
      // O banco fora agora: a próxima renovação decide.
    }
  }

  /**
   * Os balanceadores na hora de ler, em rodízio: primeiro quem teve a vez há mais tempo (ou nunca). Com mais
   * balanceadores cheios do que partes do orçamento, o que sobra de uma execução abre a seguinte: ninguém fica sem leitura.
   */
  private async selectItems(context: RunContext, now: Date): Promise<Item[]> {
    const { report } = context;
    const rows = await this.prisma.awsSource.findMany({
      where: {
        kind: 'elb_logs',
        origin: 'discovered',
        authorizedAt: { not: null },
        revokedAt: null,
        state: { in: [...AWS_SOURCE_ACTIVE_STATES] },
        cloudAccount: {
          provider: 'aws',
          status: 'active',
          ingestFrom: { not: null },
          connection: { in: ['connected', 'error'] },
          ...COLLECTING_TENANT,
        },
        ...this.tenantFilter(),
      },
      select: { ...SOURCE_SELECT, cloudAccount: { select: ACCOUNT_SELECT } },
      orderBy: [{ authorizedAt: 'asc' }, { id: 'asc' }],
    });
    const perAccount = new Map<string, number>();
    const selected: { account: AccountRow; source: SourceRow }[] = [];
    for (const { cloudAccount: account, ...row } of rows) {
      if (row.authorizedAt === null || !isAwsRegion(row.region)) continue;
      const count = (perAccount.get(account.id) ?? 0) + 1;
      perAccount.set(account.id, count);
      if (count > AWS_MAX_AUTHORIZED_WEB_SOURCES) {
        report.overLimit += 1;
        continue;
      }
      selected.push({ account, source: { ...row, authorizedAt: row.authorizedAt } });
    }
    report.sources = selected.length;
    const kept = new Set(selected.map(({ source }) => source.id));
    for (const sourceId of this.memories.keys()) if (!kept.has(sourceId)) this.forget(sourceId);
    for (const sourceId of this.turns.keys()) if (!kept.has(sourceId)) this.turns.delete(sourceId);
    // Em potências de dois: cada balanceador a mais não refaz todos os motores.
    this.share = 2 ** Math.ceil(Math.log2(Math.max(1, selected.length)));

    const items: Item[] = [];
    const refused = new Set<string>();
    for (const { account, source } of selected) {
      if (!entersRole(account)) {
        refused.add(account.id);
        continue;
      }
      const key: CursorKey = {
        cloudAccountId: account.id,
        stream: webLogsStream(source.resourceId),
        region: source.region,
      };
      const cursor = await this.cursors.read(key, now);
      // O recém-autorizado (ou que a descoberta devolveu à coleta) é lido já, sem esperar o recuo de antes.
      if (source.state !== 'authorized' && cursor.nextRunAt.getTime() > now.getTime()) {
        report.notDue += 1;
        continue;
      }
      items.push({ account, source, key, cursor, pass: null });
    }
    report.waiting = refused.size;
    const last = ({ source }: Item): number => this.turns.get(source.id) ?? 0;
    return items.sort(
      (a, b) => last(a) - last(b) || a.cursor.nextRunAt.getTime() - b.cursor.nextRunAt.getTime(),
    );
  }

  private async collect(items: readonly Item[], context: RunContext): Promise<void> {
    const now = this.now();
    context.exceptions = await this.store.activeExceptions(now);
    context.waf = await this.collectingWaf(items);
    context.slices = Math.min(MAX_SLICES, items.length);
    const limit = concurrencyLimit(this.concurrency);
    const phase = async (step: (item: Item) => Promise<void>): Promise<void> => {
      const results = await Promise.allSettled(
        items.map((item) =>
          limit(async () => {
            context.signal.throwIfAborted();
            await this.contained(item, context, step);
          }),
        ),
      );
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected !== undefined) throw rejected.reason;
    };
    await phase((item) => this.begin(item, context));
    await phase((item) => (item.pass === null ? Promise.resolve() : this.finish(item.pass, context)));
  }

  /**
   * Um passo de um balanceador: a falha dele fica nele. A parada do worker, a concessão perdida e a trava de só leitura
   * (um defeito nosso) param a execução. A falha do S3 não estraga a memória dele (o motor sabe o que já contou de cada
   * objeto); qualquer outra (o banco, a gravação) a joga fora: a passagem seguinte a refaz, e o que não chegou ao registro é
   * lido de novo.
   */
  private async contained(
    item: Item,
    context: RunContext,
    step: (item: Item) => Promise<void>,
  ): Promise<void> {
    const { report, signal } = context;
    try {
      await step(item);
    } catch (error) {
      item.pass = null;
      if (error instanceof LeaseLost) context.ownership.abort(error);
      if (signal.aborted || error instanceof ReadOnlyViolation) throw error;
      if (error instanceof AwsConnectionError) {
        // A entrada no papel recusada (ou a sessão que caiu): quem trata é a conferência da conexão. A fonte fica como está,
        // e é tentada de novo no intervalo de sempre.
        this.countFailure(report, error.code);
        const retryAt = new Date(this.now().getTime() + this.intervalMs);
        await this.contained(item, context, () => this.cursors.postpone(item.key, retryAt));
        return;
      }
      if (error instanceof AlbCallError) {
        await this.contained(item, context, () => this.failSource(item, error, context));
        return;
      }
      this.forget(item.source.id);
      if (error instanceof SourceWithdrawn) {
        report.withdrawn += 1;
        return;
      }
      report.broken += 1;
      context.firstError ??= errorKind(error);
    }
  }

  private countFailure(report: WebLogsReport, code: string): void {
    report.failed += 1;
    report.failures = { ...report.failures, [code]: (report.failures?.[code] ?? 0) + 1 };
  }

  /** As fontes do WAF das contas que estão de fato coletando: a Web ACL regional, ou o bucket do cadastro anterior. */
  private async collectingWaf(items: readonly Item[]): Promise<Set<string>> {
    const rows = await this.prisma.awsSource.findMany({
      where: {
        cloudAccountId: { in: [...new Set(items.map((item) => item.account.id))] },
        kind: 'waf',
        state: 'collecting',
        authorizedAt: { not: null },
        revokedAt: null,
      },
      select: { cloudAccountId: true, region: true, origin: true },
    });
    return new Set(rows.map((row) => `${row.cloudAccountId}|${row.origin === 'legacy' ? '' : row.region}`));
  }

  /** Os clientes do S3 de uma conta, com a trava de só leitura: um para as chamadas, outro para os corpos. */
  private async accountClients(account: AccountRow, context: RunContext): Promise<AccountClients> {
    const known = context.clients.get(account.id);
    if (known !== undefined) return known;
    const opening = (async (): Promise<AccountClients> => {
      const home = account.regions.find(isAwsRegion) ?? STS_FALLBACK_REGION;
      // A entrada no papel primeiro: recusada, nenhuma outra chamada.
      await this.credentials.session(account.accountId, home, context.signal);
      const make = (callTimeoutMs?: number): DiscoveryRunClients =>
        new DiscoveryRunClients(
          this.clients(this.credentials.credentialsFor(account.accountId, home), home),
          home,
          context.signal,
          callTimeoutMs === undefined ? {} : { callTimeoutMs },
        );
      return { calls: make(), bodies: make(this.objectTimeoutMs) };
    })();
    context.clients.set(account.id, opening);
    return opening;
  }

  // --- Fase 1: ao vivo ---

  private async begin(item: Item, context: RunContext): Promise<void> {
    const { account, source } = item;
    const { report, signal } = context;
    if (context.expired()) {
      report.deferred += 1;
      return;
    }
    // Antes de qualquer passo: a vez de quem falha também conta, e não volta na frente dos outros.
    if (!context.budget.exhausted) this.turns.set(source.id, ++this.turn);
    const target = albTargetOf(account.accountId, source.region, sourceDetails(source.details));
    if (typeof target === 'string') {
      this.forget(source.id);
      this.countFailure(report, target);
      const now = this.now();
      // Nada é pedido à AWS: a descoberta que corrigir a fonte é vista em até uma hora.
      await this.cursors.fail(item.key, named(target), now, { backoff: this.backoff });
      const lagSeconds = webLagSeconds(item.cursor.cursorAt, now);
      const outcome: WebOutcome = { type: 'failed', code: target, failures: 1, immediate: true, lagSeconds };
      await this.record(item, outcome, now, context);
      return;
    }
    const { calls, bodies } = await this.accountClients(account, context);
    // O bucket do log do ALB fica na região do balanceador; noutra, o cliente segue o redirecionamento.
    const bucket = new AlbBucket(calls.s3(source.region), bodies.s3(source.region), target);
    const now = this.now();
    const owner = {
      tenantId: source.tenantId,
      cloudAccountId: account.id,
      sourceId: source.id,
      authorizedAt: source.authorizedAt,
    };
    let config = await loadSourceConfig(this.prisma, owner);
    const replaced = await this.replacedBalancer(item, target, now, context);
    if (replaced) config = await loadSourceConfig(this.prisma, owner);
    const memory = await this.memoryOf(item, target, config, now);
    const readerSource: ReaderSource = {
      ...owner,
      bucket,
      mode: config.mode,
      multiplier: config.multiplier,
      wafCollecting: context.waf.has(`${account.id}|${source.region}`) || context.waf.has(`${account.id}|`),
      exceptions: context.exceptions.get(source.tenantId) ?? [],
      memory,
    };
    const deps = {
      prisma: this.prisma,
      store: this.store,
      traffic: this.traffic,
      countries: this.countries,
      readLimits: this.readLimits,
      now: this.now,
      random: this.random,
      sleep: this.sleep,
      throttle: this.throttle,
    };
    const nowMs = now.getTime();
    const first = slotOf(source.authorizedAt.getTime()) + 1;
    const { cursorAt } = item.cursor;
    const pass: Pass = {
      item,
      target,
      source: readerSource,
      reader: new SourceReader(deps, readerSource, report, signal),
      nowMs,
      first,
      position: Math.max(first - 1, cursorAt === null ? 0 : Math.floor(cursorAt.getTime() / SLOT_MS)),
      closed: Math.floor((nowMs - CLOSE_DELAY_MS) / SLOT_MS),
      oldest: slotOf(nowMs) - KEEP_SLOTS,
      pending: [],
      cutAt: null,
      lateLeft: 0,
      backlogLeft: false,
    };
    // A configuração de agora, sempre: a validade das fontes confiáveis só é olhada aqui.
    memory.live.engine.configure({ now: nowMs, routes: config.routes, trusted: config.trusted });
    memory.backlog?.context?.engine.configure({ now: nowMs, routes: config.routes, trusted: config.trusted });
    pass.pending = await this.listLive(pass, context);
    await this.readLive(pass, context.budget.slice(context.slices), context);
    item.pass = pass;
  }

  /** Os objetos dos últimos 70 minutos que o motor ao vivo ainda não leu, em ordem. */
  private async listLive(pass: Pass, context: RunContext): Promise<Candidate[]> {
    const { reader, nowMs } = pass;
    const { seen } = pass.source.memory.live;
    const from = Math.max(pass.oldest, pass.first - 1);
    const listed = await reader.listRange(
      utcDays(from * SLOT_MS, nowMs),
      from * SLOT_MS,
      Infinity,
      LIVE_PAGES,
    );
    if (!listed.complete) pass.cutAt = listed.objects.at(-1)?.index ?? pass.position;
    const ready: Candidate[] = [];
    for (const object of await reader.annotate(listed.objects.filter(({ index }) => index > from))) {
      if (object.endMs > nowMs + FUTURE_TOLERANCE_MS) {
        if (!unread(object)) continue;
        // Um relógio adiantado se resolve sozinho; uma data absurda, não.
        if (object.endMs > nowMs + WEB_LOGS_MAX_AGE_MS) await reader.quarantine(object, null);
        else context.report.future += 1;
        continue;
      }
      if (unread(object) || (analysed(object) && !seen.has(object.hash))) ready.push(object);
    }
    return ready.sort(byTime);
  }

  /** O relógio da avaliação ao vivo: o de agora ou, com objeto à espera, o fim do slot dele (que assim não fecha). */
  private liveClock(pass: Pass, pending: readonly Candidate[]): number {
    const waiting = pending.reduce((min, { index }) => Math.min(min, index), pass.cutAt ?? Infinity);
    return Math.min(pass.nowMs, waiting * SLOT_MS);
  }

  private async readLive(pass: Pass, budget: RunBudget, context: RunContext): Promise<void> {
    const { reader, nowMs } = pass;
    const { memory } = pass.source;
    const { live } = memory;
    pass.pending = await reader.read(
      live,
      pass.pending,
      budget,
      {
        openAt: () => nowMs,
        evaluateAt: (next) => this.liveClock(pass, next === null ? [] : [next]),
      },
      true,
    );
    const result = await reader.flush(live, this.liveClock(pass, pass.pending), true);
    pruneContext(live, pass.oldest);
    await this.saveState(pass, result.closedThrough, context);
  }

  // --- Fase 2: o que sobrou, a lacuna, os atrasados e o atraso ---

  private async finish(pass: Pass, context: RunContext): Promise<void> {
    if (pass.pending.length > 0 && !context.budget.exhausted)
      await this.readLive(pass, context.budget, context);
    await this.gaps(pass, context);
    await this.deep(pass, context);
    await this.backlog(pass, context);
    await this.conclude(pass, context);
  }

  /** O que passou de 24 h sem leitura: registrado, contado e na trilha. */
  private async gaps(pass: Pass, context: RunContext): Promise<void> {
    const { reader, item } = pass;
    const limit = Math.floor((pass.nowMs - WEB_LOGS_MAX_AGE_MS) / SLOT_MS);
    const floor = Math.floor((pass.nowMs - WEB_LOGS_MAX_GAP_SCAN_MS) / SLOT_MS);
    if (pass.position < floor) {
      await this.uncountedGap(pass, pass.position, floor);
      pass.position = floor;
      await this.moveCursor(item, pass.position);
    }
    while (pass.position < limit && !context.expired()) {
      context.signal.throwIfAborted();
      const to = Math.min(limit, pass.position + GAP_WINDOW);
      const fromMs = pass.position * SLOT_MS;
      const listed = await reader.listRange(utcDays(fromMs, pass.nowMs), fromMs, to, GAP_PAGES);
      const left = (await reader.annotate(listed.objects)).filter(
        (object) => unread(object) && object.index >= pass.first,
      );
      await reader.recordGaps(left, (tx, count, chunk) => this.auditGapOf(tx, pass, count, chunk));
      if (!listed.complete) await this.uncountedGap(pass, pass.position, to);
      pass.position = to;
      await this.moveCursor(item, pass.position);
    }
  }

  /** A lacuna que não foi contada arquivo por arquivo (velha demais, ou com arquivos demais): só na trilha. */
  private async uncountedGap(pass: Pass, from: number, to: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await pass.reader.authorize(tx);
      await this.auditGap(tx, pass, { objects: null, from: iso(from), to: iso(to) });
    }, WRITE_TRANSACTION);
  }

  private async moveCursor(item: Item, index: number): Promise<void> {
    const at = new Date(index * SLOT_MS);
    item.cursor = await this.cursors.advance(
      item.key,
      { cursorAt: at, continuation: null, nextRunAt: item.cursor.nextRunAt },
      this.now(),
    );
  }

  private auditGapOf(
    tx: Prisma.TransactionClient,
    pass: Pass,
    count: number,
    chunk: readonly Candidate[],
  ): Promise<void> {
    const indexes = chunk.map(({ index }) => index);
    return this.auditGap(tx, pass, {
      objects: count,
      from: iso(Math.min(...indexes) - 1),
      to: iso(Math.max(...indexes)),
    });
  }

  private async auditGap(
    tx: Prisma.TransactionClient,
    pass: Pass,
    gap: { objects: number | null; from: string; to: string },
  ): Promise<void> {
    const { source, account } = pass.item;
    await this.audit.write(tx, {
      actor: { type: 'system', tenantId: source.tenantId },
      action: AUDIT_ACTION,
      outcome: 'success',
      resourceType: 'cloud_account',
      resourceId: account.id,
      after: { sourceId: source.id, kind: source.kind, region: source.region, code: 'web_gap', ...gap },
    });
  }

  /**
   * De hora em hora, as pastas de ontem e de hoje inteiras contra o registro: a pasta é a do dia da entrega, então todo
   * objeto que chegou atrasado está numa delas. O de um slot já tratado é avaliado sozinho (a contagem é um piso).
   */
  private async deep(pass: Pass, context: RunContext): Promise<void> {
    const { reader, nowMs, source } = pass;
    const { memory } = source;
    const due = memory.deepAt === null || nowMs - memory.deepAt >= WEB_LOGS_DEEP_INTERVAL_MS;
    if (!due || context.budget.exhausted || reader.halted) return;
    const days = [utcDay(nowMs - WEB_LOGS_MAX_AGE_MS), utcDay(nowMs)];
    const limit = nowMs - WEB_LOGS_MAX_AGE_MS;
    const late: Candidate[] = [];
    let { day, after } = memory.deepFrom;
    let pages = 0;
    while (day < days.length && pages < DEEP_PAGES) {
      const page = await reader.listPage(days[day] ?? '', after);
      pages += 1;
      // O que é mais novo que a posição é da leitura ao vivo ou do atraso.
      const old = page.objects.filter(({ index }) => index >= pass.first && index <= pass.position);
      const missed = (await reader.annotate(old)).filter(unread);
      const tooOld = missed.filter(({ endMs }) => endMs < limit);
      if (tooOld.length > 0) {
        await reader.recordGaps(tooOld, (tx, count, chunk) => this.auditGapOf(tx, pass, count, chunk));
      }
      late.push(...missed.filter(({ endMs }) => endMs >= limit));
      after = page.next;
      if (after === null) day += 1;
    }
    memory.deepFrom = day < days.length ? { day, after } : { day: 0, after: null };
    const left = await reader.read(
      memory.live,
      late.sort(byTime),
      context.budget,
      { openAt: () => nowMs, evaluateAt: () => this.liveClock(pass, pass.pending) },
      true,
    );
    if (late.length > 0) await reader.flush(memory.live, this.liveClock(pass, pass.pending), true);
    pass.lateLeft = left.length;
    if (left.length > 0) memory.deepFrom = { day: 0, after: null };
    else if (day >= days.length) memory.deepAt = nowMs;
  }

  /**
   * O que ficou para trás (o worker parado, a leitura que não dava conta), até 24 h, slot a slot e em ordem, num motor à
   * parte: as janelas são as de quando o tráfego aconteceu. Antes do primeiro objeto por ler, relê o que falta da janela de
   * 60 minutos; depois de alcançar o motor ao vivo, segue relendo o que ele já leu até o último slot fechado, para nenhuma
   * janela ficar dividida entre os dois.
   */
  private async backlog(pass: Pass, context: RunContext): Promise<void> {
    const { source, reader } = pass;
    const { memory, sourceId } = source;
    if (memory.backlog === null && pass.position >= pass.oldest) return;
    if (reader.halted || context.budget.exhausted) {
      pass.backlogLeft = true;
      return;
    }
    if (!this.backlogs.has(sourceId)) {
      if (this.backlogs.size >= MAX_BACKLOGS) {
        pass.backlogLeft = true;
        return;
      }
      this.backlogs.add(sourceId);
    }
    const state = (memory.backlog ??= { context: null, next: pass.position + 1 });
    context.report.backlog += 1;
    let done = false;
    while (!done) {
      context.signal.throwIfAborted();
      done = state.next > pass.closed || (state.context === null && state.next > pass.oldest);
      if (done) break;
      if (context.budget.exhausted || reader.halted) break;
      if (!(await this.backlogWindow(pass, state, context))) break;
    }
    if (!done) {
      pass.position = Math.max(pass.position, state.next - 1);
      pass.backlogLeft = true;
      return;
    }
    pass.position = Math.max(pass.position, pass.closed);
    memory.backlog = null;
    this.backlogs.delete(sourceId);
  }

  /** Até 3 h do atraso. `false`: parou no meio (o orçamento). */
  private async backlogWindow(
    pass: Pass,
    state: NonNullable<SourceMemory['backlog']>,
    context: RunContext,
  ): Promise<boolean> {
    const { reader } = pass;
    const last = Math.min(pass.closed, state.next + BACKLOG_WINDOW - 1);
    const bySlot = new Map<number, Candidate[]>();
    for (const object of await this.windowOf(pass, state.next, last)) {
      const list = bySlot.get(object.index);
      if (list === undefined) bySlot.set(object.index, [object]);
      else list.push(object);
    }
    while (state.next <= last) {
      const index = state.next;
      const objects = bySlot.get(index) ?? [];
      // Depois do que é do motor ao vivo, só a releitura.
      const fresh = objects.filter((object) => unread(object) && index <= pass.oldest);
      if (state.context === null) {
        if (fresh.length === 0) {
          state.next += 1;
          continue;
        }
        state.context = await this.backlogContext(pass, index, context);
        if (state.context === null) return false;
      }
      const { context: engine } = state;
      const clock = backlogClock(index);
      const replays = objects.filter((object) => analysed(object) && !engine.seen.has(object.hash));
      const ready = [...fresh, ...replays].sort(byTime);
      const left = await reader.read(
        engine,
        ready,
        context.budget,
        { openAt: () => clock, evaluateAt: () => clock },
        false,
      );
      await reader.flush(engine, clock, false);
      if (left.length > 0) return false;
      pruneContext(engine, index - KEEP_SLOTS);
      state.next += 1;
    }
    return true;
  }

  /** Os objetos dos slots de `from` a `to`, com o que o registro diz deles. */
  private async windowOf(pass: Pass, from: number, to: number): Promise<Candidate[]> {
    const { reader } = pass;
    const fromMs = (from - 1) * SLOT_MS;
    // O que não couber nas páginas fica como atrasado: a conferência de hora em hora o acha.
    const { objects } = await reader.listRange(utcDays(fromMs, pass.nowMs), fromMs, to, BACKLOG_PAGES);
    return reader.annotate(objects.filter(({ index }) => index >= Math.max(from, pass.first)));
  }

  /** O motor do atraso, com o que a janela de 60 minutos tinha antes do primeiro objeto por ler; null sem orçamento. */
  private async backlogContext(
    pass: Pass,
    index: number,
    context: RunContext,
  ): Promise<EngineContext | null> {
    const { item, source, reader, target } = pass;
    const engine = this.engineOf(item, target, backlogClock(index), Math.max(BACKLOG_SHARE, this.share));
    const stored = await this.storedState(source.sourceId, source.tenantId);
    if (stored !== null) this.restore(engine, stored);
    const config = await loadSourceConfig(this.prisma, source);
    engine.configure({ now: pass.nowMs, routes: config.routes, trusted: config.trusted });
    const opened = newContext(engine);
    const clock = backlogClock(index);
    const before = (await this.windowOf(pass, index - LONG_SLOTS + 1, index - 1)).filter(analysed);
    const left = await reader.read(
      opened,
      before.sort(byTime),
      context.budget,
      { openAt: () => clock, evaluateAt: () => clock },
      false,
    );
    return left.length > 0 ? null : opened;
  }

  // --- O fechamento ---

  private async conclude(pass: Pass, context: RunContext): Promise<void> {
    const { item, reader, source } = pass;
    const { report } = context;
    const failure = reader.closeFailures();
    if (failure !== null) {
      await this.failSource(item, failure, context, pass.position);
      return;
    }
    const now = this.now();
    const waiting = pass.pending.filter(unread);
    let position = pass.closed;
    if (pass.cutAt !== null) position = Math.min(position, pass.cutAt - 1);
    for (const { index } of waiting) position = Math.min(position, index - 1);
    if (pass.backlogLeft) position = Math.min(position, pass.position);
    position = Math.max(position, pass.position);
    const left = pass.pending.length > 0 || pass.lateLeft > 0 || pass.backlogLeft || pass.cutAt !== null;
    const advanced = await this.cursors.advance(
      item.key,
      {
        cursorAt: new Date(position * SLOT_MS),
        continuation: null,
        nextRunAt: left ? now : new Date(now.getTime() + this.intervalMs),
      },
      now,
    );
    report.synced += 1;
    if (left) report.capped += 1;
    const { sourceId, tenantId } = source;
    const dayAgo = new Date(now.getTime() - WEB_LOGS_MAX_AGE_MS);
    const recent = (status: 'gap' | 'quarantined') =>
      this.prisma.webLogObject.findFirst({
        where: { tenantId, sourceId, status, readAt: { gt: dayAgo } },
        select: { status: true },
      });
    const [gap, quarantined, volume] = await Promise.all([
      recent('gap'),
      recent('quarantined'),
      this.prisma.webLogObject.aggregate({
        where: { tenantId, sourceId, slotStart: { gte: dayAgo }, status: { in: ['read', 'late'] } },
        _sum: { lines: true, bytes: true, malformed: true, oversize: true, foreign: true },
      }),
    ]);
    const sum = volume._sum;
    await this.record(
      item,
      {
        type: 'synced',
        ingested: reader.ingested,
        opened: reader.opened,
        newestEventAt: reader.newestMs === 0 ? null : new Date(reader.newestMs),
        unread: waiting.length + pass.lateLeft + (pass.backlogLeft || pass.cutAt !== null ? 1 : 0),
        gap: gap !== null,
        quarantined: quarantined !== null,
        volume: {
          events: (sum.lines ?? 0) - (sum.malformed ?? 0) - (sum.oversize ?? 0) - (sum.foreign ?? 0),
          bytes: Number(sum.bytes ?? 0n),
        },
        lagSeconds: webLagSeconds(advanced.cursorAt, now) ?? 0,
      },
      now,
      context,
    );
  }

  /** A leitura do S3 falhou: o recuo no cursor e o motivo na fonte. */
  private async failSource(
    item: Item,
    error: unknown,
    context: RunContext,
    position: number | null = null,
  ): Promise<void> {
    if (isFatal(error, context.signal)) throw error;
    const now = this.now();
    const failure = albFailureOf(error);
    const code = failure.type === 'permission' ? failure.detail : failure.code;
    this.countFailure(context.report, code);
    // O motor do atraso é refeito quando a leitura voltar: a vez dele não fica presa ao recuo.
    const memory = this.memories.get(item.source.id);
    if (memory !== undefined) memory.backlog = null;
    this.backlogs.delete(item.source.id);
    const cursor = await this.cursors.fail(item.key, named(code), now, {
      backoff: failure.type === 'permission' ? this.refusalBackoff : this.backoff,
    });
    const at = position === null ? cursor.cursorAt : new Date(position * SLOT_MS);
    const lagSeconds = webLagSeconds(at, now);
    await this.record(
      item,
      failure.type === 'permission'
        ? { ...failure, lagSeconds }
        : { ...failure, failures: cursor.failures, lagSeconds },
      now,
      context,
    );
  }

  /**
   * Grava o estado e a saúde da fonte, sob o lock da conta e pelo escopo do cliente, só se esta autorização ainda valer e a
   * fonte ainda estiver na coleta. A mudança de estado entra na trilha.
   */
  private async record(item: Item, outcome: WebOutcome, now: Date, context: RunContext): Promise<void> {
    const { account, source } = item;
    const changed = await this.prisma.$transaction(async (tx) => {
      await lockAwsOnboarding(tx, account.id);
      const db = scopeToTenant(tx, source.tenantId);
      const current = await db.awsSource.findFirst({
        where: {
          id: source.id,
          cloudAccountId: account.id,
          authorizedAt: source.authorizedAt,
          revokedAt: null,
          state: { in: [...AWS_SOURCE_ACTIVE_STATES] },
        },
        select: SOURCE_SELECT,
      });
      if (current === null) return false;
      const change = webSourceChange(current, outcome, now);
      await db.awsSource.updateMany({ where: { id: source.id, revokedAt: null }, data: change.data });
      if (change.transition === null) return false;
      await this.audit.write(tx, {
        actor: { type: 'system', tenantId: source.tenantId },
        action: AUDIT_ACTION,
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: account.id,
        before: { sourceId: source.id, kind: source.kind, region: source.region, ...change.transition.from },
        after: { sourceId: source.id, kind: source.kind, region: source.region, ...change.transition.to },
      });
      return true;
    }, WRITE_TRANSACTION);
    if (changed) context.report.transitions += 1;
  }

  // --- A memória e o estado ---

  private engineOf(item: Item, target: AlbTarget, nowMs: number, share: number): WebLogEngine {
    return new WebLogEngine({
      source: {
        tenantId: item.source.tenantId,
        accountId: item.account.accountId,
        region: target.region,
        loadBalancer: target.loadBalancer,
      },
      hashKey: this.hashKey,
      now: nowMs,
      prefix: target.prefix,
      limits: divideLimits(this.limits, share),
      countries: this.countries,
      ...(this.ranges !== undefined && { ranges: this.ranges }),
    });
  }

  private storedState(sourceId: string, tenantId: string) {
    return this.prisma.webEngineState.findUnique({
      where: { sourceId_tenantId: { sourceId, tenantId } },
      select: { version: true, state: true },
    });
  }

  /** O resumo do dia guardado volta para o motor; o que não serve é deixado de lado, e o dia recomeça. */
  private restore(engine: WebLogEngine, stored: { version: number; state: unknown }): void {
    const { digest } = readEngineState(stored.version, stored.state);
    if (digest !== null) engine.restore(digest);
  }

  private async memoryOf(
    item: Item,
    target: AlbTarget,
    config: SourceConfig,
    now: Date,
  ): Promise<SourceMemory> {
    const { source } = item;
    const identity = [
      target.loadBalancer,
      target.bucket,
      target.root,
      source.authorizedAt.toISOString(),
      this.share,
    ].join('|');
    const known = this.memories.get(source.id);
    if (known?.identity === identity) {
      if (known.observation.since !== config.observedSince) {
        known.observation = new Observation(config.observedSince);
      }
      return known;
    }
    this.forget(source.id);
    const engine = this.engineOf(item, target, now.getTime(), this.share);
    const stored = await this.storedState(source.id, source.tenantId);
    // Antes do estado: o `restore` esquece quem, com a configuração de agora, não é direto.
    engine.configure({ now: now.getTime(), routes: config.routes, trusted: config.trusted });
    if (stored !== null) this.restore(engine, stored);
    const saved = readEngineState(stored?.version ?? 0, stored?.state);
    const memory: SourceMemory = {
      identity,
      live: newContext(engine),
      observation: Observation.resume(saved.observation, config.observedSince),
      suppressed: saved.suppressed,
      notes: [],
      attempts: new Map(),
      persisted: new Map(),
      savedThrough: null,
      deepAt: null,
      deepFrom: { day: 0, after: null },
      backlog: null,
    };
    this.memories.set(source.id, memory);
    return memory;
  }

  /** O estado do motor, no máximo uma vez por slot fechado, só com a concessão e a autorização valendo. */
  private async saveState(pass: Pass, closedThrough: number | null, context: RunContext): Promise<void> {
    const { memory, sourceId, tenantId } = pass.source;
    if (closedThrough === null) return;
    if (memory.savedThrough !== null && closedThrough <= memory.savedThrough) return;
    const json = writeEngineState({
      digest: memory.live.engine.snapshot(),
      observation: memory.observation.state(),
      suppressed: memory.suppressed,
      notes: memory.notes,
    });
    context.signal.throwIfAborted();
    await this.prisma.$transaction(async (tx) => {
      await pass.reader.authorize(tx);
      // Outra réplica que já tenha assumido tem um estado mais novo.
      if (!(await this.lease.holdIn(tx))) throw new LeaseLost();
      await saveWebEngineState(tx, {
        sourceId,
        tenantId,
        loadBalancer: pass.target.loadBalancer,
        version: ENGINE_STATE_VERSION,
        json,
      });
    }, WRITE_TRANSACTION);
    memory.savedThrough = closedThrough;
  }

  /**
   * O balanceador foi apagado e recriado com o mesmo nome: a autorização (que é pelo nome) continua, mas nada do que foi
   * aprendido com o anterior vale. O estado sai, o modo volta a `observe` por 72 h e a troca entra na trilha do cliente.
   */
  private async replacedBalancer(
    item: Item,
    target: AlbTarget,
    now: Date,
    context: RunContext,
  ): Promise<boolean> {
    const { account, source } = item;
    const { tenantId } = source;
    const key = { sourceId_tenantId: { sourceId: source.id, tenantId } };
    const stored = await this.prisma.webEngineState.findUnique({
      where: key,
      select: { loadBalancer: true },
    });
    if (stored === null || stored.loadBalancer === target.loadBalancer) return false;
    this.forget(source.id);
    const observeUntil = new Date(now.getTime() + WEB_OBSERVE_MS);
    const replaced = await this.prisma.$transaction(async (tx) => {
      await lockAwsOnboarding(tx, account.id);
      const db = scopeToTenant(tx, tenantId);
      const current = await db.awsSource.findFirst({
        where: { id: source.id, authorizedAt: source.authorizedAt, revokedAt: null },
        select: { id: true },
      });
      const held = await tx.webEngineState.findUnique({ where: key, select: { loadBalancer: true } });
      if (current === null || held === null || held.loadBalancer === target.loadBalancer) return false;
      const before = await db.webSourceSettings.findFirst({
        where: { sourceId: source.id },
        select: { mode: true, observeUntil: true },
      });
      await deleteWebEngineState(tx, { sourceId: source.id, tenantId });
      await db.webSourceSettings.updateMany({
        where: { sourceId: source.id },
        data: { mode: 'observe', observeUntil, updatedBy: null },
      });
      await this.audit.write(tx, {
        actor: { type: 'system', tenantId },
        action: 'web_logs.settings_update',
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: account.id,
        before: {
          sourceId: source.id,
          loadBalancer: held.loadBalancer,
          mode: before?.mode ?? null,
          observeUntil: before?.observeUntil?.toISOString() ?? null,
        },
        after: {
          sourceId: source.id,
          loadBalancer: target.loadBalancer,
          mode: 'observe',
          observeUntil: observeUntil.toISOString(),
        },
      });
      return true;
    }, WRITE_TRANSACTION);
    if (replaced) context.report.replaced += 1;
    return replaced;
  }

  /** De hora em hora, as contagens por país com mais de 48 h passam para as horas. */
  private async rollUp(context: RunContext): Promise<void> {
    const now = this.now();
    if (this.rolledAt !== null && now.getTime() - this.rolledAt < WEB_LOGS_ROLLUP_INTERVAL_MS) return;
    try {
      context.report.rolledUp = await this.traffic.rollup(now, this.tenantIds, context.signal);
      this.rolledAt = now.getTime();
    } catch (error) {
      // O expurgo diário também passa; e a próxima execução tenta de novo.
      if (context.signal.aborted) throw error;
      context.firstError ??= errorKind(error);
    }
  }
}

const emptyReport = (): WebLogsReport => ({
  status: 'done',
  sources: 0,
  overLimit: 0,
  waiting: 0,
  notDue: 0,
  deferred: 0,
  synced: 0,
  capped: 0,
  backlog: 0,
  failed: 0,
  broken: 0,
  withdrawn: 0,
  replaced: 0,
  transitions: 0,
  rolledUp: 0,
  ...emptyCounts(),
});
