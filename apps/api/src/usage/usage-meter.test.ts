import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { base64Bytes, UsageMeter, usageMonth, utf8Bytes } from './usage-meter.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('mês do uso (calendário de Brasília)', () => {
  it('vira às 03:00 UTC do dia 1º, não à meia-noite UTC', () => {
    expect(usageMonth(new Date('2026-12-01T02:59:59.999Z'))).toEqual(day('2026-11-01'));
    expect(usageMonth(new Date('2026-12-01T03:00:00.000Z'))).toEqual(day('2026-12-01'));
    // Meia-noite UTC do dia 1º ainda é 21:00 do último dia do mês anterior em Brasília.
    expect(usageMonth(new Date('2026-12-01T00:00:00.000Z'))).toEqual(day('2026-11-01'));
  });

  it('a virada do ano segue a mesma regra', () => {
    expect(usageMonth(new Date('2027-01-01T02:59:59.999Z'))).toEqual(day('2026-12-01'));
    expect(usageMonth(new Date('2027-01-01T03:00:00.000Z'))).toEqual(day('2027-01-01'));
  });

  it('o resto do mês cai no próprio mês, com fevereiro curto e bissexto', () => {
    expect(usageMonth(new Date('2026-11-30T23:59:59.999Z'))).toEqual(day('2026-11-01'));
    expect(usageMonth(new Date('2027-03-01T02:00:00.000Z'))).toEqual(day('2027-02-01'));
    expect(usageMonth(new Date('2028-02-29T12:00:00.000Z'))).toEqual(day('2028-02-01'));
  });
});

describe('bytes de um registro', () => {
  it('UTF-8: acento e símbolo contam os bytes, não os caracteres', () => {
    expect(utf8Bytes('{"a":1}')).toBe(7);
    expect(utf8Bytes('ação')).toBe(6);
    expect(utf8Bytes('€')).toBe(3);
  });

  it('base64: o tamanho do registro já decodificado', () => {
    const record = JSON.stringify({ protoPayload: { methodName: 'SetIamPolicy' }, texto: 'auditoria ação' });
    expect(base64Bytes(Buffer.from(record).toString('base64'))).toBe(utf8Bytes(record));
    expect(base64Bytes(undefined)).toBe(0);
    expect(base64Bytes('')).toBe(0);
  });
});

describe('UsageMeter (somente memória)', () => {
  it('recusa valor negativo, fracionado ou acima do inteiro seguro', () => {
    const meter = new UsageMeter();
    for (const [bytes, events] of [
      [-1, 1],
      [1.5, 1],
      [10, -2],
      [Number.MAX_SAFE_INTEGER + 1, 1],
      [Number.NaN, 1],
    ]) {
      expect(() => meter.add('cliente', 'gcp', bytes ?? 0, events ?? 0)).toThrow(RangeError);
    }
    expect(meter.isEmpty).toBe(true);
  });

  it('leitura vazia (zero bytes e zero eventos) não cria nada para gravar', () => {
    const meter = new UsageMeter();
    meter.add('cliente', 'gcp', 0, 0);
    expect(meter.isEmpty).toBe(true);
    meter.add('cliente', 'gcp', 0, 1);
    expect(meter.isEmpty).toBe(false);
  });
});

describe('UsageMeter.flush', () => {
  /** Banco falso: registra cada escrita e pode falhar numa delas. */
  function fakePrisma(failOn?: string) {
    const writes: { scope: string; args: { create: Record<string, unknown> } }[] = [];
    const prisma = {
      forTenant: (scope: string) => ({
        ingestUsage: {
          upsert: (args: { create: Record<string, unknown> }) => {
            if (scope === failOn) return Promise.reject(new Error('banco indisponível'));
            writes.push({ scope, args });
            return Promise.resolve({});
          },
        },
      }),
    } as unknown as PrismaService;
    return { prisma, writes };
  }

  it('uma escrita por cliente, mês e fonte, cada uma no escopo do próprio cliente', async () => {
    const { prisma, writes } = fakePrisma();
    const meter = new UsageMeter();
    const at = new Date('2026-11-10T12:00:00.000Z');
    for (let index = 0; index < 100; index += 1) meter.add('cliente-a', 'gcp', 10, 1, at);
    meter.add('cliente-a', 'aws', 7, 2, at);
    meter.add('cliente-b', 'gcp', 5, 1, at);
    await meter.flush(prisma);
    expect(writes.map(({ scope, args }) => [scope, args.create])).toEqual([
      [
        'cliente-a',
        { tenantId: 'cliente-a', month: day('2026-11-01'), source: 'gcp', bytes: 1000n, events: 100n },
      ],
      [
        'cliente-a',
        { tenantId: 'cliente-a', month: day('2026-11-01'), source: 'aws', bytes: 7n, events: 2n },
      ],
      [
        'cliente-b',
        { tenantId: 'cliente-b', month: day('2026-11-01'), source: 'gcp', bytes: 5n, events: 1n },
      ],
    ]);
    expect(meter.isEmpty).toBe(true);
  });

  it('falha no meio: o que foi gravado sai do medidor; o resto fica para a próxima tentativa', async () => {
    const meter = new UsageMeter();
    meter.add('cliente-a', 'gcp', 10, 1);
    meter.add('cliente-b', 'gcp', 20, 1);
    const failing = fakePrisma('cliente-b');
    await expect(meter.flush(failing.prisma)).rejects.toThrow('banco indisponível');
    expect(failing.writes.map((write) => write.scope)).toEqual(['cliente-a']);

    const retry = fakePrisma();
    await meter.flush(retry.prisma);
    expect(retry.writes.map((write) => write.scope)).toEqual(['cliente-b']);
    expect(meter.isEmpty).toBe(true);
  });
});
