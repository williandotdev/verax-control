import type { protos } from '@google-cloud/tasks';
import {
  assertStepTask,
  type EnqueuedStep,
  type StepQueue,
  type StepQueueName,
  type StepTask,
  stepTaskBody,
  stepTaskId,
} from './step-queue.js';

/** Código gRPC `ALREADY_EXISTS`: a task com esse nome já existe (ou existiu há pouco). */
const ALREADY_EXISTS = 6;

/**
 * Prazo de despacho de cada task: 15 min, o mesmo `timeout` do cp-worker (run.tf) e do Scheduler (tasks.tf). O limite
 * do serviço é 30 min; os passos longos se reagendam (plano §4c).
 */
export const DISPATCH_DEADLINE_SECONDS = 900;

export type CreateTaskRequest = protos.google.cloud.tasks.v2.ICreateTaskRequest;

/** O pouco do cliente do Cloud Tasks que a fila usa (o SDK em produção; um dublê nos testes da montagem). */
export interface CloudTasksApi {
  createTask(request: CreateTaskRequest): Promise<unknown>;
}

export interface CloudTasksSettings {
  projectId: string;
  location: string;
  queues: Readonly<Record<StepQueueName, string>>;
  /** URL do cp-worker; também é o `audience` do token (o worker confere `aud == WORKER_URL`). */
  workerUrl: string;
  /** A conta do token OIDC (a `cp-invoker`, contrato com identities.tf). */
  serviceAccountEmail: string;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === ALREADY_EXISTS;
}

/**
 * O SDK oficial (`@google-cloud/tasks`), carregado só no primeiro enfileiramento: o gRPC e os protos pesam na partida,
 * e a maior parte das requisições do cp-public (checkout, status, eventos sem passo) nunca enfileira nada.
 */
export async function loadCloudTasksApi(): Promise<CloudTasksApi> {
  const { CloudTasksClient } = await import('@google-cloud/tasks');
  const client = new CloudTasksClient();
  return {
    async createTask(request) {
      const [task] = await client.createTask(request);
      return task;
    },
  };
}

/**
 * Fila de passos no Cloud Tasks: uma task HTTP por passo, `POST <WORKER_URL>/internal/steps/<passo>` com corpo JSON
 * `{tenantId, runId}`, token OIDC da conta das tasks com `audience = WORKER_URL`, prazo de despacho de 15 min e id
 * determinístico (`<passo>-<runId>`), para que a mesma entrega repetida não crie duas tasks. As novas tentativas com
 * recuo são da fila (tasks.tf: 8 tentativas, 30 s a 10 min).
 */
export class CloudTasksStepQueue implements StepQueue {
  private api: Promise<CloudTasksApi> | undefined;

  constructor(
    private readonly settings: CloudTasksSettings,
    private readonly load: () => Promise<CloudTasksApi> = loadCloudTasksApi,
  ) {}

  /** O pedido exato ao Cloud Tasks (exposto para o teste conferir a montagem). */
  buildRequest(task: StepTask): CreateTaskRequest {
    assertStepTask(task);
    const { projectId, location, queues, workerUrl, serviceAccountEmail } = this.settings;
    const parent = `projects/${projectId}/locations/${location}/queues/${queues[task.queue]}`;
    const url = new URL(`/internal/steps/${task.step}`, workerUrl).toString();
    return {
      parent,
      task: {
        name: `${parent}/tasks/${stepTaskId(task.step, task.runId, task.poll)}`,
        httpRequest: {
          httpMethod: 'POST',
          url,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(stepTaskBody(task)), 'utf8'),
          oidcToken: { serviceAccountEmail, audience: workerUrl },
        },
        dispatchDeadline: { seconds: DISPATCH_DEADLINE_SECONDS },
        ...(task.scheduleAt === undefined
          ? {}
          : { scheduleTime: { seconds: Math.floor(task.scheduleAt.getTime() / 1000) } }),
      },
    };
  }

  async enqueue(task: StepTask): Promise<EnqueuedStep> {
    const request = this.buildRequest(task);
    const taskId = stepTaskId(task.step, task.runId, task.poll);
    this.api ??= this.load();
    let api: CloudTasksApi;
    try {
      api = await this.api;
    } catch (error) {
      // Um carregamento que falhou não fica guardado: a próxima chamada tenta de novo.
      this.api = undefined;
      throw error;
    }
    try {
      await api.createTask(request);
      return { taskId, created: true };
    } catch (error) {
      if (isAlreadyExists(error)) return { taskId, created: false };
      throw error;
    }
  }
}
