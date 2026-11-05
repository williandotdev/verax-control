import { describe, expect, it } from 'vitest';
import { awsStallDedupeKey, awsStallNotice } from '../notifications/ingestion-notices.js';
import { chargeable, counterDelta, meterOwner } from './wazuh-usage.js';

const started = new Date('2026-11-09T10:00:00.000Z');
const base = (bytes: number, events: number, startedAt = started) => ({
  startedAt,
  bytesReceived: BigInt(bytes),
  awsEvents: BigInt(events),
});
const reading = (bytes: number, events: number, startedAt = started) => ({
  startedAt,
  bytesReceived: bytes,
  awsEvents: events,
});

describe('diferença dos contadores do analysisd (PR-V6)', () => {
  it('na mesma partida, soma o que os contadores andaram', () => {
    expect(counterDelta(base(1_000, 10), reading(4_500, 17))).toEqual({
      bytes: 3_500,
      events: 7,
      first: false,
      ambiguous: false,
      restarted: false,
    });
    expect(counterDelta(base(1_000, 10), reading(1_000, 10))).toEqual({
      bytes: 0,
      events: 0,
      first: false,
      ambiguous: false,
      restarted: false,
    });
  });

  it('outra partida do analysisd (reinício): soma o valor inteiro, mesmo maior que a base', () => {
    const later = new Date('2026-11-09T11:00:00.000Z');
    expect(counterDelta(base(1_000, 10), reading(300, 2, later))).toEqual({
      bytes: 300,
      events: 2,
      first: false,
      ambiguous: false,
      restarted: true,
    });
    expect(counterDelta(base(1_000, 10), reading(5_000, 40, later))).toMatchObject({
      bytes: 5_000,
      events: 40,
      restarted: true,
    });
  });

  it('um contador que caiu na mesma partida também é reinício: os dois valem inteiros', () => {
    expect(counterDelta(base(1_000, 10), reading(200, 12))).toEqual({
      bytes: 200,
      events: 12,
      first: false,
      ambiguous: false,
      restarted: true,
    });
    expect(counterDelta(base(1_000, 10), reading(1_500, 3))).toMatchObject({ bytes: 1_500, events: 3 });
  });

  it('sem base, a leitura é só a base: nada é medido (a dúvida fica a favor do cliente)', () => {
    expect(counterDelta(null, reading(9_999, 99))).toEqual({
      bytes: 0,
      events: 0,
      first: true,
      ambiguous: false,
      restarted: false,
    });
    expect(chargeable(counterDelta(null, reading(9_999, 99)))).toBe(false);
  });

  it('base ambígua (gravada ou marcada com mais de um cliente): a diferença não vale para o medidor', () => {
    const blocked = { ...base(1_000, 10), meterBlocked: 'multiple_tenants' };
    const delta = counterDelta(blocked, reading(2_100, 12));
    expect(delta).toEqual({ bytes: 1_100, events: 2, first: false, ambiguous: true, restarted: false });
    expect(chargeable(delta)).toBe(false);
    expect(chargeable(counterDelta({ ...base(1_000, 10), meterBlocked: null }, reading(2_100, 12)))).toBe(
      true,
    );
  });

  it('volume acima de 32 bits', () => {
    expect(counterDelta(base(5_000_000_000, 0), reading(9_000_000_000, 0)).bytes).toBe(4_000_000_000);
  });
});

describe('de quem é o volume do analysisd: um cliente por nó (PR-V6)', () => {
  const a = '018f2c1e-0000-7000-8000-00000000000a';
  const b = '018f2c1e-0000-7000-8000-00000000000b';

  it('sem conta AWS ativa, ninguém (nem o cliente dos agentes)', () => {
    expect(meterOwner([], null)).toEqual({ kind: 'none' });
    expect(meterOwner([], a)).toEqual({ kind: 'none' });
  });

  it('um cliente só, com ou sem conta conectada; os agentes do mesmo cliente não mudam nada', () => {
    expect(
      meterOwner(
        [
          { tenantId: a, connection: 'error' },
          { tenantId: a, connection: 'connected' },
        ],
        null,
      ),
    ).toEqual({ kind: 'single', tenantId: a, awsConnected: true });
    expect(meterOwner([{ tenantId: a, connection: 'waiting' }], a)).toEqual({
      kind: 'single',
      tenantId: a,
      awsConnected: false,
    });
  });

  it('dois clientes com conta AWS, ou os agentes de outro cliente: ambíguo', () => {
    expect(
      meterOwner(
        [
          { tenantId: b, connection: 'connected' },
          { tenantId: a, connection: 'connected' },
        ],
        null,
      ),
    ).toEqual({ kind: 'multiple', tenantIds: [a, b] });
    expect(meterOwner([{ tenantId: a, connection: 'connected' }], b)).toEqual({
      kind: 'multiple',
      tenantIds: [a, b],
    });
  });
});

describe('aviso de coleta da AWS parada (PR-V6)', () => {
  it('uma chave por parada, pelo começo dela, no tipo do PR-16', () => {
    const since = new Date('2026-11-09T08:15:00.000Z');
    expect(awsStallDedupeKey(since)).toBe('aws-stalled:2026-11-09T08:15:00.000Z');
    expect(awsStallNotice('t-1', since)).toEqual({
      tenantId: 't-1',
      kind: 'aws_ingestion_stalled',
      dedupeKey: 'aws-stalled:2026-11-09T08:15:00.000Z',
    });
    expect(awsStallDedupeKey(new Date('2026-11-09T12:00:00.000Z'))).not.toBe(awsStallDedupeKey(since));
    // Cabe na coluna (VARCHAR(128)).
    expect(awsStallDedupeKey(since).length).toBeLessThanOrEqual(128);
  });
});
