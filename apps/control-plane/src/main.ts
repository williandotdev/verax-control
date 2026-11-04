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

  // Avisos da carga (variável do outro papel ignorada) esperam o logger subir, para sair com redaction e severidade.
  const warnings: string[] = [];
  let config;
  try {
    config = loadConfig(process.env, (message) => warnings.push(message));
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
  const logger = app.get(Logger);
  for (const warning of warnings) logger.warn(warning, 'Config');
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  logger.log(`plano de controle no ar: papel ${config.ROLE}, porta ${config.PORT}`, 'Bootstrap');
}

void bootstrap();
