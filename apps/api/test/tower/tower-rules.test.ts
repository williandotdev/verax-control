import { describe, expect, it } from 'vitest';
import {
  type AccountActivity,
  coverage,
  pendingDecisions,
  trafficLight,
} from '../../src/tower/tower-rules.js';

const none = { critical: 0, high: 0, medium: 0, low: 0 };

describe('semáforo da Torre (T5.10, pendência 9)', () => {
  it('vermelho com incidente crítico aberto, qualquer que seja o resto', () => {
    expect(trafficLight({ openIncidents: { ...none, critical: 1 }, postureScore: 95 })).toEqual({
      light: 'red',
      reasons: ['critical_incident'],
    });
    expect(trafficLight({ openIncidents: { ...none, critical: 2, high: 3 }, postureScore: 40 })).toEqual({
      light: 'red',
      reasons: ['critical_incident', 'high_incident', 'low_posture'],
    });
  });

  it('amarelo com incidente alto aberto ou postura abaixo de 70', () => {
    expect(trafficLight({ openIncidents: { ...none, high: 1 }, postureScore: 90 })).toEqual({
      light: 'yellow',
      reasons: ['high_incident'],
    });
    expect(trafficLight({ openIncidents: none, postureScore: 69 })).toEqual({
      light: 'yellow',
      reasons: ['low_posture'],
    });
  });

  it('verde nos demais casos: médios e baixos não mudam a cor, 70 já é verde, sem nota não pesa', () => {
    expect(trafficLight({ openIncidents: { ...none, medium: 5, low: 9 }, postureScore: 70 })).toEqual({
      light: 'green',
      reasons: [],
    });
    expect(trafficLight({ openIncidents: none, postureScore: null })).toEqual({
      light: 'green',
      reasons: [],
    });
  });

  it('o corte de postura vem da configuração', () => {
    const thresholds = { postureWarning: 80, silentAfterHours: 24 };
    expect(trafficLight({ openIncidents: none, postureScore: 75 }, thresholds).light).toBe('yellow');
  });
});

describe('cobertura da Torre (T5.10 e fase 2)', () => {
  const now = new Date('2026-11-02T12:00:00.000Z');
  const account = (accountId: string, activity: Partial<AccountActivity> = {}): AccountActivity => ({
    accountId,
    connection: 'waiting',
    lastCollectedAt: null,
    lastEventAt: null,
    ...activity,
  });

  it('contas conectadas pela última coleta, a coleta e o evento mais recentes e as contas silenciosas', () => {
    expect(
      coverage(
        [
          account('444455556666', {
            connection: 'connected',
            lastCollectedAt: '2026-11-02T11:59:30.000Z',
            lastEventAt: '2026-11-02T11:59:00.000Z',
          }),
          account('111122223333', {
            connection: 'error',
            lastCollectedAt: '2026-11-01T11:00:00.000Z',
            lastEventAt: '2026-11-01T10:00:00.000Z',
          }),
          account('222233334444'),
        ],
        now,
      ),
    ).toEqual({
      connectedAccounts: 1,
      lastCollectedAt: '2026-11-02T11:59:30.000Z',
      lastEventAt: '2026-11-02T11:59:00.000Z',
      silentAccounts: ['111122223333', '222233334444'],
    });
  });

  it('conta lida sem erro e sem nenhum evento não fica silenciosa', () => {
    const quiet = account('333344445555', {
      connection: 'connected',
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
    });
    expect(coverage([quiet], now)).toEqual({
      connectedAccounts: 1,
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
      lastEventAt: null,
      silentAccounts: [],
    });
  });

  it('a coleta antiga com erro deixa a conta silenciosa; o evento recebido também conta como sinal de vida', () => {
    const stalled = account('111122223333', {
      connection: 'error',
      lastCollectedAt: '2026-11-01T09:00:00.000Z',
    });
    expect(coverage([stalled], now).silentAccounts).toEqual(['111122223333']);
    // Conta lida pelo Wazuh: não há coleta por conta, só o evento que chegou.
    const wazuh = account('222233334444', { lastEventAt: '2026-11-02T10:00:00.000Z' });
    expect(coverage([wazuh], now)).toMatchObject({ connectedAccounts: 0, silentAccounts: [] });
  });

  it('sem contas: nada conectado, nenhuma coleta e nenhum evento', () => {
    expect(coverage([], now)).toEqual({
      connectedAccounts: 0,
      lastCollectedAt: null,
      lastEventAt: null,
      silentAccounts: [],
    });
  });

  it('o limite de silêncio vem da configuração', () => {
    const accounts = [
      account('111122223333', { connection: 'connected', lastCollectedAt: '2026-11-02T09:00:00.000Z' }),
    ];
    expect(coverage(accounts, now).silentAccounts).toEqual([]);
    expect(coverage(accounts, now, { postureWarning: 70, silentAfterHours: 2 }).silentAccounts).toEqual([
      '111122223333',
    ]);
  });
});

describe('decisões pendentes da Torre (T5.10)', () => {
  it('só as que existem, em ordem de prioridade; alertas sem dono só para admin_verax', () => {
    const counts = { unassignedIncidents: 2, untriagedFindings: 0, unownedAlerts: 5 };
    expect(pendingDecisions(counts, { includeUnowned: false })).toEqual([
      { kind: 'unassigned_incident', count: 2 },
    ]);
    expect(pendingDecisions(counts, { includeUnowned: true })).toEqual([
      { kind: 'unassigned_incident', count: 2 },
      { kind: 'unowned_alert', count: 5 },
    ]);
  });
});
