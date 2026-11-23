import { createHash, randomUUID } from 'node:crypto';
import { AWS_SOURCE_ACTIVE_STATES, isAwsRegion } from '@verax/shared';
import { type ActiveException, matchingException } from '../../alerts/exception-match.js';
import type { FindingDraft } from '../../alerts/finding-draft.js';
import { FindingStore, LastEvents, SyncLease, type UnownedRecord } from '../../alerts/finding-store.js';
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
import { REFUSED_CODES } from '../../inventory/collectors.js';
import { concurrencyLimit } from '../../inventory/inventory.js';
import type { AlertNotices } from '../../notifications/finding-notices.js';
import { COLLECTING_TENANT } from '../../tenants/tenant-status.js';
import { UsageMeter } from '../../usage/usage-meter.js';
import { type DiscoveryClientFactory, DiscoveryRunClients } from '../discovery/clients.js';
import { discoveryErrorCode } from '../discovery/discovery.js';
import { lockAwsOnboarding } from '../discovery/discovery-runs.js';
import { inspectorEnabled, listAnalyzers } from '../discovery/lookups.js';
import { ReadOnlyViolation } from '../discovery/read-only.js';
import { entersRole } from '../onboarding/account-access.js';
import { sourceDetails } from '../onboarding/onboarding-view.js';
import {
  AwsConnectionError,
  awsErrorName,
  type AwsReaderCredentials,
  STS_FALLBACK_REGION,
} from '../web-identity.js';
import {
  type AccessAnalyzerTarget,
  parseAccessAnalyzerFinding,
  readAccessAnalyzerDetail,
  readAccessAnalyzerPage,
} from './access-analyzer.js';
import { recordBytes } from './finding-fields.js';
import {
  addVolume,
  type CursorState,
  decodeCursorState,
  encodeCursorState,
  type HourVolume,
  sourceChange,
  type SourceOutcome,
  volumeLast24h,
} from './finding-health.js';
import { awsFindingKey } from './finding-keys.js';
import {
  type AwsFindingKind,
  FindingsCallError,
  type FindingsCaller,
  type FindingsPage,
  type FindingsWindow,
  isAwsFindingKind,
  type ParsedFinding,
  type ParseOutcome,
} from './finding-records.js';
import { guardDutyDetectorExists, parseGuardDutyFinding, readGuardDutyPage } from './guardduty.js';
import { parseInspectorFinding, readInspectorPage } from './inspector.js';
import {
  parseSecurityHubFinding,
  readSecurityHubPage,
  SECURITY_HUB_MIN_INTERVAL_MS,
} from './security-hub.js';
import {
  abortableSleep,
  DEFAULT_THROTTLE_RETRY,
  isThrottling,
  RateGate,
  type Sleep,
  withThrottleRetry,
} from './throttle.js';

/** Nome da concessão em `SyncState`: um worker por vez na tarefa, mesmo com mais de uma réplica. */
export const AWS_FINDINGS_SYNC = 'aws-findings';
/** A tarefa roda a cada 5 min, e cada fonte é lida de novo 5 min depois da última leitura. */
export const AWS_FINDINGS_TICK_MS = 5 * 60 * 1000;
export const AWS_FINDINGS_INTERVAL_MS = 5 * 60 * 1000;
/** O tempo que uma execução gasta começando leituras; passado dele, as fontes que faltam ficam para a próxima. */
export const AWS_FINDINGS_RUN_BUDGET_MS = 4 * 60 * 1000;
/** O orçamento do agendador: estourado, o sinal da execução é abortado (a leitura em curso para onde está). */
export const AWS_FINDINGS_BUDGET_MS = 10 * 60 * 1000;
/** Validade da concessão, renovada durante a execução a cada terço dela. */
export const AWS_FINDINGS_LEASE_MS = 6 * 60 * 1000;
/** Sobreposição: cada leitura relê os últimos 10 min antes da posição (a chave única não deixa duplicar). */
export const AWS_FINDINGS_OVERLAP_MS = 10 * 60 * 1000;
/** A primeira leitura começa 24 h antes do dia da autorização: só os achados ativos atualizados desde então. */
export const AWS_FINDINGS_BACKFILL_MS = 24 * 60 * 60 * 1000;
/** Páginas por fonte e por execução; o que passa disso continua na execução seguinte, da continuação gravada. */
export const AWS_FINDINGS_MAX_PAGES = 10;
/** Contas lidas ao mesmo tempo (cada uma com uma transação por achado: o pool do banco é dividido com as outras tarefas). */
export const AWS_FINDINGS_ACCOUNT_CONCURRENCY = 2;
/** Chamadas à AWS ao mesmo tempo, por conta. */
export const AWS_FINDINGS_CALL_CONCURRENCY = 4;
/** Detalhes do Access Analyzer (`GetFindingV2`) por fonte e por execução. */
export const AWS_FINDINGS_DETAILS_PER_RUN = 200;
/** Recuo depois de uma falha passageira (limite de requisições, tempo esgotado, erro da AWS): 5 min, dobrando, até 1 h. */
export const AWS_FINDINGS_BACKOFF: Readonly<Backoff> = { baseMs: 5 * 60 * 1000, maxMs: 60 * 60 * 1000 };
/**
 * Recuo depois de uma recusa (falta de permissão, serviço desligado): 15 min, dobrando, até 6 h. Cada tentativa é uma
 * linha de acesso negado no CloudTrail do cliente. A fonte que volta a `authorized` (a sondagem da descoberta viu a
 * permissão de volta) é lida na execução seguinte, sem esperar o recuo.
 */
export const AWS_FINDINGS_REFUSAL_BACKOFF: Readonly<Backoff> = {
  baseMs: 15 * 60 * 1000,
  maxMs: 6 * 60 * 60 * 1000,
};

/** Teto de registros lidos de uma página (a maior página pedida tem 100). */
const MAX_PAGE_RECORDS = 200;
/** Com a continuação que não cabe no cursor, a leitura segue na mesma execução até este múltiplo do teto de páginas. */
const UNRESUMABLE_PAGES_FACTOR = 5;
const AUDIT_ACTION = 'cloud_account.aws_source_collection';

