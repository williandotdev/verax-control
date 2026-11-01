import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { APP_CREATE_OPTIONS, configureApp } from './app.setup.js';
import { ConfigValidationError, loadConfig } from './common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from './common/config/load-env-file.js';

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
    AppModule.register(config),
    APP_CREATE_OPTIONS,
  );
  configureApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

void bootstrap();
