import {
  addDays,
  brasiliaDay,
  currentBillingCycle,
  cycleBudgetGb,
  FRANCHISE_CHART_DAYS,
  type FranchiseUsage,
  franchiseUsageSchema,
  GB_BYTES,
  GIB_BYTES,
  type HistoryPeriod,
  PERIOD_BEYOND_HISTORY_CODE,
  periodBeyondHistoryMessage,
  periodFitsHistory,
  PLAN_LIMIT_REACHED_CODE,
  PLAN_SEAT_LIMIT,
  type PlanSeat,
  type PlanUsage,
  planHistorySchema,
  planLimitMessage,
  planUsageSchema,
  projectedOverageUnits,
  type ResolvedPlan,
  resolvePlan,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import type { AdminStore } from './admin';
import { DEMO_TENANTS } from './fixtures';
import type { MockState } from './handlers';

const url = (path: string): string => `${API_URL}${path}`;

const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code && { code }) }, { status });

/**
 * Plano do nó da demonstração: o Profissional da tabela de planos (`packages/shared/src/plans.ts`), sem ajuste. Como
 * no nó de verdade, o painel só mostra: os limites vêm da configuração, nunca da tela.
 */
export const DEMO_PLAN: ResolvedPlan = resolvePlan('profissional');

/** O plano do nó da demonstração, com o ajuste de histórico do estado, se houver (como o `PLAN_HISTORY_DAYS`). */
export function demoNodePlan(state: Pick<MockState, 'historyDays'>): ResolvedPlan {
  return state.historyDays === undefined
    ? DEMO_PLAN
    : { ...DEMO_PLAN, limits: { ...DEMO_PLAN.limits, historyDays: state.historyDays } };
}

/** A recusa da API (400 `PERIOD_BEYOND_PLAN_HISTORY`) do período além do histórico do plano; senão, nada. */
export function demoPeriodRefusal(
  state: Pick<MockState, 'historyDays'>,
  period: HistoryPeriod | undefined,
): Response | null {
  const days = demoNodePlan(state).limits.historyDays;
  if (period === undefined || days === null || periodFitsHistory(period, days)) return null;
  return problem(400, periodBeyondHistoryMessage(days), PERIOD_BEYOND_HISTORY_CODE);
}

const [ALFA, BETA] = DEMO_TENANTS;

/**
 * Volume lido no mês, por cliente fictício, em fração do incluído no plano: a Alfa já passou de 80% (a faixa de aviso
 * aparece); a Beta está tranquila.
 */
export const DEMO_VOLUME_RATIO: Readonly<Record<string, number>> = {
  [ALFA?.id ?? '']: 0.86,
  [BETA?.id ?? '']: 0.23,
};

/** Brasília está em UTC-3 o ano todo: o mês do uso vira às 03:00 UTC do dia 1º, como no medidor da API. */
function usageMonth(now: Date): string {
  return new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 7);
}

/** Vagas ocupadas, como na API: contas ativas; usuários convidados ou ativos (a equipe da Verax nunca está aqui). */
export function demoSeatsUsed(store: AdminStore, tenantId: string, seat: PlanSeat): number {
  return seat === 'cloudAccounts'
    ? (store.accounts.get(tenantId) ?? []).filter((account) => account.status === 'active').length
    : (store.users.get(tenantId) ?? []).filter((user) => user.status !== 'disabled').length;
}

/** A recusa da API (409 `PLAN_LIMIT_REACHED`) quando o cliente já ocupa todas as vagas; senão, nada. */
export function demoPlanRefusal(store: AdminStore, tenantId: string, seat: PlanSeat): Response | null {
  const limit = DEMO_PLAN.limits[PLAN_SEAT_LIMIT[seat]];
  if (limit === null || demoSeatsUsed(store, tenantId, seat) < limit) return null;
  return problem(409, planLimitMessage(seat, limit), PLAN_LIMIT_REACHED_CODE);
}

/**
 * A demonstração da Plataforma (CE-10, o plano da célula com franquia em GB/dia): com
 * `localStorage['verax.mock.plan'] = 'plataforma'` (ou `platform` no estado dos testes), "Plano e uso" mostra o contador
 * da franquia. Os limites e a franquia são FICTÍCIOS, sem relação com o que a Verax vende.
 */
export const MOCK_PLAN_STORAGE_KEY = 'verax.mock.plan';

export const DEMO_PLATFORM_PLAN: ResolvedPlan = {
  id: 'plataforma',
  label: 'Plataforma',
  limits: { maxCloudAccounts: 10, maxUsers: 10, monthlyGib: null, historyDays: 90 },
};
export const DEMO_FRANCHISE_GB_PER_DAY = 3;

