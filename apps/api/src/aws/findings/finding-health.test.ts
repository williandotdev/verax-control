import { describe, expect, it } from 'vitest';
import {
  addVolume,
  apiSourceLagSeconds,
  AWS_FINDINGS_ERROR_AFTER,
  decodeCursorState,
  encodeCursorState,
  type HourVolume,
  lagSince,
  sourceChange,
  type SourceHealth,
  volumeLast24h,
} from './finding-health.js';

const NOW = new Date('2026-11-23T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function health(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    state: 'authorized',
    stateCode: 'awaiting_collector',
    permission: 'granted',
    permissionDetail: null,
    missingSince: null,
    lastSyncAt: null,
    lastEventAt: null,
    ...overrides,
  };
}

const synced = (newestEventAt: Date | null = null, ingested = false) =>
  ({ type: 'synced', newestEventAt, ingested, volume: { events: 0, bytes: 0 } }) as const;

describe('estado e saúde de uma fonte de achados depois de uma leitura', () => {
  it('a primeira leitura sem erro tira a fonte de "aguardando o coletor", mesmo sem achado nenhum', () => {
    const change = sourceChange(health(), synced(), NOW);
    expect(change.data).toMatchObject({
      state: 'collecting',
      stateCode: 'no_findings_yet',
      stateSince: NOW,
      lastSyncAt: NOW,
      lagSeconds: 0,
      lastEventAt: null,
      eventsLast24h: 0,
      bytesLast24h: 0n,
    });
    expect(change.data).not.toHaveProperty('lastIngestedAt');
    expect(change.transition).toEqual({
      from: { state: 'authorized', stateCode: 'awaiting_collector' },
      to: { state: 'collecting', stateCode: 'no_findings_yet' },
    });
  });

  it('com o primeiro achado, o código some; o estado é o mesmo e nada vai para a trilha', () => {
    const at = ago(5 * 60_000);
    const change = sourceChange(
      health({ state: 'collecting', stateCode: 'no_findings_yet', lastSyncAt: ago(HOUR) }),
      { type: 'synced', newestEventAt: at, ingested: true, volume: { events: 2, bytes: 4096 } },
      NOW,
    );
    expect(change.data).toMatchObject({
      state: 'collecting',
      stateCode: null,
      lastEventAt: at,
      lastIngestedAt: NOW,
      eventsLast24h: 2,
      bytesLast24h: 4096n,
    });
    expect(change.data).not.toHaveProperty('stateSince');
    expect(change.transition).toBeNull();
  });

  it('o evento mais recente só anda para a frente, e a fonte que já teve achado não volta a "sem achado"', () => {
    const known = ago(HOUR);
    const older = sourceChange(
      health({ state: 'collecting', stateCode: null, lastEventAt: known }),
      synced(ago(2 * HOUR)),
      NOW,
    );
    expect(older.data).toMatchObject({ lastEventAt: known, stateCode: null });
    const none = sourceChange(
      health({ state: 'collecting', stateCode: null, lastEventAt: known }),
      synced(),
      NOW,
    );
    expect(none.data).toMatchObject({ lastEventAt: known, stateCode: null });
  });

  it('a leitura que deu certo é a prova da permissão e tira a fonte do erro', () => {
    const change = sourceChange(
      health({
        state: 'permission_error',
        stateCode: 'guardduty:ListFindings',
        permission: 'missing',
        permissionDetail: 'guardduty:ListFindings',
        lastEventAt: ago(HOUR),
      }),
      synced(),
      NOW,
    );
    expect(change.data).toMatchObject({
      state: 'collecting',
      stateCode: null,
      permission: 'granted',
      permissionDetail: null,
      permissionCheckedAt: NOW,
    });
    expect(change.transition?.to).toEqual({ state: 'collecting', stateCode: null });
  });

  it('a permissão negada vira permission_error, com a ação do IAM que faltou', () => {
    const change = sourceChange(
      health({ state: 'collecting', stateCode: null, lastSyncAt: ago(10 * 60_000) }),
      { type: 'permission', detail: 'securityhub:GetFindings' },
      NOW,
    );
    expect(change.data).toMatchObject({
      state: 'permission_error',
      stateCode: 'securityhub:GetFindings',
      stateSince: NOW,
      permission: 'missing',
      permissionDetail: 'securityhub:GetFindings',
      permissionCheckedAt: NOW,
      lagSeconds: 600,
    });
    expect(change.transition).toEqual({
      from: { state: 'collecting', stateCode: null },
      to: { state: 'permission_error', stateCode: 'securityhub:GetFindings' },
    });
    // De novo a mesma recusa: nada muda no estado nem na permissão, e nada vai para a trilha.
    const again = sourceChange(
      health({
        state: 'permission_error',
        stateCode: 'securityhub:GetFindings',
        permission: 'missing',
        permissionDetail: 'securityhub:GetFindings',
      }),
      { type: 'permission', detail: 'securityhub:GetFindings' },
      NOW,
    );
    expect(again.transition).toBeNull();
    expect(again.data).not.toHaveProperty('permission');
    expect(again.data).not.toHaveProperty('stateSince');
  });

  it('o serviço desligado depois da autorização vira source_missing, com a data do sumiço', () => {
    const change = sourceChange(
      health({ state: 'collecting', stateCode: null }),
      { type: 'missing', code: 'not_enabled' },
      NOW,
    );
    expect(change.data).toEqual({
      state: 'source_missing',
      stateCode: 'not_enabled',
      stateSince: NOW,
      missingSince: NOW,
    });
    expect(change.transition?.to).toEqual({ state: 'source_missing', stateCode: 'not_enabled' });
  });

  it('a falha passageira só vira ingestion_error na terceira seguida', () => {
    const current = health({ state: 'collecting', stateCode: null, lastSyncAt: ago(15 * 60_000) });
    for (let failures = 1; failures < AWS_FINDINGS_ERROR_AFTER; failures += 1) {
      const change = sourceChange(current, { type: 'failed', code: 'throttled', failures }, NOW);
      expect(change.data).toEqual({ lagSeconds: 900 });
      expect(change.transition).toBeNull();
    }
    const third = sourceChange(
      current,
      { type: 'failed', code: 'throttled', failures: AWS_FINDINGS_ERROR_AFTER },
      NOW,
    );
    expect(third.data).toMatchObject({ state: 'ingestion_error', stateCode: 'throttled', stateSince: NOW });
    expect(third.transition).toEqual({
      from: { state: 'collecting', stateCode: null },
      to: { state: 'ingestion_error', stateCode: 'throttled' },
    });
    // Outra falha, com outro código: o código acompanha, o estado é o mesmo, e nada vai para a trilha.
    const other = sourceChange(
      health({ state: 'ingestion_error', stateCode: 'throttled' }),
      { type: 'failed', code: 'TimeoutError', failures: 4 },
      NOW,
    );
    expect(other.data).toMatchObject({ state: 'ingestion_error', stateCode: 'TimeoutError' });
    expect(other.data).not.toHaveProperty('stateSince');
    expect(other.transition).toBeNull();
  });

  it('o atraso é o tempo desde a última leitura sem erro; só a fonte lida por API e na coleta o calcula ao vivo', () => {
    expect(lagSince(null, NOW)).toBeNull();
    expect(lagSince(ago(90_500), NOW)).toBe(90);
    // O relógio de outra réplica um pouco adiantado não dá atraso negativo.
    expect(lagSince(new Date(NOW.getTime() + 5_000), NOW)).toBe(0);
    const row = { method: 'api', state: 'collecting', lastSyncAt: ago(3 * HOUR) };
    expect(apiSourceLagSeconds(row, NOW)).toBe(3 * 3600);
    expect(apiSourceLagSeconds({ ...row, state: 'ingestion_error' }, NOW)).toBe(3 * 3600);
    expect(apiSourceLagSeconds({ ...row, lastSyncAt: null }, NOW)).toBeNull();
    // Fora da coleta (revogada, sumida) e nas fontes do Wazuh, vale o que está gravado.
    expect(apiSourceLagSeconds({ ...row, state: 'revoked' }, NOW)).toBeNull();
    expect(apiSourceLagSeconds({ ...row, state: 'source_missing' }, NOW)).toBeNull();
    expect(apiSourceLagSeconds({ ...row, method: 's3' }, NOW)).toBeNull();
  });
});

