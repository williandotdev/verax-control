import { describe, expect, it } from 'vitest';
import { ControlPlaneNodeKey } from '../common/config/control-plane-sync.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { fixedTenantPlans } from '../plan/tenant-plan.js';
import { SOURCE_RETRY_MAX_MS, sourceRetryDelayMs } from './apply-source.js';
import {
  CONTROL_PLANE_SYNC_BUDGET_MS,
  CONTROL_PLANE_SYNC_TASK,
  CONTROL_PLANE_SYNC_TICK_MS,
  FAILURE_RETRY_MAX_MS,
  failureRetryDelayMs,
  vaultKeyOf,
} from './control-plane-sync.js';
import { controlPlaneSyncTask } from './control-plane-sync-task.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const deps = { prisma: {} as PrismaService, plans: fixedTenantPlans(null), logger: silent };
const base = {
  NODE_PLATFORM: 'gcp' as const,
  credentialsKeyring: null,
  NODE_EGRESS_IPS: undefined,
  NODE_SA_UNIQUE_ID: '123456789012345678901',
  AWS_WEB_IDENTITY_AUDIENCE: undefined,
};
const sync = {
  origin: 'https://conta.exemplo.com.br',
  url: 'https://conta.exemplo.com.br/v1/node-sync',
  commit: 'c'.repeat(40),
};

describe('tarefa control-plane-sync no agendador do worker', () => {
  it('desligada (sem CONTROL_PLANE_SYNC), não entra no agendador', async () => {
    expect(await controlPlaneSyncTask({ ...base, controlPlaneSync: null }, deps)).toBeNull();
  });

  it('ligada: o nome, o tique de 15 s e o orçamento de 60 s, nas duas plataformas', async () => {
    for (const config of [
      { ...base, controlPlaneSync: { ...sync, credential: { kind: 'gcp_identity' as const } } },
      {
        ...base,
        NODE_PLATFORM: 'vm' as const,
        NODE_SA_UNIQUE_ID: undefined,
        controlPlaneSync: {
          ...sync,
          credential: { kind: 'node_key' as const, key: new ControlPlaneNodeKey('k'.repeat(43)) },
        },
      },
    ]) {
      const task = await controlPlaneSyncTask(config, { ...deps, idToken: () => Promise.resolve('x.y.z') });
      expect(task).toMatchObject({
        name: CONTROL_PLANE_SYNC_TASK,
        intervalMs: CONTROL_PLANE_SYNC_TICK_MS,
        budgetMs: CONTROL_PLANE_SYNC_BUDGET_MS,
      });
      expect(CONTROL_PLANE_SYNC_TICK_MS).toBeLessThan(CONTROL_PLANE_SYNC_BUDGET_MS);
    }
  });

  it('esperas: 1, 2, 4... minutos, até 30', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(failureRetryDelayMs)).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      960_000,
      1_800_000,
      1_800_000,
      FAILURE_RETRY_MAX_MS,
    ]);
    expect([1, 2, 3, 10].map(sourceRetryDelayMs)).toEqual([60_000, 120_000, 240_000, SOURCE_RETRY_MAX_MS]);
  });

  it('sem o cofre, o nó informa vaultKey null', () => {
    expect(vaultKeyOf(null)).toBeNull();
  });
});
