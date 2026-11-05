import {
  GIB_BYTES,
  PLAN_LIMIT_REACHED_CODE,
  PLAN_SEAT_LIMIT,
  type PlanSeat,
  type PlanUsage,
  planLimitMessage,
  planUsageSchema,
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

/** O `GET /v1/plan` da demonstração, com as contas e os usuários do estado do mock. */
export function demoPlanUsage(store: AdminStore, tenantId: string, now: Date = new Date()): PlanUsage {
  const included = (DEMO_PLAN.limits.monthlyGib ?? 0) * GIB_BYTES;
  return planUsageSchema.parse({
    plan: DEMO_PLAN,
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
      return HttpResponse.json(demoPlanUsage(store, state.me.scopeTenantId));
    }),
  ];
}
