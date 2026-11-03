import { pino } from 'pino';
import { AlertSync } from './alerts/alert-sync.js';
import { loadWorkerConfig } from './common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from './common/config/load-env-file.js';
import { buildPinoOptions } from './common/logger/logger.options.js';
import { PrismaService } from './common/prisma/prisma.service.js';
import { IndexerClient } from './indexer/indexer.client.js';
import { loadIndexerConfig } from './indexer/indexer.config.js';
import { indexerSecretsFor } from './indexer/indexer-secrets.js';

/**
 * Worker do sync de alertas (T5.3): o mesmo código da API num processo à parte, sem porta aberta. Roda em laço,
 * uma execução a cada `SYNC_INTERVAL_SECONDS`. A concessão no banco garante um worker por vez, mesmo com mais de uma
 * réplica. SIGTERM ou SIGINT esperam a execução em curso terminar, e ela libera a concessão.
 */
async function main(): Promise<void> {
  loadEnvFileForLocalDevelopment();

  let config;
  let indexerConfig;
  try {
    config = loadWorkerConfig();
    indexerConfig = loadIndexerConfig();
  } catch (error) {
    // Só nomes de variáveis e o problema; nenhum valor é impresso.
    console.error((error as Error).message);
    process.exit(1);
  }

  const logger = pino(buildPinoOptions(config));
  const prisma = new PrismaService(config);
  const sync = new AlertSync(prisma, new IndexerClient(indexerConfig, indexerSecretsFor(indexerConfig)));
  const intervalMs = config.SYNC_INTERVAL_SECONDS * 1000;

  let stopping = false;
  let wake = (): void => undefined;
  const stop = (): void => {
    stopping = true;
    wake();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  logger.info({ intervalSeconds: config.SYNC_INTERVAL_SECONDS }, 'worker do sync de alertas iniciado');
  while (!stopping) {
    try {
      const report = await sync.runOnce();
      logger.info({ sync: report }, 'sync de alertas');
    } catch (error) {
      logger.error({ err: error }, 'sync de alertas falhou');
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  await prisma.$disconnect();
  logger.info('worker do sync de alertas encerrado');
}

void main();
