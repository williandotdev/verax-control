import { HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  CASE_SPLIT_TOO_LARGE_CODE,
  CASE_SPLIT_WHOLE_CODE,
  type CaseSplit,
  type CaseSplitResult,
  MAX_SPLIT_ALERTS,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { sqlStateOf } from './case-errors.js';
import { insertSplitCase, lockSplitFindings, moveFindings, refreshCaseFacts } from './case-split-store.js';
import { uuidV7 } from './case-plan.js';
import { lockFindingsBriefly, setTriageTimeouts } from './triage-store.js';

const LOCK_TIMEOUT_MS = 3_000;
const STATEMENT_TIMEOUT_MS = 6_000;
const BUSY: ReadonlySet<string | null> = new Set(['55P03', '57014', '40P01']);

const CASE_NOT_FOUND = 'Caso não encontrado';
const FINDING_NOT_FOUND = 'Alerta não encontrado neste caso';

/**
 * Dividir um caso: o remédio para quando a chave juntou coisas diferentes. Os alertas escolhidos vão para um caso novo, com
 * a mesma chave, que nasce **selado** (`split`): a chave só tem um caso aberto, e os alertas seguintes continuam no
 * original. As contagens dos dois são dos gatilhos.
 *
 * Só o agrupamento muda: o status, o incidente e o `updatedAt` dos alertas ficam como estão (a retenção lê o `updatedAt`
 * como atividade, e a atribuição também não o toca).
 */
@Injectable()
export class CaseSplitService {
  private readonly logger = new Logger(CaseSplitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async split(id: string, input: CaseSplit): Promise<CaseSplitResult> {
    const db = this.prisma.scoped();
    const tenantId = this.prisma.scopeTenantId();
    this.audit.describe({ action: 'case.split', resourceType: 'alert_case', resourceId: id });
    // Só o sistema grava casos: pelo cliente base, com o cliente da sessão em cada comando.
    const tx = this.prisma.db();
    const now = new Date();
    try {
      await setTriageTimeouts(tx, LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS);
      await lockFindingsBriefly(tx, tenantId);
      const original = await db.alertCase.findUnique({
        where: { id },
        select: { title: true, groupKey: true, total: true, newCount: true, investigatingCount: true },
      });
      if (original === null) throw new ApiError(HttpStatus.NOT_FOUND, CASE_NOT_FOUND);

      const ids = await lockSplitFindings(
        tx,
        tenantId,
        id,
        'findingIds' in input ? { ids: input.findingIds } : { group: input.group },
        MAX_SPLIT_ALERTS + 1,
      );
      const asked = 'findingIds' in input ? input.findingIds.length : null;
      if (ids.length === 0 || (asked !== null && ids.length !== asked)) {
        throw new ApiError(HttpStatus.NOT_FOUND, FINDING_NOT_FOUND);
      }
      if (ids.length > MAX_SPLIT_ALERTS) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          `São alertas demais para dividir de uma vez (o máximo é ${MAX_SPLIT_ALERTS}).`,
          CASE_SPLIT_TOO_LARGE_CODE,
          { max: MAX_SPLIT_ALERTS },
        );
      }
      const stored = await tx.finding.count({ where: { tenantId, caseId: id } });
      if (ids.length >= stored) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'O caso precisa ficar com pelo menos um alerta.',
          CASE_SPLIT_WHOLE_CODE,
        );
      }
      const newId = uuidV7(now.getTime());
      await insertSplitCase(tx, tenantId, { id: newId, originalId: id, findingIds: ids, now });
      const moved = await moveFindings(tx, tenantId, { from: id, to: newId, ids });
      if (moved !== ids.length) throw new Error('alerta travado que não foi movido');
      for (const caseId of [id, newId]) await refreshCaseFacts(tx, tenantId, caseId);
      this.audit.describe({
        before: { title: original.title, total: original.total },
        after: {
          caseId: newId,
          moved,
          remaining: stored - moved,
          by: 'findingIds' in input ? 'alerts' : 'group',
          ...('group' in input && { group: input.group }),
          reason: input.reason ?? null,
        },
      });
      return { caseId: newId, moved, remaining: stored - moved };
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (!BUSY.has(sqlState)) throw error;
      this.logger.warn({ sqlState }, 'o banco estava ocupado demais para dividir o caso');
      throw new ServiceUnavailableException();
    }
  }
}
