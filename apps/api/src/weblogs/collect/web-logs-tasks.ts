import type { ScopedExceptionSource } from '../../alerts/scoped-exception-match.js';
import type { WebLogsCredentials } from './web-logs-job.js';
import { awsSourceFeatures } from '../../common/config/web-logs.js';
import { errorKind } from '../../common/logger/error-kind.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { AlertNotices } from '../../notifications/finding-notices.js';
import type { ScheduledTask } from '../../worker/scheduler.js';
import type { CountryLookup } from '../traffic.js';

/** O que as tarefas usam do worker. */
export interface WebLogsTaskDeps {
  prisma: PrismaService;
  /** As sessões no papel de leitura; null no nó sem identidade na AWS. */
  credentials: WebLogsCredentials | null;
  /** O aviso por e-mail dos achados: `undefined` é um por achado; com os casos ligados, quem avisa é o caso. */
  notices: AlertNotices | undefined;
  /** As exceções amplas (casos, PR-9), só com `CASES_MODE=on`. */
  scopedExceptions?: ScopedExceptionSource | undefined;
  logger: { warn(fields: object, message: string): void };
}

export interface WebLogsTasks {
  tasks: ScheduledTask[];
  /** Na parada do worker, depois de as execuções terminarem. */
  close: () => Promise<void>;
}

const NONE: WebLogsTasks = { tasks: [], close: () => Promise.resolve() };

/**
 * As tarefas dos ataques web pelos logs do ALB (`web-logs` e `web-logs-estimate`). Desligados no nó (o padrão, e sempre na
 * célula) ou sem identidade na AWS, não existem: nenhum módulo delas é carregado e nenhuma chamada sai para o S3.
 */
export async function webLogsTasks(
  config: Parameters<typeof awsSourceFeatures>[0],
  { prisma, credentials, notices, scopedExceptions, logger }: WebLogsTaskDeps,
): Promise<WebLogsTasks> {
  if (!awsSourceFeatures(config).webLogs || credentials === null) return NONE;
  const [job, estimate, { sdkDiscoveryClients }, countries] = await Promise.all([
    import('./web-logs-job.js'),
    import('./web-estimate-job.js'),
    import('../../aws/discovery/sdk-clients.js'),
    loadCountries(logger),
  ]);
  const collector = new job.WebLogsCollector(prisma, credentials, sdkDiscoveryClients, {
    countries,
    ...(notices !== undefined && { notices }),
    ...(scopedExceptions !== undefined && { scopedExceptions }),
    onEvidenceRefused: (ruleId) => {
      logger.warn({ ruleId }, 'evidência de ataque web recusada: o achado foi gravado sem ela');
    },
  });
  const estimator = new estimate.WebLogsEstimator(prisma, credentials, sdkDiscoveryClients);
  return {
    tasks: [
      {
        name: job.WEB_LOGS_SYNC,
        intervalMs: job.WEB_LOGS_TICK_MS,
        budgetMs: job.WEB_LOGS_BUDGET_MS,
        run: (signal) => collector.runOnce(signal),
      },
      {
        name: estimate.WEB_ESTIMATE_SYNC,
        intervalMs: estimate.WEB_ESTIMATE_TICK_MS,
        budgetMs: estimate.WEB_ESTIMATE_BUDGET_MS,
        run: (signal) => estimator.runOnce(signal),
      },
    ],
    close: () => collector.close(),
  };
}

/** A tabela de países, uma vez por processo. Sem ela, a detecção segue, e o tráfego sai com o país desconhecido. */
export async function loadCountries(
  logger: WebLogsTaskDeps['logger'],
  load: () => Promise<CountryLookup> = async () => (await import('../../geo/ip-country.js')).loadIpCountry(),
): Promise<CountryLookup | null> {
  try {
    return await load();
  } catch (error) {
    logger.warn({ error: errorKind(error) }, 'tabela de países indisponível: o tráfego sai sem o país');
    return null;
  }
}
