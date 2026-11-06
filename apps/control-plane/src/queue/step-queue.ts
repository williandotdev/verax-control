import { isUlid } from '../common/ulid.js';

/**
 * Filas do Cloud Tasks (plano §2.1): `provisioning` (um passo do provisionamento por task, plano §4c) e `lifecycle`
 * (suspensão, reativação e exclusão, CP-11). Cada task é um `POST <WORKER_URL>/internal/steps/<passo>` com corpo
 * `{tenantId, runId}` e o token OIDC da conta das tasks; quem atende é o cp-worker (CP-07 e CP-11).
 */
export const STEP_QUEUE_NAMES = ['provisioning', 'lifecycle'] as const;
export type StepQueueName = (typeof STEP_QUEUE_NAMES)[number];

/** O primeiro passo do provisionamento (plano §4c), enfileirado quando o cliente entra em `provisioning`. */
export const FIRST_PROVISIONING_STEP = 'preflight';

/** Nome de passo: minúsculas, números, sublinhado e ponto (`preflight`, `cloudflare.tunnel`). Classe única: linear. */
const STEP_NAME_PATTERN = /^[a-z][a-z0-9_.]{0,62}[a-z0-9]$/;

export function isStepName(value: string): boolean {
  return STEP_NAME_PATTERN.test(value) && !value.includes('..');
}

export interface StepTask {
  queue: StepQueueName;
  /** Nome do passo; vira o fim da URL e, com o `runId`, o id da task. */
  step: string;
  tenantId: string;
  /** A execução (provisionamento, suspensão...) a que o passo pertence; vem de `tenant.provisioning.runId`. */
  runId: string;
  /** Agendamento opcional (passos que esperam, CP-07). */
  scheduleAt?: Date;
  /**
   * Número da consulta de um passo que espera e se reagenda (CP-07: `terraform.wait`, `node.wait_ready`,
   * `panel.domain_wait`...). Entra no id da task (o Cloud Tasks não aceita o mesmo nome por cerca de 1 hora depois de a
   * task terminar) e no corpo, para o passo descartar uma entrega repetida de uma consulta já feita.
   */
  poll?: number;
}

/** Maior número de consulta de um passo (24 h de espera a cada 2 min dão 720; folga para os outros prazos). */
export const MAX_STEP_POLL = 100_000;

export interface EnqueuedStep {
  /** Id da task, determinístico por passo e execução: `<passo com _ no lugar de .>-<runId>`. */
  taskId: string;
  /** `false` quando a task com esse id já existia (repetição da mesma entrega): nada novo foi enfileirado. */
  created: boolean;
}

/**
 * Enfileirar passos. Idempotente pelo id da task: enfileirar duas vezes o mesmo passo da mesma execução cria uma task
 * só (o Cloud Tasks recusa o nome repetido por cerca de 1 hora depois de a task terminar; depois disso, quem garante é
 * o worker, que confere se o passo é o próximo, plano §4c). Implementações: `CloudTasksStepQueue` (produção) e
 * `MemoryStepQueue` (testes).
 */
export interface StepQueue {
  enqueue(task: StepTask): Promise<EnqueuedStep>;
}

export const STEP_QUEUE = Symbol('STEP_QUEUE');

/** A fila não está configurada (variáveis `TASKS_*`, `WORKER_URL`, `WORKER_SA_EMAIL`): nada foi enfileirado. */
export class StepQueueUnavailableError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`fila de passos sem configuração: ${missing.join(', ')}`);
    this.name = 'StepQueueUnavailableError';
  }
}

/** Confere a task antes de enfileirar: nada de nome de passo ou id fora do formato no caminho ou na URL. */
export function assertStepTask(task: StepTask): void {
  if (!(STEP_QUEUE_NAMES as readonly string[]).includes(task.queue)) throw new TypeError('fila desconhecida');
  if (!isStepName(task.step)) throw new TypeError('nome de passo inválido');
  if (!isUlid(task.tenantId)) throw new TypeError('id de cliente inválido');
  if (!isUlid(task.runId)) throw new TypeError('id de execução inválido');
  if (task.poll !== undefined && !isStepPoll(task.poll)) throw new TypeError('número de consulta inválido');
}

export function isStepPoll(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_STEP_POLL;
}

/**
 * Id da task no Cloud Tasks (letras, números, hífen e sublinhado): o passo, sem pontos, e a execução; numa consulta de
 * um passo que espera, também o número dela (`-p<n>`).
 */
export function stepTaskId(step: string, runId: string, poll?: number): string {
  const base = `${step.replaceAll('.', '_')}-${runId}`;
  return poll === undefined ? base : `${base}-p${poll}`;
}

/** O corpo que o worker recebe: só os dois ids (e o número da consulta), nunca dado do cliente. */
export function stepTaskBody(task: StepTask): { tenantId: string; runId: string; poll?: number } {
  return {
    tenantId: task.tenantId,
    runId: task.runId,
    ...(task.poll === undefined ? {} : { poll: task.poll }),
  };
}
