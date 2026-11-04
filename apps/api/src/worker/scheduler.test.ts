import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogCapture } from '../../test/support/log-capture.js';
import { buildPinoOptions } from '../common/logger/logger.options.js';
import { Scheduler, type ScheduledTask } from './scheduler.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Promessa que o teste resolve quando quiser: a execução "lenta" só termina quando ele mandar. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(tasks: ScheduledTask[]) {
  const capture = new LogCapture();
  const scheduler = new Scheduler(tasks, pino(buildPinoOptions({ LOG_LEVEL: 'info' }), capture));
  const lines = (message: string) => capture.entries().filter((entry) => entry['msg'] === message);
  return { scheduler, capture, lines };
}

/** Tarefa que conta as execuções e guarda o sinal de cada uma. */
function task(name: string, intervalMs: number, run: () => Promise<unknown>, budgetMs = 10 * MINUTE) {
  const calls: AbortSignal[] = [];
  const definition: ScheduledTask = {
    name,
    intervalMs,
    budgetMs,
    run: (signal) => {
      calls.push(signal);
      return run();
    },
  };
  return { definition, calls };
}

describe('agendador do worker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uma tarefa lenta não atrasa a outra', async () => {
    const stuck = deferred();
    const slow = task('lenta', MINUTE, () => stuck.promise);
    const fast = task('rapida', 10 * SECOND, () => Promise.resolve({ lidos: 0 }));
    const { scheduler } = setup([slow.definition, fast.definition]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(35 * SECOND);
    // A rápida rodou em 0, 10, 20 e 30 s; a lenta segue na primeira execução.
    expect(fast.calls).toHaveLength(4);
    expect(slow.calls).toHaveLength(1);

    stuck.resolve();
    await scheduler.stop();
  });

  it('nunca roda duas execuções da mesma tarefa ao mesmo tempo', async () => {
    let inFlight = 0;
    let peak = 0;
    const work = task('demorada', SECOND, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Cada execução leva 5 s, cinco vezes o intervalo.
      await new Promise((resolve) => setTimeout(resolve, 5 * SECOND));
      inFlight -= 1;
    });
    const { scheduler } = setup([work.definition]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(29 * SECOND);
    expect(peak).toBe(1);
    // Começa em 0, 6, 12, 18 e 24 s: o intervalo conta do fim de uma execução ao começo da outra.
    expect(work.calls).toHaveLength(5);

    await scheduler.stop();
  });

  it('a parada aborta o sinal das execuções em curso e espera elas terminarem', async () => {
    const stuck = deferred();
    const busy = task('ocupada', MINUTE, () => stuck.promise);
    const idle = task('parada', MINUTE, () => Promise.resolve());
    const { scheduler } = setup([busy.definition, idle.definition]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(SECOND);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    // A tarefa no intervalo acorda na hora; a ocupada recebe o aviso e a parada espera por ela.
    expect(busy.calls[0]?.aborted).toBe(true);
    expect((busy.calls[0]?.reason as DOMException).name).toBe('AbortError');
    expect(stopped).toBe(false);

    stuck.resolve();
    await stopping;
    expect(stopped).toBe(true);
    // Depois da parada, nada mais roda.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(busy.calls).toHaveLength(1);
    expect(idle.calls).toHaveLength(1);
  });

  it('uma exceção vai para o log só pelo tipo e não derruba o laço nem as outras tarefas', async () => {
    let call = 0;
    const flaky = task('instavel', 5 * SECOND, () => {
      call += 1;
      if (call === 1) return Promise.reject(new TypeError('projeto-secreto-do-cliente 203.0.113.10'));
      return Promise.resolve({ lidos: 2 });
    });
    const steady = task('estavel', 5 * SECOND, () => Promise.resolve({ lidos: 1 }));
    const { scheduler, capture, lines } = setup([flaky.definition, steady.definition]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(6 * SECOND);
    expect(flaky.calls).toHaveLength(2);
    expect(steady.calls).toHaveLength(2);

    expect(lines('tarefa falhou')).toEqual([
      expect.objectContaining({ level: 50, task: 'instavel', error: 'TypeError' }),
    ]);
    expect(lines('tarefa concluída')).toContainEqual(
      expect.objectContaining({ task: 'instavel', report: { lidos: 2 } }),
    );
    // Nem a mensagem nem a pilha do erro chegam ao log.
    expect(capture.text).not.toContain('projeto-secreto');
    expect(capture.text).not.toContain('203.0.113.10');
    expect(capture.text).not.toContain('scheduler.test');

    await scheduler.stop();
  });

  it('o orçamento estourado vai para o log e aborta o sinal; a próxima execução espera a atual acabar', async () => {
    const stuck = deferred();
    let call = 0;
    const late = task(
      'atrasada',
      SECOND,
      () => {
        call += 1;
        return call === 1 ? stuck.promise : Promise.resolve();
      },
      2 * SECOND,
    );
    const { scheduler, lines } = setup([late.definition]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(lines('tarefa passou do orçamento de tempo')).toEqual([
      expect.objectContaining({ level: 40, task: 'atrasada', budgetMs: 2 * SECOND }),
    ]);
    expect(late.calls[0]?.aborted).toBe(true);
    expect((late.calls[0]?.reason as DOMException).name).toBe('TimeoutError');

    // A tarefa ignorou o sinal: ela atrasa só a si mesma, sem segunda execução por cima.
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(late.calls).toHaveLength(1);

    stuck.resolve();
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(late.calls).toHaveLength(2);
    // A segunda terminou dentro do orçamento: nenhum aviso novo.
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(lines('tarefa passou do orçamento de tempo')).toHaveLength(1);

    await scheduler.stop();
  });

  it('a tarefa interrompida pela parada vai para o log como interrompida, não como falha', async () => {
    // A tarefa respeita o sinal: para (com erro) assim que o worker avisa que vai parar.
    const definition: ScheduledTask = {
      name: 'atenta',
      intervalMs: MINUTE,
      budgetMs: 10 * MINUTE,
      run: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        }),
    };
    const { scheduler, lines } = setup([definition]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(SECOND);
    await scheduler.stop();
    expect(lines('tarefa falhou')).toEqual([]);
    expect(lines('tarefa interrompida')).toEqual([
      expect.objectContaining({ level: 40, task: 'atenta', error: 'AbortError' }),
    ]);
  });

  it('passou do orçamento e depois lançou um erro comum: é falha, não interrupção', async () => {
    const stuck = deferred();
    const late = task(
      'estourada',
      MINUTE,
      async () => {
        await stuck.promise;
        // O erro é do banco, não do cancelamento: o sinal abortado não pode esconder a falha.
        throw new TypeError('conexão perdida com 203.0.113.10');
      },
      2 * SECOND,
    );
    const { scheduler, capture, lines } = setup([late.definition]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    expect(late.calls[0]?.aborted).toBe(true);
    stuck.resolve();
    await vi.advanceTimersByTimeAsync(SECOND);

    expect(lines('tarefa interrompida')).toEqual([]);
    expect(lines('tarefa falhou')).toEqual([
      expect.objectContaining({ level: 50, task: 'estourada', error: 'TypeError' }),
    ]);
    expect(capture.text).not.toContain('203.0.113.10');

    await scheduler.stop();
  });

  it('erro comum durante a parada também é falha; o motivo da parada é interrupção', async () => {
    const definition = (name: string, fail: () => Error): ScheduledTask => ({
      name,
      intervalMs: MINUTE,
      budgetMs: 10 * MINUTE,
      run: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(fail()), { once: true });
        }),
    });
    const { scheduler, lines } = setup([
      // Ao receber o aviso, uma tarefa falha por outro motivo; a outra para com o próprio erro de cancelamento.
      definition('desatenta', () => new RangeError('lote inválido')),
      definition('cancelada', () => new DOMException('leitura cancelada', 'AbortError')),
    ]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(SECOND);
    await scheduler.stop();
    expect(lines('tarefa falhou')).toEqual([
      expect.objectContaining({ level: 50, task: 'desatenta', error: 'RangeError' }),
    ]);
    expect(lines('tarefa interrompida')).toEqual([
      expect.objectContaining({ level: 40, task: 'cancelada', error: 'AbortError' }),
    ]);
  });

  it('recusa nomes repetidos, intervalo ou orçamento que não sejam positivos e partida dupla', async () => {
    const ok = task('coleta', SECOND, () => Promise.resolve()).definition;
    expect(() => setup([ok, { ...ok }])).toThrow('tarefa repetida no agendador: coleta');
    expect(() => setup([{ ...ok, intervalMs: 0 }])).toThrow(/precisam ser positivos/);
    expect(() => setup([{ ...ok, budgetMs: Number.NaN }])).toThrow(/precisam ser positivos/);
    const { scheduler } = setup([ok]);
    scheduler.start();
    expect(() => scheduler.start()).toThrow('o agendador já foi iniciado');
    await scheduler.stop();
  });
});
