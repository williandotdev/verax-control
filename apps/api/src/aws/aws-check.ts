import {
  AWS_CONNECTION_WARNING_CODES,
  type AwsConnectionErrorCode,
  type AwsConnectionWarningCode,
  awsConnectionErrorValue,
  type CloudAccountConnection,
} from '@verax/shared';
import { AuditService } from '../common/audit/audit.service.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { COLLECTING_TENANT } from '../tenants/tenant-status.js';
import type { AwsCheckOutcome, AwsCheckTarget, AwsConnectionChecker } from './aws-connection-check.js';

/** A cada 30 s: o "Verificar" do painel é respondido logo, e o painel consulta a conta enquanto espera. */
export const AWS_CHECK_INTERVAL_MS = 30_000;
/**
 * Por quanto tempo um erro que pode passar (`retryable`) deixa o pedido pendente em vez de virar o erro da conta: logo
 * depois da criação da pilha, o papel pode levar alguns segundos para valer no IAM, e o Google ou a AWS podem falhar
 * por um momento. Passado o prazo, o erro é gravado.
 */
export const AWS_CHECK_RETRY_WINDOW_MS = 10 * 60 * 1000;
/** Pedidos por execução, os mais antigos primeiro; o mesmo limite vale para as conferências periódicas. */
export const AWS_CHECK_BATCH = 20;
/** Sem pedido, cada conta já verificada é conferida de novo a cada 15 min (PR-V5'). */
export const AWS_RECHECK_INTERVAL_MS = 15 * 60 * 1000;
/** A trilha, o export do GuardDuty e a permissão demais: uma vez por dia por conta (e em todo "Verificar"). */
export const AWS_DAILY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * As novas tentativas de um erro que pode passar são espaçadas: 30 s, 1 min, 2 min e depois a cada 4 min, até a janela
 * de 10 min. São 6 conferências por clique no pior caso (eram até 20, uma a cada 30 s), cada uma uma entrada no
 * CloudTrail do cliente.
 */
export const AWS_CHECK_RETRY_BASE_MS = 30_000;
export const AWS_CHECK_RETRY_MAX_MS = 4 * 60 * 1000;

/** A espera antes da próxima tentativa, depois de `attempts` falhas seguidas que podem passar. */
export function awsCheckRetryDelayMs(attempts: number): number {
  return Math.min(AWS_CHECK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), AWS_CHECK_RETRY_MAX_MS);
}

/** Contagens de uma execução dos pedidos (vão para o log do agendador; nenhum dado de cliente). */
export interface AwsCheckReport {
  /** Pedidos pendentes lidos nesta execução. */
  pending: number;
  connected: number;
  /** Erro gravado na conta. */
  failed: number;
  /**
   * Erro que pode passar, dentro da janela: o pedido continua pendente para uma próxima tentativa (também o pedido
   * que ainda espera a hora dela).
   */
  retrying: number;
  /** O pedido mudou durante a conferência (conta desativada ou removida): o resultado foi descartado. */
  stale: number;
  /** Códigos dos erros gravados. */
  failures?: Partial<Record<AwsConnectionErrorCode, number>>;
}

/** Contagens de uma execução das conferências sem pedido (a cada 15 min por conta). */
export interface AwsRecheckReport {
  /** Contas AWS ativas, já verificadas e sem pedido pendente. */
  accounts: number;
  /** Conferidas nesta execução (as outras ainda não estavam na hora). */
  checked: number;
  /** Com as conferências diárias concluídas. */
  daily: number;
  /** A conexão mudou e foi gravada, com auditoria. Sem mudança, nada é gravado. */
  changed: number;
  /** Erro que pode passar numa conta conectada: tentado de novo, espaçado, antes de virar o erro da conta. */
  retrying: number;
  /** A conta mudou durante a conferência (pedido novo, desativada): o resultado foi descartado. */
  stale: number;
  /** Códigos dos erros gravados. */
  failures?: Partial<Record<AwsConnectionErrorCode, number>>;
}

