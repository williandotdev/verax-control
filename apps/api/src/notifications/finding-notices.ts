import type { FindingSeverity } from '../alerts/finding-draft.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { IncidentPlacement } from '../incidents/incident-grouping.js';

/**
 * Avisos por e-mail que um achado gera (fase 2, PR-16), decididos na mesma transação que grava o achado e o incidente
 * (`FindingStore`). Assim, todo coletor ganha o aviso sem mudança. Três casos:
 * - um incidente abre alto ou crítico (`incident_opened`);
 * - um incidente sobe para alto ou crítico (`incident_escalated`): de médio para alto, de alto para crítico;
 * - um achado crítico fica fora de incidente (`critical_finding`): o que não tem usuário, chave, IP nem recurso para
 *   agrupar.
 *
 * A chave de deduplicação do incidente leva a severidade (`incident:<id>:<severidade>`): cada incidente avisa no máximo
 * uma vez por faixa, a junção que não muda a severidade não avisa, e reler o mesmo achado (duplicado) nem chega aqui.
 */

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Severidades que avisam por e-mail. */
export type NoticeSeverity = Extract<FindingSeverity, 'high' | 'critical'>;

export function isNoticeSeverity(severity: FindingSeverity): severity is NoticeSeverity {
  return severity === 'high' || severity === 'critical';
}

/** Uma linha da fila de saída, sem o estado (nasce `pending`). */
export type NoticeRow = Pick<
  Prisma.NotificationCreateManyInput,
  'tenantId' | 'kind' | 'dedupeKey' | 'severity' | 'incidentId' | 'findingId'
>;

export function findingNotices(
  finding: { tenantId: string; id: string; severity: FindingSeverity },
  placement: IncidentPlacement,
): NoticeRow[] {
  const { tenantId } = finding;
  switch (placement.outcome) {
    case 'opened': {
      const { incidentId, severity } = placement;
      if (!isNoticeSeverity(severity)) return [];
      return [
        {
          tenantId,
          kind: 'incident_opened',
          dedupeKey: `incident:${incidentId}:${severity}`,
          severity,
          incidentId,
        },
      ];
    }
    case 'joined': {
      const { incidentId, severity, previousSeverity } = placement;
      if (!isNoticeSeverity(severity) || SEVERITY_RANK[severity] <= SEVERITY_RANK[previousSeverity])
        return [];
      return [
        {
          tenantId,
          kind: 'incident_escalated',
          dedupeKey: `incident:${incidentId}:${severity}`,
          severity,
          incidentId,
        },
      ];
    }
    case 'none':
      if (finding.severity !== 'critical') return [];
      return [
        {
          tenantId,
          kind: 'critical_finding',
          dedupeKey: `finding:${finding.id}`,
          severity: 'critical',
          findingId: finding.id,
        },
      ];
  }
}

/**
 * Grava os avisos na fila de saída, pelo cliente do banco já no escopo do cliente (o da transação do achado). A chave de
 * deduplicação é única por cliente: o aviso que já existe fica como está.
 */
export async function enqueueNotices(
  db: Prisma.TransactionClient,
  rows: readonly NoticeRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { count } = await db.notification.createMany({ data: [...rows], skipDuplicates: true });
  return count;
}
