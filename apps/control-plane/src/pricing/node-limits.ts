import type { NodeLimits } from './pricing.schema.js';

/**
 * Gancho do PR-18 (limites do plano no nó): os limites de uma configuração na forma que o nó já entende.
 *
 * O nó lê o plano do ambiente (`PLAN` e os ajustes `PLAN_*`, escritos pelo `start.sh` a partir do `node.conf`;
 * `packages/shared/src/plans.ts`). O plano `enterprise` é o que não tem padrão: os quatro limites vêm sempre dos
 * ajustes. É ele que o nó de um cliente configurável recebe até o PC-10 criar o rótulo próprio (`configuravel`, o
 * mesmo `enterprise` com outro nome).
 *
 * Os agentes nas instâncias do cliente usam as variáveis que o nó já tem (`WAZUH_AGENTS` e `WAZUH_AGENTS_MAX`, em
 * `infra/node/node.conf.example` e `apps/api/src/agents/agents-config.ts`): com pacotes contratados, o interruptor
 * liga e o teto é o contratado; sem pacote, fica desligado. O resto do que os agentes pedem (o interruptor
 * `wazuh_agents` e as faixas de origem no Terraform do nó, o endereço, a CA e a senha de registro, que o `install.sh`
 * gera) é do provisionamento, não do preço.
 *
 * Quem grava isto no nó é o provisionamento (CP-07: variáveis do Job do Terraform → metadados da VM → `node.conf`) e,
 * numa troca de configuração, o passo `node.apply_limits` (PC-12). Este PR só gera o mapa e o guarda no cliente
 * (`tenants/{id}.limits`); o nó não muda.
 */
export const NODE_PLAN_ID = 'enterprise';

/**
 * O maior `WAZUH_AGENTS_MAX` que o nó aceita: o `WAZUH_AGENTS_MAX_LIMIT` de `packages/shared/src/agents.ts` (o plano de
 * controle não depende do pacote compartilhado; o teste confere que os dois batem). A checagem de publicação recusa
 * uma tabela que venda mais agentes que isso.
 */
export const NODE_AGENTS_MAX_LIMIT = 500;

/** Agentes contratados acima do que o nó aceita: a tabela de preços venderia mais do que o nó comporta. */
export class NodeAgentsLimitError extends RangeError {
  constructor(readonly maxAgents: number) {
    super(`o nó aceita no máximo ${NODE_AGENTS_MAX_LIMIT} agentes; a configuração pede ${maxAgents}`);
    this.name = 'NodeAgentsLimitError';
  }
}

/**
 * `{ PLAN: 'enterprise', PLAN_MAX_CLOUD_ACCOUNTS: '15', ..., WAZUH_AGENTS: 'true', WAZUH_AGENTS_MAX: '20' }`: só
 * texto, pronto para o `node.conf`. Sem agentes contratados, `WAZUH_AGENTS=false` e sem `WAZUH_AGENTS_MAX` (o nó recusa
 * o teto com o interruptor desligado).
 */
export function nodeLimitsEnv(limits: NodeLimits): Record<string, string> {
  if (limits.maxAgents > NODE_AGENTS_MAX_LIMIT) throw new NodeAgentsLimitError(limits.maxAgents);
  return {
    PLAN: NODE_PLAN_ID,
    PLAN_MAX_CLOUD_ACCOUNTS: String(limits.maxCloudAccounts),
    PLAN_MONTHLY_GIB: String(limits.monthlyGib),
    PLAN_HISTORY_DAYS: String(limits.historyDays),
    PLAN_MAX_USERS: String(limits.maxUsers),
    WAZUH_AGENTS: limits.maxAgents > 0 ? 'true' : 'false',
    ...(limits.maxAgents > 0 ? { WAZUH_AGENTS_MAX: String(limits.maxAgents) } : {}),
  };
}
