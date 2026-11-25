import { TRIAGE_UNDO_HOURS, type TriageStop } from '@verax/shared';
import type { AuditService } from '../common/audit/audit.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  addToIncidentSummary,
  removeFromIncidentSummary,
  resummarizeIncident,
} from '../incidents/incident-summary-store.js';
import { enqueueNotices, incidentNotices } from '../notifications/finding-notices.js';
import {
  applyAttach,
  applyStatus,
  countItems,
  EMPTY_RUN,
  frozenSlice,
  hasOtherAlerts,
  itemSlice,
  type LockedOperation,
  lockFindings,
  lockIncident,
  lockOperation,
  reopenCases,
  resolveIncident,
  revert,
  revertibleIds,
  saveProgress,
  saveRun,
  type TriageRun,
  unpointCases,
} from './triage-store.js';

/** Alertas por lote (cada lote é uma transação, sob o lock dos alertas do cliente). */
export const TRIAGE_BATCH = 500;
/** Alertas que o banco não deixa gravar, numa operação, antes de ela parar. */
export const TRIAGE_MAX_FAILED = 50;

const HOUR_MS = 60 * 60 * 1000;

/** Na fila ou em curso. Qualquer outro estado não roda. */
export const ACTIVE_STATES: readonly string[] = ['queued', 'running'];

/** Até quando se pode desfazer o que terminou agora. */
export const undoDeadline = (now: Date): Date => new Date(now.getTime() + TRIAGE_UNDO_HOURS * HOUR_MS);

export interface BatchInput {
  tenantId: string;
  operationId: string;
  limit: number;
  now: Date;
  /** O primeiro alerta do trecho não grava: conta como pulado e fica anotado para o "continuar". */
  isolate?: boolean;
}

export interface BatchOutcome {
  /** A operação não está mais na fila (cancelada, terminada por outra réplica, ou não existe). */
  gone: boolean;
  seen: number;
  changed: number;
  finished: boolean;
}

const GONE: BatchOutcome = { gone: true, seen: 0, changed: 0, finished: true };

/**
 * Um lote de uma operação, dentro da transação de quem chama (a da requisição ou a do worker), que **já tem o lock dos
 * alertas do cliente**. A ordem das travas está em `triage-store.ts`.
 *
 * **Exatamente uma vez:** o lote lê a operação travada, e o cursor avança na mesma transação em que os alertas mudam. Uma
 * queda no meio desfaz os dois; a retomada recomeça do mesmo cursor. Duas réplicas no mesmo lote se serializam no lock, e
 * a segunda vê o cursor já adiante. Por baixo disso, um alerta só muda se o item dele acabou de nascer (chave primária).
 *
 * O alerta que deixou de valer no meio (outra pessoa o tratou, entrou num incidente, ficou crítico, saiu na retenção) é
 * contado como pulado, e não é tocado.
 */
export async function runTriageBatch(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  input: BatchInput,
): Promise<BatchOutcome> {
  const operation = await lockOperation(tx, input.tenantId, input.operationId);
  if (operation === null || !ACTIVE_STATES.includes(operation.state)) return GONE;
  return operation.action === 'undo'
    ? undoBatch(tx, audit, operation, input)
    : forwardBatch(tx, audit, operation, input);
}

async function forwardBatch(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  operation: LockedOperation,
  input: BatchInput,
): Promise<BatchOutcome> {
  const { tenantId, now } = input;
  const offset = Number(operation.cursor ?? 0);
  const { ids, more } = await frozenSlice(
    tx,
    tenantId,
    operation.id,
    offset,
    input.isolate ? 1 : input.limit,
  );
  const { incidentId } = operation;
  const incident = incidentId === null ? null : await lockIncident(tx, tenantId, incidentId);
  if (incidentId !== null) {
    const stop = incidentStop(incident);
    if (stop !== null) return stopped(tx, audit, operation, stop, now);
  }

  let changed = 0;
  if (!input.isolate) {
    await lockFindings(tx, tenantId, ids);
    if (incidentId === null) changed = await applyStatus(tx, operation, ids, now);
    else if (incident !== null) {
      const added = await applyAttach(tx, operation, ids, now);
      changed = added.length;
      if (changed > 0) {
        const data = await addToIncidentSummary(tx, tenantId, incidentId, added);
        // Ao anexar, a severidade pode subir; o conjunto vai dos piores para os outros, então sobe uma vez só. Ao promover,
        // o incidente já nasceu com os piores, e o aviso dele é o da abertura.
        if (operation.action === 'attach') {
          await enqueueNotices(
            scopeToTenant(tx, tenantId),
            incidentNotices(tenantId, {
              change: 'attached',
              incidentId,
              severity: data.severity,
              previousSeverity: incident.severity,
            }),
          );
        }
      }
    }
  }
  return advance(tx, audit, operation, input, {
    cursor: String(offset + ids.length),
    seen: ids,
    changed,
    skipped: ids.length - changed,
    more,
  });
}

