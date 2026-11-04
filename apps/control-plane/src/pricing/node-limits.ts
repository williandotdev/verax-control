import type { NodeLimits } from './pricing.schema.js';

/**
 * Gancho do PR-18 (limites do plano no nó): os limites de uma configuração na forma que o nó já entende.
 *
 * O nó lê o plano do ambiente (`PLAN` e os ajustes `PLAN_*`, escritos pelo `start.sh` a partir do `node.conf`;
 * `packages/shared/src/plans.ts`). O plano `enterprise` é o que não tem padrão: os quatro limites vêm sempre dos
 * ajustes. É ele que o nó de um cliente configurável recebe até o PC-10 criar o rótulo próprio (`configuravel`, o
 * mesmo `enterprise` com outro nome). `PLAN_MAX_AGENTS` é novo: o nó de hoje o ignora, e o PR-18/PC-10 passa a
 * aplicá-lo (com o desenho dos agentes).
 *
 * Quem grava isto no nó é o provisionamento (CP-07: variáveis do Job do Terraform → metadados da VM → `node.conf`) e,
 * numa troca de configuração, o passo `node.apply_limits` (PC-12). Este PR só gera o mapa e o guarda no cliente
 * (`tenants/{id}.limits`); o nó não muda.
 */
export const NODE_PLAN_ID = 'enterprise';

export const NODE_LIMIT_VARIABLES = {
  maxCloudAccounts: 'PLAN_MAX_CLOUD_ACCOUNTS',
  monthlyGib: 'PLAN_MONTHLY_GIB',
  historyDays: 'PLAN_HISTORY_DAYS',
  maxUsers: 'PLAN_MAX_USERS',
  maxAgents: 'PLAN_MAX_AGENTS',
} as const satisfies Record<keyof NodeLimits, string>;

export type NodeLimitVariable = (typeof NODE_LIMIT_VARIABLES)[keyof typeof NODE_LIMIT_VARIABLES];

/** `{ PLAN: 'enterprise', PLAN_MAX_CLOUD_ACCOUNTS: '15', ... }`: só inteiros em texto, prontos para o `node.conf`. */
export function nodeLimitsEnv(limits: NodeLimits): Record<'PLAN' | NodeLimitVariable, string> {
  return {
    PLAN: NODE_PLAN_ID,
    PLAN_MAX_CLOUD_ACCOUNTS: String(limits.maxCloudAccounts),
    PLAN_MONTHLY_GIB: String(limits.monthlyGib),
    PLAN_HISTORY_DAYS: String(limits.historyDays),
    PLAN_MAX_USERS: String(limits.maxUsers),
    PLAN_MAX_AGENTS: String(limits.maxAgents),
  };
}
