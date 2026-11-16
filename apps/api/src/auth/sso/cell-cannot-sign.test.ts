import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Meta-teste da entrada única (`docs/ARQUITETURA.md`, "Entrada única"): a célula só CONFERE o token do console; nada no
 * que vai para o nó (o código da API, o pacote do nó e o Terraform dos nós e das células) tem como assinar um. A chave
 * de assinatura (`cp-admin-sso-signing-key`) é citada só pelo plano de controle; a célula recebe a chave pública, fixada
 * no `node.conf`.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Os arquivos de texto de uma pasta, recursivamente (sem `node_modules`, `dist` e o cliente gerado do Prisma). */
function filesUnder(path: string): string[] {
  const absolute = join(repoRoot, path);
  const entries = readdirSync(absolute);
  return entries.flatMap((entry) => {
    if (['node_modules', 'dist', 'generated', '__pycache__', '.terraform'].includes(entry)) return [];
    const full = join(absolute, entry);
    const rel = relative(repoRoot, full);
    if (statSync(full).isDirectory()) return filesUnder(rel);
    return /\.(ts|sh|ya?ml|tf|hcl|conf|example|service|py|json)$/.test(entry) ? [rel] : [];
  });
}

const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

/** O que vai para a célula: o código de produção da API e do worker, o pacote do nó e o Terraform dos nós. */
const CELL_SIDE = [
  ...filesUnder('apps/api/src').filter((path) => !path.endsWith('.test.ts')),
  ...filesUnder('infra/node'),
  ...filesUnder('infra/gcp/modules'),
  ...filesUnder('infra/gcp/envs').filter(
    (path) => !path.replaceAll('\\', '/').includes('envs/control-plane/'),
  ),
];

describe('a célula não tem como assinar um login do console', () => {
  it('nenhum arquivo do lado da célula cita o cofre da chave de assinatura', () => {
    expect(CELL_SIDE.length).toBeGreaterThan(50);
    const offenders = CELL_SIDE.filter((path) => read(path).includes('sso-signing-key'));
    expect(offenders).toEqual([]);
  });

  it('o código da entrada única na API só confere: nenhuma chave privada, nenhuma assinatura, nenhum HMAC', () => {
    const sso = filesUnder('apps/api/src/auth/sso').filter((path) => !path.endsWith('.test.ts'));
    expect(sso.length).toBeGreaterThan(0);
    for (const path of [...sso, 'apps/api/src/common/config/sso.ts']) {
      const text = read(path);
      for (const forbidden of [
        /\bcreatePrivateKey\b/,
        /\bgenerateKeyPair(Sync)?\b/,
        /\bcreateHmac\b/,
        /\bcreateSign\b/,
        /import\s*\{[^}]*\bsign\b[^}]*\}\s*from\s*'node:crypto'/,
      ]) {
        expect(forbidden.test(text), `${path}: ${String(forbidden)}`).toBe(false);
      }
    }
  });

  it('o node.conf e o start.sh levam só a chave pública da entrada única', () => {
    const conf = read('infra/node/node.conf.example');
    const start = read('infra/node/bin/start.sh');
    expect(conf).toContain('SSO_PUBLIC_KEY');
    for (const text of [conf, start]) {
      expect(text).not.toMatch(/SSO_[A-Z_]*PRIVATE/);
      expect(text).not.toMatch(/SSO_[A-Z_]*SECRET/);
    }
    // O start.sh não lê nenhum cofre para a entrada única: a chave pública vem do node.conf.
    expect(start).not.toMatch(/external_secret[^\n]*sso/i);
  });
});
