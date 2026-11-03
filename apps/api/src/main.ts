import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { APP_CREATE_OPTIONS, configureApp } from './app.setup.js';
import { ConfigValidationError, loadConfig } from './common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from './common/config/load-env-file.js';
import { IndexerRawEvents } from './findings/indexer-raw-events.js';
import { IndexerClient } from './indexer/indexer.client.js';
import { loadIndexerConfig } from './indexer/indexer.config.js';
import { indexerSecretsFor } from './indexer/indexer-secrets.js';

async function bootstrap(): Promise<void> {
  loadEnvFileForLocalDevelopment();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      // Só nomes de variáveis e o problema; nenhum valor é impresso.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  // Com o indexer configurado, o detalhe do achado traz o evento bruto; sem ele (desenvolvimento), sai sem.
  let rawEvents: IndexerRawEvents | undefined;
  if (process.env['INDEXER_URL']) {
    try {
      const indexer = loadIndexerConfig();
      rawEvents = new IndexerRawEvents(new IndexerClient(indexer, indexerSecretsFor(indexer)));
    } catch (error) {
      // Só nomes de variáveis e o problema; nenhum valor é impresso.
      console.error((error as Error).message);
      process.exit(1);
    }
  }

  // Os logs do boot ficam retidos até o pino assumir, para que tudo saia pelo logger com redaction.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, { rawEvents }),
    APP_CREATE_OPTIONS,
  );
  configureApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

void bootstrap();