describe('o que a tarefa guarda no cursor de uma fonte', () => {
  const since = new Date('2026-11-23T11:00:00.000Z');
  const before = new Date('2026-11-23T12:00:00.000Z');

  it('a continuação e o volume vão e voltam iguais', () => {
    const hours: HourVolume[] = [
      [495_900, 3, 2048],
      [495_901, 1, 512],
    ];
    const { text, resumable } = encodeCursorState({ resume: { since, before, token: 'abc' }, hours });
    expect(resumable).toBe(true);
    expect(decodeCursorState(text)).toEqual({ resume: { since, before, token: 'abc' }, hours });
    // Sem continuação e sem volume, o cursor fica vazio.
    expect(encodeCursorState({ resume: null, hours: [] })).toEqual({ text: null, resumable: true });
    expect(decodeCursorState(encodeCursorState({ resume: null, hours }).text)).toEqual({
      resume: null,
      hours,
    });
  });

  it('a continuação que não cabe na coluna fica de fora, e o volume fica', () => {
    const hours: HourVolume[] = [[495_900, 3, 2048]];
    const { text, resumable } = encodeCursorState({
      resume: { since, before, token: 'x'.repeat(3000) },
      hours,
    });
    expect(resumable).toBe(false);
    expect(text?.length).toBeLessThanOrEqual(2048);
    expect(decodeCursorState(text)).toEqual({ resume: null, hours });
  });

  it('o que não segue o formato é o estado vazio', () => {
    const empty = { resume: null, hours: [] };
    expect(decodeCursorState(null)).toEqual(empty);
    expect(decodeCursorState('não é json')).toEqual(empty);
    expect(decodeCursorState('{"w":{"s":"ontem","b":"hoje","t":"x"}}')).toEqual(empty);
    expect(decodeCursorState('{"h":[[1,-2,3]]}')).toEqual(empty);
    expect(decodeCursorState('{"outro":1}')).toEqual(empty);
  });

  it('o volume soma na hora corrente e solta o que saiu das últimas 24 h', () => {
    const hour = Math.floor(NOW.getTime() / HOUR);
    let hours = addVolume([], NOW, 2, 1000);
    hours = addVolume(hours, NOW, 1, 500);
    expect(hours).toEqual([[hour, 3, 1500]]);
    // Sem achado novo, nada entra.
    expect(addVolume(hours, NOW, 0, 0)).toEqual(hours);
    const later = new Date(NOW.getTime() + 23 * HOUR);
    hours = addVolume(hours, later, 4, 100);
    expect(hours).toEqual([
      [hour, 3, 1500],
      [hour + 23, 4, 100],
    ]);
    expect(volumeLast24h(hours, later)).toEqual({ events: 7, bytes: 1600 });
    // Uma hora depois, a primeira saiu da janela.
    const next = new Date(later.getTime() + HOUR);
    expect(volumeLast24h(hours, next)).toEqual({ events: 4, bytes: 100 });
    expect(addVolume(hours, next, 0, 0)).toEqual([[hour + 23, 4, 100]]);
  });
});
