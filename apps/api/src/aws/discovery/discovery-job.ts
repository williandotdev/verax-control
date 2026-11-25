import { randomUUID } from 'node:crypto';
import {
  AWS_DISCOVERY_MAX_ERRORS,
  AWS_SOURCE_GLOBAL_REGION,
  type AwsDiscoveryError,
  type AwsDiscoveryStatus,
  type AwsInfrastructureSummary,
  type AwsReaderCapability,
  type AwsSourceFeatures,
  type AwsSourceKind,
  isAwsRegion,
  isAwsTemplateOutdated,
} from '@verax/shared';
import { SyncLease } from '../../alerts/finding-store.js';
import { type Backoff, CollectorCursors, type CursorKey } from '../../collectors/collector-cursor.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { errorKind } from '../../common/logger/error-kind.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { COLLECTING_TENANT } from '../../tenants/tenant-status.js';
import { entersRole } from '../onboarding/account-access.js';
import {
  accountCapabilities,
  SOURCE_SELECT,
  sourceDetails,
  type SourceRow,
} from '../onboarding/onboarding-view.js';
import type { AwsReaderFacts } from '../aws-connection-check.js';
import { readerFactsChanged, recordReaderFacts } from '../onboarding/reader-facts.js';
import { readReaderTags, TEMPLATE_V1_FACTS } from '../reader-tags.js';
import { AwsConnectionError, type AwsReaderCredentials, STS_FALLBACK_REGION } from '../web-identity.js';
import type { CatalogueContext } from './catalogue.js';
import { type DiscoveryClientFactory, DiscoveryRunClients } from './clients.js';
import {
  discoverAccount,
  discoveryErrorCode,
  type DiscoveryResult,
  type DiscoveryTarget,
  DiscoveryUnavailable,
} from './discovery.js';
import {
  DISCOVERY_RUN_SELECT,
  type DiscoveryRunRow,
  lockAwsOnboarding,
  requestAwsDiscovery,
} from './discovery-runs.js';
import { applyDiscovery, type ApplyReport, applySourceReading } from './discovery-store.js';
import { probeInto } from './probes.js';
import { ReadOnlyViolation } from './read-only.js';
import { readSource, type SourceReading } from './source-reading.js';

/** Nome da concessão em `SyncState`: um worker por vez na tarefa, mesmo com mais de uma réplica. */
export const AWS_DISCOVERY_SYNC = 'aws-discovery';
/** O fluxo do cursor de cada conta (`CollectorCursor`): a próxima descoberta diária e as falhas seguidas. */
export const AWS_DISCOVERY_STREAM = 'aws_discovery';
/** A tarefa olha os pedidos a cada 30 s: a descoberta do "Conectar" começa logo depois da entrada no papel. */
export const AWS_DISCOVERY_TICK_MS = 30_000;
/** Orçamento de uma execução da tarefa (algumas contas, uma de cada vez). */
export const AWS_DISCOVERY_BUDGET_MS = 30 * 60 * 1000;
/** Validade da concessão, renovada durante a execução a cada terço dela e conferida na transação que grava. */
export const AWS_DISCOVERY_LEASE_MS = 15 * 60 * 1000;
/** Uma descoberta por conta a cada 24 h... */
export const AWS_DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** ...mais um sorteio de até 1 h, para as contas não serem lidas todas na mesma hora. */
export const AWS_DISCOVERY_JITTER_MS = 60 * 60 * 1000;
/** As contas a agendar são olhadas a cada 5 min (os pedidos pendentes, a cada execução). */
export const AWS_DISCOVERY_SCHEDULE_EVERY_MS = 5 * 60 * 1000;
/** Descobertas por execução da tarefa, as mais antigas primeiro. */
export const AWS_DISCOVERY_BATCH = 3;
/** Sondagens pedidas no painel ("Tentar de novo") respondidas por execução. */
export const AWS_DISCOVERY_PROBE_BATCH = 20;
/** Recuo da descoberta diária depois de uma que falhou: 30 min, dobrando, até 6 h. */
export const AWS_DISCOVERY_BACKOFF: Readonly<Backoff> = { baseMs: 30 * 60 * 1000, maxMs: 6 * 60 * 60 * 1000 };
/** A gravação de uma descoberta grande (centenas de fontes) cabe com folga. */
const PERSIST_TIMEOUT_MS = 120_000;
const MAX_ACCOUNT_REGIONS = 40;

