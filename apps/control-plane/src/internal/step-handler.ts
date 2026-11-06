/** O corpo de toda task do Cloud Tasks (`stepTaskBody`): os dois ids e, numa consulta de um passo que espera, o número dela. */
export interface StepInput {
  tenantId: string;
  runId: string;
  /** Só nos passos que esperam e se reagendam (CP-07): a consulta que esta task faz (a primeira não tem número). */
  poll?: number;
}

export interface StepContext {
  requestId?: string;
  /**
   * Quantas vezes o Cloud Tasks já repetiu esta task (cabeçalho `X-CloudTasks-TaskRetryCount`; 0 na primeira entrega).
   * Os passos do provisionamento usam para não deixar o cliente parado em `provisioning` quando a fila desistir: na
   * última tentativa, uma falha repetível vira `provisioning_failed`. Sem o cabeçalho (o responsável chamando à mão),
   * fica indefinido.
   */
  retryCount?: number;
}

/**
 * Um passo atendido pelo cp-worker em `POST /internal/steps/<nome>`. Idempotente: a mesma task pode chegar mais de
 * uma vez. Devolve o desfecho (para o log e a resposta); erro repetível lança exceção, e o Cloud Tasks repete com
 * recuo. Os passos do provisionamento (CP-07) e do ciclo de vida (CP-11) entram na mesma lista (`STEP_HANDLERS`).
 */
export interface StepHandler {
  readonly name: string;
  run(input: StepInput, context: StepContext): Promise<string>;
}

export const STEP_HANDLERS = Symbol('STEP_HANDLERS');
