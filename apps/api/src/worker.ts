import { pino } from 'pino';
import { AlertSync } from './alerts/alert-sync.js';
import { loadWorkerConfig } from './common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from './common/config/load-env-file.js';
import { buildPinoOptions } from './common/logger/logger.options.js';
import { PrismaService } from './common/prisma/prisma.service.js';
import { GcpAuditSync } from './gcp/gcp-audit-sync.js';
import { MetadataTokenProvider, PubsubRestReader } from './gcp/pubsub.client.js';
import { IndexerClient } from './indexer/indexer.client.js';
import { loadIndexerConfig } from './indexer/indexer.config.js';
import { indexerSecretsFor } from './indexer/indexer-secrets.js';
import { type ScheduledTask, Scheduler } from './worker/scheduler.js';

/**
 * Orçamento de uma execução dos syncs de alertas: a validade da concessão no banco, renovada a cada lote. Uma
 * execução mais longa que isso vai para o log como estouro. Os syncs não interrompem no meio: a próxima execução só
 * começa depois que a atual termina, como antes.
 */
const SYNC_BUDGET_MS = 5 * 60 * 1000;

/**
 * Worker do Verax Control: o mesmo código da API num processo à parte, sem porta aberta. Cada fonte de `SYNC_SOURCES`
 * vira uma tarefa do agendador, a cada `SYNC_INTERVAL_SECONDS`; as tarefas rodam ao mesmo tempo, cada uma no próprio
 * laço. A concessão no banco garante um worker por vez em cada fonte, mesmo com mais de uma réplica. SIGTERM ou SIGINT
 * esperam as execuções em curso terminarem, e elas liberam a concessão.
 *
 * O pool do banco tem 10 conexões (`PrismaService`): uma por tarefa em curso, com folga para as transações.
 */
async function main(): Promise<void> {
  loadEnvFileForLocalDevelopment();

  let config;
  let tasks: ScheduledTask[];
  let prisma: PrismaService;
  try {
    config = loadWorkerConfig();
    prisma = new PrismaService(config);
    const intervalMs = config.SYNC_INTERVAL_SECONDS * 1000;
    tasks = config.SYNC_SOURCES.map((source): ScheduledTask => {
      if (source === 'wazuh') {
        const indexerConfig = loadIndexerConfig();
        const indexer = new IndexerClient(indexerConfig, indexerSecretsFor(indexerConfig));
        return {
          name: 'wazuh',
          intervalMs,
          budgetMs: SYNC_BUDGET_MS,
          run: () => new AlertSync(prisma, indexer).runOnce(),
        };
      }
      // Auditoria da GCP: o token vem da identidade da VM do nó, sem chave.
      const sync = new GcpAuditSync(prisma, new PubsubRestReader(new MetadataTokenProvider()));
      return { name: 'gcp', intervalMs, budgetMs: SYNC_BUDGET_MS, run: () => sync.runOnce() };
    });
  } catch (error) {
    // Só nomes de variáveis e o problema; nenhum valor é impresso.
    console.error((error as Error).message);
    process.exit(1);
  }

  const logger = pino(buildPinoOptions(config));
  const scheduler = new Scheduler(tasks, logger);
  const stopRequested = new Promise<void>((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
  });

  logger.info(
    { intervalSeconds: config.SYNC_INTERVAL_SECONDS, tasks: tasks.map((task) => task.name) },
    'worker iniciado',
  );
  scheduler.start();
  await stopRequested;
  await scheduler.stop();
  await prisma.$disconnect();
  logger.info('worker encerrado');
}

void main();
