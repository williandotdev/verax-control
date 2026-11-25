import {
  isScopedExceptionBlocked,
  MAX_ACTIVE_SCOPED_EXCEPTIONS,
  type ScopedExceptionSeverity,
  severityWithin,
} from '@verax/shared';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { FindingDraft } from './finding-draft.js';

/**
 * Exceções amplas (casos, PR-9) no caminho da coleta. Separado das exceções de usuário, IP e recurso
 * (`exception-match.ts`), e lido à parte: uma falha na leitura daqui nunca para a coleta, os alertas só entram como
 * sempre, na fila.
 */

/** Exceção ampla em vigor, como o `FindingStore` a compara. */
export interface ActiveScopedException {
  id: string;
  ruleId: string;
  logSource: string;
  accountId: string;
  eventName: string | null;
  resourcePrefix: string | null;
  maxSeverity: ScopedExceptionSeverity;
  expiresAt: Date;
}

type MatchedFields = Pick<
  FindingDraft,
  'ruleId' | 'logSource' | 'accountId' | 'eventName' | 'resource' | 'severity'
>;

/**
 * A exceção ampla que marca o alerta novo como esperado: mesma regra, fonte de log e conta; o mesmo evento e o recurso que
 * começa pelo prefixo, se a exceção os tem; severidade até a máxima (crítico nunca); dentro da validade. As regras
 * bloqueadas nunca casam, mesmo que a linha exista (gravada à mão no banco, por exemplo). Compara os valores como o achado
 * os grava (cortados no tamanho da coluna), para a prévia, que lê do banco, contar o mesmo. Vale a primeira, na ordem de
 * criação.
 */
export function matchingScopedException(
  finding: MatchedFields,
  exceptions: readonly ActiveScopedException[],
  now: Date,
): ActiveScopedException | null {
  if (isScopedExceptionBlocked(finding.ruleId)) return null;
  const eventName = finding.eventName?.slice(0, 256) ?? null;
  const resource = finding.resource?.slice(0, 2048) ?? null;
  for (const exception of exceptions) {
    if (exception.expiresAt.getTime() <= now.getTime()) continue;
    if (exception.ruleId !== finding.ruleId) continue;
    if (exception.logSource !== finding.logSource || exception.accountId !== finding.accountId) continue;
    if (!severityWithin(finding.severity, exception.maxSeverity)) continue;
    if (exception.eventName !== null && exception.eventName !== eventName) continue;
    if (exception.resourcePrefix !== null && !(resource ?? '').startsWith(exception.resourcePrefix)) continue;
    return exception;
  }
  return null;
}

export interface ScopedExceptionLogger {
  warn(fields: object, message: string): void;
}

export interface ScopedExceptionSourceOptions {
  /** Quanto tempo a lista lida de um cliente vale. A revogação é conferida de novo a cada alerta marcado. */
  ttlMs?: number;
  logger?: ScopedExceptionLogger;
}

interface Cached {
  at: number;
  exceptions: Promise<readonly ActiveScopedException[]>;
}

/**
 * As exceções amplas em vigor de cada cliente, lidas do banco e guardadas por pouco tempo. Só existe no worker com os casos
 * ligados (`CASES_MODE=on`); sem ela, o `FindingStore` é o de antes. Nunca lança: uma leitura que falha vira lista vazia
 * (o alerta entra na fila, o lado seguro) e um aviso no log, só com o tipo do erro.
 */
export class ScopedExceptionSource {
  private readonly cache = new Map<string, Cached>();
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly options: ScopedExceptionSourceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  async forTenant(tenantId: string, now: Date): Promise<readonly ActiveScopedException[]> {
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && now.getTime() - cached.at < this.ttlMs) return cached.exceptions;
    const exceptions = this.read(tenantId, now);
    this.cache.set(tenantId, { at: now.getTime(), exceptions });
    return exceptions;
  }

  /**
   * A exceção que casou ainda vale agora (não foi revogada nem venceu desde a leitura guardada)? Na dúvida (falha na
   * leitura), não: o alerta entra na fila.
   */
  async stillActive(tenantId: string, id: string, now: Date): Promise<boolean> {
    try {
      const row = await this.prisma.forTenant(tenantId).scopedException.findFirst({
        where: { id, revokedAt: null, expiresAt: { gt: now } },
        select: { id: true },
      });
      return row !== null;
    } catch (error) {
      this.options.logger?.warn({ err: errorKind(error) }, 'exceções amplas: falha ao conferir a exceção');
      return false;
    }
  }

  private async read(tenantId: string, now: Date): Promise<readonly ActiveScopedException[]> {
    try {
      return (await this.prisma.forTenant(tenantId).scopedException.findMany({
        where: { revokedAt: null, expiresAt: { gt: now }, maxSeverity: { not: 'critical' } },
        select: {
          id: true,
          ruleId: true,
          logSource: true,
          accountId: true,
          eventName: true,
          resourcePrefix: true,
          maxSeverity: true,
          expiresAt: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_ACTIVE_SCOPED_EXCEPTIONS,
      })) as ActiveScopedException[];
    } catch (error) {
      this.options.logger?.warn(
        { err: errorKind(error) },
        'exceções amplas: falha na leitura; os alertas entram na fila',
      );
      return [];
    }
  }
}