export interface AwsCheckOptions {
  audit?: AuditService;
  now?: () => Date;
  retryWindowMs?: number;
  batch?: number;
  recheckIntervalMs?: number;
  dailyIntervalMs?: number;
  /** Só os testes, que dividem o banco: restringe a execução às contas destes clientes. */
  tenantIds?: readonly string[];
}

const ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  accountId: true,
  regions: true,
  cloudtrailBucket: true,
  guarddutyBucket: true,
  wafBucket: true,
  connection: true,
  connectionError: true,
  checkRequestedAt: true,
  ingestFrom: true,
} as const satisfies Prisma.CloudAccountSelect;
type AccountRow = Prisma.CloudAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** O estado da conexão que a tarefa grava. */
interface ConnectionState {
  connection: CloudAccountConnection;
  connectionError: string | null;
}

/** O estado de uma conta com pedido pendente: o "Verificar" volta a conexão para "aguardando", sem erro. */
const RESET_STATE: ConnectionState = { connection: 'waiting', connectionError: null };

/** Os avisos que só as conferências diárias encontram (o `region_disabled` sai de toda conferência). */
const DAILY_WARNINGS: ReadonlySet<string> = new Set<AwsConnectionWarningCode>([
  'trail_not_logging',
  'guardduty_export_missing',
  'excess_permissions',
]);

/** A tentativa periódica de um erro que pode passar (a de um pedido usa o horário dele). */
const PERIODIC = 'periodic';

/**
 * O que o worker lembra de cada conta, só em memória: numa partida nova, toda conta já verificada é conferida (com as
 * diárias) na primeira execução, e nada se perde além disso.
 */
interface AccountMemory {
  /** Fim da última conferência com resultado (gravado, ou igual ao gravado). */
  checkedAt?: number;
  /** Fim das últimas conferências diárias concluídas e os avisos delas. */
  dailyAt?: number;
  dailyWarnings?: readonly AwsConnectionWarningCode[];
  /** Erro que pode passar em curso: de que pedido (ou `periodic`), desde quando, quantas tentativas e a próxima. */
  retry?: { episode: string; since: number; attempts: number; nextAt: number };
}

/** O dia anterior ao da verificação, em UTC: o `only_logs_after` do Wazuh, com um dia de folga. */
export function ingestDayFor(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
}

function isoDay(day: Date | null): string | null {
  return day?.toISOString().slice(0, 10) ?? null;
}

function targetOf(row: AccountRow, daily: boolean): AwsCheckTarget {
  return {
    cloudAccountId: row.id,
    accountId: row.accountId,
    regions: row.regions,
    buckets: { cloudtrail: row.cloudtrailBucket, guardduty: row.guarddutyBucket, waf: row.wafBucket },
    daily,
  };
}

/**
 * O estado a gravar: o erro (com a fonte, num erro de bucket), ou conectada com o aviso de maior prioridade entre os
 * da conferência e os das últimas diárias. Sem diárias na memória (partida nova, diária ainda não concluída), o aviso
 * diário já gravado fica.
 */
function stateOf(outcome: AwsCheckOutcome, memory: AccountMemory, stored: ConnectionState): ConnectionState {
  if (!outcome.ok) {
    return { connection: 'error', connectionError: awsConnectionErrorValue(outcome.code, outcome.source) };
  }
  const storedDaily =
    stored.connection === 'connected' &&
    stored.connectionError !== null &&
    DAILY_WARNINGS.has(stored.connectionError)
      ? [stored.connectionError]
      : [];
  const found = new Set<string>([...(outcome.warnings ?? []), ...(memory.dailyWarnings ?? storedDaily)]);
  return {
    connection: 'connected',
    connectionError: AWS_CONNECTION_WARNING_CODES.find((code) => found.has(code)) ?? null,
  };
}

function countFailure(
  report: { failures?: Partial<Record<AwsConnectionErrorCode, number>> },
  outcome: AwsCheckOutcome,
): void {
  if (outcome.ok) return;
  report.failures = { ...report.failures, [outcome.code]: (report.failures?.[outcome.code] ?? 0) + 1 };
}

