import { z } from 'zod';

/**
 * Planos do Verax Control (fase 2). Cada nó atende um cliente e tem um plano, que vem do ambiente (`PLAN` e os
 * ajustes `PLAN_*`, escritos pelo `start.sh` a partir do `node.conf`): o ambiente é a fonte da verdade, e o bootstrap
 * só grava o rótulo em `Tenant.plan`. A aplicação dos limites (contas, usuários, volume e histórico) vem nos PRs
 * seguintes; aqui ficam só a tabela e a validação.
 *
 * - `essencial` e `profissional` têm limites fixos, que os ajustes podem trocar (extras como "conta extra" ou
 *   "+10 GiB");
 * - `enterprise` não tem padrão: os quatro limites vêm sempre dos ajustes;
 * - `interno` é o nó da própria Verax, sem limite nenhum, e não aceita ajuste.
 */
export const PLAN_IDS = ['essencial', 'profissional', 'enterprise', 'interno'] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const planIdSchema = z.enum(PLAN_IDS, {
  error: 'plano desconhecido: use essencial, profissional, enterprise ou interno',
});

export const PLAN_LABELS: Readonly<Record<PlanId, string>> = {
  essencial: 'Essencial',
  profissional: 'Profissional',
  enterprise: 'Enterprise',
  interno: 'Interno',
};

/** Os limites de um plano. `null` é "sem limite". */
export const PLAN_LIMIT_KEYS = ['maxCloudAccounts', 'maxUsers', 'monthlyGib', 'historyDays'] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
export type PlanLimits = Readonly<Record<PlanLimitKey, number | null>>;

/**
 * Faixa aceita em cada ajuste. O histórico tem piso de 30 dias: um valor pequeno por engano apagaria dados no expurgo.
 * - contas cloud: contas AWS, projetos da GCP e contas do Cloudflare ativos;
 * - usuários: os do cliente (a equipe da Verax não conta);
 * - GiB por mês: volume de log lido no mês do calendário de Brasília;
 * - histórico: dias de achados, incidentes e auditoria guardados.
 */
export const PLAN_LIMIT_BOUNDS = {
  maxCloudAccounts: { min: 1, max: 1000 },
  maxUsers: { min: 1, max: 1000 },
  monthlyGib: { min: 1, max: 100_000 },
  historyDays: { min: 30, max: 3650 },
} as const satisfies Record<PlanLimitKey, { min: number; max: number }>;

/** Mensagem de um ajuste fora da faixa, a mesma no ambiente e no contrato. */
export function planLimitRangeMessage(key: PlanLimitKey): string {
  const { min, max } = PLAN_LIMIT_BOUNDS[key];
  return `deve ser um número inteiro de ${min} a ${max}`;
}

const limitSchema = (key: PlanLimitKey) => {
  const { min, max } = PLAN_LIMIT_BOUNDS[key];
  const error = planLimitRangeMessage(key);
  return z.number({ error }).int({ error }).min(min, { error }).max(max, { error });
};

/** Limites fixos de cada plano; `enterprise` é `null` porque depende sempre dos ajustes. */
export const PLANS: Readonly<Record<PlanId, PlanLimits | null>> = {
  essencial: { maxCloudAccounts: 3, maxUsers: 5, monthlyGib: 15, historyDays: 90 },
  profissional: { maxCloudAccounts: 15, maxUsers: 15, monthlyGib: 60, historyDays: 365 },
  enterprise: null,
  interno: { maxCloudAccounts: null, maxUsers: null, monthlyGib: null, historyDays: null },
};

/** Ajustes do plano (`PLAN_MAX_CLOUD_ACCOUNTS`, `PLAN_MAX_USERS`, `PLAN_MONTHLY_GIB` e `PLAN_HISTORY_DAYS`). */
export const planOverridesSchema = z.strictObject({
  maxCloudAccounts: limitSchema('maxCloudAccounts').optional(),
  maxUsers: limitSchema('maxUsers').optional(),
  monthlyGib: limitSchema('monthlyGib').optional(),
  historyDays: limitSchema('historyDays').optional(),
});
export type PlanOverrides = z.infer<typeof planOverridesSchema>;

/** Plano em vigor no nó: o id, o rótulo e os limites já com os ajustes. */
export const resolvedPlanSchema = z.strictObject({
  id: planIdSchema,
  label: z.string().min(1).max(60),
  limits: z.strictObject({
    maxCloudAccounts: limitSchema('maxCloudAccounts').nullable(),
    maxUsers: limitSchema('maxUsers').nullable(),
    monthlyGib: limitSchema('monthlyGib').nullable(),
    historyDays: limitSchema('historyDays').nullable(),
  }),
});
export type ResolvedPlan = z.infer<typeof resolvedPlanSchema>;

/**
 * Problemas da combinação de plano e ajustes, por limite: o `enterprise` exige os quatro, e o `interno` não aceita
 * nenhum. Vazio quando a combinação vale. A faixa de cada valor é conferida pelo `planOverridesSchema`.
 */
export function planOverrideProblems(
  id: PlanId,
  overrides: PlanOverrides,
): { key: PlanLimitKey; message: string }[] {
  if (id === 'enterprise') {
    return PLAN_LIMIT_KEYS.filter((key) => overrides[key] === undefined).map((key) => ({
      key,
      message: 'obrigatório no plano enterprise',
    }));
  }
  if (id === 'interno') {
    return PLAN_LIMIT_KEYS.filter((key) => overrides[key] !== undefined).map((key) => ({
      key,
      message: 'não se aplica ao plano interno, que não tem limite',
    }));
  }
  return [];
}

/** Plano em vigor: os limites fixos do plano, trocados pelos ajustes informados. Lança se a combinação não vale. */
export function resolvePlan(id: PlanId, overrides: PlanOverrides = {}): ResolvedPlan {
  const valid = planOverridesSchema.parse(overrides);
  const problems = planOverrideProblems(id, valid);
  if (problems.length > 0) {
    throw new Error(
      `Plano ${id}: ${problems.map((problem) => `${problem.key} ${problem.message}`).join('; ')}`,
    );
  }
  const base = PLANS[id];
  const limit = (key: PlanLimitKey): number | null => valid[key] ?? base?.[key] ?? null;
  return {
    id,
    label: PLAN_LABELS[id],
    limits: {
      maxCloudAccounts: limit('maxCloudAccounts'),
      maxUsers: limit('maxUsers'),
      monthlyGib: limit('monthlyGib'),
      historyDays: limit('historyDays'),
    },
  };
}
