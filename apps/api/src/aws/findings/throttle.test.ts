import { describe, expect, it, vi } from 'vitest';
import {
  abortableSleep,
  isThrottling,
  RateGate,
  type Sleep,
  throttleDelay,
  withThrottleRetry,
} from './throttle.js';

function awsError(name: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error('mensagem da AWS, que nunca é usada');
  error.name = name;
  return Object.assign(error, extra);
}

const signal = () => new AbortController().signal;
const noSleep: Sleep = () => Promise.resolve();

describe('limite de requisições da AWS', () => {
  it('reconhece o limite pelo nome do erro de cada serviço e pelo HTTP 429', () => {
    for (const name of [
      'ThrottlingException',
      'Throttling',
      'TooManyRequestsException',
      'RequestLimitExceeded',
      'LimitExceededException',
    ]) {
      expect(isThrottling(awsError(name)), name).toBe(true);
    }
    expect(isThrottling(awsError('Erro', { $metadata: { httpStatusCode: 429 } }))).toBe(true);
    expect(isThrottling(awsError('AccessDeniedException'))).toBe(false);
    expect(isThrottling(awsError('InternalServerException', { $metadata: { httpStatusCode: 500 } }))).toBe(
      false,
    );
    expect(isThrottling(null)).toBe(false);
  });

  it('o recuo dobra a cada tentativa, com metade sorteada, até o teto', () => {
    const options = { baseMs: 1_000, maxMs: 8_000 };
    // Sorteio no mínimo: metade do recuo; no máximo: o recuo inteiro.
    expect(throttleDelay(1, { ...options, random: () => 0 })).toBe(500);
    expect(throttleDelay(1, { ...options, random: () => 1 })).toBe(1_000);
    expect(throttleDelay(2, { ...options, random: () => 0.5 })).toBe(1_500);
    expect(throttleDelay(3, { ...options, random: () => 1 })).toBe(4_000);
    expect(throttleDelay(10, { ...options, random: () => 1 })).toBe(8_000);
    // O tempo que a própria AWS pede vale, sem passar do teto.
    expect(throttleDelay(1, { ...options, random: () => 0 }, 3)).toBe(3_000);
    expect(throttleDelay(1, { ...options, random: () => 0 }, 60)).toBe(8_000);
  });

  it('a chamada limitada é repetida depois do recuo, e o resultado é o da que deu certo', async () => {
    const sleeps: number[] = [];
    const sleep: Sleep = (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(awsError('TooManyRequestsException'))
      .mockRejectedValueOnce(awsError('ThrottlingException'))
      .mockResolvedValue('página');
    const onRetry = vi.fn();
    await expect(
      withThrottleRetry(call, {
        attempts: 3,
        baseMs: 1_000,
        maxMs: 8_000,
        random: () => 0.5,
        sleep,
        signal: signal(),
        onRetry,
      }),
    ).resolves.toBe('página');
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([750, 1_500]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('o limite que persiste sobe como veio, depois da última tentativa', async () => {
    const error = awsError('ThrottlingException');
    const call = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    await expect(
      withThrottleRetry(call, {
        attempts: 3,
        baseMs: 10,
        maxMs: 20,
        random: () => 0,
        sleep: noSleep,
        signal: signal(),
      }),
    ).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('outro erro sobe na hora, sem nova tentativa', async () => {
    const error = awsError('AccessDeniedException');
    const call = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    const sleep = vi.fn<Sleep>(() => Promise.resolve());
    await expect(
      withThrottleRetry(call, {
        attempts: 3,
        baseMs: 10,
        maxMs: 20,
        random: () => 0,
        sleep,
        signal: signal(),
      }),
    ).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('com o sinal abortado, nem a chamada sai nem o recuo espera', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('o worker está parando', 'AbortError'));
    const call = vi.fn<() => Promise<string>>().mockResolvedValue('página');
    await expect(
      withThrottleRetry(call, {
        attempts: 3,
        baseMs: 10,
        maxMs: 20,
        random: () => 0,
        sleep: noSleep,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
    await expect(abortableSleep(10_000, controller.signal)).rejects.toThrow();
    // A espera em curso termina quando o sinal é abortado.
    const later = new AbortController();
    const waiting = abortableSleep(10_000, later.signal);
    later.abort(new DOMException('parando', 'AbortError'));
    await expect(waiting).rejects.toThrow();
    await expect(abortableSleep(1, signal())).resolves.toBeUndefined();
  });

  it('as chamadas da mesma chave saem espaçadas; as de outra chave não esperam', async () => {
    let clock = 1_000;
    const sleeps: number[] = [];
    const gate = new RateGate(
      350,
      (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      () => clock,
    );
    await gate.wait('conta|sa-east-1', signal());
    await gate.wait('conta|sa-east-1', signal());
    await gate.wait('conta|sa-east-1', signal());
    // A primeira sai na hora; cada uma das outras, 350 ms depois da anterior (3 por segundo fica de fora).
    expect(sleeps).toEqual([350, 350]);
    await gate.wait('conta|us-east-1', signal());
    await gate.wait('outra|sa-east-1', signal());
    expect(sleeps).toEqual([350, 350]);
    // Passado o intervalo, a chamada seguinte não espera.
    clock += 1_000;
    await gate.wait('conta|sa-east-1', signal());
    expect(sleeps).toEqual([350, 350]);
  });
});