/** O que a tarefa usa do provedor de sessões (o do worker; um falso nos testes). */
export type FindingsCredentials = Pick<AwsReaderCredentials, 'session' | 'credentialsFor'>;

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente nem da AWS, e nenhum achado). */
export interface AwsFindingsReport {
  /** `locked`: outra réplica tem a concessão; `lease_lost`: a concessão venceu no meio e outra réplica a tomou. */
  status: 'done' | 'locked' | 'lease_lost';
  /** Contas com fonte de achados na coleta. */
  accounts: number;
  /** Contas que não entram no papel agora: esperam a conferência da conexão. */
  waiting: number;
  /** Contas cuja leitura parou num erro que não é da AWS (banco, gravação). */
  failedAccounts: number;
  /** Fontes de achados na coleta (autorizadas, não revogadas). */
  sources: number;
  /** Ainda não estavam na hora. */
  notDue: number;
  /** Ficaram para a execução seguinte, pelo orçamento de tempo. */
  deferred: number;
  /** Fontes lidas sem erro (inclusive as que pararam no teto de páginas). */
  synced: number;
  /** Das lidas, as que pararam no teto de páginas e continuam na execução seguinte. */
  capped: number;
  /** Fontes cuja leitura falhou. */
  failed: number;
  pages: number;
  /** Registros lidos da AWS. */
  read: number;
  /** Achados novos. */
  created: number;
  /** Achados já gravados que ganharam uma versão mais nova da origem. */
  updated: number;
  /** Registros de uma versão já gravada (a sobreposição, a listagem inteira do Access Analyzer). */
  duplicates: number;
  /** Security Hub: achados de um serviço que a conta já lê pela fonte própria (GuardDuty, Inspector). */
  skipped: number;
  /** Arquivados, resolvidos ou suprimidos na origem. */
  inactive: number;
  /** Fora do formato. */
  invalid: number;
  /** Achados de conta que não é do cliente da fonte: na fila sem dono. */
  unowned: number;
  /** Achados que já nasceram esperados por uma exceção. */
  excepted: number;
  /** Chamadas que a AWS limitou e foram repetidas. */
  throttled: number;
  /** Mudanças de estado de fonte (as que entram na trilha de auditoria). */
  transitions: number;
  /** Bytes medidos (os achados novos ou com versão nova). */
  bytes: number;
  /** Os códigos das leituras que falharam. */
  failures?: Record<string, number>;
}

export interface AwsFindingsOptions {
  audit?: AuditService;
  /** Nome da concessão em `SyncState` (os testes usam um por caso). */
  name?: string;
  owner?: string;
  leaseMs?: number;
  now?: () => Date;
  /** O relógio do orçamento da execução e do espaçamento das chamadas, em milissegundos (os testes o controlam). */
  elapsed?: () => number;
  /** O sorteio do recuo, de 0 a 1 (os testes fixam). */
  random?: () => number;
  /** A espera do recuo e do espaçamento das chamadas (os testes trocam por uma que não espera). */
  sleep?: Sleep;
  /** Avisos por e-mail do alerta (os testes trocam por um que falha, para provar que nada fica pela metade). */
  notices?: AlertNotices;
  intervalMs?: number;
  overlapMs?: number;
  backfillMs?: number;
  maxPages?: number;
  runBudgetMs?: number;
  accountConcurrency?: number;
  callConcurrency?: number;
  detailsPerRun?: number;
  backoff?: Backoff;
  refusalBackoff?: Backoff;
  /** As novas tentativas de uma chamada limitada pela AWS. */
  throttle?: { attempts: number; baseMs: number; maxMs: number };
  /** O espaçamento das chamadas ao Security Hub, por conta e região. */
  securityHubIntervalMs?: number;
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
  awsCapabilities: true,
  awsCapabilitiesCheckedAt: true,
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
  missingSince: true,
  authorizedAt: true,
  collectFrom: true,
  lastSyncAt: true,
  lastEventAt: true,
} as const satisfies Prisma.AwsSourceSelect;
type SourceRow = Prisma.AwsSourceGetPayload<{ select: typeof SOURCE_SELECT }>;

/** Uma fonte na hora de ler: a linha, o tipo e o cursor dela. */
interface Stream {
  source: SourceRow;
  kind: AwsFindingKind;
  key: CursorKey;
  cursor: CollectorCursor;
}

/** O que a leitura de uma conta divide entre as fontes dela. */
interface AccountRun {
  account: AccountRow;
  clients: DiscoveryRunClients;
  /** Os analisadores ativos de cada região, lidos uma vez por execução. */
  analyzers: Map<string, Promise<{ name: string; arn: string }[]>>;
}

interface RunContext {
  signal: AbortSignal;
  ownership: AbortController;
  report: AwsFindingsReport;
  exceptions: ReadonlyMap<string, ActiveException[]>;
  lastEvents: LastEvents;
  /** As fontes próprias (GuardDuty e Inspector) com a autorização valendo: `cliente|conta|tipo|região`. */
  ownSources: ReadonlySet<string>;
  /** As contas AWS citadas em achados e que não são a da fonte: o cliente de cada uma, ou null se não está cadastrada. */
  members: Map<string, string | null>;
  /** O orçamento de tempo da execução acabou: nenhuma leitura nova começa. */
  exhausted: () => boolean;
  firstError: string | null;
}

/** O que uma página deixou: o volume medido e o achado mais recente. */
interface PageTally {
  events: number;
  bytes: number;
  newest: Date | null;
  /** A página não foi processada: os detalhes do Access Analyzer desta execução acabaram. */
  deferred: boolean;
}

type Failure =
  | { type: 'permission'; detail: string }
  | { type: 'missing'; code: 'not_enabled' | 'not_found' }
  | { type: 'failed'; code: string };

/** A concessão não é mais deste worker: a execução para onde está. */
class FindingsLeaseLost extends Error {
  constructor() {
    super('achados da AWS: concessão perdida');
    this.name = 'FindingsLeaseLost';
  }
}

/** A fonte autorizada não existe mais na conta (o analisador apagado, o detector removido). */
class SourceGone extends Error {
  constructor(readonly code: 'not_enabled' | 'not_found') {
    super(`fonte de achados da AWS: ${code}`);
    this.name = 'SourceGone';
  }
}

/** Uma leitura que falhou, guardada no cursor só pelo código. */
class FindingsRunError extends Error {
  constructor(code: string) {
    super(`leitura de achados da AWS: ${code}`);
    this.name = code;
  }
}

/** O fluxo do cursor de uma fonte: um por tipo e região; no Access Analyzer, um por analisador. */
export function findingsStream(kind: AwsFindingKind, resourceId: string): string {
  switch (kind) {
    case 'guardduty':
      return 'aws_findings_guardduty';
    case 'security_hub':
      return 'aws_findings_security_hub';
    case 'inspector':
      return 'aws_findings_inspector';
    case 'access_analyzer':
      // Uma região pode ter mais de um analisador, cada um autorizado à parte: o nome dele entra pelo resumo.
      return `aws_findings_aa_${createHash('sha256').update(resourceId).digest('hex').slice(0, 10)}`;
  }
}

