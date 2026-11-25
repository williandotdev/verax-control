import { WEB_OBSERVE_MS } from '@verax/shared';

/**
 * O começo da observação de um balanceador, que identifica a contagem dela: as 72 h antes do fim obrigatório (o da
 * autorização, ou o de quando o balanceador foi trocado) ou, sem ele, a própria autorização. A tarefa que conta e a tela que
 * mostra usam a mesma conta: a observação guardada de outra vez não é a de agora.
 */
export function observedSince(observeUntil: Date | null | undefined, authorizedAt: Date): string {
  const since = observeUntil == null ? authorizedAt : new Date(observeUntil.getTime() - WEB_OBSERVE_MS);
  return since.toISOString();
}
