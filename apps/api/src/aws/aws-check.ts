import type { AwsConnectionErrorCode } from '@verax/shared';
import { AuditService } from '../common/audit/audit.service.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AwsCheckOutcome, AwsCheckTarget, AwsConnectionChecker } from './aws-connection-check.js';

/** A cada 30 s: o "Verificar" do painel é respondido logo, e o painel consulta a conta enquanto espera. */
export const AWS_CHECK_INTERVAL_MS = 30_000;
/**
 * Por quanto tempo um erro que pode passar (`retryable`) deixa o pedido pendente em vez de virar o erro da conta: logo
 * depois da criação da pilha, o papel pode levar alguns segundos para valer no IAM, e o Google ou a AWS podem falhar
 * por um momento. Passado o prazo, o erro é gravado.
 */
export const AWS_CHECK_RETRY_WINDOW_MS = 10 * 60 * 1000;
/** Pedidos por execução, os mais antigos primeiro. */
export const AWS_CHECK_BATCH = 20;

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente). */
export interface AwsCheckReport {
  /** Pedidos pendentes lidos nesta execução. */
  pending: number;
  connected: number;
  /** Erro gravado na conta. */
  failed: number;
  /** Erro que pode passar, dentro da janela: o pedido continua pendente para a próxima execução. */
  retrying: number;
  /** O pedido mudou durante a conferência (conta desativada ou removida): o resultado foi descartado. */
  stale: number;
  /** Códigos dos erros gravados. */
  failures?: Partial<Record<AwsConnectionErrorCode, number>>;
}

export interface AwsCheckOptions {
  audit?: AuditService;
  now?: () => Date;
  retryWindowMs?: number;
  batch?: number;
}

const PENDING_SELECT = {
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
} as const satisfies Prisma.CloudAccountSelect;
type PendingRow = Prisma.CloudAccountGetPayload<{ select: typeof PENDING_SELECT }>;

/** O dia anterior ao da verificação, em UTC: o `only_logs_after` do Wazuh, com um dia de folga. */
export function ingestDayFor(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
}

function targetOf(row: PendingRow): AwsCheckTarget {
  const buckets = [row.cloudtrailBucket, row.guarddutyBucket, row.wafBucket].filter(
    (name): name is string => name !== null,
  );
  return {
    cloudAccountId: row.id,
    accountId: row.accountId,
    regions: row.regions,
    buckets: [...new Set(buckets)],
  };
}

/**
 * Tarefa `aws-check` do worker (fase 2, PR-V3'): responde o "Verificar" das contas AWS. A API só grava o pedido
 * (`checkRequestedAt`, com a conexão em "aguardando"); esta tarefa, no único processo do nó com o metadata da GCP, chama
 * a conferência (`AwsConnectionChecker`) e grava o resultado na conta: "conectada" ou "erro" com o código.
 *
 * - Busca de sistema, entre todos os clientes, só das contas AWS ativas com pedido pendente; cada resultado é gravado
 *   numa transação própria, pelo escopo do cliente da conta, com auditoria (`cloud_account.aws_check`) na trilha dele.
 * - O resultado só vale para o pedido conferido: a gravação compara o `checkRequestedAt` lido (e a conta ainda ativa).
 *   Conta desativada ou removida no meio descarta o resultado.
 * - Um erro que pode passar (`retryable`) deixa o pedido pendente até `AWS_CHECK_RETRY_WINDOW_MS` depois do pedido.
 * - Na primeira verificação bem-sucedida, grava `ingestFrom` (o dia anterior), uma vez só: é o `only_logs_after` que o
 *   gerador da configuração do Wazuh usa (PR-V4'), para o nó não ler o histórico inteiro do bucket.
 * - Uma exceção da conferência (não um resultado) conta como `check_unavailable` que pode passar; o sinal do agendador
 *   (parada do worker, orçamento) interrompe a execução.
 *
 * A verificação periódica (a cada 15 min) e a diária (trilha, export e permissão demais) entram no PR-V5'.
 */
export class AwsCheck {
  private readonly audit: AuditService;
  private readonly now: () => Date;
  private readonly retryWindowMs: number;
  private readonly batch: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly checker: AwsConnectionChecker,
    {
      audit = new AuditService(),
      now = () => new Date(),
      retryWindowMs = AWS_CHECK_RETRY_WINDOW_MS,
      batch = AWS_CHECK_BATCH,
    }: AwsCheckOptions = {},
  ) {
    if (!Number.isInteger(batch) || batch < 1)
      throw new Error('o lote do aws-check precisa ser um inteiro positivo');
    this.audit = audit;
    this.now = now;
    this.retryWindowMs = retryWindowMs;
    this.batch = batch;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<AwsCheckReport> {
    const report: AwsCheckReport = { pending: 0, connected: 0, failed: 0, retrying: 0, stale: 0 };
    const rows = await this.prisma.cloudAccount.findMany({
      where: { provider: 'aws', status: 'active', checkRequestedAt: { not: null } },
      select: PENDING_SELECT,
      orderBy: [{ checkRequestedAt: 'asc' }, { id: 'asc' }],
      take: this.batch,
    });
    report.pending = rows.length;
    for (const row of rows) {
      signal.throwIfAborted();
      const requestedAt = row.checkRequestedAt;
      if (requestedAt === null) continue;
      const outcome = await this.checkOne(targetOf(row), signal);
      if (
        !outcome.ok &&
        outcome.retryable &&
        this.now().getTime() - requestedAt.getTime() < this.retryWindowMs
      ) {
        report.retrying += 1;
        continue;
      }
      const result = await this.record(row, requestedAt, outcome);
      report[result] += 1;
      if (result === 'failed' && !outcome.ok) {
        report.failures = { ...report.failures, [outcome.code]: (report.failures?.[outcome.code] ?? 0) + 1 };
      }
    }
    return report;
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
    row: PendingRow,
    requestedAt: Date,
    outcome: AwsCheckOutcome,
  ): Promise<'connected' | 'failed' | 'stale'> {
    return this.prisma.$transaction(async (tx) => {
      const db = scopeToTenant(tx, row.tenantId);
      const now = this.now();
      const data: Prisma.CloudAccountUpdateManyMutationInput = outcome.ok
        ? { connection: 'connected', connectionError: null, checkRequestedAt: null }
        : { connection: 'error', connectionError: outcome.code, checkRequestedAt: null };
      const { count } = await db.cloudAccount.updateMany({
        where: { id: row.id, provider: 'aws', status: 'active', checkRequestedAt: requestedAt },
        data,
      });
      if (count === 0) return 'stale';
      // A primeira verificação bem-sucedida marca de onde o Wazuh começa a ler. Só uma vez: a linha está presa pela
      // gravação acima até o fim da transação.
      if (outcome.ok) {
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
          ingestFrom: after.ingestFrom?.toISOString().slice(0, 10) ?? null,
        },
      });
      return outcome.ok ? 'connected' : 'failed';
    });
  }
}