async function undoBatch(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  operation: LockedOperation,
  input: BatchInput,
): Promise<BatchOutcome> {
  const { tenantId, now } = input;
  const undoneId = operation.undoOfId;
  const undone = undoneId === null ? null : await lockOperation(tx, tenantId, undoneId);
  // A chave estrangeira não deixa a operação desfeita sair antes desta.
  if (undone === null) return stopped(tx, audit, operation, 'unavailable', now);
  const { incidentId } = undone;
  if (incidentId !== null) {
    const incident = await lockIncident(tx, tenantId, incidentId);
    // O incidente resolvido não perde alerta: quem desfaz o reabre antes. O que saiu na retenção levou os alertas.
    if (incident?.status === 'resolved')
      return stopped(tx, audit, operation, 'incident_resolved', now, undone);
  }
  const { ids, more } = await itemSlice(
    tx,
    tenantId,
    undone.id,
    operation.cursor,
    input.isolate ? 1 : input.limit,
  );
  let changed = 0;
  let already = 0;
  if (!input.isolate && ids.length > 0) {
    await lockFindings(tx, tenantId, ids);
    already = await countItems(tx, tenantId, operation.id, ids);
    const reverting = await revertible(tx, undone, ids);
    if (reverting.length > 0) {
      changed = await revert(tx, operation, undone.id, reverting, now);
      if (incidentId !== null) await removeFromIncidentSummary(tx, tenantId, incidentId, changed);
      await reopenCases(tx, tenantId, reverting);
    }
  }
  return advance(
    tx,
    audit,
    operation,
    input,
    {
      cursor: ids.at(-1) ?? operation.cursor,
      seen: ids,
      changed,
      skipped: Math.max(0, ids.length - changed - already),
      more,
    },
    undone,
  );
}

/** Os alertas do lote que voltam. O que abriu o incidente fica nele, e o incidente nunca fica sem nenhum. */
async function revertible(
  tx: Prisma.TransactionClient,
  undone: LockedOperation,
  ids: readonly string[],
): Promise<string[]> {
  const reverting = await revertibleIds(tx, undone, ids, undone.run.anchorId);
  const { incidentId, tenantId } = undone;
  if (incidentId === null || reverting.length === 0) return reverting;
  if (await hasOtherAlerts(tx, tenantId, incidentId, reverting)) return reverting;
  return reverting.slice(1);
}

function incidentStop(incident: { status: string } | null): TriageStop | null {
  if (incident === null) return 'incident_gone';
  return incident.status === 'resolved' ? 'incident_resolved' : null;
}

interface Step {
  cursor: string | null;
  seen: readonly string[];
  changed: number;
  skipped: number;
  more: boolean;
}

/** Grava o andamento do lote e, no último, o fim da operação, na mesma transação. */
async function advance(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  operation: LockedOperation,
  input: BatchInput,
  step: Step,
  undone: LockedOperation | null = null,
): Promise<BatchOutcome> {
  const { tenantId, now } = input;
  const failed = input.isolate ? [...operation.run.failed, ...step.seen] : operation.run.failed;
  const run: TriageRun = { ...operation.run, failed };
  const next: LockedOperation = {
    ...operation,
    run,
    cursor: step.cursor,
    changed: operation.changed + step.changed,
    skipped: operation.skipped + step.skipped,
  };
  if (failed.length >= TRIAGE_MAX_FAILED && step.more) {
    await finish(tx, audit, next, 'too_many_failures', now, undone);
  } else if (step.more) {
    await saveProgress(tx, tenantId, operation.id, { ...next, state: 'running', now });
    if (input.isolate) await saveRun(tx, tenantId, operation.id, run, { keepIds: true });
    return { gone: false, seen: step.seen.length, changed: step.changed, finished: false };
  } else {
    await finish(tx, audit, next, failed.length > 0 ? 'failed_alerts' : null, now, undone);
  }
  return { gone: false, seen: step.seen.length, changed: step.changed, finished: true };
}

