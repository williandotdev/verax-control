import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { ScheduledTask } from '../worker/scheduler.js';
import {
  CASE_ASSIGN_BUDGET_MS,
  CASE_ASSIGN_INTERVAL_MS,
  CASE_ASSIGN_TASK,
  CaseAssignJob,
  type CaseLogger,
} from './case-assign-job.js';
import {
  CASE_RECONCILE_BUDGET_MS,
  CASE_RECONCILE_CHECK_MS,
  CASE_RECONCILE_TASK,
  CaseReconcileJob,
} from './case-reconcile-job.js';
import { CASE_WATCH_BUDGET_MS, CASE_WATCH_INTERVAL_MS, CASE_WATCH_TASK, CaseWatch } from './case-watch.js';
import { casesOperable, type CasesMode } from './cases-mode.js';
import {
  TRIAGE_OPS_BUDGET_MS,
  TRIAGE_OPS_INTERVAL_MS,
  TRIAGE_OPS_TASK,
  TriageOpsJob,
} from './triage-ops-job.js';

/**
 * As tarefas dos casos no worker. Com `off`, nenhuma: o worker fica como antes dos casos. A fila da triagem em massa só
 * roda com `on`, como as rotas que a enchem: o que ficou nela espera os casos voltarem.
 */
export function caseTasks(mode: CasesMode, prisma: PrismaService, logger: CaseLogger): ScheduledTask[] {
  if (mode === 'off') return [];
  const assign = new CaseAssignJob(prisma, { logger });
  const watch = new CaseWatch(prisma, { logger });
  const reconcile = new CaseReconcileJob(prisma, { logger });
  return [
    {
      name: CASE_ASSIGN_TASK,
      intervalMs: CASE_ASSIGN_INTERVAL_MS,
      budgetMs: CASE_ASSIGN_BUDGET_MS,
      run: (signal) => assign.runOnce(signal),
    },
    {
      name: CASE_WATCH_TASK,
      intervalMs: CASE_WATCH_INTERVAL_MS,
      budgetMs: CASE_WATCH_BUDGET_MS,
      run: (signal) => watch.runOnce(signal),
    },
    {
      name: CASE_RECONCILE_TASK,
      intervalMs: CASE_RECONCILE_CHECK_MS,
      budgetMs: CASE_RECONCILE_BUDGET_MS,
      run: (signal) => reconcile.runOnce(signal),
    },
    ...(casesOperable(mode) ? [triageTask(prisma, logger)] : []),
  ];
}

function triageTask(prisma: PrismaService, logger: CaseLogger): ScheduledTask {
  const job = new TriageOpsJob(prisma, { logger });
  return {
    name: TRIAGE_OPS_TASK,
    intervalMs: TRIAGE_OPS_INTERVAL_MS,
    budgetMs: TRIAGE_OPS_BUDGET_MS,
    run: (signal) => job.runOnce(signal),
  };
}
