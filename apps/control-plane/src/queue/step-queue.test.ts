import { describe, expect, it } from 'vitest';
import { newUlid } from '../common/ulid.js';
import {
  type CloudTasksApi,
  CloudTasksStepQueue,
  type CreateTaskRequest,
  DISPATCH_DEADLINE_SECONDS,
} from './cloud-tasks-step-queue.js';
import { MemoryStepQueue } from './memory-step-queue.js';
import { isStepName, StepQueueUnavailableError, type StepTask, stepTaskId } from './step-queue.js';
import { resolveStepQueueSettings, UnconfiguredStepQueue } from './step-queue.module.js';

/** Configuração fictícia (CLAUDE.md, regra 10): projeto `demo-`, nenhuma conta real. */
const SETTINGS = {
  projectId: 'demo-verax-cp',
  location: 'southamerica-east1',
  queues: { provisioning: 'provisioning', lifecycle: 'lifecycle' },
  workerUrl: 'https://cp-worker-123456789012.southamerica-east1.run.app',
  serviceAccountEmail: 'cp-invoker@demo-verax-cp.iam.gserviceaccount.com',
} as const;

class RecordingApi implements CloudTasksApi {
  readonly requests: CreateTaskRequest[] = [];
  failWith: Error | undefined;

  createTask(request: CreateTaskRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.failWith !== undefined) {
      const error = this.failWith;
      this.failWith = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve({ name: request.task?.name });
  }
}

function task(overrides: Partial<StepTask> = {}): StepTask {
  return { queue: 'provisioning', step: 'preflight', tenantId: newUlid(), runId: newUlid(), ...overrides };
}

