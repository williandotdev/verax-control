import type { Configuration, NodeLimits } from '../pricing/pricing.schema.js';
import type { Hosting } from '../tenants/tenant.schema.js';
import { limitsFitNode } from './executor-env.js';

/**
 * Por que uma configuração não cabe no que o `envs/tenant` sabe criar hoje (CP-06 e CP-07): outro modo (o ambiente na
 * infraestrutura do cliente nunca é provisionado), outro porte (só o P, perfil `standard`), agentes do Wazuh nas
 * instâncias do cliente (fora do `envs/tenant`) ou limites fora das faixas do nó (`NODE_LIMIT_RANGES`).
 */
export const NODE_FIT_PROBLEMS = ['mode', 'size', 'agents', 'limits'] as const;
export type NodeFitProblem = (typeof NODE_FIT_PROBLEMS)[number];

/**
 * O que impede o provisionamento de criar esta configuração (vazio: cabe). A mesma regra do `preflight`
 * (`configuration_unsupported`) e do console, que recusa o cadastro antes de criar o cliente: nunca se entrega menos do
 * que foi contratado.
 *
 * Com o ambiente na infraestrutura do cliente (`hosting = customer`, contrato direto), nada é provisionado: o porte é a
 * máquina que o cliente escolhe e os agentes, o pacote do nó já sabe receber. Sobra só o que o próprio nó recusa, os
 * limites fora das faixas dele (o cliente os escreve no `node.conf`).
 */
export function nodeFitProblems(
  configuration: Configuration,
  limits: NodeLimits,
  hosting: Hosting = 'verax',
): NodeFitProblem[] {
  const problems: NodeFitProblem[] = [];
  if (hosting === 'verax') {
    if (configuration.mode !== 'managed') problems.push('mode');
    if (configuration.size !== 'P') problems.push('size');
    if (limits.maxAgents !== 0) problems.push('agents');
  }
  if (!limitsFitNode(limits)) problems.push('limits');
  return problems;
}
