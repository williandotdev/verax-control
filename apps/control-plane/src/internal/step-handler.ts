/** O corpo de toda task do Cloud Tasks (`stepTaskBody`): só os dois ids. */
export interface StepInput {
  tenantId: string;
  runId: string;
}

export interface StepContext {
  requestId?: string;
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