/** O que a tarefa usa do provedor de sessões (o do worker; um falso nos testes). */
export type DiscoveryCredentials = Pick<AwsReaderCredentials, 'session' | 'credentialsFor' | 'forget'>;

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente nem da AWS). */
export interface AwsDiscoveryReport {
  /** `locked`: outra réplica tem a concessão; `lease_lost`: a concessão venceu no meio e outra réplica a tomou. */
  status: 'done' | 'locked' | 'lease_lost';
  /** Execuções que ficaram "em curso" de um worker que parou: marcadas como falha. */
  interrupted: number;
  /** Descobertas diárias pedidas nesta execução. */
  scheduled: number;
  /** Pedidos pendentes lidos. */
  pending: number;
  succeeded: number;
  partial: number;
  failed: number;
  /** O pedido mudou no meio (a conta desativada, outra réplica o pegou): nada gravado. */
  stale: number;
  /** Fontes novas, alteradas, sumidas e tiradas da lista, somadas as execuções. */
  sources: Pick<ApplyReport, 'created' | 'updated' | 'missing' | 'removed'>;
  /** Sondagens pedidas no painel respondidas. */
  probes: number;
  /** Os códigos das descobertas que falharam. */
  failures?: Record<string, number>;
}

export interface AwsDiscoveryOptions {
  audit?: AuditService;
  /** Nome da concessão em `SyncState` (os testes usam um por caso). */
  name?: string;
  owner?: string;
  leaseMs?: number;
  now?: () => Date;
  /** O sorteio do horário, de 0 a 1 (os testes fixam). */
  random?: () => number;
  batch?: number;
  probeBatch?: number;
  intervalMs?: number;
  jitterMs?: number;
  scheduleEveryMs?: number;
  backoff?: Backoff;
  /** O que o nó tem ligado (`AWS_WEB_LOGS_ENABLED`); sem informar, nada. */
  features?: Readonly<AwsSourceFeatures>;
  /** Só os testes, que dividem o banco: restringe a execução às contas destes clientes. */
  tenantIds?: readonly string[];
}

const ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  accountId: true,
  provider: true,
  status: true,
  origin: true,
  regions: true,
  connection: true,
  connectionError: true,
  ingestFrom: true,
  cloudtrailBucket: true,
  guarddutyBucket: true,
  wafBucket: true,
  awsTemplateVersion: true,
  awsCapabilities: true,
  awsCapabilitiesCheckedAt: true,
  awsDiscoveredRegions: true,
} as const satisfies Prisma.CloudAccountSelect;
type AccountRow = Prisma.CloudAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** A concessão não é mais deste worker: a execução para, e nada do que está em curso é gravado. */
class DiscoveryLeaseLost extends Error {
  constructor() {
    super('descoberta da AWS: concessão perdida');
    this.name = 'DiscoveryLeaseLost';
  }
}

/** Uma descoberta diária que falhou, guardada no cursor só pelo código. */
class DiscoveryRunError extends Error {
  constructor(code: string) {
    super(`descoberta da AWS: ${code}`);
    this.name = code;
  }
}

/** O código de uma descoberta que falhou: o da conexão, o da descoberta, ou o tipo do erro (banco, gravação). */
function failureCode(error: unknown): string {
  if (error instanceof AwsConnectionError) return error.code;
  if (error instanceof DiscoveryUnavailable) return error.code;
  if (error instanceof ReadOnlyViolation) return 'read_only_violation';
  return errorKind(error);
}

/**
 * O que a descoberta precisa saber da conta. Com as tags do papel lidas, as capacidades são as delas (no template v1,
 * só a descoberta: as outras não estão liberadas, e as fontes pedem a atualização da pilha). Sem as tags lidas ainda, a
 * permissão de cada fonte é sondada. A conta que chega aqui já traz as tags lidas no começo da execução (`withFacts`).
 */
function targetOf(account: AccountRow, features: Readonly<AwsSourceFeatures> | undefined): DiscoveryTarget {
  // As tags lidas dizem as capacidades mesmo quando a da versão não é um número (a versão fica null).
  const capabilities: AwsReaderCapability[] | null =
    account.awsCapabilitiesCheckedAt === null ? null : accountCapabilities(account.awsCapabilities);
  return {
    accountId: account.accountId,
    regions: account.regions,
    capabilities,
    templateOutdated: isAwsTemplateOutdated(account.awsTemplateVersion),
    legacyBuckets: {
      cloudtrail: account.cloudtrailBucket,
      guardduty: account.guarddutyBucket,
      waf: account.wafBucket,
    },
    features,
  };
}