const ownSourceKey = (tenantId: string, accountId: string, kind: string, region: string): string =>
  `${tenantId}|${accountId}|${kind}|${region}`;

/** O começo da primeira leitura: 24 h antes do dia da autorização. Nada mais antigo é buscado. */
function backfillFloor(source: SourceRow, backfillMs: number, now: Date): Date {
  const from = source.collectFrom ?? source.authorizedAt ?? now;
  return new Date(from.getTime() - backfillMs);
}

/** A AWS recusou a continuação gravada (vencida, de outra janela)? A leitura recomeça a janela. */
function isRejectedToken(error: unknown): boolean {
  if (!(error instanceof FindingsCallError)) return false;
  const name = awsErrorName(error.cause);
  return name === 'BadRequestException' || name === 'InvalidInputException' || name === 'ValidationException';
}

/** O que nunca vira o resultado de uma fonte: o cancelamento, a trava de só leitura e a sessão que caiu. */
function isFatal(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof ReadOnlyViolation || error instanceof AwsConnectionError;
}

/**
 * Tarefa `aws-findings` do worker (onboarding self-service; `docs/ARQUITETURA.md`, "Onboarding AWS self-service"): os
 * achados do GuardDuty, do Security Hub, do Inspector e do Access Analyzer de cada conta AWS, lidos pela API de cada
 * serviço, pela mesma sessão de leitura da conferência da conexão e da descoberta (`AwsReaderCredentials`: o papel sem
 * chave ou, na VM própria do cliente, a chave do cofre) e pelos mesmos clientes com a trava de só leitura
 * (`discovery/clients.ts`).
 *
 * A cada execução (5 min), sob a concessão no banco:
 * 1. **Quem entra:** as fontes lidas por API com a autorização valendo e dentro da coleta (`authorized`, `collecting`,
 *    `permission_error`, `ingestion_error`...), de conta AWS ativa, já verificada, que entra no papel, de cliente ativo.
 *    A fonte revogada sai na execução seguinte; a que sumiu (`source_missing`) espera a descoberta vê-la de novo.
 *    Com as tags do papel dizendo que a leitura de achados está desligada, a fonte fica `permission_error`
 *    (`capability_off`) sem chamada nenhuma.
 * 2. **Uma conta de cada vez por sessão**, no máximo 2 contas ao mesmo tempo, as fontes de cada conta em sequência, a
 *    mais atrasada primeiro. Passado o orçamento de tempo da execução, as que faltam ficam para a próxima.
 * 3. **A leitura de uma fonte** (o cursor dela em `CollectorCursor`, um fluxo por tipo e região): a janela vai da
 *    posição menos 10 min (a primeira, de 24 h antes do dia da autorização) até agora, página a página. Cada página é
 *    gravada antes de a continuação andar: uma execução que para no meio (o worker parado, o orçamento) relê a página
 *    em que parou, e a chave única dos achados não deixa duplicar. No teto de páginas, a continuação fica no cursor e a
 *    execução seguinte segue dela; lida a janela inteira, a posição vai para o fim dela.
 * 4. **Cada registro** é conferido (o que está fora do formato é contado e ignorado) e só segue se for novo ou tiver
 *    uma versão (`updatedAt`) mais nova do que a gravada: a sobreposição e a listagem inteira do Access Analyzer não
 *    gravam nem medem nada de novo. O dono é o cliente da conta cuja sessão leu o achado, desde que a conta do achado
 *    seja a da fonte (ou outra conta do mesmo cliente, no detector ou no hub que administra contas-membro). A conta de
 *    outro cliente, ou não cadastrada, manda o achado para a fila sem dono, com o motivo.
 * 5. **A gravação** é a de todo coletor (`FindingStore`): o achado, a exceção e o aviso por e-mail numa transação, pelo
 *    escopo do cliente. O GuardDuty sai com a mesma chave do caminho do bucket; os outros, com a versão que só
 *    atualiza o achado que já existe (`revision`).
 * 6. **O volume** (os bytes do JSON de cada achado novo ou com versão nova) entra no medidor da AWS (`IngestUsage` e
 *    `IngestUsageDay`), depois de a leitura da página ficar gravada. Nenhum achado é descartado por plano.
 * 7. **O estado e a saúde de cada fonte** (`finding-health.ts`) são gravados sob o lock da conta, o mesmo da autorização
 *    pelo painel e da descoberta, só se a autorização ainda valer. A mudança de estado entra na trilha do cliente
 *    (`cloud_account.aws_source_collection`, ator sistema).
 *
 * Uma fonte com falha nunca para as outras: a permissão negada, o serviço desligado e o limite de requisições ficam
 * registrados na própria fonte, com recuo. Nada do achado vai para o log: o relatório só tem contagens e códigos, e as
 * credenciais ficam no provedor.
 */
