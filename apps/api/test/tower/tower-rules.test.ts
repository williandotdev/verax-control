import { describe, expect, it } from 'vitest';
import {
  type AccountActivity,
  awsLogsStalledSince,
  coverage,
  DEFAULT_TOWER_THRESHOLDS,
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
    const thresholds = { ...DEFAULT_TOWER_THRESHOLDS, postureWarning: 80 };
    expect(trafficLight({ openIncidents: none, postureScore: 75 }, thresholds).light).toBe('yellow');
  });
});

describe('cobertura da Torre (T5.10 e fase 2)', () => {
  const now = new Date('2026-11-02T12:00:00.000Z');
  const CLOUDFLARE_ID = '0123456789abcdef0123456789abcdef';
  /** Conta AWS (lida pelo Wazuh) por padrão. */
  const account = (accountId: string, activity: Partial<AccountActivity> = {}): AccountActivity => ({
    accountId,
    provider: 'aws',
    connection: 'waiting',
    lastCollectedAt: null,
    lastEventAt: null,
    ...activity,
  });

  it('contas conectadas pelo estado, a coleta e o evento mais recentes e as contas silenciosas', () => {
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

  it('AWS lida pelo Wazuh: o evento recente é o sinal de vida, e a conta conectada pelo evento entra na contagem', () => {
    // Sem coleta por conta: o Wazuh só registra o evento, e o evento conecta a conta (`LastEvents.save`).
    const wazuh = account('222233334444', {
      connection: 'connected',
      lastEventAt: '2026-11-02T10:00:00.000Z',
    });
    expect(coverage([wazuh], now)).toMatchObject({ connectedAccounts: 1, silentAccounts: [] });
  });

  it('GCP (entregue por evento): coleta recente com evento antigo, ou sem evento nenhum, deixa a conta silenciosa', () => {
    const stale = account('vx-projeto-antigo', {
      provider: 'gcp',
      connection: 'connected',
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
      lastEventAt: '2026-11-01T09:00:00.000Z',
    });
    // Lida sem erro, mas nunca recebeu evento: a leitura vazia não prova que os logs chegam.
    const empty = account('vx-projeto-vazio', {
      provider: 'gcp',
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
    });
    expect(coverage([stale, empty], now)).toEqual({
      connectedAccounts: 1,
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
      lastEventAt: '2026-11-01T09:00:00.000Z',
      silentAccounts: ['vx-projeto-antigo', 'vx-projeto-vazio'],
    });
    // A AWS segue a mesma regra: a coleta não conta, só o evento.
    const aws = account('111122223333', { lastCollectedAt: '2026-11-02T11:58:00.000Z' });
    expect(coverage([aws], now).silentAccounts).toEqual(['111122223333']);
  });

  it('Cloudflare (coletado por API): coleta recente sem nenhum evento não fica silenciosa; coleta antiga, sim', () => {
    const quiet = account(CLOUDFLARE_ID, {
      provider: 'cloudflare',
      connection: 'connected',
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
    });
    expect(coverage([quiet], now)).toEqual({
      connectedAccounts: 1,
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
      lastEventAt: null,
      silentAccounts: [],
    });
    const stalled = account(CLOUDFLARE_ID, {
      provider: 'cloudflare',
      connection: 'error',
      lastCollectedAt: '2026-11-01T09:00:00.000Z',
    });
    expect(coverage([stalled], now).silentAccounts).toEqual([CLOUDFLARE_ID]);
    // O evento recebido também vale como sinal de vida.
    const withEvent = { ...stalled, lastEventAt: '2026-11-02T11:00:00.000Z' };
    expect(coverage([withEvent], now).silentAccounts).toEqual([]);
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
      account('111122223333', { connection: 'connected', lastEventAt: '2026-11-02T09:00:00.000Z' }),
    ];
    expect(coverage(accounts, now).silentAccounts).toEqual([]);
    expect(
      coverage(accounts, now, { ...DEFAULT_TOWER_THRESHOLDS, silentAfterHours: 2 }).silentAccounts,
    ).toEqual(['111122223333']);
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

describe('saúde da ingestão da AWS na Torre (fase 2, PR-V6)', () => {
  const now = new Date('2026-11-09T12:00:00.000Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

  it('com conta conectada, parada há mais de 2 h: desde a última vez que os eventos andaram', () => {
    expect(DEFAULT_TOWER_THRESHOLDS.awsStalledAfterHours).toBe(2);
    expect(awsLogsStalledSince({ awsConnected: true, lastProgressAt: hoursAgo(3) }, now)).toEqual(
      hoursAgo(3),
    );
    expect(
      awsLogsStalledSince({ awsConnected: true, lastProgressAt: new Date(hoursAgo(2).getTime() - 1) }, now),
    ).toEqual(new Date(hoursAgo(2).getTime() - 1));
  });

  it('até 2 h exatas, sem conta conectada ou sem observação: nada a mostrar', () => {
    expect(awsLogsStalledSince({ awsConnected: true, lastProgressAt: hoursAgo(2) }, now)).toBeNull();
    expect(awsLogsStalledSince({ awsConnected: true, lastProgressAt: hoursAgo(1) }, now)).toBeNull();
    expect(awsLogsStalledSince({ awsConnected: false, lastProgressAt: hoursAgo(5) }, now)).toBeNull();
    expect(awsLogsStalledSince({ awsConnected: true, lastProgressAt: null }, now)).toBeNull();
  });

  it('o prazo vem da configuração', () => {
    const thresholds = { ...DEFAULT_TOWER_THRESHOLDS, awsStalledAfterHours: 6 };
    expect(
      awsLogsStalledSince({ awsConnected: true, lastProgressAt: hoursAgo(3) }, now, thresholds),
    ).toBeNull();
  });
});
