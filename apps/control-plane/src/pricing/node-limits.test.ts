import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NODE_AGENTS_MAX_LIMIT, NodeAgentsLimitError, nodeLimitsEnv } from './node-limits.js';

const sharedAgents = new URL('../../../../packages/shared/src/agents.ts', import.meta.url);

describe('limites do nó (gancho do PR-18)', () => {
  it('vira o plano enterprise com os ajustes PLAN_* e, com agentes, o interruptor e o teto que o nó já lê', () => {
    expect(
      nodeLimitsEnv({ maxCloudAccounts: 7, monthlyGib: 100, historyDays: 360, maxAgents: 20, maxUsers: 10 }),
    ).toEqual({
      PLAN: 'enterprise',
      PLAN_MAX_CLOUD_ACCOUNTS: '7',
      PLAN_MONTHLY_GIB: '100',
      PLAN_HISTORY_DAYS: '360',
      PLAN_MAX_USERS: '10',
      WAZUH_AGENTS: 'true',
      WAZUH_AGENTS_MAX: '20',
    });
  });

  it('sem agentes contratados, o interruptor fica desligado e sem teto (o nó recusa o teto desligado)', () => {
    expect(
      nodeLimitsEnv({ maxCloudAccounts: 2, monthlyGib: 10, historyDays: 30, maxAgents: 0, maxUsers: 10 }),
    ).toEqual({
      PLAN: 'enterprise',
      PLAN_MAX_CLOUD_ACCOUNTS: '2',
      PLAN_MONTHLY_GIB: '10',
      PLAN_HISTORY_DAYS: '30',
      PLAN_MAX_USERS: '10',
      WAZUH_AGENTS: 'false',
    });
  });

  it('acima do teto do nó, erro (a checagem de publicação recusa a tabela antes)', () => {
    const limits = { maxCloudAccounts: 2, monthlyGib: 10, historyDays: 30, maxUsers: 10 };
    expect(nodeLimitsEnv({ ...limits, maxAgents: NODE_AGENTS_MAX_LIMIT })['WAZUH_AGENTS_MAX']).toBe(
      String(NODE_AGENTS_MAX_LIMIT),
    );
    expect(() => nodeLimitsEnv({ ...limits, maxAgents: NODE_AGENTS_MAX_LIMIT + 1 })).toThrow(
      NodeAgentsLimitError,
    );
  });

  it('o teto é o mesmo do pacote compartilhado (WAZUH_AGENTS_MAX_LIMIT)', () => {
    const source = readFileSync(sharedAgents, 'utf8');
    const declared = /export const WAZUH_AGENTS_MAX_LIMIT = (\d+);/.exec(source)?.[1];
    expect(Number(declared)).toBe(NODE_AGENTS_MAX_LIMIT);
  });
});
