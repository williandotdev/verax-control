import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { APP_CREATE_OPTIONS, configureApp } from './app.setup.js';
import { ConfigValidationError, loadConfig } from './common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from './common/config/load-env-file.js';
import { createFirestore, FirestoreDocumentStore } from './firestore/firestore-document-store.js';

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

  // Os logs do boot ficam retidos até o pino assumir, para que tudo saia pelo logger com redaction.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, { documentStore: new FirestoreDocumentStore(createFirestore(config)) }),
    APP_CREATE_OPTIONS,
  );
  configureApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  app.get(Logger).log(`plano de controle no ar: papel ${config.ROLE}, porta ${config.PORT}`, 'Bootstrap');
}

void bootstrap();