function demoPlatform(state: Pick<MockState, 'platform'>): boolean {
  if (state.platform !== undefined) return state.platform;
  return typeof window !== 'undefined' && window.localStorage.getItem(MOCK_PLAN_STORAGE_KEY) === 'plataforma';
}

/**
 * O contador da franquia da demonstração: um volume por dia que oscila um pouco acima da franquia (a AWS entre 2,6 e
 * 3,2 GB, a GCP 0,35 GB e a auditoria do Cloudflare 0,04 GB), com as contas da API (`packages/shared/src/franchise.ts`).
 */
export function demoFranchise(now: Date = new Date()): FranchiseUsage {
  const cycle = currentBillingCycle(now);
  const today = brasiliaDay(now);
  const chartStart = addDays(today, -(FRANCHISE_CHART_DAYS - 1));
  const volume = (day: string) => {
    const wave = Number(day.slice(8, 10)) % 4;
    return { aws: (2.6 + wave * 0.2) * GB_BYTES, gcp: 0.35 * GB_BYTES, cloudflare: 0.04 * GB_BYTES };
  };
  let used = 0;
  for (let day = cycle.start; day <= today; day = addDays(day, 1)) {
    const { aws, gcp, cloudflare } = volume(day);
    used += aws + gcp + cloudflare;
  }
  const schedule = [{ from: cycle.start, gbPerDay: DEMO_FRANCHISE_GB_PER_DAY }];
  const budgetGb = cycleBudgetGb(schedule, cycle);
  used = Math.round(used);
  return franchiseUsageSchema.parse({
    cycle,
    franchiseGbPerDay: DEMO_FRANCHISE_GB_PER_DAY,
    schedule,
    budgetGb,
    usedBytes: used,
    dailyAverageBytes: Math.floor(used / cycle.day),
    projectedBytes: Math.floor((used * cycle.days) / cycle.day),
    projectedOverageUnits: projectedOverageUnits(used, budgetGb, cycle.day, cycle.days),
    days: Array.from({ length: FRANCHISE_CHART_DAYS }, (_, index) => {
      const day = addDays(chartStart, index);
      const { aws, gcp, cloudflare } = volume(day);
      return { day, aws: Math.round(aws), gcp: Math.round(gcp), cloudflare: Math.round(cloudflare) };
    }),
  });
}

/** O `GET /v1/plan` da demonstração, com as contas e os usuários do estado do mock. */
export function demoPlanUsage(
  store: AdminStore,
  tenantId: string,
  now: Date = new Date(),
  plan: ResolvedPlan = DEMO_PLAN,
): PlanUsage {
  const included = (plan.limits.monthlyGib ?? 0) * GIB_BYTES;
  return planUsageSchema.parse({
    plan,
    usage: {
      cloudAccounts: demoSeatsUsed(store, tenantId, 'cloudAccounts'),
      users: demoSeatsUsed(store, tenantId, 'users'),
      month: usageMonth(now),
      // Para cima: a porcentagem da tela (arredondada para baixo) é a da fração da demonstração.
      monthlyBytes: Math.ceil((DEMO_VOLUME_RATIO[tenantId] ?? 0) * included),
    },
  });
}

export function createPlanHandlers(state: MockState, store: AdminStore) {
  return [
    http.get(url('/v1/plan'), () => {
      if (!state.me) return problem(401, 'Não autenticado');
      if (!state.me.permissions.includes('plan:read')) return problem(403, 'Sem permissão');
      if (!state.me.scopeTenantId) {
        return problem(409, 'Selecione um cliente para continuar', 'TENANT_REQUIRED');
      }
      if (demoPlatform(state)) {
        const now = new Date();
        return HttpResponse.json(
          planUsageSchema.parse({
            ...demoPlanUsage(store, state.me.scopeTenantId, now, DEMO_PLATFORM_PLAN),
            franchise: demoFranchise(now),
          }),
        );
      }
      return HttpResponse.json(demoPlanUsage(store, state.me.scopeTenantId, new Date(), demoNodePlan(state)));
    }),
    // Só o histórico (PR-20): todos os papéis, sem cliente escolhido (é do nó).
    http.get(url('/v1/plan/history'), () => {
      if (!state.me) return problem(401, 'Não autenticado');
      if (!state.me.permissions.includes('plan_history:read')) return problem(403, 'Sem permissão');
      return HttpResponse.json(
        planHistorySchema.parse({ historyDays: demoNodePlan(state).limits.historyDays }),
      );
    }),
  ];
}