/** A conta com as tags do papel lidas agora no lugar das gravadas. */
function withFacts(account: AccountRow, facts: AwsReaderFacts, now: Date): AccountRow {
  return {
    ...account,
    awsTemplateVersion: facts.templateVersion,
    awsCapabilities: [...facts.capabilities],
    awsCapabilitiesCheckedAt: now,
  };
}

/** As regiões monitoradas com as descobertas no fim, sem repetir e sem tirar nenhuma. */
function withDiscovered(current: readonly string[], discovered: readonly string[]): string[] {
  const merged = [...current];
  for (const region of discovered) {
    if (merged.length >= MAX_ACCOUNT_REGIONS) break;
    if (isAwsRegion(region) && !merged.includes(region)) merged.push(region);
  }
  return merged;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** A conta de um lote de sondagens: os clientes da sessão dela e o que as tags do papel dizem agora. */
interface ProbeSession {
  clients: DiscoveryRunClients;
  context: CatalogueContext;
  templateOutdated: boolean;
}

/**
 * Tarefa `aws-discovery` do worker (onboarding self-service; `docs/ARQUITETURA.md`, "Onboarding AWS self-service"): a
 * descoberta das fontes de log de cada conta AWS, pela mesma sessão de leitura da conferência da conexão e do
 * inventário (`AwsReaderCredentials`: o papel sem chave ou, na VM própria do cliente, a chave do cofre).
 *
 * A cada execução (30 s), sob a concessão no banco:
 * 1. **O que ficou "em curso"** de um worker que parou vira falha (`interrupted`): só quem tem a concessão executa.
 * 2. **O agendamento diário** (olhado a cada 5 min): a conta AWS ativa, já verificada e que entra no papel ganha um
 *    pedido `scheduled` quando a última descoberta tem mais de 24 h (mais um sorteio de até 1 h), pelo cursor da conta
 *    (`CollectorCursor`, fluxo `aws_discovery`). Com outro pedido pendente, nada é pedido.
 * 3. **Os pedidos pendentes** (do "Conectar", do painel e os diários), os mais antigos primeiro, no máximo
 *    `AWS_DISCOVERY_BATCH`: cada um é tomado (`pending` para `running`), executado (`discoverAccount`) e gravado numa
 *    transação pelo escopo do cliente da conta: as fontes (`applyDiscovery`), as regiões da conta e o fim da execução,
 *    com a concessão conferida e o lock da conta (o mesmo da autorização pelo painel). A conta que não entra no papel,
 *    foi desativada ou é de um cliente parado termina a execução como falha, sem chamar a AWS. **Toda execução começa
 *    lendo as tags do papel** (`readReaderTags`: a versão do template e as capacidades), e são elas que valem até o
 *    fim, não as gravadas na conta: o cliente que atualizou a pilha e pediu a descoberta vê as fontes liberadas na
 *    hora. As tags vão para a conta junto com o resultado, pela regra de `onboarding/reader-facts.ts` (a mudança entra
 *    na trilha). Com a leitura das tags sem resposta (uma falha passageira), valem as gravadas, e a falha fica no
 *    registro da execução (`iam × global × código`), que termina `partial`.
 * 4. **As sondagens pedidas no painel** ("Tentar de novo" numa fonte): as tags do papel e a própria fonte são lidas de
 *    novo na AWS, e só então a permissão é sondada (`answerProbes`). Nada do que está gravado decide a resposta.
 *
 * **As regiões:** `awsDiscoveredRegions` passa a ser as regiões com recurso ou fonte. As monitoradas (`regions`) só
 * ganham regiões, nunca perdem, e só na conta cadastrada pelo painel: na conta do console, as regiões são do console.
 * A mudança entra na trilha do cliente (`cloud_account.aws_discovery`, ator sistema), junto com o que mudou nas fontes.
 *
 * Nada da conta vai para o log: o relatório só tem contagens e códigos.
 */
export class AwsDiscovery {
  private readonly audit: AuditService;
  private readonly lease: SyncLease;
  private readonly cursors: CollectorCursors;
  private readonly name: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly batch: number;
  private readonly probeBatch: number;
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly scheduleEveryMs: number;
  private readonly backoff: Backoff;
  private readonly features: Readonly<AwsSourceFeatures> | undefined;
  private readonly tenantIds: readonly string[] | undefined;
  private readonly renewEveryMs: number;
  private scheduledAt: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: DiscoveryCredentials,
    private readonly clients: DiscoveryClientFactory,
    {
      audit = new AuditService(),
      name = AWS_DISCOVERY_SYNC,
      owner = `worker-${randomUUID()}`,
      leaseMs = AWS_DISCOVERY_LEASE_MS,
      now = () => new Date(),
      random = Math.random,
      batch = AWS_DISCOVERY_BATCH,
      probeBatch = AWS_DISCOVERY_PROBE_BATCH,
      intervalMs = AWS_DISCOVERY_INTERVAL_MS,
      jitterMs = AWS_DISCOVERY_JITTER_MS,
      scheduleEveryMs = AWS_DISCOVERY_SCHEDULE_EVERY_MS,
      backoff = AWS_DISCOVERY_BACKOFF,
      features,
      tenantIds,
    }: AwsDiscoveryOptions = {},
  ) {
    if (!Number.isInteger(batch) || batch < 1) {
      throw new Error('o lote do aws-discovery precisa ser um inteiro positivo');
    }
    this.audit = audit;
    this.name = name;
    this.lease = new SyncLease(prisma, name, owner, leaseMs);
    this.renewEveryMs = Math.max(250, Math.floor(leaseMs / 3));
    this.cursors = new CollectorCursors(prisma);
    this.now = now;
    this.random = random;
    this.batch = batch;
    this.probeBatch = probeBatch;
    this.intervalMs = intervalMs;
    this.jitterMs = jitterMs;
    this.scheduleEveryMs = scheduleEveryMs;
    this.backoff = backoff;
    this.features = features;
    this.tenantIds = tenantIds;
  }

  /** A próxima descoberta diária depois de uma que terminou: 24 h depois do início dela, mais o sorteio. */
  nextRunAfter(startedAt: Date): Date {
    const jitter = Math.floor(Math.min(Math.max(this.random(), 0), 1) * this.jitterMs);
    return new Date(startedAt.getTime() + this.intervalMs + jitter);
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<AwsDiscoveryReport> {
    const report: AwsDiscoveryReport = {
      status: 'done',
      interrupted: 0,
      scheduled: 0,
      pending: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      stale: 0,
      sources: { created: 0, updated: 0, missing: 0, removed: 0 },
      probes: 0,
    };
    const startedAt = this.now();
    if (!(await this.lease.acquire(startedAt))) return { ...report, status: 'locked' };
    const ownership = new AbortController();
    const active = AbortSignal.any([signal, ownership.signal]);
    const keeper = setInterval(() => void this.keepLease(ownership), this.renewEveryMs);
    let firstError: string | null = null;
    try {
      report.interrupted = await this.failInterrupted(startedAt);
      if (this.scheduledAt === null || startedAt.getTime() - this.scheduledAt >= this.scheduleEveryMs) {
        report.scheduled = await this.schedule(startedAt);
        this.scheduledAt = startedAt.getTime();
      }
      const runs = await this.prisma.awsDiscoveryRun.findMany({
        where: { status: 'pending', ...this.tenantFilter() },
        select: DISCOVERY_RUN_SELECT,
        orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        take: this.batch,
      });
      report.pending = runs.length;
      for (const run of runs) {
        active.throwIfAborted();
        const failed = await this.execute(run, report, active, ownership);
        firstError ??= failed;
        await this.keepLease(ownership);
      }
      active.throwIfAborted();
      report.probes = await this.answerProbes(active);
      active.throwIfAborted();
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastRunAt: startedAt,
          ...(firstError === null && { lastSuccessAt: this.now() }),
          lastError: firstError,
        },
      });
      return report;
    } catch (error) {
      if (ownership.signal.aborted && !signal.aborted) return { ...report, status: 'lease_lost' };
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
      if (!(await this.lease.renew())) ownership.abort(new DiscoveryLeaseLost());
    } catch {
      // O banco fora agora: a próxima renovação, ou a gravação, decide.
    }
  }

  private keyOf(cloudAccountId: string): CursorKey {
    return { cloudAccountId, stream: AWS_DISCOVERY_STREAM };
  }

  /** As execuções que um worker deixou "em curso" ao parar: com a concessão nas mãos, ninguém mais as executa. */
  private async failInterrupted(now: Date): Promise<number> {
    const { count } = await this.prisma.awsDiscoveryRun.updateMany({
      where: { status: 'running', ...this.tenantFilter() },
      data: {
        status: 'failed',
        finishedAt: now,
        errors: [{ service: 'run', region: 'global', code: 'interrupted' }],
      },
    });
    return count;
  }

  /** Pede a descoberta diária das contas na hora (pelo cursor de cada uma) e sem outro pedido pendente. */
  private async schedule(now: Date): Promise<number> {
    const accounts = await this.prisma.cloudAccount.findMany({
      where: {
        provider: 'aws',
        status: 'active',
        ingestFrom: { not: null },
        connection: { in: ['connected', 'error'] },
        ...COLLECTING_TENANT,
        ...this.tenantFilter(),
      },
      select: ACCOUNT_SELECT,
      orderBy: { id: 'asc' },
    });
    let scheduled = 0;
    for (const account of accounts) {
      if (!entersRole(account)) continue;
      // Sem cursor (nunca descoberta), ele nasce com a descoberta para já.
      const cursor = await this.cursors.read(this.keyOf(account.id), now);
      if (cursor.nextRunAt.getTime() > now.getTime()) continue;
      const { created } = await this.prisma.$transaction((tx) =>
        requestAwsDiscovery(tx, {
          tenantId: account.tenantId,
          cloudAccountId: account.id,
          trigger: 'scheduled',
          now,
        }),
      );
      if (created) scheduled += 1;
    }
    return scheduled;
  }

  /**
   * Uma descoberta pedida. Devolve o código da falha (ou null), para o estado da tarefa. O sinal é o da execução (o do
   * agendador e o da concessão); abortado, a execução em curso fica marcada como interrompida.
   */
  private async execute(
    run: DiscoveryRunRow,
    report: AwsDiscoveryReport,
    signal: AbortSignal,
    ownership: AbortController,
  ): Promise<string | null> {
    const startedAt = this.now();
    const account = await this.prisma.cloudAccount.findFirst({
      where: {
        id: run.cloudAccountId,
        tenantId: run.tenantId,
        provider: 'aws',
        status: 'active',
        ...COLLECTING_TENANT,
      },
      select: ACCOUNT_SELECT,
    });
    // Toma o pedido: outra réplica (ou uma execução anterior) pode tê-lo pego.
    const taken = await this.prisma.awsDiscoveryRun.updateMany({
      where: { id: run.id, status: 'pending' },
      data: { status: 'running', startedAt },
    });
    if (taken.count === 0) {
      report.stale += 1;
      return null;
    }
    if (account === null || !entersRole(account)) {
      const code = account === null ? 'account_unavailable' : 'not_connected';
      await this.finish(run, startedAt, [{ service: 'run', region: 'global', code }]);
      return this.failed(report, code);
    }
    const home = account.regions.find(isAwsRegion) ?? STS_FALLBACK_REGION;
    let clients: DiscoveryRunClients | null = null;
    try {
      // A entrada no papel primeiro: recusada, nenhuma outra chamada.
      const session = await this.credentials.session(account.accountId, home, signal);
      clients = new DiscoveryRunClients(
        this.clients(this.credentials.credentialsFor(account.accountId, home), home),
        home,
        signal,
      );
      // As tags do papel, lidas agora, valem para a execução inteira. A leitura recusada é o template v1: se for uma
      // sessão que deixou de valer, nada mais é lido, a execução falha e nada disso é gravado.
      const tags = await readReaderTags(clients.iam(), session.principal, signal);
      const facts =
        tags.status === 'read' ? tags.facts : tags.status === 'refused' ? TEMPLATE_V1_FACTS : null;
      const result = await discoverAccount(
        targetOf(facts === null ? account : withFacts(account, facts, startedAt), this.features),
        clients,
        { signal, now: startedAt },
      );
      if (tags.status === 'unavailable') {
        // Sem as tags agora, valeram as capacidades gravadas na conta: fica dito no registro da execução.
        const unread: AwsDiscoveryError = {
          service: 'iam',
          region: AWS_SOURCE_GLOBAL_REGION,
          code: discoveryErrorCode(tags.error),
        };
        const known = result.errors.some(
          (error) =>
            error.service === unread.service && error.region === unread.region && error.code === unread.code,
        );
        if (!known) result.errors.unshift(unread);
      }
      const persisted = await this.persist(run, account, result, startedAt, facts);
      if (persisted === 'lost') {
        ownership.abort(new DiscoveryLeaseLost());
        signal.throwIfAborted();
      }
      if (persisted === 'stale') {
        await this.finish(run, startedAt, [
          { service: 'run', region: 'global', code: 'account_unavailable' },
        ]);
        report.stale += 1;
        return null;
      }
      const applied = persisted as ApplyReport;
      report.sources.created += applied.created;
      report.sources.updated += applied.updated;
      report.sources.missing += applied.missing;
      report.sources.removed += applied.removed;
      if (result.errors.length > 0) report.partial += 1;
      else report.succeeded += 1;
      await this.cursors.read(this.keyOf(account.id), startedAt);
      await this.cursors.advance(
        this.keyOf(account.id),
        { continuation: null, nextRunAt: this.nextRunAfter(startedAt) },
        this.now(),
      );
      return null;
    } catch (error) {
      if (signal.aborted) {
        // A parada do worker, o orçamento ou a concessão perdida: a execução não fica "em curso" para sempre.
        await this.finish(run, startedAt, [{ service: 'run', region: 'global', code: 'interrupted' }]).catch(
          () => undefined,
        );
        throw error;
      }
      const code = failureCode(error);
      // Tudo recusado: a sessão guardada pode ter sido revogada no console.
      if (error instanceof DiscoveryUnavailable) this.credentials.forget(account.accountId);
      const service = error instanceof AwsConnectionError ? 'sts' : 'run';
      await this.finish(run, startedAt, [{ service, region: 'global', code }]);
      await this.cursors.read(this.keyOf(account.id), startedAt);
      await this.cursors.fail(this.keyOf(account.id), new DiscoveryRunError(code), this.now(), {
        backoff: this.backoff,
      });
      return this.failed(report, code);
    } finally {
      clients?.destroy();
    }
  }

  private failed(report: AwsDiscoveryReport, code: string): string {
    report.failed += 1;
    report.failures = { ...report.failures, [code]: (report.failures?.[code] ?? 0) + 1 };
    return code;
  }

  /** Termina uma execução que não entrou na conta, com o motivo. */
  private async finish(run: DiscoveryRunRow, startedAt: Date, errors: AwsDiscoveryError[]): Promise<void> {
    await this.prisma.forTenant(run.tenantId).awsDiscoveryRun.updateMany({
      where: { id: run.id, status: 'running' },
      data: { status: 'failed', startedAt, finishedAt: this.now(), errors },
    });
  }

  /**
   * Grava o resultado numa transação só, pelo escopo do cliente da conta: as tags do papel lidas no começo (`facts`;
   * null quando não puderam ser lidas), as fontes, as regiões da conta, o fim da execução e a auditoria. A concessão é
   * conferida e renovada na própria transação, o lock da conta serializa com a autorização pelo painel, e a conta
   * precisa continuar ativa (senão, nada é gravado).
   */
  private persist(
    run: DiscoveryRunRow,
    account: AccountRow,
    result: DiscoveryResult,
    startedAt: Date,
    facts: AwsReaderFacts | null,
  ): Promise<ApplyReport | 'stale' | 'lost'> {
    return this.prisma.$transaction(
      async (tx) => {
        if (!(await this.lease.holdIn(tx))) return 'lost';
        await lockAwsOnboarding(tx, account.id);
        const db = scopeToTenant(tx, account.tenantId);
        const current = await db.cloudAccount.findFirst({
          where: { id: account.id, provider: 'aws', status: 'active', accountId: account.accountId },
          select: { regions: true, awsDiscoveredRegions: true, origin: true },
        });
        if (current === null) return 'stale';
        const now = this.now();
        // A execução já rodou com estas tags: a mudança entra na trilha, sem pedir outra descoberta.
        if (facts !== null) {
          await recordReaderFacts(tx, this.audit, account, facts, now, { requestDiscovery: false });
        }
        const applied = await applyDiscovery(db, {
          tenantId: account.tenantId,
          cloudAccountId: account.id,
          sources: result.sources,
          covered: result.covered,
          now,
          features: this.features,
        });
        // As regiões da conta do console são do console: a descoberta só acrescenta nas do painel.
        const regions =
          current.origin === 'panel'
            ? withDiscovered(current.regions, result.discoveredRegions)
            : current.regions;
        const regionsChanged =
          !sameList(regions, current.regions) ||
          !sameList(result.discoveredRegions, current.awsDiscoveredRegions);
        if (regionsChanged) {
          await db.cloudAccount.updateMany({
            where: { id: account.id },
            data: { regions, awsDiscoveredRegions: result.discoveredRegions },
          });
        }
        const status: AwsDiscoveryStatus = result.errors.length > 0 ? 'partial' : 'succeeded';
        await db.awsDiscoveryRun.updateMany({
          where: { id: run.id, status: 'running' },
          data: {
            status,
            startedAt,
            finishedAt: now,
            regions: result.regions,
            errors: result.errors.slice(0, AWS_DISCOVERY_MAX_ERRORS),
            summary: result.summary satisfies AwsInfrastructureSummary,
          },
        });
        const sourcesChanged = applied.created + applied.missing + applied.reappeared + applied.removed > 0;
        // Sem mudança nas regiões nem na lista de fontes, a descoberta diária não deixa registro na trilha.
        if (regionsChanged || sourcesChanged || run.trigger !== 'scheduled') {
          await this.audit.write(tx, {
            actor: { type: 'system', tenantId: account.tenantId },
            action: 'cloud_account.aws_discovery',
            outcome: 'success',
            resourceType: 'cloud_account',
            resourceId: account.id,
            before: { regions: current.regions, awsDiscoveredRegions: current.awsDiscoveredRegions },
            after: {
              regions,
              awsDiscoveredRegions: result.discoveredRegions,
              trigger: run.trigger,
              status,
              regionsRead: result.regions.length,
              errors: result.errors.length,
              sources: applied,
            },
          });
        }
        return applied;
      },
      { timeout: PERSIST_TIMEOUT_MS, maxWait: 15_000 },
    );
  }

  /**
   * As sondagens pedidas no painel ("Tentar de novo" numa fonte). O cliente pede a sondagem depois de mudar algo na conta
   * dele (a tag no grupo de logs, a pilha, a política do bucket ou da chave, o destino de um log); por isso a resposta
   * sai do que a AWS diz agora, e não do que a última descoberta gravou:
   * 1. as tags do papel são lidas de novo, uma vez por conta (`openProbeSession`), como no começo de toda descoberta:
   *    a capacidade ligada numa atualização da pilha vale na hora;
   * 2. a fonte é lida de novo (`readSource`): o destino, o prefixo, o formato, a tag do grupo e o estado do serviço;
   * 3. a permissão é sondada sobre o que foi lido (`probeInto`), e o resultado é gravado com as regras da descoberta
   *    para uma fonte conhecida (`applySourceReading`).
   *
   * A fonte que não está mais lá só desfaz o pedido e pede uma descoberta da conta: quem tira a linha, marca como sumida
   * ou acha a fonte que entrou no lugar é a descoberta. A conta que não entra no papel, ou a leitura que falha, só desfaz
   * o pedido: o que está gravado fica.
   */
  private async answerProbes(signal: AbortSignal): Promise<number> {
    const requested = await this.prisma.awsSource.findMany({
      where: { probeRequestedAt: { not: null }, origin: 'discovered', ...this.tenantFilter() },
      select: SOURCE_SELECT,
      orderBy: [{ probeRequestedAt: 'asc' }, { id: 'asc' }],
      take: this.probeBatch,
    });
    let answered = 0;
    const sessions = new Map<string, ProbeSession | null>();
    try {
      for (const row of requested) {
        signal.throwIfAborted();
        let session = sessions.get(row.cloudAccountId);
        if (session === undefined) {
          session = await this.openProbeSession(row, signal);
          sessions.set(row.cloudAccountId, session);
        }
        let reading: SourceReading | null = null;
        if (session !== null) {
          try {
            reading = await readSource(
              {
                kind: row.kind as AwsSourceKind,
                region: row.region,
                resourceId: row.resourceId,
                details: sourceDetails(row.details),
              },
              session.context,
              session.clients,
              signal,
            );
            if (reading.status === 'found') {
              await probeInto(reading.source, session.context, session.clients, {
                signal,
                now: this.now(),
                templateOutdated: session.templateOutdated,
              });
            }
          } catch (error) {
            if (signal.aborted) throw error;
            // A leitura recusada, a AWS fora: o pedido é desfeito, e o que está gravado fica.
            reading = null;
          }
        }
        await this.recordProbe(row, reading);
        answered += 1;
      }
    } finally {
      for (const session of sessions.values()) session?.clients.destroy();
    }
    return answered;
  }

  /**
   * A conta de um lote de sondagens: a sessão de leitura, os clientes e as tags do papel lidas agora (`iam:GetRole` no
   * próprio papel ou, na VM própria, `iam:GetUser`).
   * - **Lidas:** valem para o lote e são gravadas na conta pela regra da conferência diária (a mudança entra na trilha
   *   e pede uma descoberta, para as outras fontes).
   * - **Recusadas:** pode ser o papel do template v1 ou uma sessão que deixou de valer, e aqui não há outra leitura para
   *   desempatar. Nada é gravado. Se a conta já está gravada como v1, a recusa só confirma, e valem as gravadas.
   * - **Recusadas numa conta gravada com outro template, ou sem resposta:** as capacidades ficam desconhecidas, e toda
   *   fonte é sondada na AWS. As gravadas na conta não decidem.
   *
   * Null quando a conta não entra no papel ou a sessão foi recusada.
   */
  private async openProbeSession(
    row: Pick<SourceRow, 'cloudAccountId' | 'tenantId'>,
    signal: AbortSignal,
  ): Promise<ProbeSession | null> {
    const account = await this.prisma.cloudAccount.findFirst({
      where: {
        id: row.cloudAccountId,
        tenantId: row.tenantId,
        provider: 'aws',
        status: 'active',
        ...COLLECTING_TENANT,
      },
      select: ACCOUNT_SELECT,
    });
    if (account === null || !entersRole(account)) return null;
    const home = account.regions.find(isAwsRegion) ?? STS_FALLBACK_REGION;
    let clients: DiscoveryRunClients | null = null;
    try {
      const session = await this.credentials.session(account.accountId, home, signal);
      clients = new DiscoveryRunClients(
        this.clients(this.credentials.credentialsFor(account.accountId, home), home),
        home,
        signal,
      );
      const tags = await readReaderTags(clients.iam(), session.principal, signal);
      const now = this.now();
      let known: AccountRow;
      if (tags.status === 'read') {
        const { facts } = tags;
        await this.prisma.$transaction((tx) =>
          recordReaderFacts(tx, this.audit, account, facts, now, { requestDiscovery: true }),
        );
        known = withFacts(account, facts, now);
      } else if (tags.status === 'refused' && !readerFactsChanged(account, TEMPLATE_V1_FACTS)) {
        known = account;
      } else {
        known = { ...account, awsCapabilitiesCheckedAt: null };
      }
      const target = targetOf(known, this.features);
      return {
        clients,
        templateOutdated: target.templateOutdated,
        context: {
          accountId: target.accountId,
          legacyBuckets: target.legacyBuckets,
          capabilities: target.capabilities,
          features: target.features,
        },
      };
    } catch (error) {
      clients?.destroy();
      if (signal.aborted) throw error;
      return null;
    }
  }

  /** Grava a resposta de uma sondagem, sob o lock da conta, se o pedido ainda for o lido. */
  private recordProbe(row: SourceRow, reading: SourceReading | null): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await lockAwsOnboarding(tx, row.cloudAccountId);
      const db = scopeToTenant(tx, row.tenantId);
      const current = await db.awsSource.findFirst({
        where: { id: row.id, probeRequestedAt: row.probeRequestedAt },
        select: SOURCE_SELECT,
      });
      if (current === null) return;
      const now = this.now();
      if (reading?.status === 'found') {
        await applySourceReading(db, current, reading.source, now, this.features);
        return;
      }
      await db.awsSource.update({
        where: { id: row.id },
        data: { probeRequestedAt: null },
        select: { id: true },
      });
      if (reading?.status === 'absent') {
        await requestAwsDiscovery(tx, {
          tenantId: row.tenantId,
          cloudAccountId: row.cloudAccountId,
          trigger: 'scheduled',
          now,
        });
      }
    });
  }
}
