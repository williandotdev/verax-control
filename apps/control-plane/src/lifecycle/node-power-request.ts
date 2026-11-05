import type { Clock } from '../common/clock.js';
import { newUlid } from '../common/ulid.js';
import type { StepQueue } from '../queue/step-queue.js';
import type { TenantState } from '../tenants/tenant.schema.js';
import { NODE_RUNNING_STATES, NODE_STOPPED_STATES } from './lifecycle-rules.js';

/** Os passos que param e ligam a VM do cliente (fila `lifecycle`, CP-11). */
export const NODE_STOP_STEP = 'node.stop';
export const NODE_START_STEP = 'node.start';
export type NodePowerStep = typeof NODE_STOP_STEP | typeof NODE_START_STEP;

/**
 * Pede para parar ou ligar a VM: uma task nova na fila `lifecycle`, com uma execução própria (cada pedido tem o seu
 * `runId`, então dois pedidos seguidos são duas tasks). O passo relê o estado do cliente antes de agir: uma task velha
 * (o cliente já mudou de estado) não faz nada. O webhook (cp-public) e o `tick` (cp-worker) chamam; o `tick` também
 * repete o pedido enquanto a VM não chegar ao estado certo.
 */
export async function requestNodePower(
  queue: StepQueue,
  clock: Clock,
  tenantId: string,
  step: NodePowerStep,
): Promise<boolean> {
  const runId = newUlid(clock.now().getTime());
  const { created } = await queue.enqueue({ queue: 'lifecycle', step, tenantId, runId });
  return created;
}

/**
 * O que a VM precisa depois de uma transição: parar ao entrar em `suspended` ou `canceled` vindo de um estado com a VM
 * ligada; ligar ao sair de `suspended` para um estado com a VM ligada (a reativação, `invoice.paid`).
 */
export function nodePowerAfterTransition(from: TenantState, to: TenantState): NodePowerStep | undefined {
  if (NODE_STOPPED_STATES.includes(to) && !NODE_STOPPED_STATES.includes(from)) return NODE_STOP_STEP;
  if (from === 'suspended' && NODE_RUNNING_STATES.includes(to)) return NODE_START_STEP;
  return undefined;
}