/**
 * Tarefa `aws-check` do worker (fase 2, PR-V3' e PR-V5'): a conexão das contas AWS pelo papel de leitura sem chave.
 * Roda no único processo do nó com o metadata da GCP e chama a conferência (`AwsConnectionChecker`).
 *
 * **Pedidos (`runOnce`, o "Verificar" do painel):** a API só grava o pedido (`checkRequestedAt`, com a conexão em
 * "aguardando"); esta tarefa confere, com as diárias, e grava "conectada" (com o aviso, se houver) ou "erro" com o
 * código.
 * - Busca de sistema, entre todos os clientes, só das contas AWS ativas com pedido pendente; cada resultado é gravado
 *   numa transação própria, pelo escopo do cliente da conta, com auditoria (`cloud_account.aws_check`) na trilha dele.
 * - O resultado só vale para o pedido conferido: a gravação compara o `checkRequestedAt` lido (e a conta ainda ativa).
 *   Conta desativada ou removida no meio descarta o resultado.
 * - Um erro que pode passar (`retryable`) deixa o pedido pendente até `AWS_CHECK_RETRY_WINDOW_MS` depois do pedido,
 *   com as tentativas espaçadas (`awsCheckRetryDelayMs`).
 * - Na primeira verificação bem-sucedida, grava `ingestFrom` (o dia anterior), uma vez só: é o `only_logs_after` que o
 *   gerador da configuração do Wazuh usa (PR-V4'), para o nó não ler o histórico inteiro do bucket.
 * - Uma exceção da conferência (não um resultado) conta como `check_unavailable` que pode passar; o sinal do agendador
 *   (parada do worker, orçamento) interrompe a execução.
 *
 * **Sem pedido (`recheck`, PR-V5'):** cada conta já verificada (com `ingestFrom`), conectada ou com erro, é conferida
 * de novo a cada `AWS_RECHECK_INTERVAL_MS`, com as diárias a cada `AWS_DAILY_CHECK_INTERVAL_MS`. Só uma mudança da
 * conexão é gravada, com auditoria; a conta corrigida pelo cliente volta a "conectada" sozinha. Numa conta conectada,
 * um erro que pode passar é tentado de novo, espaçado, por até 10 min antes de virar o erro dela (um tropeço da AWS
 * ou do Google não pisca o painel); numa conta já com erro, uma tentativa a cada 15 min. Uma conta em "aguardando"
 * (reativada, ou sem verificação) espera o "Verificar".
 *
 * Os avisos (`AWS_CONNECTION_WARNING_CODES`) não param a coleta: a conta fica conectada, com o de maior prioridade em
 * `connectionError`. O agendamento fica na memória do worker: numa partida nova, tudo é conferido de novo.
 */
