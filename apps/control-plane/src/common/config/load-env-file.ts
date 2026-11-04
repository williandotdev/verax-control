import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pasta do app (`apps/control-plane`), tanto no código-fonte quanto no `dist/`. */
const APP_DIR = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Em desenvolvimento, carrega o `.env` da própria pasta do app (modelo em `.env.example`). Em produção não faz
 * nada: as variáveis vêm do serviço do Cloud Run e os segredos do Secret Manager, montados como variáveis na
 * implantação. Variáveis já definidas no ambiente têm precedência sobre o arquivo.
 *
 * O caminho é derivado da localização deste arquivo, nunca de entrada externa.
 */
export function loadEnvFileForLocalDevelopment(appDir: string = APP_DIR): void {
  if (process.env.NODE_ENV === 'production') return;
  const envPath = join(appDir, '.env');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho derivado da pasta do app
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}
