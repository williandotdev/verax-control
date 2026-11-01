import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Em desenvolvimento, carrega o .env da raiz do monorepo (o mesmo usado pelo docker-compose).
 * Em produção não faz nada: as variáveis vêm do ECS e os segredos do Secrets Manager.
 * Variáveis já definidas no ambiente têm precedência sobre o arquivo.
 *
 * Os caminhos são derivados do diretório de trabalho do processo, nunca de entrada externa.
 */
export function loadEnvFileForLocalDevelopment(startDir: string = process.cwd()): void {
  if (process.env.NODE_ENV === 'production') return;
  const root = findWorkspaceRoot(startDir);
  if (root === undefined) return;
  const envPath = join(root, '.env');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho derivado do cwd
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

/** Raiz do monorepo (onde está o `pnpm-workspace.yaml`), subindo a partir de `startDir`. */
export function findWorkspaceRoot(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho derivado do cwd
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
