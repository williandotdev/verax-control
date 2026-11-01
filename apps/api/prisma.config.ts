import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

// Em desenvolvimento o CLI lê o .env da raiz do monorepo. Variáveis já definidas no ambiente (CI, testes,
// task de migration em produção) têm precedência, e em produção o arquivo nunca é lido.
const rootEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
// eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho fixo, relativo a este arquivo
if (process.env['NODE_ENV'] !== 'production' && existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

// Sem telemetria nem checagem de atualização do CLI (checkpoint.prisma.io).
process.env['CHECKPOINT_DISABLE'] ??= '1';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` não conecta ao banco e roda sem a variável (lint e build no CI);
    // migrate e studio falham com erro claro se ela faltar.
    url: process.env['DATABASE_URL'] ?? '',
  },
});
