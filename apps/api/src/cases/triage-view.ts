import {
  type Author,
  hasPermission,
  isMassTriageRole,
  type Role,
  TRIAGE_ACTIONS,
  TRIAGE_STATES,
  TRIAGE_STOPS,
  type TriageOperationDetail,
  type TriageOperationView,
  type TriageTargetView,
  type TriageWarning,
} from '@verax/shared';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { ACTIVE_STATES, undoDeadline } from './triage-engine.js';
import { runOf } from './triage-store.js';

/** A operação como aparece no caso e no alerta, e nas rotas dela. Só leitura, sem banco. */

export const operationSelect = {
  id: true,
  action: true,
  status: true,
  state: true,
  reason: true,
  matched: true,
  changed: true,
  skipped: true,
  createdAt: true,
  undoUntil: true,
  undoOfId: true,
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.TriageOperationSelect;

/** Sem o alvo: ele pode levar o conjunto congelado, e é lido à parte, sem ele. */
export const operationDetailSelect = {
  ...operationSelect,
  requestId: true,
  incidentId: true,
  includeCritical: true,
  expectedCount: true,
  cutoffAt: true,
  updatedAt: true,
  undoOf: { select: { action: true, incidentId: true } },
  undoneBy: { select: { id: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
} as const satisfies Prisma.TriageOperationSelect;

type OperationRow = Prisma.TriageOperationGetPayload<{ select: typeof operationSelect }>;
export type OperationDetailRow = Prisma.TriageOperationGetPayload<{ select: typeof operationDetailSelect }>;

/** O valor, se é um dos que esta versão conhece: a coluna é texto com CHECK, e uma versão seguinte pode ter outros. */
export function known<T extends string>(values: readonly T[], value: string | null): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

/** A operação, ou nada se ela é de um tipo que esta versão não conhece. */
export function toOperation(row: OperationRow): TriageOperationView | null {
  const action = known(TRIAGE_ACTIONS, row.action);
  const state = known(TRIAGE_STATES, row.state);
  if (action === null || state === null) return null;
  const author: Author | null = row.createdBy;
  return {
    id: row.id,
    action,
    status: row.status,
    state,
    reason: row.reason,
    author,
    createdAt: row.createdAt.toISOString(),
    matched: row.matched,
    changed: row.changed,
    skipped: row.skipped,
    undoUntil: row.undoUntil?.toISOString() ?? null,
    undoOfId: row.undoOfId,
  };
}

/** Quem pede pode mexer na operação: quem a pediu, ou quem administra. */
export function mayManage(
  viewer: { role: Role; userId: string },
  operation: { createdById: string | null },
): boolean {
  return (
    hasPermission(viewer.role, 'findings:triage') &&
    (isMassTriageRole(viewer.role) || operation.createdById === viewer.userId)
  );
}

export const FORWARD_ACTIONS: readonly string[] = ['status', 'promote', 'attach'];
const INCIDENT_ACTIONS: readonly string[] = ['promote', 'attach'];
export const UNDOABLE_STATES: readonly string[] = ['done', 'partial', 'canceled'];
export const RESUMABLE_STATES: readonly string[] = ['partial', 'failed'];

/** Promover e anexar também pedem a permissão dos incidentes, e desfazê-los também. */
export function needsIncidentWrite(action: string): boolean {
  return INCIDENT_ACTIONS.includes(action);
}

/** Até quando uma operação parada aceita "continuar": o prazo do desfazer; no desfazer, um dia da última mudança. */
export function resumeDeadline(operation: { undoUntil: Date | null; updatedAt: Date }): Date {
  return operation.undoUntil ?? undoDeadline(operation.updatedAt);
}

const storedTargetSchema = z.union([
  z.object({ caseIds: z.array(z.uuid()), group: z.string().optional() }),
  z.object({ findingIds: z.array(z.string()) }),
  z.object({ filter: z.record(z.string(), z.unknown()) }),
  z.object({ operationId: z.uuid() }),
  z.object({ userId: z.string() }),
]);

function targetView(target: unknown): TriageTargetView {
  const parsed = storedTargetSchema.safeParse(target);
  if (!parsed.success) return { kind: 'findings', count: 0 };
  const stored = parsed.data;
  if ('caseIds' in stored) return { kind: 'cases', caseIds: stored.caseIds, group: stored.group ?? null };
  if ('findingIds' in stored) return { kind: 'findings', count: stored.findingIds.length };
  if ('operationId' in stored) return { kind: 'operation', operationId: stored.operationId };
  if ('userId' in stored) return { kind: 'user', userId: stored.userId };
  const filter = Object.entries(stored.filter).flatMap(([name, value]) =>
    typeof value === 'string' ? [[name, value] as const] : [],
  );
  return { kind: 'filter', filter: Object.fromEntries(filter) };
}

export interface OperationViewer {
  role: Role;
  userId: string;
  /** Com os casos só na medição (`shadow`), ninguém opera. */
  operating: boolean;
}

/** A operação inteira. `target` é o gravado, sem o conjunto congelado. */
export function toOperationDetail(
  row: OperationDetailRow,
  target: unknown,
  viewer: OperationViewer,
  now: Date,
): TriageOperationDetail | null {
  const base = toOperation(row);
  if (base === null) return null;
  const run = runOf(target);
  const manages = viewer.operating && mayManage(viewer, { createdById: row.createdBy?.id ?? null });
  const incidents = hasPermission(viewer.role, 'incidents:write');
  const effective = row.undoOf?.action ?? row.action;
  const allowed = manages && (incidents || !needsIncidentWrite(effective));
  const active = ACTIVE_STATES.includes(row.state);
  const stopped = RESUMABLE_STATES.includes(row.state);
  const warnings: TriageWarning[] = [
    ...(run.excludedCritical > 0 ? (['critical_excluded'] as const) : []),
    ...(row.action === 'undo' && effective === 'promote'
      ? (['notice_not_recalled', 'anchor_kept'] as const)
      : []),
  ];
  return {
    ...base,
    requestId: row.requestId,
    target: targetView(target),
    incidentId: row.incidentId ?? row.undoOf?.incidentId ?? null,
    includeCritical: row.includeCritical,
    excludedCritical: run.excludedCritical,
    expectedCount: row.expectedCount,
    cutoffAt: row.cutoffAt.toISOString(),
    remaining: Math.max(0, row.matched - row.changed - row.skipped),
    failed: run.failed.length,
    stop: known(TRIAGE_STOPS, run.stop),
    updatedAt: row.updatedAt.toISOString(),
    undoId: row.undoneBy[0]?.id ?? null,
    warnings,
    can: {
      cancel: allowed && (active || stopped),
      continue: allowed && stopped && resumeDeadline(row) > now,
      undo:
        allowed &&
        FORWARD_ACTIONS.includes(row.action) &&
        UNDOABLE_STATES.includes(row.state) &&
        row.changed > 0 &&
        row.undoUntil !== null &&
        row.undoUntil > now,
    },
  };
}