export class AwsCheck {
  private readonly audit: AuditService;
  private readonly now: () => Date;
  private readonly retryWindowMs: number;
  private readonly batch: number;
  private readonly recheckIntervalMs: number;
  private readonly dailyIntervalMs: number;
  private readonly tenantFilter: Prisma.CloudAccountWhereInput;
  private readonly memory = new Map<string, AccountMemory>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly checker: AwsConnectionChecker,
    {
      audit = new AuditService(),
      now = () => new Date(),
      retryWindowMs = AWS_CHECK_RETRY_WINDOW_MS,
      batch = AWS_CHECK_BATCH,
      recheckIntervalMs = AWS_RECHECK_INTERVAL_MS,
      dailyIntervalMs = AWS_DAILY_CHECK_INTERVAL_MS,
      tenantIds,
    }: AwsCheckOptions = {},
  ) {
    if (!Number.isInteger(batch) || batch < 1)
      throw new Error('o lote do aws-check precisa ser um inteiro positivo');
    this.audit = audit;
    this.now = now;
    this.retryWindowMs = retryWindowMs;
    this.batch = batch;
    this.recheckIntervalMs = recheckIntervalMs;
    this.dailyIntervalMs = dailyIntervalMs;
    this.tenantFilter = tenantIds === undefined ? {} : { tenantId: { in: [...tenantIds] } };
  }

  /** Os pedidos pendentes ("Verificar"). */
  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<AwsCheckReport> {
    const report: AwsCheckReport = { pending: 0, connected: 0, failed: 0, retrying: 0, stale: 0 };
    const rows = await this.prisma.cloudAccount.findMany({
      // Só cliente ativo (CE-02): o pedido de quem está suspenso, cancelado ou em expurgo espera.
      where: {
        provider: 'aws',
        status: 'active',
        checkRequestedAt: { not: null },
        ...COLLECTING_TENANT,
        ...this.tenantFilter,
      },
      select: ACCOUNT_SELECT,
      orderBy: [{ checkRequestedAt: 'asc' }, { id: 'asc' }],
      take: this.batch,
    });
    report.pending = rows.length;
    for (const row of rows) {
      signal.throwIfAborted();
      const requestedAt = row.checkRequestedAt;
      if (requestedAt === null) continue;
      const memory = this.memoryOf(row.id);
      const episode = `request:${requestedAt.getTime()}`;
      if (memory.retry?.episode === episode && memory.retry.nextAt > this.now().getTime()) {
        report.retrying += 1;
        continue;
      }
      const outcome = await this.checkOne(targetOf(row, true), signal);
      const now = this.now().getTime();
      if (!outcome.ok && outcome.retryable && now - requestedAt.getTime() < this.retryWindowMs) {
        this.scheduleRetry(memory, episode, requestedAt.getTime(), now);
        report.retrying += 1;
        continue;
      }
      this.remember(memory, outcome, now);
      const result = await this.record(row, requestedAt, stateOf(outcome, memory, RESET_STATE));
      report[result] += 1;
      if (result === 'failed') countFailure(report, outcome);
    }
    return report;
  }

  /** As conferências sem pedido: a cada 15 min por conta já verificada, e as diárias uma vez por dia. */
  async recheck(signal: AbortSignal = new AbortController().signal): Promise<AwsRecheckReport> {
    const report: AwsRecheckReport = { accounts: 0, checked: 0, daily: 0, changed: 0, retrying: 0, stale: 0 };
    const rows = await this.prisma.cloudAccount.findMany({
      where: {
        provider: 'aws',
        status: 'active',
        checkRequestedAt: null,
        ingestFrom: { not: null },
        connection: { in: ['connected', 'error'] },
        ...COLLECTING_TENANT,
        ...this.tenantFilter,
      },
      select: ACCOUNT_SELECT,
      orderBy: { id: 'asc' },
    });
    report.accounts = rows.length;
    let budget = this.batch;
    for (const row of rows) {
      if (budget === 0) break;
      signal.throwIfAborted();
      const memory = this.memoryOf(row.id);
      const startedAt = this.now().getTime();
      const retry = memory.retry?.episode === PERIODIC ? memory.retry : undefined;
      const due =
        retry !== undefined
          ? retry.nextAt <= startedAt
          : memory.checkedAt === undefined || startedAt - memory.checkedAt >= this.recheckIntervalMs;
      if (!due) continue;
      budget -= 1;
      const daily = memory.dailyAt === undefined || startedAt - memory.dailyAt >= this.dailyIntervalMs;
      const outcome = await this.checkOne(targetOf(row, daily), signal);
      report.checked += 1;
      const now = this.now().getTime();
      if (!outcome.ok && outcome.retryable && row.connection === 'connected') {
        const since = retry?.since ?? now;
        if (now - since < this.retryWindowMs) {
          this.scheduleRetry(memory, PERIODIC, since, now);
          report.retrying += 1;
          continue;
        }
      }
      this.remember(memory, outcome, now);
      if (outcome.ok && outcome.daily !== undefined) report.daily += 1;
      const state = stateOf(outcome, memory, row);
      if (state.connection === row.connection && state.connectionError === row.connectionError) continue;
      const result = await this.recordRecheck(row, state);
      report[result] += 1;
      if (result === 'changed') countFailure(report, outcome);
    }
    return report;
  }

  private memoryOf(id: string): AccountMemory {
    let memory = this.memory.get(id);
    if (memory === undefined) {
      memory = {};
      this.memory.set(id, memory);
    }
    return memory;
  }

  /** A próxima tentativa de um erro que pode passar, espaçada pelo número de falhas seguidas do mesmo episódio. */
  private scheduleRetry(memory: AccountMemory, episode: string, since: number, now: number): void {
    const attempts = memory.retry?.episode === episode ? memory.retry.attempts + 1 : 1;
    memory.retry = { episode, since, attempts, nextAt: now + awsCheckRetryDelayMs(attempts) };
  }

  /** Uma conferência com resultado: a próxima periódica conta daqui, e as diárias concluídas ficam lembradas. */
  private remember(memory: AccountMemory, outcome: AwsCheckOutcome, now: number): void {
    memory.checkedAt = now;
    delete memory.retry;
    if (outcome.ok && outcome.daily !== undefined) {
      memory.dailyAt = now;
      memory.dailyWarnings = outcome.daily.warnings;
    }
  }

  /** A conferência de uma conta. Só o sinal abortado passa adiante; qualquer outra exceção vira um erro que pode passar. */
  private async checkOne(target: AwsCheckTarget, signal: AbortSignal): Promise<AwsCheckOutcome> {
    try {
      return await this.checker.check(target, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, code: 'check_unavailable', retryable: true };
    }
  }

  /** Grava o resultado do pedido conferido, se ele ainda for o pendente, com a auditoria na trilha do cliente. */
  private record(
    row: AccountRow,
    requestedAt: Date,
    state: ConnectionState,
  ): Promise<'connected' | 'failed' | 'stale'> {
    return this.prisma.$transaction(async (tx) => {
      const db = scopeToTenant(tx, row.tenantId);
      const now = this.now();
      const { count } = await db.cloudAccount.updateMany({
        where: { id: row.id, provider: 'aws', status: 'active', checkRequestedAt: requestedAt },
        data: { ...state, checkRequestedAt: null },
      });
      if (count === 0) return 'stale';
      const connected = state.connection === 'connected';
      // A primeira verificação bem-sucedida marca de onde o Wazuh começa a ler. Só uma vez: a linha está presa pela
      // gravação acima até o fim da transação.
      if (connected) {
        await db.cloudAccount.updateMany({
          where: { id: row.id, ingestFrom: null },
          data: { ingestFrom: ingestDayFor(now) },
        });
      }
      const after = await db.cloudAccount.findUniqueOrThrow({
        where: { id: row.id },
        select: { connection: true, connectionError: true, ingestFrom: true },
      });
      await this.audit.write(tx, {
        actor: { type: 'system', tenantId: row.tenantId },
        action: 'cloud_account.aws_check',
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: row.id,
        before: { connection: row.connection, connectionError: row.connectionError },
        after: {
          connection: after.connection,
          connectionError: after.connectionError,
          ingestFrom: isoDay(after.ingestFrom),
        },
      });
      return connected ? 'connected' : 'failed';
    });
  }

  /**
   * Grava a mudança de uma conferência sem pedido, se a conta ainda está como foi lida (ativa, sem pedido novo e com a
   * mesma conexão), com a auditoria na trilha do cliente.
   */
  private recordRecheck(row: AccountRow, state: ConnectionState): Promise<'changed' | 'stale'> {
    return this.prisma.$transaction(async (tx) => {
      const db = scopeToTenant(tx, row.tenantId);
      const { count } = await db.cloudAccount.updateMany({
        where: {
          id: row.id,
          provider: 'aws',
          status: 'active',
          checkRequestedAt: null,
          connection: row.connection,
          connectionError: row.connectionError,
        },
        data: state,
      });
      if (count === 0) return 'stale';
      await this.audit.write(tx, {
        actor: { type: 'system', tenantId: row.tenantId },
        action: 'cloud_account.aws_check',
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: row.id,
        before: { connection: row.connection, connectionError: row.connectionError },
        after: { ...state, ingestFrom: isoDay(row.ingestFrom) },
      });
      return 'changed';
    });
  }
}
