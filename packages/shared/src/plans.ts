import { z } from 'zod';

/**
 * Planos do Verax Control (fase 2). O nó dedicado atende um cliente e tem um plano, que vem do ambiente (`PLAN` e os
 * ajustes `PLAN_*`, escritos pelo `start.sh` a partir do `node.conf`): no nó dedicado, o ambiente é a fonte da verdade
 * e semeia o plano do cliente (`TenantPlan`, CE-02), e o bootstrap só grava o rótulo em `Tenant.plan`. Na célula
 * compartilhada, cada cliente tem o próprio plano, gravado pelo plano de controle (`tenantPlanSchema`, abaixo).
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

/**
 * Planos de um cliente (CE-02): os do nó e a `plataforma`, que só existe na célula compartilhada. A Plataforma não tem
 * padrão no repositório: os limites e a franquia em GB/dia vêm sempre do plano de controle (o que foi vendido), e o
 * `node.conf` não a aceita (`planIdSchema`).
 */
export const TENANT_PLAN_IDS = [...PLAN_IDS, 'plataforma'] as const;
export type TenantPlanId = (typeof TENANT_PLAN_IDS)[number];
export const tenantPlanIdSchema = z.enum(TENANT_PLAN_IDS, {
  error: 'plano desconhecido: use essencial, profissional, enterprise, interno ou plataforma',
});

export const PLAN_LABELS: Readonly<Record<TenantPlanId, string>> = {
  essencial: 'Essencial',
  profissional: 'Profissional',
  enterprise: 'Enterprise',
  interno: 'Interno',
  plataforma: 'Plataforma',
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

/** Plano em vigor para um cliente: o id, o rótulo e os limites já com os ajustes. */
export const resolvedPlanSchema = z.strictObject({
  id: tenantPlanIdSchema,
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

/**
 * Franquia contratada da Plataforma, em GB/dia (10^9 bytes por dia; CE-02). Aqui fica só a faixa de sanidade: o tamanho
 * da base e o teto vendido online ficam na tabela de preços do plano de controle, fora do repositório.
 */
export const FRANCHISE_GB_PER_DAY_BOUNDS = { min: 1, max: 1000 } as const;

const FRANCHISE_RANGE_MESSAGE = `deve ser um número inteiro de ${FRANCHISE_GB_PER_DAY_BOUNDS.min} a ${FRANCHISE_GB_PER_DAY_BOUNDS.max}`;

/**
 * Plano de um cliente (`TenantPlan`, CE-02), como o sistema o grava: o id, os quatro limites já resolvidos e a franquia
 * em GB/dia. Só o sistema grava: o `node.conf` no nó dedicado (o plano resolvido do ambiente, sem franquia) e o comando
 * do plano de controle na célula. Nenhuma rota da API aceita este objeto, nem parte dele (meta-teste em
 * `apps/api/test/tenant-plan.test.ts`).
 *
 * Regras de cada plano (`tenantPlanProblems`):
 * - `interno`: nenhum limite e nenhuma franquia;
 * - `essencial`, `profissional` e `enterprise`: os quatro limites, sem franquia (o volume é o mês em GiB);
 * - `plataforma`: contas, usuários e histórico, a franquia em GB/dia e nenhum volume mensal (o volume é medido por dia,
 *   contra a franquia).
 */
export const tenantPlanSchema = z.strictObject({
  planId: tenantPlanIdSchema,
  limits: resolvedPlanSchema.shape.limits,
  franchiseGbPerDay: z
    .number({ error: FRANCHISE_RANGE_MESSAGE })
    .int({ error: FRANCHISE_RANGE_MESSAGE })
    .min(FRANCHISE_GB_PER_DAY_BOUNDS.min, { error: FRANCHISE_RANGE_MESSAGE })
    .max(FRANCHISE_GB_PER_DAY_BOUNDS.max, { error: FRANCHISE_RANGE_MESSAGE })
    .nullable(),
});
export type TenantPlan = z.infer<typeof tenantPlanSchema>;

/** Problemas da combinação de plano, limites e franquia, por campo. Vazio quando a combinação vale. */
export function tenantPlanProblems(plan: TenantPlan): { field: string; message: string }[] {
  const problems: { field: string; message: string }[] = [];
  const limitPresent = (key: PlanLimitKey, present: boolean, message: string): void => {
    if ((plan.limits[key] !== null) !== present) problems.push({ field: `limits.${key}`, message });
  };
  if (plan.planId === 'interno') {
    for (const key of PLAN_LIMIT_KEYS)
      limitPresent(key, false, 'não se aplica ao plano interno, que não tem limite');
  } else if (plan.planId === 'plataforma') {
    limitPresent('maxCloudAccounts', true, 'obrigatório no plano plataforma');
    limitPresent('maxUsers', true, 'obrigatório no plano plataforma');
    limitPresent('historyDays', true, 'obrigatório no plano plataforma');
    limitPresent(
      'monthlyGib',
      false,
      'não se aplica ao plano plataforma, que mede o volume por dia contra a franquia',
    );
  } else {
    for (const key of PLAN_LIMIT_KEYS) limitPresent(key, true, `obrigatório no plano ${plan.planId}`);
  }
  const wantsFranchise = plan.planId === 'plataforma';
  if ((plan.franchiseGbPerDay !== null) !== wantsFranchise) {
    problems.push({
      field: 'franchiseGbPerDay',
      message: wantsFranchise
        ? 'obrigatória no plano plataforma'
        : `não se aplica ao plano ${plan.planId}, que não tem franquia por dia`,
    });
  }
  return problems;
}

/** Confere o plano do cliente (faixas e combinação). Lança com os campos e os motivos, nunca com os valores recebidos. */
export function parseTenantPlan(input: unknown): TenantPlan {
  const result = tenantPlanSchema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`);
    throw new Error(`Plano do cliente: ${fields.join('; ')}`);
  }
  const problems = tenantPlanProblems(result.data);
  if (problems.length > 0) {
    throw new Error(
      `Plano do cliente: ${problems.map((problem) => `${problem.field} ${problem.message}`).join('; ')}`,
    );
  }
  return result.data;
}

/** O plano do cliente a partir do plano resolvido do ambiente (o `node.conf` do nó dedicado): sem franquia. */
export function tenantPlanFromResolved(plan: ResolvedPlan): TenantPlan {
  return { planId: plan.id, limits: { ...plan.limits }, franchiseGbPerDay: null };
}

/** O plano resolvido (o que as telas, as vagas e o expurgo leem) a partir do plano do cliente. */
export function resolvedPlanOf(plan: TenantPlan): ResolvedPlan {
  return { id: plan.planId, label: PLAN_LABELS[plan.planId], limits: { ...plan.limits } };
}
