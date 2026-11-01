import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { loadEnvFileForLocalDevelopment } from '../../src/common/config/load-env-file.js';
import { scrubString } from '../../src/common/logger/sanitize.js';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

const apiDir = fileURLToPath(new URL('../..', import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

/** O Vitest 5 perde a mensagem de erros do globalSetup ao formatar a stack; ela sai também no stderr. */
function fail(message: string): never {
  console.error(`\n[global-setup] ${message}\n`);
  throw new Error(message);
}

/**
 * Antes da suíte: aplica as migrations no banco de teste e entrega a URL aos testes via `inject`.
 * Recusa qualquer banco cujo nome não termine em `_test`, para nunca rodar contra dados reais.
 */
export default function setup(project: TestProject): void {
  loadEnvFileForLocalDevelopment(apiDir);

  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    fail('TEST_DATABASE_URL não definida. Rode `pnpm setup:env` e `docker compose up -d --wait` na raiz.');
  }
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    fail('TEST_DATABASE_URL precisa apontar para um banco cujo nome termina em "_test".');
  }

  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1' },
      stdio: 'pipe',
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const output = stderr === undefined ? '' : stderr.toString();
    // A saída do CLI pode conter a URL; a senha é removida antes de aparecer no terminal ou no CI. O erro
    // original não é repassado porque carrega a mesma saída sem limpeza.
    fail(`Falha ao aplicar as migrations no banco de teste:\n${scrubString(output)}`);
  }

  project.provide('testDatabaseUrl', url);
}
