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

interface Sync {
  name: string;
  runOnce(): Promise<object>;
}

/**
 * Worker dos syncs de alertas (T5.3): o mesmo código da API num processo à parte, sem porta aberta. Roda em laço,
 * uma execução de cada fonte (`SYNC_SOURCES`) a cada `SYNC_INTERVAL_SECONDS`. A concessão no banco garante um worker
 * por vez em cada fonte, mesmo com mais de uma réplica. SIGTERM ou SIGINT esperam a execução em curso terminar, e ela
 * libera a concessão.
 */
async function main(): Promise<void> {
  loadEnvFileForLocalDevelopment();

  let config;
  let syncs: Sync[];
  let prisma: PrismaService;
  try {
    config = loadWorkerConfig();
    prisma = new PrismaService(config);
    syncs = config.SYNC_SOURCES.map((source): Sync => {
      if (source === 'wazuh') {
        const indexerConfig = loadIndexerConfig();
        const indexer = new IndexerClient(indexerConfig, indexerSecretsFor(indexerConfig));
        return { name: 'wazuh', runOnce: () => new AlertSync(prisma, indexer).runOnce() };
      }
      // Auditoria da GCP: o token vem da identidade da VM do nó, sem chave.
      const sync = new GcpAuditSync(prisma, new PubsubRestReader(new MetadataTokenProvider()));
      return { name: 'gcp', runOnce: () => sync.runOnce() };
    });
  } catch (error) {
    // Só nomes de variáveis e o problema; nenhum valor é impresso.
    console.error((error as Error).message);
    process.exit(1);
  }

  const logger = pino(buildPinoOptions(config));
  const intervalMs = config.SYNC_INTERVAL_SECONDS * 1000;

  let stopping = false;
  let wake = (): void => undefined;
  const stop = (): void => {
    stopping = true;
    wake();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  logger.info(
    { intervalSeconds: config.SYNC_INTERVAL_SECONDS, sources: config.SYNC_SOURCES },
    'worker dos syncs de alertas iniciado',
  );
  while (!stopping) {
    for (const sync of syncs) {
      try {
        const report = await sync.runOnce();
        logger.info({ source: sync.name, sync: report }, 'sync de alertas');
      } catch (error) {
        logger.error({ source: sync.name, err: error }, 'sync de alertas falhou');
      }
      if (stopping) break;
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
  logger.info('worker dos syncs de alertas encerrado');
}

void main();
