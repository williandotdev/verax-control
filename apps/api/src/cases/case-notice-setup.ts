import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { AlertNotices } from '../notifications/finding-notices.js';
import type { NotificationDispatcherOptions } from '../notifications/notification-dispatcher.js';
import { CaseAssignJob, type CaseLogger } from './case-assign-job.js';
import { CaseNoticeMail } from './case-notice-mail.js';
import { CaseAlertNotices, CaseNoticeRegime } from './case-notice-regime.js';
import { CaseNotices } from './case-notices.js';
import { casesNoticed, type CasesMode } from './cases-mode.js';

/** Tempo da última passagem na parada do worker: o contêiner tem 10 s para parar. */
export const CASE_DRAIN_MS = 5_000;

/** Os avisos por e-mail dos alertas no worker, conforme o `CASES_MODE`. */
export interface CaseNoticeSetup {
  /** O passo do `FindingStore` nos coletores; `undefined` é o de sempre (um aviso por alerta). */
  alertNotices: AlertNotices | undefined;
  /** O que a tarefa `notifications` ganha. */
  dispatcher: Pick<NotificationDispatcherOptions, 'cases' | 'caseMail'>;
  /** Antes de o agendador começar. Uma falha não impede a partida: até dar certo, o aviso é por alerta. */
  start(): Promise<void>;
  /** Depois de o agendador parar. */
  finish(): Promise<void>;
}

export interface CaseNoticeSetupOptions {
  /** Só os testes: restringe os avisos e a última passagem a estes clientes, e muda o prazo dela. */
  tenantIds?: readonly string[];
  drainMs?: number;
}

/**
 * - `off` e `shadow`: o aviso é por alerta, como sempre. A tarefa `notifications` só confere (uma leitura) se os avisos por
 *   caso já valeram, para devolver o que ficou no meio.
 * - `on`: os coletores param de avisar depois que a virada está gravada, e a tarefa `notifications` avisa por caso. Na
 *   partida, a virada é gravada antes de os coletores começarem; na parada, uma última passagem atribui e avisa o que acabou
 *   de chegar, para uma volta de versão logo depois não achar alerta sem aviso.
 */
export function caseNoticeSetup(
  mode: CasesMode,
  prisma: PrismaService,
  logger: CaseLogger,
  { tenantIds, drainMs = CASE_DRAIN_MS }: CaseNoticeSetupOptions = {},
): CaseNoticeSetup {
  if (!casesNoticed(mode)) {
    const notices = new CaseNotices(prisma, { logger });
    return {
      alertNotices: undefined,
      dispatcher: { cases: { check: (now, signal) => notices.handBack(now, signal) }, caseMail: null },
      start: () => Promise.resolve(),
      finish: () => Promise.resolve(),
    };
  }
  const regime = new CaseNoticeRegime(prisma);
  const only = tenantIds === undefined ? {} : { tenantIds };
  const notices = new CaseNotices(prisma, { regime, logger, ...only });
  const attempt = async (what: () => Promise<unknown>, message: string): Promise<void> => {
    try {
      await what();
    } catch (error) {
      logger.warn({ error: errorKind(error) }, message);
    }
  };
  return {
    alertNotices: new CaseAlertNotices(regime),
    dispatcher: { cases: notices, caseMail: new CaseNoticeMail(prisma) },
    start: () =>
      attempt(
        () => regime.activate(new Date()),
        'a virada para os avisos por caso não foi gravada: até lá, o aviso é por alerta',
      ),
    finish: () =>
      attempt(async () => {
        const signal = AbortSignal.timeout(drainMs);
        await new CaseAssignJob(prisma, { logger, caseNotices: true, ...only }).runOnce(signal);
        await notices.check(new Date(), signal);
      }, 'a última passagem dos avisos por caso não terminou: o resto sai na próxima partida'),
  };
}
