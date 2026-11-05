import {
  assertStepTask,
  type EnqueuedStep,
  type StepQueue,
  type StepQueueName,
  type StepTask,
  stepTaskId,
} from './step-queue.js';

export interface MemoryQueuedTask extends StepTask {
  taskId: string;
}

/**
 * Dublê em memória da fila de passos, para os testes: guarda cada task criada, recusa o id repetido como o Cloud
 * Tasks (`created: false`) e pode falhar a próxima chamada (`failNext`), para provar que o webhook repete o
 * enfileiramento quando a Stripe entrega de novo.
 */
export class MemoryStepQueue implements StepQueue {
  readonly tasks: MemoryQueuedTask[] = [];
  private failure: Error | undefined;

  enqueue(task: StepTask): Promise<EnqueuedStep> {
    assertStepTask(task);
    if (this.failure !== undefined) {
      const error = this.failure;
      this.failure = undefined;
      return Promise.reject(error);
    }
    const taskId = stepTaskId(task.step, task.runId, task.poll);
    if (this.tasks.some((queued) => queued.queue === task.queue && queued.taskId === taskId)) {
      return Promise.resolve({ taskId, created: false });
    }
    this.tasks.push({ ...task, taskId });
    return Promise.resolve({ taskId, created: true });
  }

  /** A próxima chamada falha com este erro (uma vez). */
  failNext(error: Error): void {
    this.failure = error;
  }

  inQueue(queue: StepQueueName): MemoryQueuedTask[] {
    return this.tasks.filter((task) => task.queue === queue);
  }

  clear(): void {
    this.tasks.length = 0;
    this.failure = undefined;
  }
}