export class AwsFindings {
  private readonly audit: AuditService;
  private readonly lease: SyncLease;
  private readonly cursors: CollectorCursors;
  private readonly store: FindingStore;
  private readonly name: string;
  private readonly now: () => Date;
  private readonly elapsed: () => number;
  private readonly random: () => number;
  private readonly sleep: Sleep;
  private readonly intervalMs: number;
  private readonly overlapMs: number;
  private readonly backfillMs: number;
  private readonly maxPages: number;
  private readonly runBudgetMs: number;
  private readonly accountConcurrency: number;
  private readonly callConcurrency: number;
  private readonly detailsPerRun: number;
  private readonly backoff: Backoff;
  private readonly refusalBackoff: Backoff;
  private readonly throttle: { attempts: number; baseMs: number; maxMs: number };
  private readonly securityHubGate: RateGate;
  private readonly tenantIds: readonly string[] | undefined;
  private readonly renewEveryMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: FindingsCredentials,
    private readonly clients: DiscoveryClientFactory,
    {
      audit = new AuditService(),
      name = AWS_FINDINGS_SYNC,
      owner = `worker-${randomUUID()}`,
      leaseMs = AWS_FINDINGS_LEASE_MS,
      now = () => new Date(),
      elapsed = () => performance.now(),
      random = Math.random,
      sleep = abortableSleep,
      notices,
      intervalMs = AWS_FINDINGS_INTERVAL_MS,
      overlapMs = AWS_FINDINGS_OVERLAP_MS,
      backfillMs = AWS_FINDINGS_BACKFILL_MS,
      maxPages = AWS_FINDINGS_MAX_PAGES,
      runBudgetMs = AWS_FINDINGS_RUN_BUDGET_MS,
      accountConcurrency = AWS_FINDINGS_ACCOUNT_CONCURRENCY,
      callConcurrency = AWS_FINDINGS_CALL_CONCURRENCY,
      detailsPerRun = AWS_FINDINGS_DETAILS_PER_RUN,
      backoff = AWS_FINDINGS_BACKOFF,
      refusalBackoff = AWS_FINDINGS_REFUSAL_BACKOFF,
      throttle = DEFAULT_THROTTLE_RETRY,
      securityHubIntervalMs = SECURITY_HUB_MIN_INTERVAL_MS,
      tenantIds,
    }: AwsFindingsOptions = {},
  ) {
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new RangeError('o teto de páginas do aws-findings precisa ser um inteiro positivo');
    }
    if (!Number.isInteger(accountConcurrency) || accountConcurrency < 1) {
      throw new RangeError('as contas ao mesmo tempo do aws-findings precisam ser um inteiro positivo');
    }
    this.audit = audit;
    this.name = name;
    this.lease = new SyncLease(prisma, name, owner, leaseMs);
    this.renewEveryMs = Math.max(250, Math.floor(leaseMs / 3));
    this.cursors = new CollectorCursors(prisma);
    this.store = new FindingStore(prisma, notices);
    this.now = now;
    this.elapsed = elapsed;
    this.random = random;
    this.sleep = sleep;
    this.intervalMs = intervalMs;
    this.overlapMs = overlapMs;
    this.backfillMs = backfillMs;
    this.maxPages = maxPages;
    this.runBudgetMs = runBudgetMs;
    this.accountConcurrency = accountConcurrency;
    this.callConcurrency = callConcurrency;
    this.detailsPerRun = detailsPerRun;
    this.backoff = backoff;
    this.refusalBackoff = refusalBackoff;
    this.throttle = throttle;
    this.securityHubGate = new RateGate(securityHubIntervalMs, sleep, elapsed);
    this.tenantIds = tenantIds;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<AwsFindingsReport> {
    const report: AwsFindingsReport = {
      status: 'done',
      accounts: 0,
      waiting: 0,
      failedAccounts: 0,
      sources: 0,
      notDue: 0,
      deferred: 0,
      synced: 0,
      capped: 0,
      failed: 0,
      pages: 0,
      read: 0,
      created: 0,
      updated: 0,
      duplicates: 0,
      skipped: 0,
      inactive: 0,
      invalid: 0,
      unowned: 0,
      excepted: 0,
      throttled: 0,
      transitions: 0,
      bytes: 0,
    };
    const startedAt = this.now();
    if (!(await this.lease.acquire(startedAt))) return { ...report, status: 'locked' };
    // A concessão perdida aborta este sinal, junto com o do agendador: as chamadas à AWS e a gravação param.
    const ownership = new AbortController();
    const active = AbortSignal.any([signal, ownership.signal]);
    const keeper = setInterval(() => void this.keepLease(ownership), this.renewEveryMs);
    const startedClock = this.elapsed();
    try {
      const rows = await this.prisma.awsSource.findMany({
        where: {
          method: 'api',
          authorizedAt: { not: null },
          revokedAt: null,
          state: { in: [...AWS_SOURCE_ACTIVE_STATES] },
          cloudAccount: {
            provider: 'aws',
            status: 'active',
            ingestFrom: { not: null },
            connection: { in: ['connected', 'error'] },
            // Só cliente ativo (CE-02): a conta de quem está suspenso, cancelado ou em expurgo não é lida.
            ...COLLECTING_TENANT,
          },
          ...this.tenantFilter(),
        },
        select: { ...SOURCE_SELECT, cloudAccount: { select: ACCOUNT_SELECT } },
        orderBy: [{ cloudAccountId: 'asc' }, { kind: 'asc' }, { region: 'asc' }, { authorizedAt: 'desc' }],
      });
      const byAccount = new Map<string, { account: AccountRow; sources: SourceRow[] }>();
      for (const { cloudAccount, ...source } of rows) {
        if (!isAwsFindingKind(source.kind) || !isAwsRegion(source.region)) continue;
        const known = byAccount.get(cloudAccount.id) ?? { account: cloudAccount, sources: [] };
        known.sources.push(source);
        byAccount.set(cloudAccount.id, known);
        report.sources += 1;
      }
      report.accounts = byAccount.size;
      const context: RunContext = {
        signal: active,
        ownership,
        report,
        exceptions: byAccount.size === 0 ? new Map() : await this.store.activeExceptions(startedAt),
        lastEvents: new LastEvents(),
        ownSources: byAccount.size === 0 ? new Set() : await this.ownSources(),
        members: new Map(),
        exhausted: () => this.elapsed() - startedClock >= this.runBudgetMs,
        firstError: null,
      };
      const limit = concurrencyLimit(this.accountConcurrency);
      const results = await Promise.allSettled(
        [...byAccount.values()].map(({ account, sources }) =>
          limit(async () => {
            active.throwIfAborted();
            try {
              await this.collectAccount(account, sources, context);
            } catch (error) {
              // A parada do worker, o orçamento e a concessão perdida param a execução; a trava de só leitura é um erro
              // nosso, que não pode passar em silêncio.
              if (active.aborted || error instanceof ReadOnlyViolation) throw error;
              // Uma conta com problema (banco, gravação) não para as outras.
              report.failedAccounts += 1;
              context.firstError ??= errorKind(error);
            }
          }),
        ),
      );
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected !== undefined) throw rejected.reason;
      active.throwIfAborted();
      await context.lastEvents.save(this.prisma, 'aws');
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastRunAt: startedAt,
          ...(context.firstError === null && { lastSuccessAt: this.now() }),
          lastError: context.firstError,
        },
      });
      return report;
    } catch (error) {
      // Outra réplica tomou a concessão: a execução para aqui, e o estado da tarefa é dela agora.
      if (ownership.signal.aborted && !signal.aborted) return { ...report, status: 'lease_lost' };
      // Só o tipo do erro: a mensagem de um erro do banco pode carregar dado.
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: { lastRunAt: startedAt, lastError: errorKind(error) },
      });
      throw error;
    } finally {
      clearInterval(keeper);
      await this.lease.release();
    }
  }

  private tenantFilter(): { tenantId?: { in: string[] } } {
    return this.tenantIds === undefined ? {} : { tenantId: { in: [...this.tenantIds] } };
  }

  /** Renova a concessão. Perdida, aborta a execução. Uma falha do banco fica para a renovação seguinte. */
  private async keepLease(ownership: AbortController): Promise<void> {
    if (ownership.signal.aborted) return;
    try {
      if (!(await this.lease.renew())) ownership.abort(new FindingsLeaseLost());
    } catch {
      // O banco fora agora: a próxima renovação decide.
    }
  }

  /**
   * As fontes próprias do GuardDuty e do Inspector com a autorização valendo, em qualquer estado: é o que faz o
   * Security Hub pular os achados desses serviços (o coletor da fonte própria os traz, com a chave dele; se ele estiver
   * com erro, o cursor dele não anda, e nada se perde).
   */
  private async ownSources(): Promise<Set<string>> {
    const rows = await this.prisma.awsSource.findMany({
      where: {
        method: 'api',
        kind: { in: ['guardduty', 'inspector'] },
        authorizedAt: { not: null },
        revokedAt: null,
        cloudAccount: { provider: 'aws', status: 'active' },
        ...this.tenantFilter(),
      },
      select: { tenantId: true, kind: true, region: true, cloudAccount: { select: { accountId: true } } },
    });
    return new Set(
      rows.map((row) => ownSourceKey(row.tenantId, row.cloudAccount.accountId, row.kind, row.region)),
    );
  }

  /** As fontes de uma conta: as que estão na hora, com uma sessão só, uma de cada vez. */
  private async collectAccount(
    account: AccountRow,
    sources: readonly SourceRow[],
    context: RunContext,
  ): Promise<void> {
    const { report, signal } = context;
    if (!entersRole(account)) {
      report.waiting += 1;
      return;
    }
    const now = this.now();
    // As tags do papel foram lidas e não têm a capacidade dos achados: a política não tem as ações, e nada é chamado.
    const capabilityOff =
      account.awsCapabilitiesCheckedAt !== null && !account.awsCapabilities.includes('findings');
    const due: Stream[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      if (!isAwsFindingKind(source.kind)) continue;
      const key: CursorKey = {
        cloudAccountId: account.id,
        stream: findingsStream(source.kind, source.resourceId),
        region: source.region,
      };
      // Duas linhas no mesmo fluxo (um detector antigo e o novo, na mesma região): só a autorizada por último é lida.
      const id = `${key.stream}|${source.region}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (capabilityOff) {
        this.countFailure(report, 'capability_off');
        // Já registrada assim: nada a gravar de novo a cada execução.
        if (source.state !== 'permission_error' || source.stateCode !== 'capability_off') {
          await this.record(account, source, { type: 'permission', detail: 'capability_off' }, now, context);
        }
        continue;
      }
      const cursor = await this.cursors.read(key, now);
      // A fonte recém-autorizada (ou que a descoberta devolveu à coleta) é lida já, sem esperar o recuo de antes.
      if (source.state !== 'authorized' && cursor.nextRunAt.getTime() > now.getTime()) {
        report.notDue += 1;
        continue;
      }
      due.push({ source, kind: source.kind, key, cursor });
    }
    if (due.length === 0) return;
    due.sort((a, b) => a.cursor.nextRunAt.getTime() - b.cursor.nextRunAt.getTime());
    if (context.exhausted()) {
      report.deferred += due.length;
      return;
    }
    const home = account.regions.find(isAwsRegion) ?? STS_FALLBACK_REGION;
    let clients: DiscoveryRunClients | null = null;
    try {
      // A entrada no papel primeiro: recusada, nenhuma outra chamada.
      await this.credentials.session(account.accountId, home, signal);
      clients = new DiscoveryRunClients(
        this.clients(this.credentials.credentialsFor(account.accountId, home), home),
        home,
        signal,
        { concurrency: this.callConcurrency },
      );
      const run: AccountRun = { account, clients, analyzers: new Map() };
      for (const [index, stream] of due.entries()) {
        signal.throwIfAborted();
        if (context.exhausted()) {
          report.deferred += due.length - index;
          break;
        }
        await this.collectStream(run, stream, context);
        await this.keepLease(context.ownership);
      }
    } catch (error) {
      if (signal.aborted || !(error instanceof AwsConnectionError)) throw error;
      // A entrada no papel recusada (ou a sessão que caiu no meio): quem trata é a conferência da conexão. As fontes
      // ficam como estão, e a conta é tentada de novo na execução seguinte.
      this.countFailure(report, error.code);
    } finally {
      clients?.destroy();
    }
  }

  private countFailure(report: AwsFindingsReport, code: string): void {
    report.failed += 1;
    report.failures = { ...report.failures, [code]: (report.failures?.[code] ?? 0) + 1 };
  }

  /**
   * Como a tarefa chama a AWS por uma fonte: o espaçamento das chamadas do Security Hub, a nova tentativa da chamada
   * limitada e a falha embrulhada com a ação do IAM. O cancelamento, a trava de só leitura e a sessão que caiu sobem
   * como vieram.
   */
  private callerFor(account: AccountRow, stream: Stream, context: RunContext): FindingsCaller {
    const { signal, report } = context;
    const gateKey = `${account.id}|${stream.source.region}`;
    const gated = stream.kind === 'security_hub';
    return async (action, call) => {
      try {
        return await withThrottleRetry(
          async () => {
            if (gated) await this.securityHubGate.wait(gateKey, signal);
            return call();
          },
          {
            ...this.throttle,
            random: this.random,
            sleep: this.sleep,
            signal,
            onRetry: () => {
              report.throttled += 1;
            },
          },
        );
      } catch (error) {
        if (isFatal(error, signal)) throw error;
        throw new FindingsCallError(action, error);
      }
    };
  }

  /** A leitura de uma fonte. A falha da AWS fica na fonte; a do banco sobe e encerra a conta nesta execução. */
  private async collectStream(run: AccountRun, stream: Stream, context: RunContext): Promise<void> {
    const call = this.callerFor(run.account, stream, context);
    const now = this.now();
    try {
      await this.readStream(run, stream, call, context, now);
    } catch (error) {
      if (isFatal(error, context.signal)) throw error;
      if (!(error instanceof FindingsCallError) && !(error instanceof SourceGone)) throw error;
      const failure =
        error instanceof SourceGone
          ? ({ type: 'missing', code: error.code } as const)
          : await this.classify(run, stream, error, call, context.signal);
      await this.failStream(run.account, stream, failure, now, context);
    }
  }

  /** O analisador de uma fonte do Access Analyzer, entre os ativos da região (`ListAnalyzers`, uma vez por execução). */
  private async analyzerOf(
    run: AccountRun,
    stream: Stream,
    call: FindingsCaller,
  ): Promise<AccessAnalyzerTarget> {
    const { region, resourceId } = stream.source;
    let listed = run.analyzers.get(region);
    if (listed === undefined) {
      // As fontes de uma conta são lidas em sequência: cada uma espera a listagem (ou a falha dela) antes de seguir.
      listed = call('access-analyzer:ListAnalyzers', () => listAnalyzers(run.clients, region));
      run.analyzers.set(region, listed);
    }
    const found = (await listed).find((analyzer) => analyzer.name === resourceId);
    // O analisador autorizado não está mais entre os ativos da região: apagado, ou desligado.
    if (found === undefined) throw new SourceGone('not_found');
    return { region, analyzerName: resourceId, analyzerArn: found.arn };
  }

  private async readStream(
    run: AccountRun,
    stream: Stream,
    call: FindingsCaller,
    context: RunContext,
    now: Date,
  ): Promise<void> {
    const { source, kind, key, cursor } = stream;
    const { report, signal } = context;
    const { clients } = run;
    const { region } = source;
    const state: CursorState = decodeCursorState(cursor.continuation);
    const floor = backfillFloor(source, this.backfillMs, now);

    // A página de cada serviço e a conversão do registro dela.
    let read: (window: FindingsWindow, token: string | null) => Promise<FindingsPage>;
    let parse: (raw: unknown) => ParseOutcome;
    let analyzer: AccessAnalyzerTarget | null = null;
    switch (kind) {
      case 'guardduty': {
        const target = { region, detectorId: sourceDetails(source.details).detectorId ?? source.resourceId };
        read = (window, token) => readGuardDutyPage(clients, call, target, window, token);
        parse = parseGuardDutyFinding;
        break;
      }
      case 'security_hub':
        read = (window, token) => readSecurityHubPage(clients, call, { region }, window, token);
        parse = (raw) => parseSecurityHubFinding(raw, now);
        break;
      case 'inspector':
        read = (window, token) => readInspectorPage(clients, call, { region }, window, token);
        parse = (raw) => parseInspectorFinding(raw, now);
        break;
      case 'access_analyzer': {
        const target = await this.analyzerOf(run, stream, call);
        analyzer = target;
        read = (_window, token) => readAccessAnalyzerPage(clients, call, target, token);
        parse = (raw) => parseAccessAnalyzerFinding(raw, target, now);
        break;
      }
    }

    // A janela: a continuação de uma leitura cortada, ou da posição (menos a sobreposição) até agora. O Access Analyzer
    // não filtra por data: a listagem é sempre inteira, e a continuação só diz em que página ela está.
    let window: FindingsWindow;
    let pageToken: string | null = null;
    const resume = state.resume;
    if (kind === 'access_analyzer') {
      window = { since: floor, before: now };
      pageToken = resume?.token ?? null;
    } else if (
      resume !== null &&
      resume.since >= floor &&
      resume.before <= now &&
      resume.since < resume.before
    ) {
      window = { since: resume.since, before: resume.before };
      pageToken = resume.token;
    } else {
      const from =
        cursor.cursorAt === null
          ? floor
          : new Date(Math.max(cursor.cursorAt.getTime() - this.overlapMs, floor.getTime()));
      window = { since: from, before: now };
    }

    let hours: HourVolume[] = state.hours;
    let newest: Date | null = null;
    let ingested = false;
    let pages = 0;
    let complete = false;
    let resumable = true;
    let retriedToken = false;
    const details = { left: this.detailsPerRun };
    const meter = new UsageMeter();
    for (;;) {
      signal.throwIfAborted();
      if (pages > 0) {
        const cap = resumable ? this.maxPages : this.maxPages * UNRESUMABLE_PAGES_FACTOR;
        if (pages >= cap || context.exhausted()) break;
      }
      let page: FindingsPage;
      try {
        page = await read(window, pageToken);
      } catch (error) {
        // A continuação gravada não vale mais: a janela recomeça do início dela, uma vez.
        if (pageToken !== null && !retriedToken && isRejectedToken(error)) {
          pageToken = null;
          retriedToken = true;
          continue;
        }
        throw error;
      }
      const tally = await this.processPage(run, stream, analyzer, page.records, parse, call, details, meter, {
        context,
        now,
      });
      if (tally.deferred) break;
      pages += 1;
      report.pages += 1;
      hours = addVolume(hours, now, tally.events, tally.bytes);
      report.bytes += tally.bytes;
      if (tally.events > 0) ingested = true;
      if (tally.newest !== null && (newest === null || tally.newest > newest)) newest = tally.newest;
      pageToken = page.nextToken;
      if (pageToken === null) {
        complete = true;
        break;
      }
      // A página está gravada: só agora a continuação anda, e só depois dela o volume é medido.
      const encoded = encodeCursorState({ resume: { ...window, token: pageToken }, hours });
      await this.cursors.note(key, encoded.text);
      resumable = encoded.resumable;
      await meter.flush(this.prisma);
    }

    const encoded = encodeCursorState({
      resume: complete || pageToken === null ? null : { ...window, token: pageToken },
      hours,
    });
    await this.cursors.advance(
      key,
      complete
        ? {
            cursorAt: window.before,
            continuation: encoded.text,
            nextRunAt: new Date(now.getTime() + this.intervalMs),
          }
        : // Cortada no teto: a posição fica, e a fonte volta na execução seguinte.
          { continuation: encoded.text, nextRunAt: now },
      this.now(),
    );
    await meter.flush(this.prisma);
    report.synced += 1;
    if (!complete) report.capped += 1;
    await this.record(
      run.account,
      source,
      { type: 'synced', newestEventAt: newest, ingested, volume: volumeLast24h(hours, now) },
      now,
      context,
    );
  }

  /**
   * Os registros de uma página, na ordem: conferidos, com o dono decidido, comparados com o que já está gravado e, os
   * que seguem, gravados um a um. Devolve o volume medido (só os achados novos ou com versão nova).
   */
  private async processPage(
    run: AccountRun,
    stream: Stream,
    analyzer: AccessAnalyzerTarget | null,
    records: readonly unknown[],
    parse: (raw: unknown) => ParseOutcome,
    call: FindingsCaller,
    details: { left: number },
    meter: UsageMeter,
    { context, now }: { context: RunContext; now: Date },
  ): Promise<PageTally> {
    const { report } = context;
    const { account } = run;
    const tally: PageTally = { events: 0, bytes: 0, newest: null, deferred: false };

    interface Candidate {
      finding: ParsedFinding;
      owner: { tenantId: string; accountId: string };
      drafts: FindingDraft[];
    }
    const candidates: Candidate[] = [];
    const counted = { read: 0, inactive: 0, invalid: 0, skipped: 0, unowned: 0 };
    const unowned: UnownedRecord[] = [];
    for (const raw of records.slice(0, MAX_PAGE_RECORDS)) {
      counted.read += 1;
      const outcome = parse(raw);
      if (!outcome.ok) {
        counted[outcome.reason] += 1;
        continue;
      }
      const { finding } = outcome;
      // Security Hub: o achado de um serviço que esta conta já lê pela fonte própria, na mesma região, é pulado.
      if (finding.product !== undefined) {
        const cited = finding.accounts?.length === 1 ? finding.accounts[0] : undefined;
        const covered = ownSourceKey(
          account.tenantId,
          cited ?? account.accountId,
          finding.product.kind,
          finding.product.region ?? stream.source.region,
        );
        if (context.ownSources.has(covered)) {
          counted.skipped += 1;
          continue;
        }
      }
      const owner = await this.ownerOf(account, finding.accounts, context);
      if (!owner.owned) {
        counted.unowned += 1;
        unowned.push({
          source: 'aws',
          sourceEventId: awsFindingKey(account.accountId, finding.label, finding.nativeId),
          reason: owner.reason,
          accounts: owner.accounts,
          occurredAt: new Date(finding.updatedAt),
          ruleId: finding.summary.ruleId,
          ruleLevel: finding.summary.ruleLevel,
          title: finding.summary.title,
        });
        continue;
      }
      candidates.push({ finding, owner: owner.owner, drafts: finding.drafts(owner.owner) });
    }

    // O que já está gravado, numa busca só, pelo escopo do cliente da conta.
    const stored = await this.storedVersions(
      account.tenantId,
      candidates.flatMap((candidate) => candidate.drafts),
    );
    const fresh = candidates.filter(
      (candidate) => !stored.current(candidate.drafts, candidate.finding.updatedAt),
    );
    // O detalhe do Access Analyzer só é pedido para o achado que segue. Sem orçamento para a página inteira (e com
    // algum já gasto nesta execução), ela fica para a próxima, de onde a continuação parou.
    const needing = fresh.filter((candidate) => candidate.finding.needsDetail === true).length;
    if (needing > details.left && details.left < this.detailsPerRun) return { ...tally, deferred: true };
    details.left -= needing;

    report.read += counted.read;
    report.inactive += counted.inactive;
    report.invalid += counted.invalid;
    report.skipped += counted.skipped;
    report.unowned += counted.unowned;
    report.duplicates += candidates.length - fresh.length;
    for (const record of unowned) await this.store.recordUnowned(record);
    for (const { finding, owner } of candidates) {
      const at = new Date(finding.updatedAt);
      // O último evento da conta conta também os já gravados, como no sync dos alertas do Wazuh.
      context.lastEvents.see(owner.tenantId, owner.accountId, at);
      if (tally.newest === null || at > tally.newest) tally.newest = at;
    }

    for (const candidate of fresh) {
      context.signal.throwIfAborted();
      const { finding, owner } = candidate;
      let { drafts } = candidate;
      let bytes = finding.bytes;
      if (finding.needsDetail === true && analyzer !== null) {
        const id = finding.nativeId.slice(finding.nativeId.lastIndexOf('/') + 1);
        let detail: unknown;
        try {
          detail = await readAccessAnalyzerDetail(run.clients, call, analyzer, id);
        } catch (error) {
          // O achado resolvido entre a listagem e o detalhe: não há mais o que gravar.
          if (
            error instanceof FindingsCallError &&
            awsErrorName(error.cause) === 'ResourceNotFoundException'
          ) {
            report.inactive += 1;
            continue;
          }
          throw error;
        }
        drafts = finding.drafts(owner, detail);
        bytes += recordBytes(detail) ?? 0;
      }
      const existed = drafts.some((draft) => stored.has(draft));
      let created = false;
      let excepted = false;
      for (const draft of drafts) {
        const exception = matchingException(draft, context.exceptions.get(owner.tenantId) ?? [], now);
        const outcome = await this.store.persist(draft, exception, now);
        if (outcome !== 'duplicate') created = true;
        if (outcome === 'excepted') excepted = true;
      }
      if (created) report.created += 1;
      else if (existed) report.updated += 1;
      else report.duplicates += 1;
      if (excepted) report.excepted += 1;
      // O volume é o do achado novo ou com versão nova, uma vez: a AWS no nó dedicado é medida no dia da leitura.
      meter.add(owner.tenantId, 'aws', bytes, 1, now);
      meter.addDaily(owner.tenantId, 'aws', bytes, 1, now);
      tally.events += 1;
      tally.bytes += bytes;
    }
    return tally;
  }

  /**
   * As versões já gravadas dos achados de uma página, pelo escopo do cliente: a chave de cada um e a versão mais nova
   * da cadeia dele (o original e as recorrências do GuardDuty). `current` diz se o achado já está gravado nesta versão
   * (ou numa mais nova): todas as chaves dele existem, e a versão conhecida não é mais antiga.
   */
  private async storedVersions(tenantId: string, drafts: readonly FindingDraft[]) {
    const id = (source: string, key: string) => `${source}|${key}`;
    const keys = [...new Set(drafts.map((draft) => draft.sourceEventId))];
    const chains = [
      ...new Set(drafts.flatMap((draft) => (draft.recurrence ? [draft.recurrence.chainKey] : []))),
    ];
    const rows =
      keys.length === 0
        ? []
        : await this.prisma.forTenant(tenantId).finding.findMany({
            where: {
              OR: [
                { sourceEventId: { in: keys } },
                ...(chains.length > 0 ? [{ chainKey: { in: chains } }] : []),
              ],
            },
            select: { source: true, sourceEventId: true, chainKey: true, lastSeenAt: true },
          });
    const known = new Map<string, Date | null>();
    const latest = new Map<string, Date>();
    const newer = (key: string, at: Date | null) => {
      if (at === null) return;
      const seen = latest.get(key);
      if (seen === undefined || at > seen) latest.set(key, at);
    };
    for (const row of rows) {
      known.set(id(row.source, row.sourceEventId), row.lastSeenAt);
      newer(id(row.source, row.sourceEventId), row.lastSeenAt);
      if (row.chainKey !== null) newer(id(row.source, row.chainKey), row.lastSeenAt);
    }
    const has = (draft: FindingDraft) => known.has(id(draft.source, draft.sourceEventId));
    return {
      has,
      current: (found: readonly FindingDraft[], updatedAt: string): boolean => {
        const version = new Date(updatedAt);
        return (
          found.length > 0 &&
          found.every((draft) => {
            if (!has(draft)) return false;
            const seen = latest.get(id(draft.source, draft.recurrence?.chainKey ?? draft.sourceEventId));
            return seen !== undefined && seen >= version;
          })
        );
      },
    };
  }

  /**
   * De quem é o achado. A conta do achado é a da fonte: é do cliente dela. Outra conta (o detector, o hub ou o
   * analisador que administra contas-membro): segue a regra de sempre (`alerts/alert-owner.ts`), só é do cliente se
   * estiver cadastrada, ativa, para ele. Na dúvida, o achado não é de ninguém.
   */
  private async ownerOf(
    account: AccountRow,
    accounts: readonly string[] | null,
    context: RunContext,
  ): Promise<
    | { owned: true; owner: { tenantId: string; accountId: string } }
    | { owned: false; reason: UnownedRecord['reason']; accounts: string[] }
  > {
    if (accounts === null) return { owned: false, reason: 'invalid_alert', accounts: [] };
    const [cited] = accounts;
    if (cited === undefined) return { owned: false, reason: 'no_account', accounts: [] };
    if (accounts.length > 1) return { owned: false, reason: 'conflicting_accounts', accounts: [...accounts] };
    if (cited === account.accountId) {
      return { owned: true, owner: { tenantId: account.tenantId, accountId: cited } };
    }
    let memberOf = context.members.get(cited);
    if (memberOf === undefined) {
      // Busca de sistema, só para decidir o dono: a conta citada está cadastrada, ativa, e de quem é.
      const member = await this.prisma.cloudAccount.findFirst({
        where: { provider: 'aws', accountId: cited, status: 'active' },
        select: { tenantId: true },
      });
      memberOf = member?.tenantId ?? null;
      context.members.set(cited, memberOf);
    }
    if (memberOf === null) return { owned: false, reason: 'unknown_account', accounts: [cited] };
    if (memberOf !== account.tenantId) return { owned: false, reason: 'source_mismatch', accounts: [cited] };
    return { owned: true, owner: { tenantId: account.tenantId, accountId: cited } };
  }

  /**
   * O que a falha de uma chamada diz da fonte: a permissão que falta (com a ação do IAM), o serviço desligado ou o
   * recurso que sumiu, ou uma falha que pode passar (com o código). Onde o erro da AWS não separa os casos, uma leitura
   * a mais confere: o detector do GuardDuty ainda existe? O Inspector está ligado?
   */
  private async classify(
    run: AccountRun,
    stream: Stream,
    error: FindingsCallError,
    call: FindingsCaller,
    signal: AbortSignal,
  ): Promise<Failure> {
    const name = awsErrorName(error.cause);
    const { source, kind } = stream;
    if (isThrottling(error.cause)) return { type: 'failed', code: 'throttled' };
    const confirm = async (check: () => Promise<boolean>): Promise<boolean | null> => {
      try {
        return await check();
      } catch (failure) {
        if (isFatal(failure, signal)) throw failure;
        return null;
      }
    };
    if (
      kind === 'security_hub' &&
      (name === 'InvalidAccessException' || name === 'ResourceNotFoundException')
    ) {
      return { type: 'missing', code: 'not_enabled' };
    }
    if (kind === 'access_analyzer' && name === 'ResourceNotFoundException') {
      return { type: 'missing', code: 'not_found' };
    }
    if (kind === 'guardduty' && name === 'BadRequestException') {
      const target = {
        region: source.region,
        detectorId: sourceDetails(source.details).detectorId ?? source.resourceId,
      };
      const exists = await confirm(() => guardDutyDetectorExists(run.clients, call, target));
      if (exists === false) return { type: 'missing', code: 'not_found' };
    }
    if (REFUSED_CODES.has(name)) {
      if (kind === 'inspector') {
        // O Inspector desligado também responde acesso negado: o estado da conta separa os dois.
        const enabled = await confirm(() =>
          call('inspector2:BatchGetAccountStatus', () => inspectorEnabled(run.clients, source.region)),
        );
        if (enabled === false) return { type: 'missing', code: 'not_enabled' };
      }
      return { type: 'permission', detail: error.action };
    }
    return { type: 'failed', code: discoveryErrorCode(error.cause) };
  }

  /** Registra a falha de uma fonte: o recuo no cursor e o estado dela. */
  private async failStream(
    account: AccountRow,
    stream: Stream,
    failure: Failure,
    now: Date,
    context: RunContext,
  ): Promise<void> {
    const code = failure.type === 'permission' ? failure.detail : failure.code;
    this.countFailure(context.report, code);
    const cursor = await this.cursors.fail(stream.key, new FindingsRunError(code), now, {
      backoff: failure.type === 'failed' ? this.backoff : this.refusalBackoff,
    });
    const outcome: SourceOutcome =
      failure.type === 'failed' ? { type: 'failed', code, failures: cursor.failures } : failure;
    await this.record(account, stream.source, outcome, now, context);
  }

  /**
   * Grava o estado e a saúde de uma fonte, sob o lock da conta (o mesmo da autorização pelo painel e da descoberta) e
   * pelo escopo do cliente dela, só se a autorização ainda valer e a fonte ainda estiver na coleta: a que foi revogada,
   * ou que a descoberta marcou como sumida no meio da leitura, fica como está. A mudança de estado entra na trilha.
   */
  private async record(
    account: AccountRow,
    source: SourceRow,
    outcome: SourceOutcome,
    now: Date,
    context: RunContext,
  ): Promise<void> {
    const changed = await this.prisma.$transaction(async (tx) => {
      await lockAwsOnboarding(tx, account.id);
      const db = scopeToTenant(tx, account.tenantId);
      const current = await db.awsSource.findFirst({
        where: {
          id: source.id,
          cloudAccountId: account.id,
          authorizedAt: { not: null },
          revokedAt: null,
          state: { in: [...AWS_SOURCE_ACTIVE_STATES] },
        },
        select: SOURCE_SELECT,
      });
      if (current === null) return false;
      const change = sourceChange(current, outcome, now);
      await db.awsSource.updateMany({ where: { id: source.id, revokedAt: null }, data: change.data });
      if (change.transition === null) return false;
      await this.audit.write(tx, {
        actor: { type: 'system', tenantId: account.tenantId },
        action: AUDIT_ACTION,
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: account.id,
        before: { sourceId: source.id, kind: source.kind, region: source.region, ...change.transition.from },
        after: { sourceId: source.id, kind: source.kind, region: source.region, ...change.transition.to },
      });
      return true;
    });
    if (changed) context.report.transitions += 1;
  }
}
