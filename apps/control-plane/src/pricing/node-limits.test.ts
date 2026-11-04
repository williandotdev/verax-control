import { describe, expect, it } from 'vitest';
import { NODE_LIMIT_VARIABLES, nodeLimitsEnv } from './node-limits.js';

describe('limites do nó (gancho do PR-18)', () => {
  it('vira o plano enterprise com os ajustes PLAN_* que o nó já lê, mais PLAN_MAX_AGENTS', () => {
    expect(
      nodeLimitsEnv({ maxCloudAccounts: 7, monthlyGib: 100, historyDays: 360, maxAgents: 20, maxUsers: 10 }),
    ).toEqual({
      PLAN: 'enterprise',
      PLAN_MAX_CLOUD_ACCOUNTS: '7',
      PLAN_MONTHLY_GIB: '100',
      PLAN_HISTORY_DAYS: '360',
      PLAN_MAX_USERS: '10',
      PLAN_MAX_AGENTS: '20',
    });
  });

  it('os quatro ajustes que o nó exige no enterprise são os do packages/shared (plans.ts)', () => {
    expect(Object.values(NODE_LIMIT_VARIABLES)).toEqual([
      'PLAN_MAX_CLOUD_ACCOUNTS',
      'PLAN_MONTHLY_GIB',
      'PLAN_HISTORY_DAYS',
      'PLAN_MAX_USERS',
      'PLAN_MAX_AGENTS',
    ]);
  });
});
