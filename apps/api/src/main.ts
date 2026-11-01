import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
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

  const app = await NestFactory.create(AppModule.register(config));
  await app.listen(config.PORT);
}

void bootstrap();
