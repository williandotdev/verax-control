import { describe, expect, it } from 'vitest';
import {
  unownedAccountsQuerySchema,
  unownedAlertListQuerySchema,
  unownedAlertSchema,
} from './unowned-alerts.js';

describe('fila de alertas sem dono', () => {
  it('filtros estritos; o resumo das contas olha 30 dias por padrão', () => {
    expect(
      unownedAlertListQuerySchema.parse({ reason: 'unknown_account', account: '111122223333' }),
    ).toMatchObject({
      reason: 'unknown_account',
      account: '111122223333',
      page: 1,
    });
    expect(unownedAlertListQuerySchema.safeParse({ reason: 'outro' }).success).toBe(false);
    expect(unownedAccountsQuerySchema.parse({})).toEqual({ period: '30d' });
    expect(unownedAccountsQuerySchema.safeParse({ page: '1' }).success).toBe(false);
  });

  it('o alerta da fila não carrega o evento bruto', () => {
    const alert = {
      id: '018f2c1e-0000-7000-8000-0000000c0001',
      source: 'wazuh',
      reason: 'unknown_account',
      accounts: ['111122223333'],
      occurredAt: null,
      ruleId: '80202',
      ruleLevel: 12,
      title: 'Trilha desligada',
      createdAt: '2026-11-03T12:00:00.000Z',
    };
    expect(unownedAlertSchema.parse(alert)).toEqual(alert);
    expect(unownedAlertSchema.safeParse({ ...alert, fullLog: '{}' }).success).toBe(false);
  });
});
