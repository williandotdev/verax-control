import type { FindingSeverity } from '../alerts/finding-draft.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Avisos por e-mail de alertas e incidentes (fase 2, PR-16; regras de 17/11/2026, alerta → validação → incidente).
 *
 * - Alerta que chega (decidido na mesma transação que grava o achado, em `FindingStore`; todo coletor ganha o aviso sem
 *   mudança): alto avisa (`high_finding`), crítico avisa (`critical_finding`). Médio e baixo, não.
 * - Incidente confirmado por uma pessoa (promover alertas, `IncidentsService`): avisa em qualquer severidade
 *   (`incident_opened`).
 * - Incidente que sobe para alto ou crítico ao receber alertas (anexar): avisa (`incident_escalated`), de médio para
 *   alto, de alto para crítico.
 *
 * O contato de escalonamento só recebe os críticos (`reachesEscalationContact`). A chave de deduplicação do alerta é
 * `finding:<id>` (um aviso por alerta, por mais que ele seja relido); a do incidente leva a severidade
 * (`incident:<id>:<severidade>`): cada incidente avisa no máximo uma vez por faixa, e a mudança que não sobe a
 * severidade não avisa.
 *
 * Com os casos ligados (`CASES_MODE=on`), o alerta que chega não avisa: quem avisa é o caso dele (`cases/case-notices.ts`).
 */

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Severidades em que o alerta e a subida do incidente avisam por e-mail. */
export type NoticeSeverity = Extract<FindingSeverity, 'high' | 'critical'>;

export function isNoticeSeverity(severity: FindingSeverity): severity is NoticeSeverity {
  return severity === 'high' || severity === 'critical';
}

/** Uma linha da fila de saída, sem o estado (nasce `pending`). */
export type NoticeRow = Pick<
  Prisma.NotificationCreateManyInput,
  'tenantId' | 'kind' | 'dedupeKey' | 'severity' | 'incidentId' | 'findingId'
>;

/** O aviso do alerta que chegou: alto ou crítico. */
export function alertNotices(finding: {
  tenantId: string;
  id: string;
  severity: FindingSeverity;
}): NoticeRow[] {
  if (!isNoticeSeverity(finding.severity)) return [];
  return [
    {
      tenantId: finding.tenantId,
      kind: finding.severity === 'critical' ? 'critical_finding' : 'high_finding',
      dedupeKey: `finding:${finding.id}`,
      severity: finding.severity,
      findingId: finding.id,
    },
  ];
}

/** O que mudou no incidente pela mão de uma pessoa: confirmado (promovido) ou com alertas novos (anexados). */
export type IncidentChange =
  | { change: 'opened'; incidentId: string; severity: FindingSeverity }
  | { change: 'attached'; incidentId: string; severity: FindingSeverity; previousSeverity: FindingSeverity };

export function incidentNotices(tenantId: string, change: IncidentChange): NoticeRow[] {
  const { incidentId, severity } = change;
  if (change.change === 'opened') {
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
  if (!isNoticeSeverity(severity) || SEVERITY_RANK[severity] <= SEVERITY_RANK[change.previousSeverity])
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

/**
 * Grava os avisos na fila de saída, pelo cliente do banco já no escopo do cliente (o da transação do achado ou da
 * requisição). A chave de deduplicação é única por cliente: o aviso que já existe fica como está.
 */
export async function enqueueNotices(
  db: Prisma.TransactionClient,
  rows: readonly NoticeRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { count } = await db.notification.createMany({ data: [...rows], skipDuplicates: true });
  return count;
}

/** O alerta a avisar. */
export interface AlertNoticeTarget {
  tenantId: string;
  id: string;
  severity: FindingSeverity;
  /**
   * A severidade subiu na origem, e nenhum caso vai avisar disso: o alerta está num incidente, já foi tratado ou ainda não
   * tem caso. Só importa com os avisos por caso (`CaseAlertNotices`).
   */
  outsideCases?: boolean;
}

/**
 * O passo do `FindingStore` depois de gravar um alerta novo: o aviso dele, na mesma transação. É uma classe para os
 * testes dos coletores trocarem por uma que falha e provarem que nada fica pela metade, e para os avisos por caso
 * (`CASES_MODE=on`, `CaseAlertNotices`).
 */
export class AlertNotices {
  async enqueue(db: Prisma.TransactionClient, finding: AlertNoticeTarget): Promise<number> {
    return enqueueNotices(db, alertNotices(finding));
  }
}
