import { errorKind } from '../common/logger/error-kind.js';

/** Uma tarefa do worker: um coletor, o despachante de e-mail, o expurgo. */
export interface ScheduledTask {
  /** Nome curto e fixo. É o único dado da tarefa que vai para o log, junto com o relatório que ela devolve. */
  readonly name: string;
  /** Pausa entre o fim de uma execução e o começo da próxima. */
  readonly intervalMs: number;
  /**
   * Tempo máximo de uma execução. Estourado, o estouro vai para o log e o sinal da execução é abortado; a próxima só
   * começa quando esta terminar, então a tarefa que ignora o sinal atrasa só a si mesma.
   */
  readonly budgetMs: number;
  /**
   * Uma execução. O sinal é abortado na parada do worker (`AbortError`) ou no estouro do orçamento (`TimeoutError`).
   * O relatório devolvido (contagens) vai para o log; nunca devolva dado de cliente nele.
   */
  run(signal: AbortSignal): Promise<unknown>;
}

/**
 * O erro veio do próprio cancelamento: o sinal foi abortado e a tarefa devolveu o motivo dele, ou um `DOMException`
 * de cancelamento (`AbortError`, `TimeoutError`), como o do `fetch` que recebeu o sinal. Qualquer outro erro é falha,
 * mesmo depois do estouro do orçamento ou do começo da parada: um erro do banco não pode sumir como "interrompida".
 */
function cancelledBy(signal: AbortSignal, error: unknown): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** O que o agendador usa do logger (o pino do worker; um dublê nos testes). */
export interface SchedulerLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/**
 * Agendador do worker (fase 2): cada tarefa roda num laço próprio, com o próprio intervalo.
 * - Tarefas diferentes rodam ao mesmo tempo: uma lenta não atrasa as outras.
 * - A mesma tarefa nunca roda duas vezes ao mesmo tempo: a próxima execução só é marcada depois que a atual termina.
 * - Uma exceção vai para o log só pelo tipo (nunca a mensagem) e não derruba o laço: a tarefa roda de novo no
 *   intervalo seguinte.
 * - `stop()` para de marcar execuções, aborta o sinal das que estão em curso e espera todas terminarem.
 *
 * Cada execução roda uma vez ao iniciar, como o laço que veio antes. O agendador não sabe nada de banco nem de
 * concessão: a concessão no banco (`SyncLease`) continua garantindo um worker por vez quando há mais de uma réplica.
 */
export class Scheduler {
  private readonly stopping = new AbortController();
  /** Execuções em curso, para a parada abortar o sinal de cada uma. */
  private readonly running = new Set<AbortController>();
  private loops: Promise<void>[] | null = null;

  constructor(
    private readonly tasks: readonly ScheduledTask[],
    private readonly logger: SchedulerLogger,
  ) {
    const names = new Set<string>();
    for (const task of tasks) {
      if (names.has(task.name)) throw new Error(`tarefa repetida no agendador: ${task.name}`);
      names.add(task.name);
      if (!(task.intervalMs > 0) || !(task.budgetMs > 0)) {
        throw new Error(`intervalo e orçamento da tarefa ${task.name} precisam ser positivos`);
      }
    }
  }

  start(): void {
    if (this.loops !== null) throw new Error('o agendador já foi iniciado');
    this.loops = this.tasks.map((task) => this.loop(task));
  }

  /** Para de agendar, aborta o sinal das execuções em curso e espera todas terminarem. */
  async stop(): Promise<void> {
    if (!this.stopping.signal.aborted) {
      this.stopping.abort();
      const reason = new DOMException('o worker está parando', 'AbortError');
      for (const controller of this.running) controller.abort(reason);
    }
    await Promise.all(this.loops ?? []);
  }

  private async loop(task: ScheduledTask): Promise<void> {
    while (!this.stopping.signal.aborted) {
      await this.execute(task);
      await this.pause(task.intervalMs);
    }
  }

  private async execute(task: ScheduledTask): Promise<void> {
    const controller = new AbortController();
    this.running.add(controller);
    const startedAt = Date.now();
    const budget = setTimeout(() => {
      this.logger.warn({ task: task.name, budgetMs: task.budgetMs }, 'tarefa passou do orçamento de tempo');
      controller.abort(new DOMException('a tarefa passou do orçamento de tempo', 'TimeoutError'));
    }, task.budgetMs);
    try {
      const report = await task.run(controller.signal);
      this.logger.info(
        {
          task: task.name,
          durationMs: Date.now() - startedAt,
          ...(typeof report === 'object' && report !== null && { report }),
        },
        'tarefa concluída',
      );
    } catch (error) {
      // Só o tipo: a mensagem e a pilha de um erro do banco ou da fonte podem carregar dado do cliente ou segredo.
      const fields = { task: task.name, durationMs: Date.now() - startedAt, error: errorKind(error) };
      if (cancelledBy(controller.signal, error)) this.logger.warn(fields, 'tarefa interrompida');
      else this.logger.error(fields, 'tarefa falhou');
    } finally {
      clearTimeout(budget);
      this.running.delete(controller);
    }
  }

  /** Espera o intervalo; a parada acorda na hora. */
  private pause(ms: number): Promise<void> {
    const signal = this.stopping.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      signal.addEventListener('abort', wake, { once: true });
    });
  }
}
