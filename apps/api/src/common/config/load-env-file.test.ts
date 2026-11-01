import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFileForLocalDevelopment } from './load-env-file.js';

describe('loadEnvFileForLocalDevelopment', () => {
  let root: string;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'verax-env-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(root, '.env'), 'VERAX_TEST_ONLY_VAR=from-file\n');
    mkdirSync(join(root, 'apps', 'api'), { recursive: true });
    delete process.env.VERAX_TEST_ONLY_VAR;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.VERAX_TEST_ONLY_VAR;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('carrega o .env da raiz do monorepo a partir de um subdiretório', () => {
    process.env.NODE_ENV = 'development';
    loadEnvFileForLocalDevelopment(join(root, 'apps', 'api'));
    expect(process.env.VERAX_TEST_ONLY_VAR).toBe('from-file');
  });

  it('não carrega arquivo nenhum em produção', () => {
    process.env.NODE_ENV = 'production';
    loadEnvFileForLocalDevelopment(join(root, 'apps', 'api'));
    expect(process.env.VERAX_TEST_ONLY_VAR).toBeUndefined();
  });

  it('não sobrescreve variável já definida no ambiente', () => {
    process.env.NODE_ENV = 'development';
    process.env.VERAX_TEST_ONLY_VAR = 'from-env';
    loadEnvFileForLocalDevelopment(join(root, 'apps', 'api'));
    expect(process.env.VERAX_TEST_ONLY_VAR).toBe('from-env');
  });
});