describe('fila de passos no Cloud Tasks (CP-04)', () => {
  it('monta a task HTTP exata: fila, id determinístico, URL do worker, corpo, OIDC e prazo de 15 min', async () => {
    const api = new RecordingApi();
    const queue = new CloudTasksStepQueue(SETTINGS, () => Promise.resolve(api));
    const t = task({ step: 'cloudflare.tunnel' });

    expect(await queue.enqueue(t)).toEqual({ taskId: `cloudflare_tunnel-${t.runId}`, created: true });

    const parent = 'projects/demo-verax-cp/locations/southamerica-east1/queues/provisioning';
    const [sent] = api.requests;
    expect(sent).toEqual({
      parent,
      task: {
        name: `${parent}/tasks/cloudflare_tunnel-${t.runId}`,
        httpRequest: {
          httpMethod: 'POST',
          url: `${SETTINGS.workerUrl}/internal/steps/cloudflare.tunnel`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify({ tenantId: t.tenantId, runId: t.runId })),
          oidcToken: { serviceAccountEmail: SETTINGS.serviceAccountEmail, audience: SETTINGS.workerUrl },
        },
        dispatchDeadline: { seconds: DISPATCH_DEADLINE_SECONDS },
      },
    });
    expect(DISPATCH_DEADLINE_SECONDS).toBe(900);
  });

  it('a fila de ciclo de vida e o agendamento entram no pedido', () => {
    const queue = new CloudTasksStepQueue(SETTINGS, () => Promise.resolve(new RecordingApi()));
    const at = new Date('2026-11-05T03:00:00.000Z');
    const request = queue.buildRequest(task({ queue: 'lifecycle', step: 'node.stop', scheduleAt: at }));
    expect(request.parent).toBe('projects/demo-verax-cp/locations/southamerica-east1/queues/lifecycle');
    expect(request.task?.scheduleTime).toEqual({ seconds: at.getTime() / 1000 });
  });

  it('id repetido (ALREADY_EXISTS) não é erro: created=false; outro erro sobe', async () => {
    const api = new RecordingApi();
    const queue = new CloudTasksStepQueue(SETTINGS, () => Promise.resolve(api));
    const t = task();
    api.failWith = Object.assign(new Error('6 ALREADY_EXISTS: Requested entity already exists'), { code: 6 });
    expect(await queue.enqueue(t)).toEqual({ taskId: stepTaskId('preflight', t.runId), created: false });

    api.failWith = Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 });
    await expect(queue.enqueue(t)).rejects.toThrow('PERMISSION_DENIED');
  });

  it('o SDK só é carregado no primeiro uso, e uma carga que falhou é tentada de novo', async () => {
    let loads = 0;
    const api = new RecordingApi();
    const queue = new CloudTasksStepQueue(SETTINGS, () => {
      loads += 1;
      return loads === 1 ? Promise.reject(new Error('sem credenciais')) : Promise.resolve(api);
    });
    expect(loads).toBe(0);
    await expect(queue.enqueue(task())).rejects.toThrow('sem credenciais');
    await queue.enqueue(task());
    await queue.enqueue(task());
    expect(loads).toBe(2);
    expect(api.requests).toHaveLength(2);
  });

  it('recusa passo, fila ou ids fora do formato antes de chamar o Cloud Tasks', async () => {
    const api = new RecordingApi();
    const queue = new CloudTasksStepQueue(SETTINGS, () => Promise.resolve(api));
    for (const bad of [
      task({ step: '../tick' }),
      task({ step: 'Preflight' }),
      task({ step: 'a..b' }),
      task({ step: 'preflight?x=1' }),
      task({ tenantId: 'nao-e-ulid' }),
      task({ runId: 'x/y' }),
      task({ queue: 'outra' as 'provisioning' }),
    ]) {
      await expect(queue.enqueue(bad)).rejects.toBeInstanceOf(TypeError);
    }
    expect(api.requests).toHaveLength(0);
    expect(
      ['preflight', 'cloudflare.tunnel', 'secrets.tunnel_token', 'node.wait_ready'].every(isStepName),
    ).toBe(true);
  });

  it('dublê em memória: guarda a task, recusa o id repetido como o Cloud Tasks e falha uma vez quando pedido', async () => {
    const queue = new MemoryStepQueue();
    const t = task();
    expect(await queue.enqueue(t)).toEqual({ taskId: `preflight-${t.runId}`, created: true });
    expect(await queue.enqueue(t)).toEqual({ taskId: `preflight-${t.runId}`, created: false });
    queue.failNext(new Error('fora do ar'));
    await expect(queue.enqueue(task())).rejects.toThrow('fora do ar');
    expect(queue.inQueue('provisioning')).toHaveLength(1);
  });

  it('configuração: o grupo inteiro, ou a fila que recusa tudo citando só os nomes', async () => {
    const ready = resolveStepQueueSettings({
      TASKS_PROJECT_ID: SETTINGS.projectId,
      TASKS_LOCATION: SETTINGS.location,
      TASKS_QUEUE_PROVISIONING: 'provisioning',
      TASKS_QUEUE_LIFECYCLE: 'lifecycle',
      WORKER_URL: SETTINGS.workerUrl,
      WORKER_SA_EMAIL: SETTINGS.serviceAccountEmail,
    } as Parameters<typeof resolveStepQueueSettings>[0]);
    expect(ready).toEqual({ ready: true, settings: SETTINGS });

    const missing = resolveStepQueueSettings({
      TASKS_LOCATION: SETTINGS.location,
    } as Parameters<typeof resolveStepQueueSettings>[0]);
    expect(missing).toEqual({
      ready: false,
      missing: [
        'TASKS_PROJECT_ID',
        'TASKS_QUEUE_PROVISIONING',
        'TASKS_QUEUE_LIFECYCLE',
        'WORKER_URL',
        'WORKER_SA_EMAIL',
      ],
    });
    const unconfigured = new UnconfiguredStepQueue(['TASKS_PROJECT_ID']);
    await expect(unconfigured.enqueue(task())).rejects.toBeInstanceOf(StepQueueUnavailableError);
  });
});
