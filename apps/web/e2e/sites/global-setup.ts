import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HostingConfig, siteHostingConfig } from '../../src/hosting';
import { startHostingServer } from './hosting-server';
import { API_TEMPLATE, PORT, TENANTS, panelHost } from './sites';

const web = fileURLToPath(new URL('../..', import.meta.url));

function run(script: string, args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: web,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`${script} terminou com código ${String(result.status)}`);
}

/**
 * Um build só, com `VITE_API_URL` no modelo, numa pasta temporária (o `dist` do repositório fica como está), passado
 * pela mesma varredura de segredos do build normal. Cada site recebe a configuração gerada para ele a partir do
 * `dist-hosting.json` desse build, como na publicação, e o servidor de teste serve o mesmo `dist` para todos.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const workspace = mkdtempSync(join(tmpdir(), 'verax-build-unico-'));
  const dist = join(workspace, 'dist');
  run(join(web, 'node_modules/vite/bin/vite.js'), ['build', '--outDir', dist, '--emptyOutDir'], {
    VITE_API_URL: API_TEMPLATE,
  });
  run(join(web, '../../scripts/scan-bundle.mjs'), [dist]);

  const template = JSON.parse(readFileSync(`${dist}-hosting.json`, 'utf8')) as HostingConfig;
  const sites = new Map(TENANTS.map((tenant) => [panelHost(tenant), siteHostingConfig(template, tenant)]));
  const server = await startHostingServer({ root: dist, sites, port: PORT });

  return async () => {
    await server.close();
    rmSync(workspace, { recursive: true, force: true });
  };
}
