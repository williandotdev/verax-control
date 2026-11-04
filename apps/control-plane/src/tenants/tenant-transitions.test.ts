import { describe, expect, it } from 'vitest';
import { canTransition, TENANT_TRANSITIONS } from './tenant-transitions.js';
import { TENANT_STATES, type TenantState } from './tenant.schema.js';

describe('tabela de transições (plano §4b e §4d)', () => {
  it('cobre todos os estados, nunca repete o estado atual e só aponta para estados conhecidos', () => {
    expect(Object.keys(TENANT_TRANSITIONS).sort()).toEqual([...TENANT_STATES].sort());
    for (const from of TENANT_STATES) {
      expect(TENANT_TRANSITIONS[from]).not.toContain(from);
      for (const to of TENANT_TRANSITIONS[from]) expect(TENANT_STATES).toContain(to);
    }
  });

  it.each<[TenantState, TenantState]>([
    ['pending', 'provisioning'],
    ['pending', 'canceled'],
    ['provisioning', 'waiting_customer_connection'],
    ['provisioning', 'provisioning_failed'],
    ['provisioning_failed', 'provisioning'],
    ['waiting_customer_connection', 'active'],
    ['active', 'past_due'],
    ['past_due', 'suspended'],
    ['past_due', 'active'],
    ['suspended', 'active'],
    ['suspended', 'canceled'],
    ['canceled', 'deleted'],
  ])('permite %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[TenantState, TenantState]>([
    ['pending', 'active'],
    ['pending', 'deleted'],
    ['active', 'provisioning'],
    ['active', 'deleted'],
    ['canceled', 'active'],
    ['deleted', 'canceled'],
    ['deleted', 'deleted'],
  ])('recusa %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('deleted é terminal e só se chega a ele por canceled (exclusão em dois tempos)', () => {
    expect(TENANT_TRANSITIONS.deleted).toEqual([]);
    const sources = TENANT_STATES.filter((from) => canTransition(from, 'deleted'));
    expect(sources).toEqual(['canceled']);
  });
});