async function stopped(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  operation: LockedOperation,
  stop: TriageStop,
  now: Date,
  undone: LockedOperation | null = null,
): Promise<BatchOutcome> {
  await finish(tx, audit, operation, stop, now, undone);
  return { gone: false, seen: 0, changed: 0, finished: true };
}

/**
 * O fim de uma operação: o estado, o prazo do desfazer (que conta daqui), o conjunto congelado, que sai quando não há mais
 * o que continuar, o resumo do incidente e um `triage.bulk.finish` do sistema na trilha do cliente. Parada antes do fim, é
 * `partial`, ou `failed` se não mudou nada; as duas aceitam "continuar". Quem chama tem o lock dos alertas do cliente.
 */
export async function finish(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  operation: LockedOperation,
  stop: TriageStop | null,
  now: Date,
  undone: LockedOperation | null = null,
): Promise<void> {
  const { tenantId, id } = operation;
  const undo = operation.action === 'undo';
  const state = stop === null ? 'done' : operation.changed > 0 ? 'partial' : 'failed';
  let run: TriageRun = { ...operation.run, stop };
  await settleIncident(tx, tenantId, operation.incidentId ?? undone?.incidentId ?? null);
  if (undone !== null && stop === null) {
    run = { ...run, incidentResolved: await closeUndone(tx, audit, operation, undone, now) };
  }
  await saveProgress(tx, tenantId, id, { ...operation, state, now });
  await saveRun(tx, tenantId, id, run, {
    keepIds: stop !== null,
    // O que se desfaz uma vez não se refaz por aqui: o desfazer não tem prazo de desfazer.
    ...(!undo && { undoUntil: undoDeadline(now) }),
  });
  await audit.write(tx, {
    actor: { type: 'system', tenantId },
    action: 'triage.bulk.finish',
    outcome: stop === null ? 'success' : 'failure',
    resourceType: 'triage_operation',
    resourceId: id,
    after: {
      action: operation.action,
      ...(operation.status !== null && { status: operation.status }),
      ...(operation.incidentId !== null && { incidentId: operation.incidentId }),
      ...(undone !== null && { undoOf: undone.id, undoneAction: undone.action }),
      requestedBy: operation.createdById,
      state,
      stop,
      matched: operation.matched,
      changed: operation.changed,
      skipped: operation.skipped,
      failed: run.failed.length,
      ...(run.incidentResolved !== null && { incidentResolved: run.incidentResolved }),
    },
  });
}

/**
 * O resumo do incidente de uma operação que acabou (ou parou, ou foi cancelada), refeito dos alertas dele. Nos lotes ele é
 * só juntado, ou acompanha a contagem. Com o lock dos alertas do cliente.
 */
export async function settleIncident(
  tx: Prisma.TransactionClient,
  tenantId: string,
  incidentId: string | null,
): Promise<void> {
  if (incidentId === null || (await lockIncident(tx, tenantId, incidentId)) === null) return;
  if (await hasOtherAlerts(tx, tenantId, incidentId, [])) await resummarizeIncident(tx, tenantId, incidentId);
}

/**
 * O fim do desfazer, na operação desfeita. Num `promote`, o incidente que ficou só com o alerta que o abriu é encerrado, com
 * o registro na trilha; com outros alertas (que alguém pôs, ou que o desfazer não pôde tirar), continua aberto, à vista.
 * Null quando não há incidente a encerrar.
 */
async function closeUndone(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  operation: LockedOperation,
  undone: LockedOperation,
  now: Date,
): Promise<boolean | null> {
  const { tenantId } = undone;
  await saveProgress(tx, tenantId, undone.id, { ...undone, state: 'undone', now });
  await saveRun(tx, tenantId, undone.id, { ...EMPTY_RUN, ...undone.run }, { keepIds: false });
  const { incidentId } = undone;
  if (undone.action !== 'promote' || incidentId === null) return null;
  await unpointCases(tx, tenantId, incidentId);
  const { anchorId } = undone.run;
  if (anchorId === null || (await hasOtherAlerts(tx, tenantId, incidentId, [anchorId]))) return false;
  const resolved = await resolveIncident(tx, tenantId, incidentId, now);
  if (resolved) {
    await audit.write(tx, {
      actor: { type: 'system', tenantId },
      action: 'incident.update',
      outcome: 'success',
      resourceType: 'incident',
      resourceId: incidentId,
      after: {
        status: 'resolved',
        cause: 'triage_undo',
        operationId: operation.id,
        requestedBy: operation.createdById,
        reason: operation.reason,
      },
    });
  }
  return resolved;
}
