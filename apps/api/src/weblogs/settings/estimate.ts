import {
  type AwsWebLogsAcknowledgement,
  projectWebLogs,
  type VolumeAllowance,
  WEB_ESTIMATE_MAX_AGE_MS,
  type WebEstimate,
  type WebEstimateStatus,
} from '@verax/shared';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * A estimativa de volume de um balanceador (`WebSourceEstimate`): o que a API devolve dela e o que ela exige antes da
 * autorização. Quem a calcula é o worker (PR-4), que é quem fala com a AWS; aqui só se lê o que está gravado. O número do
 * pedido nunca vale por si: é conferido com o gravado.
 */

export const ESTIMATE_SELECT = {
  sourceId: true,
  requestedAt: true,
  lastRequestAt: true,
  status: true,
  computedAt: true,
  day: true,
  objects: true,
  bytesPerDay: true,
  truncated: true,
  errorCode: true,
} as const satisfies Prisma.WebSourceEstimateSelect;
export type EstimateRow = Prisma.WebSourceEstimateGetPayload<{ select: typeof ESTIMATE_SELECT }>;

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/** A projeção de uma estimativa que vale para autorizar: calculada, sem falha e de até 7 dias. Null fora disso. */
function projectionOf(row: EstimateRow, allowance: VolumeAllowance, now: Date) {
  const { status, computedAt } = row;
  if (computedAt === null || (status !== 'ready' && status !== 'no_sample')) return null;
  const age = now.getTime() - computedAt.getTime();
  // Um horário no futuro (o relógio voltou) também não prova que a estimativa é recente.
  if (age < 0 || age > WEB_ESTIMATE_MAX_AGE_MS) return null;
  // O CHECK do banco limita o volume ao inteiro seguro do JSON.
  const bytesPerDay = status === 'ready' && row.bytesPerDay !== null ? Number(row.bytesPerDay) : null;
  return {
    computedAt,
    ...projectWebLogs(bytesPerDay, row.truncated, allowance),
    validUntil: new Date(computedAt.getTime() + WEB_ESTIMATE_MAX_AGE_MS).toISOString(),
  };
}

/** A estimativa como a API a devolve. `allowance` é null para quem não lê o plano: sem a projeção, que o revelaria. */
export function toEstimate(row: EstimateRow, allowance: VolumeAllowance | null, now: Date): WebEstimate {
  const projection = allowance === null ? null : projectionOf(row, allowance, now);
  return {
    requestedAt: iso(row.requestedAt),
    status: row.status as WebEstimateStatus | null,
    computedAt: iso(row.computedAt),
    day: row.day === null ? null : row.day.toISOString().slice(0, 10),
    objects: row.objects,
    truncated: row.truncated,
    errorCode: row.errorCode,
    projection:
      projection === null
        ? null
        : {
            gbPerDay: projection.gbPerDay,
            percent: projection.percent,
            basis: projection.basis,
            acknowledgementRequired: projection.acknowledgementRequired,
            validUntil: projection.validUntil,
          },
  };
}

export type AcknowledgementProblem =
  'WEB_LOGS_ESTIMATE_REQUIRED' | 'WEB_LOGS_ESTIMATE_CHANGED' | 'WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED';

/** O que falta para autorizar o balanceador, ou null. */
export function acknowledgementProblem(
  row: EstimateRow | undefined,
  acknowledgement: AwsWebLogsAcknowledgement | undefined,
  allowance: VolumeAllowance,
  now: Date,
): AcknowledgementProblem | null {
  const projection = row === undefined ? null : projectionOf(row, allowance, now);
  if (projection === null || acknowledgement === undefined) return 'WEB_LOGS_ESTIMATE_REQUIRED';
  if (
    Date.parse(acknowledgement.estimatedAt) !== projection.computedAt.getTime() ||
    acknowledgement.estimatedGbPerDay !== projection.gbPerDay ||
    acknowledgement.projectedPercent !== projection.percent
  ) {
    return 'WEB_LOGS_ESTIMATE_CHANGED';
  }
  return projection.acknowledgementRequired && !acknowledgement.acknowledged
    ? 'WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED'
    : null;
}
