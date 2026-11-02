import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as setup } from '@playwright/test';
import { FIXTURES_FILE } from './support';

/** Cria clientes e usuários de e2e no banco de teste, pelo script da própria API (recusa banco que não seja `_test`). */
setup('dados de e2e', () => {
  const script = fileURLToPath(new URL('../../../api/dist/cli/e2e-fixtures.js', import.meta.url));
  const env = {
    ...process.env,
    ...(JSON.parse(process.env['E2E_API_ENV'] ?? '{}') as Record<string, string>),
  };
  const output = execFileSync(process.execPath, [script], { env, encoding: 'utf8' });
  writeFileSync(FIXTURES_FILE(), output);
});
